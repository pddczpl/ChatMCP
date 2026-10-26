import { useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { translate, useTranslation, type TranslationKey } from '@/lib/i18n';
import { requestApplyUpdate } from '@/lib/native-apply-update';
import { applyReducer, errorGroup, refusalKey, type ApplyPhase } from '@/lib/updates';
import type { UpdateInfo } from '@/types';

/**
 * What the owner can do about the update notice, shared by the strip under the header and Settings → Updates: answer the question (or tick the box), look now, skip a release.
 * Each call asks the Hub (lib/update-check.mjs), refreshes what the page knows and says the result in the language of the page; one request at a time (`busy`).
 * `download` and `cancelDownload` are the owner's clicks on the Download and Cancel buttons (lib/update-download.mjs): the Hub downloads nothing else, ever.
 * `askApply`, `backApply` and `confirmApply` are the steps of the owner's click on Install and restart, inside the desktop shell: the page sends the shell one message (lib/native-apply-update.ts) and the
 * shell checks everything itself (native-shared/UpdateApplier.cs); nothing here installs or starts anything. `dismissApplied` tells the Hub that the owner has read what the last update left.
 */
export function useUpdateActions() {
  const { t, lang } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useAppStore(state => state.showToast);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [apply, dispatchApply] = useReducer(applyReducer, { phase: 'idle' } as ApplyPhase);
  const sending = useRef(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['hubState'] });

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
  const download = async (version: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.downloadUpdate(version);
      await refresh();
      if (result.started) showToast(t('upd_toast_dl_started', { version }), 'info');
    } catch (error) {
      await refresh().catch(() => undefined);
      failed(error);
    } finally { setBusy(false); }
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

  /** The owner pressed Install and restart: the question is asked; nothing is sent yet. */
  const askApply = () => dispatchApply({ type: 'ask' });
  /** "Not now", or a refusal put away. */
  const backApply = () => dispatchApply({ type: 'back' });

  /**
   * Close and install: ONE message to the shell, which answers once. `launched` means the installer is running and this window is closing; any other answer is a refusal that the page says in its own words, and the
   * button comes back. A second press while the first is out is not sent.
   */
  const confirmApply = async () => {
    if (sending.current) return;
    sending.current = true;
    dispatchApply({ type: 'confirm' });
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

  return { busy, cancelling, apply, answer, check, skip, download, cancelDownload, askApply, backApply, confirmApply, dismissApplied };
}

export type { TranslationKey };
