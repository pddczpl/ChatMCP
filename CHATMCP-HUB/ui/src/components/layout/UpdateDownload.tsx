import { CircleCheck, Download, TriangleAlert } from 'lucide-react';
import { translate } from '@/lib/i18n';
import { downloadView, formatBytes, type DownloadView, type Lang } from '@/lib/updates';
import { Button } from '@/components/ui/Button';
import type { UpdateInfo } from '@/types';

/** The test ids of one place that shows the download (the strip under the header and Settings → Updates show the same controls under different ids). */
export interface DownloadIds {
  download: string; progress: string; progressText: string; cancel: string; verifying: string; ready: string; readyNote: string; error: string; signatureNote: string; recheck: string;
}
export const STRIP_IDS: DownloadIds = {
  download: 'update-download', progress: 'update-download-progress', progressText: 'update-download-progress-text', cancel: 'update-cancel', verifying: 'update-download-verifying',
  ready: 'update-download-ready', readyNote: 'update-download-ready-note', error: 'update-download-error', signatureNote: 'update-signature-note', recheck: 'update-recheck',
};
export const PANEL_IDS: DownloadIds = {
  download: 'updates-download', progress: 'updates-download-progress', progressText: 'updates-download-progress-text', cancel: 'updates-cancel', verifying: 'updates-download-verifying',
  ready: 'updates-download-ready', readyNote: 'updates-download-ready-note', error: 'updates-download-error', signatureNote: 'updates-signature-note', recheck: 'updates-recheck',
};

/**
 * What the owner can do about the installer of the release on offer, and what the Hub has done: a Download button (only for a release whose signature checked and that names one installer), the
 * progress with Cancel, the checking of the file, "Downloaded and checked", a failure in words, or why there is no button (the release is not signed, the signature does not check, it could not be
 * read, its manifest names no single installer). Presentational: the containers talk to the Hub. There is no way to install here, and none is drawn: installing is not something this version of the app does.
 * `busy` holds back the buttons that start something while a request is out; Cancel waits only for a Cancel of its own (`cancelling`), because the Hub already reports a download that is still being
 * looked at, and the person who started it must be able to stop it.
 */
export function DownloadControls({ update, lang, busy = false, cancelling = false, ids, onDownload, onCancel, onCheck }: {
  update: UpdateInfo | null | undefined; lang: Lang; busy?: boolean; cancelling?: boolean; ids: DownloadIds;
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
        <div className="flex w-full items-start gap-2">
          <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          <div className="min-w-0">
            <p data-testid={ids.ready} className="text-[13px] font-medium text-fg">{t('upd_dl_ready')}</p>
            <p data-testid={ids.readyNote} className="mt-0.5 text-[12px] leading-5 text-muted">{t('upd_dl_ready_note', { version, size: formatBytes(view.bytes, lang) })}</p>
          </div>
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
