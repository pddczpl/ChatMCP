import { CircleCheck, Download } from 'lucide-react';
import { translate } from '@/lib/i18n';
import { downloadView, formatBytes, type Lang } from '@/lib/updates';
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
 * What the owner can do about the installer of the release on offer, and what the Hub has done: a Download button (only for a release whose signature checked), the progress with Cancel, the
 * checking of the file, "Downloaded and checked", a failure in words, or why there is no button (the release is not signed, the signature does not check, it could not be read). Presentational: the
 * containers talk to the Hub. There is no way to install here, and none is drawn: installing is not something this version of the app does.
 */
export function DownloadControls({ update, lang, busy = false, ids, onDownload, onCancel, onCheck }: {
  update: UpdateInfo | null | undefined; lang: Lang; busy?: boolean; ids: DownloadIds;
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

  switch (view.kind) {
    case 'none':
      return null;
    case 'offer':
      return downloadButton;
    case 'progress': {
      const words = view.percent === null ? t('upd_dl_preparing') : t('upd_dl_progress', { percent: view.percent, received: formatBytes(view.received, lang), total: formatBytes(view.total, lang) });
      return (
        <div className="flex w-full flex-wrap items-center gap-3">
          <div className="min-w-[12rem] flex-1">
            <div
              role="progressbar" aria-valuemin={0} aria-valuemax={100} {...(view.percent === null ? {} : { 'aria-valuenow': view.percent })} aria-label={words} data-testid={ids.progress}
              className="h-1.5 w-full overflow-hidden rounded-full bg-line"
            >
              <div className={`h-full rounded-full bg-primary ${view.percent === null ? 'w-1/3 animate-pulse' : ''}`} style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
            </div>
            <p data-testid={ids.progressText} className="mt-1 text-[12px] leading-5 text-muted">{words}</p>
          </div>
          <Button data-testid={ids.cancel} size="sm" variant="secondary" disabled={busy} onClick={onCancel}>{t('upd_dl_cancel')}</Button>
        </div>
      );
    }
    case 'verifying':
      return (
        <div className="flex w-full flex-wrap items-center gap-3">
          <p data-testid={ids.verifying} className="min-w-[12rem] flex-1 text-[13px] leading-5 text-fg">{t('upd_dl_verifying')}</p>
          <Button data-testid={ids.cancel} size="sm" variant="secondary" disabled={busy} onClick={onCancel}>{t('upd_dl_cancel')}</Button>
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
      return (
        <div className="flex w-full flex-wrap items-center gap-3">
          <p data-testid={ids.error} className="min-w-[12rem] flex-1 text-[13px] leading-5 text-warning">{t('upd_dl_err_label')} {t(`upd_dl_err_${view.group ?? 'other'}`)}</p>
          {view.canDownload && downloadButton}
        </div>
      );
    case 'blocked': {
      // a signature that was not read, or not looked at yet, can be looked at again; one that is missing or does not check cannot be changed by looking
      const again = view.signature === 'unreadable' || view.signature === 'unchecked';
      return (
        <div className="flex w-full flex-wrap items-center gap-3">
          <p data-testid={ids.signatureNote} data-signature={view.signature} className="min-w-[12rem] flex-1 text-[12px] leading-5 text-muted">{t(`upd_sig_${view.signature}`)}</p>
          {again && <Button data-testid={ids.recheck} size="sm" variant="secondary" disabled={busy} onClick={onCheck}>{t('upd_check_now')}</Button>}
        </div>
      );
    }
    default:
      return null;
  }
}
