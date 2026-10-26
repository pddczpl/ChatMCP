import { useEffect, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { translate, useTranslation, type TranslationKey } from '@/lib/i18n';
import { isDesktopShell, requestApplyUpdate } from '@/lib/native-apply-update';
import { applyReducer, drawnApplyKind, errorGroup, refusalKey, type ApplyPhase } from '@/lib/updates';
import type { UpdateInfo } from '@/types';

/**
 * What the owner can do about the update notice, shared by the strip under the header and Settings → Updates: answer the question (or tick the box), look now, skip a release.
 * Each call asks the Hub (lib/update-check.mjs), refreshes what the page knows and says the result in the language of the page; one request at a time (`busy`).
 * `download` and `cancelDownload` are the owner's clicks on the Download and Cancel buttons (lib/update-download.mjs): the Hub downloads nothing else, ever. `downloadAgain` is "Download again", the same
 * click with again: true, offered after the desktop app found that what the Hub calls ready is gone or does not prove itself.
 * `askApply`, `backApply` and `confirmApply` are the steps of the owner's click on Install and restart, inside the desktop shell: the page sends the shell one message (lib/native-apply-update.ts) and the
 * shell checks everything itself (native-shared/UpdateApplier.cs); nothing here installs or starts anything. The question and a refusal are about the release the owner pressed the button for, and a
 * confirm is sent only for the question that was asked about it. `context` (the update notice and the Hub's state the page has, and `shown`: whether the surface that uses the hook is drawn at all, which the
 * strip is not for a release the owner skipped) lets the hook drop a question or a refusal that the page no longer draws, so that it does not come back by itself later. `dismissApplied` tells the Hub that the owner has read what the last update left.
 */
export function useUpdateActions(context?: { update: UpdateInfo | null | undefined; hub: unknown; shown?: boolean }) {
  const { t, lang } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useAppStore(state => state.showToast);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [apply, dispatchApply] = useReducer(applyReducer, { phase: 'idle' } as ApplyPhase);
  const sending = useRef(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['hubState'] });

  // A question or a refusal that is no longer drawn (a task has started, the release changed, the download is gone) is put away, so that it does not come back by itself when the page draws the button again:
  // the owner answers a question they can see.
  const drawn = context ? drawnApplyKind(context.update, context.hub, isDesktopShell(), apply, context.shown ?? true) : null;
  useEffect(() => {
    if (drawn !== null && (apply.phase === 'confirm' || apply.phase === 'refused') && drawn !== apply.phase) dispatchApply({ type: 'back' });
  }, [drawn, apply.phase]);

  /** A refusal the Hub gave a code of the update notice is said in the words of the page (the Hub speaks Vietnamese only); any other failure in the Hub's own words when it gave some, else the page's. */
  const failed = (error: unknown) => {
    const known = refusalKey((error as { code?: unknown } | null)?.code);
    showToast(known ? translate(lang, known) : (error as { message?: string } | null)?.message || t('upd_save_failed'), 'error');
  };

  /** What a check found, in words: the failure first (the release that was known is still on offer, but the owner asked to know what happened now). */
  const told = (update: UpdateInfo, throttled: boolean) => {
    if (throttled) showToast(t('upd_toast_throttled'), 'info');
    else if (update.error) showToast(translate(lang, `upd_err_${errorGroup(update.error.code)}`, { status: update.error.status ?? '' }), 'error');
    else if (update.available && update.latest) showToast(t('upd_toast_available', { version: update.latest }), 'success');
    else showToast(t('upd_toast_uptodate'), 'info');
  };

  /** Yes or no to "may DatGold look by itself". A yes is followed by a first look, so that the person sees the answer now and not half a minute later. */
  const answer = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setAutoCheckUpdates(enabled);
      // the choice is saved; a first look that does not work is shown by the state (Settings → Updates), not by a failure of the choice
      if (enabled) await api.checkForUpdates().catch(() => undefined);
      await refresh();
      showToast(t(enabled ? 'upd_toast_on' : 'upd_toast_off'), 'success');
    } catch (error) { failed(error); } finally { setBusy(false); }
  };

  /** "Check now": one request at most a minute; a press that is too soon is answered by the Hub from what it knows, and said so. */
  const check = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.checkForUpdates();
      await refresh();
      told(result.update, result.throttled);
    } catch (error) { failed(error); } finally { setBusy(false); }
  };

  /** Skip a release (the one on offer), or take the skip back with null. A refusal (the release changed meanwhile) makes the page look again at what the Hub knows. */
  const skip = async (version: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.skipUpdate(version);
      await refresh();
      const named = version ?? result.update.latest ?? '';
      showToast(t(version === null ? 'upd_toast_unskipped' : 'upd_toast_skipped', { version: named }), 'success');
    } catch (error) {
      await refresh().catch(() => undefined);
      failed(error);
    } finally { setBusy(false); }
  };

  /** Download the release that was shown (the Hub refuses when it is no longer the one on offer). A click that started nothing, because it was already running or ready, is not announced. */
  const download = async (version: string, again = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.downloadUpdate(version, again);
      await refresh();
      if (result.started) showToast(t('upd_toast_dl_started', { version }), 'info');
    } catch (error) {
      await refresh().catch(() => undefined);
      failed(error);
    } finally { setBusy(false); }
  };

  /** "Download again": the refusal is put away and the release is fetched anew (the Hub drops what it calls ready). */
  const downloadAgain = async (version: string) => {
    dispatchApply({ type: 'back' });
    await download(version, true);
  };

  /**
   * Stop the download that runs; the Hub closes the connection and removes what it had written. It does not wait for `busy`: the click on Download is still being answered for as long as the Hub looks
   * at the release again (two chains of requests), the Hub already reports the download, and the person who started it must be able to stop it. Only a second Cancel waits.
   */
  const cancelDownload = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      const result = await api.cancelUpdateDownload();
      await refresh();
      if (result.cancelled) showToast(t('upd_toast_dl_cancelled'), 'info');
    } catch (error) {
      await refresh().catch(() => undefined);
      failed(error);
    } finally { setCancelling(false); }
  };

  /** The owner pressed Install and restart for this release: the question is asked; nothing is sent yet. */
  const askApply = (version: string) => dispatchApply({ type: 'ask', version });
  /** "Not now", or a refusal put away. */
  const backApply = () => dispatchApply({ type: 'back' });

  /**
   * Close and install: ONE message to the shell, which answers once. It is sent only for the question that was asked about this release; without one nothing is sent. `launched` means the installer is
   * running and this window is closing; any other answer is a refusal that the page says in its own words, and the button comes back. A second press while the first is out is not sent.
   */
  const confirmApply = async (version: string) => {
    if (sending.current || apply.phase !== 'confirm' || apply.version !== version) return;
    sending.current = true;
    dispatchApply({ type: 'confirm', version });
    const result = await requestApplyUpdate();
    if (!result.ok) sending.current = false;
    dispatchApply({ type: 'answered', result });
  };

  /** The owner has read what the last update left: the Hub forgets it (it keeps it in memory only). */
  const dismissApplied = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.dismissAppliedUpdate();
      await refresh();
    } catch (error) {
      await refresh().catch(() => undefined);
      failed(error);
    } finally { setBusy(false); }
  };

  return { busy, cancelling, apply, answer, check, skip, download, downloadAgain, cancelDownload, askApply, backApply, confirmApply, dismissApplied };
}

export type { TranslationKey };
