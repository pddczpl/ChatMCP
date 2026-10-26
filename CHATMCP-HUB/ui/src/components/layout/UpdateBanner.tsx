import { useQuery } from '@tanstack/react-query';
import { Bell, CircleArrowUp, CircleCheck, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { translate, useTranslation } from '@/lib/i18n';
import { isDesktopShell } from '@/lib/native-apply-update';
import { appliedView, noticeKind, pollInterval, safeNotesUrl } from '@/lib/updates';
import { useUpdateActions } from '@/lib/useUpdateActions';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { DownloadControls, STRIP_IDS, type InstallProps } from './UpdateDownload';
import type { UpdateInfo } from '@/types';

const strip = 'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-primary/30 bg-primary/10 px-4 py-2 text-[13px] text-fg';

/**
 * The strip under the header: first the question the owner is asked once (may DatGold look for a new version by itself?), then a release that is on offer, with "What's new" and
 * "Skip this version", and under them what the owner can do about its installer (Download for a release whose signature checked, the progress with Cancel, "Downloaded and checked" and then, inside the
 * desktop app, "Install and restart", or why there is no button). Presentational (the container below talks to the Hub and to the shell), so that a test can render every state.
 */
export function UpdateNotice({ update, lang: pinned, busy = false, cancelling = false, install, onAnswer, onSkip, onDetails, onDownload, onCancel, onCheck }: {
  update: UpdateInfo | null | undefined; lang?: 'vi' | 'en'; busy?: boolean; cancelling?: boolean; install?: InstallProps;
  onAnswer: (enabled: boolean) => void; onSkip: (version: string) => void; onDetails: () => void;
  onDownload: (version: string) => void; onCancel: () => void; onCheck: () => void;
}) {
  const { lang: current } = useTranslation();
  const lang = pinned ?? current;
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  const kind = noticeKind(update);
  if (!update || kind === 'none') return null;

  if (kind === 'question') {
    return (
      <div role="status" data-testid="update-question" data-kind="question" className={strip}>
        <Bell className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-[16rem] flex-1">
          <p data-testid="update-question-title" className="font-medium">{t('upd_q_title')}</p>
          <p data-testid="update-question-body" className="mt-0.5 text-[12px] leading-5 text-muted">{t('upd_q_body', { version: update.current })}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button data-testid="update-yes" size="sm" variant="primary" disabled={busy} onClick={() => onAnswer(true)}>{t('upd_q_yes')}</Button>
          <Button data-testid="update-no" size="sm" variant="secondary" disabled={busy} onClick={() => onAnswer(false)}>{t('upd_q_no')}</Button>
          <button type="button" data-testid="update-details" onClick={onDetails} className="text-[13px] text-fg underline decoration-fg/40 underline-offset-2 hover:decoration-fg">{t('upd_q_details')}</button>
        </div>
      </div>
    );
  }

  const latest = String(update.latest);
  // The Hub builds the link from the version; the page shows it only when it is exactly the tag page of that release on the project's GitHub.
  const notes = safeNotesUrl(update);
  return (
    <div role="status" aria-atomic="false" data-testid="update-notice" data-kind="available" data-version={latest} className={strip}>
      <CircleArrowUp className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span data-testid="update-notice-text" className="min-w-0 flex-1 font-medium">{t('upd_n_available', { version: latest })}</span>
      {notes && (
        <a data-testid="update-notes" href={notes} target="_blank" rel="noopener noreferrer"
          className="inline-flex h-8 shrink-0 items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-primary transition-colors hover:border-line-strong hover:bg-hover">{t('upd_n_notes')}</a>
      )}
      {/* The desktop app opens this link in the system browser (the shell does that for a release page of the project); the copy button is for a machine that has no browser to open it. */}
      {notes && <span data-testid="update-copy" className="shrink-0"><CopyButton text={notes} label={t('upd_copy_link')} /></span>}
      <Button data-testid="update-skip" size="sm" variant="secondary" disabled={busy} onClick={() => onSkip(latest)}>{t('upd_n_skip')}</Button>
      <div className="basis-full">
        <DownloadControls update={update} lang={lang} busy={busy} cancelling={cancelling} ids={STRIP_IDS} install={install} onDownload={onDownload} onCancel={onCancel} onCheck={onCheck} />
      </div>
    </div>
  );
}

/**
 * What the last update left, under the header, until the owner dismisses it: "Updated to DatGold x.y.z" with "What's new" (the notes of that release, built from the version), or why the update did not go
 * through and which version still runs. The Hub keeps it in memory from the result file of the installer; the words are the page's own, chosen by the code of the reason, and nothing of the file is drawn.
 */
export function AppliedNotice({ update, lang: pinned, busy = false, onDismiss }: {
  update: UpdateInfo | null | undefined; lang?: 'vi' | 'en'; busy?: boolean; onDismiss: () => void;
}) {
  const { lang: current } = useTranslation();
  const lang = pinned ?? current;
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  const view = appliedView(update);
  if (view.kind === 'none') return null;
  const version = String(view.version);
  const dismiss = <Button data-testid="update-applied-dismiss" size="sm" variant="secondary" disabled={busy} onClick={onDismiss}>{t('upd_applied_dismiss')}</Button>;
  const notes = view.notesUrl && (
    <>
      <a data-testid="update-applied-notes" href={view.notesUrl} target="_blank" rel="noopener noreferrer"
        className="inline-flex h-8 shrink-0 items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-primary transition-colors hover:border-line-strong hover:bg-hover">{t('upd_n_notes')}</a>
      <span data-testid="update-applied-copy" className="shrink-0"><CopyButton text={view.notesUrl} label={t('upd_copy_link')} /></span>
    </>
  );
  if (view.kind === 'updated') {
    return (
      <div role="status" data-testid="update-applied" data-kind="updated" data-version={version} className={strip}>
        <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        <span data-testid="update-applied-text" className="min-w-0 flex-1 font-medium">{t('upd_applied_title', { version })}</span>
        {notes}
        {dismiss}
      </div>
    );
  }
  // An update that did not go through: the words of the page for the reason, the version that still runs, and what was done with the files when it matters. Not drawn as a danger: nothing was lost.
  // An update that left the installation in need of recovery: nothing runs behind the marker of the unfinished update, so this is read by a Hub that started again, that is, after the installation was put
  // back by hand. The version that runs is named as for any refusal; if THIS update stopped halfway that is said as something that happened (an earlier one found unfinished needs nothing more than its reason).
  const stoppedHalfway = view.state === 'needs_recovery' && view.reasonKey !== 'upd_applied_reason_pending_recovery';
  const sentences = [
    t('upd_applied_failed_title', { version }),
    t('upd_applied_failed_body', { reason: t(String(view.reasonKey)), current: String(update?.current ?? '') }),
    view.state === 'rolled_back' ? t('upd_applied_state_rolled_back') : '',
    stoppedHalfway ? t('upd_applied_state_needs_recovery') : '',
  ].filter(Boolean);
  return (
    <div role="status" data-testid="update-applied" data-kind="not_updated" data-version={version} className={strip}>
      <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      <span data-testid="update-applied-text" className="min-w-0 flex-1 font-medium">{sentences.join(' ')}</span>
      {dismiss}
    </div>
  );
}

export function UpdateBanner() {
  const openSettings = useAppStore(state => state.openSettings);
  // the page asks faster while a download runs, so that the bar moves
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: query => pollInterval(query.state.data?.update) });
  // `shown`: the strip draws nothing for a release the owner skipped, and a question or a refusal in it must not wait there to come back when the skip is taken back
  const { busy, cancelling, apply, answer, skip, check, download, downloadAgain, cancelDownload, askApply, backApply, confirmApply, dismissApplied } = useUpdateActions({ update: hub?.update, hub, shown: noticeKind(hub?.update) === 'available' });
  // Inside the desktop shell the update that is ready can be installed: the shell is asked (it checks the file again with its own code); the Hub's state is what holds the button back while work runs.
  const install: InstallProps = { shell: isDesktopShell(), hub, phase: apply, onAsk: askApply, onConfirm: confirmApply, onBack: backApply, onAgain: version => void downloadAgain(version) };
  return (
    <>
      <AppliedNotice update={hub?.update} busy={busy} onDismiss={() => void dismissApplied()} />
      <UpdateNotice
        update={hub?.update} busy={busy} cancelling={cancelling} install={install} onAnswer={enabled => void answer(enabled)} onSkip={version => void skip(version)} onDetails={() => openSettings('updates')}
        onDownload={version => void download(version)} onCancel={() => void cancelDownload()} onCheck={() => void check()}
      />
    </>
  );
}
