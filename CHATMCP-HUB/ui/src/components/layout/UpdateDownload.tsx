import { CircleCheck, Download, RotateCw, TriangleAlert } from 'lucide-react';
import { translate } from '@/lib/i18n';
import { applyView, downloadView, formatBytes, type ApplyPhase, type ApplyView, type DownloadView, type Lang } from '@/lib/updates';
import { Button } from '@/components/ui/Button';
import type { UpdateInfo } from '@/types';

/** The test ids of one place that shows the download (the strip under the header and Settings → Updates show the same controls under different ids). */
export interface DownloadIds {
  download: string; progress: string; progressText: string; cancel: string; verifying: string; ready: string; readyNote: string; error: string; signatureNote: string; recheck: string;
  apply: string; applyBrowser: string; applyBlocked: string; confirm: string; confirmText: string; confirmYes: string; confirmNo: string; applying: string; applyError: string;
}
export const STRIP_IDS: DownloadIds = {
  download: 'update-download', progress: 'update-download-progress', progressText: 'update-download-progress-text', cancel: 'update-cancel', verifying: 'update-download-verifying',
  ready: 'update-download-ready', readyNote: 'update-download-ready-note', error: 'update-download-error', signatureNote: 'update-signature-note', recheck: 'update-recheck',
  apply: 'update-apply', applyBrowser: 'update-apply-browser', applyBlocked: 'update-apply-blocked', confirm: 'update-apply-confirm', confirmText: 'update-apply-confirm-text',
  confirmYes: 'update-apply-yes', confirmNo: 'update-apply-no', applying: 'update-apply-sending', applyError: 'update-apply-error',
};
export const PANEL_IDS: DownloadIds = {
  download: 'updates-download', progress: 'updates-download-progress', progressText: 'updates-download-progress-text', cancel: 'updates-cancel', verifying: 'updates-download-verifying',
  ready: 'updates-download-ready', readyNote: 'updates-download-ready-note', error: 'updates-download-error', signatureNote: 'updates-signature-note', recheck: 'updates-recheck',
  apply: 'updates-apply', applyBrowser: 'updates-apply-browser', applyBlocked: 'updates-apply-blocked', confirm: 'updates-apply-confirm', confirmText: 'updates-apply-confirm-text',
  confirmYes: 'updates-apply-yes', confirmNo: 'updates-apply-no', applying: 'updates-apply-sending', applyError: 'updates-apply-error',
};

/**
 * What the page knows about installing the update that is ready, handed down from the container: whether this page runs inside the desktop shell (the only place the shell can be asked), the state of the
 * Hub (to hold the button back while work runs), the step of the owner's click, and what each step does. Without it the page behaves as in a plain browser.
 */
export interface InstallProps {
  shell: boolean;
  hub: unknown;
  phase: ApplyPhase;
  onAsk: () => void;
  onConfirm: () => void | Promise<void>;
  onBack: () => void;
}

/**
 * What the owner can do about the installer of the release on offer, and what the Hub has done: a Download button (only for a release whose signature checked and that names one installer), the
 * progress with Cancel, the checking of the file, "Downloaded and checked" and, for a download that is ready, what can be done with it: in the desktop app the button "Install and restart" (held back, with the
 * reason, while work runs; a question that says the app closes and opens again before anything starts; the shell's refusal in words), and in a plain browser where it can be done. Presentational: the containers
 * talk to the Hub and to the shell. `busy` holds back the buttons that start something while a request is out; Cancel waits only for a Cancel of its own (`cancelling`), because the Hub already reports a
 * download that is still being looked at, and the person who started it must be able to stop it.
 */
export function DownloadControls({ update, lang, busy = false, cancelling = false, ids, install, onDownload, onCancel, onCheck }: {
  update: UpdateInfo | null | undefined; lang: Lang; busy?: boolean; cancelling?: boolean; ids: DownloadIds; install?: InstallProps;
  onDownload: (version: string) => void; onCancel: () => void; onCheck: () => void;
}) {
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  const view = downloadView(update);
  const version = view.version ?? '';
  const size = formatBytes(view.bytes, lang);
  const downloadButton = (
    <Button data-testid={ids.download} size="sm" variant="primary" disabled={busy} onClick={() => onDownload(version)}>
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{view.bytes === null ? t('upd_n_download_plain') : t('upd_n_download', { size })}</span>
    </Button>
  );
  const cancelButton = <Button data-testid={ids.cancel} size="sm" variant="secondary" disabled={cancelling} onClick={onCancel}>{t('upd_dl_cancel')}</Button>;
  /** Why there is no Download button: the signature (it is missing, does not check, was not read) or the manifest (it names no single installer). */
  const why = (current: DownloadView) => (
    <p data-testid={ids.signatureNote} data-signature={current.signature} data-reason={current.reason ?? ''} className="min-w-[12rem] flex-1 text-[12px] leading-5 text-muted">
      {t(current.reason === 'installer' ? 'upd_dl_no_installer' : `upd_sig_${current.signature}`)}
    </p>
  );

  switch (view.kind) {
    case 'none':
      return null;
    case 'offer':
      return downloadButton;
    case 'progress': {
      const words = view.percent === null ? t('upd_dl_preparing') : t('upd_dl_progress', { percent: view.percent, received: formatBytes(view.received, lang), total: formatBytes(view.total, lang) });
      // not a live region of its own: it changes at every poll, and the strip around it must not read each change out (what is announced is the state that follows: ready, or the failure)
      return (
        <div className="flex w-full flex-wrap items-center gap-3" aria-live="off">
          <div className="min-w-[12rem] flex-1">
            <div
              role="progressbar" aria-valuemin={0} aria-valuemax={100} {...(view.percent === null ? {} : { 'aria-valuenow': view.percent })} aria-label={words} data-testid={ids.progress}
              className="h-1.5 w-full overflow-hidden rounded-full bg-line"
            >
              {/* where the size is not known yet a faint full bar that pulses; with reduced motion it stays still and is not a part of a bar that would read as a number */}
              <div className={`h-full rounded-full ${view.percent === null ? 'w-full bg-primary/40 animate-pulse' : 'bg-primary'}`} style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
            </div>
            <p data-testid={ids.progressText} className="mt-1 text-[12px] leading-5 text-muted">{words}</p>
          </div>
          {cancelButton}
        </div>
      );
    }
    case 'verifying':
      return (
        <div className="flex w-full flex-wrap items-center gap-3">
          <p data-testid={ids.verifying} className="min-w-[12rem] flex-1 text-[13px] leading-5 text-fg">{t('upd_dl_verifying')}</p>
          {cancelButton}
        </div>
      );
    case 'ready':
      return (
        <div className="flex w-full flex-col gap-2">
          <div className="flex w-full items-start gap-2">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            <div className="min-w-0">
              <p data-testid={ids.ready} className="text-[13px] font-medium text-fg">{t('upd_dl_ready')}</p>
              <p data-testid={ids.readyNote} className="mt-0.5 text-[12px] leading-5 text-muted">{t('upd_dl_ready_note', { version, size: formatBytes(view.bytes, lang) })}</p>
            </div>
          </div>
          <InstallControls view={applyView(update, install?.hub, install?.shell ?? false, install?.phase ?? { phase: 'idle' })} ids={ids} t={t} busy={busy} install={install} version={version} />
        </div>
      );
    case 'failed':
      // the words are in the colour of the text (amber text on the strip does not reach 4.5:1 in the light theme); the amber is the icon's
      return (
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-[12rem] flex-1 items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <p data-testid={ids.error} className="text-[13px] leading-5 text-fg">{t('upd_dl_err_label')} {t(`upd_dl_err_${view.group ?? 'other'}`)}</p>
          </div>
          {view.canDownload ? downloadButton : why(view)}
        </div>
      );
    case 'blocked': {
      // a signature that was not read, or not looked at yet, can be looked at again; one that is missing or does not check, or a manifest with no single installer, cannot be changed by looking
      const again = view.reason === 'signature' && (view.signature === 'unreadable' || view.signature === 'unchecked');
      return (
        <div className="flex w-full flex-wrap items-center gap-3">
          {why(view)}
          {again && <Button data-testid={ids.recheck} size="sm" variant="secondary" disabled={busy} onClick={onCheck}>{t('upd_check_now')}</Button>}
        </div>
      );
    }
    default:
      return null;
  }
}

/**
 * Installing the download that is ready. In a plain browser there is nothing to press and the page says where it can be done. In the desktop shell: the button; the same button held back, with its reason tied to
 * it, while work runs; a question that says the app closes and opens again (the shell, not the Hub, then checks the file again and starts the installer); the wait; and a refusal of the shell in words with the
 * button back. A refusal is not drawn as a danger and nothing in it is the text of an exception: the page chooses its own words by the shell's code.
 */
function InstallControls({ view, ids, t, busy, install, version }: {
  view: ApplyView; ids: DownloadIds; t: (key: string, params?: Record<string, string | number>) => string; busy: boolean; install?: InstallProps; version: string;
}) {
  const button = (disabled: boolean, describedBy?: string) => (
    <Button data-testid={ids.apply} size="sm" variant="primary" disabled={disabled} aria-describedby={describedBy} onClick={install?.onAsk}>
      <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{t('upd_apply_button')}</span>
    </Button>
  );
  switch (view.kind) {
    case 'hidden':
      return null;
    case 'browser':
      return <p data-testid={ids.applyBrowser} className="text-[12px] leading-5 text-muted">{t('upd_apply_browser')}</p>;
    case 'offer':
      return <div>{button(busy)}</div>;
    case 'blocked':
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {button(true, ids.applyBlocked)}
          <p id={ids.applyBlocked} data-testid={ids.applyBlocked} className="min-w-[12rem] flex-1 text-[12px] leading-5 text-muted">{t('upd_apply_blocked')}</p>
        </div>
      );
    case 'confirm':
      return (
        <div data-testid={ids.confirm} role="group" aria-labelledby={ids.confirmText} className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p id={ids.confirmText} data-testid={ids.confirmText} className="min-w-[12rem] flex-1 text-[13px] leading-5 text-fg">{t('upd_apply_confirm', { version })}</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button data-testid={ids.confirmYes} size="sm" variant="primary" onClick={() => void install?.onConfirm()}>{t('upd_apply_confirm_yes')}</Button>
            <Button data-testid={ids.confirmNo} size="sm" variant="secondary" autoFocus onClick={install?.onBack}>{t('upd_apply_confirm_no')}</Button>
          </div>
        </div>
      );
    case 'sending':
      return <p data-testid={ids.applying} role="status" className="text-[13px] leading-5 text-fg">{t('upd_apply_sending')}</p>;
    case 'refused':
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-[12rem] flex-1 items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <p data-testid={ids.applyError} className="text-[13px] leading-5 text-fg">{t('upd_apply_err_label')} {t(`upd_apply_err_${view.group ?? 'other'}`)}</p>
          </div>
          {button(busy)}
        </div>
      );
    default:
      return null;
  }
}
