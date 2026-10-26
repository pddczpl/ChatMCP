import { useEffect, useReducer } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { translate, useTranslation } from '@/lib/i18n';
import { autoView, cooldownMs, downloadView, errorGroup, formatBytes, formatWhen, pollInterval, safeNotesUrl, signatureView, statusKey } from '@/lib/updates';
import { useUpdateActions } from '@/lib/useUpdateActions';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import type { UpdateInfo } from '@/types';
import { DownloadControls, PANEL_IDS } from '@/components/layout/UpdateDownload';
import { SettingsCard, FactRow } from './SettingsCard';

const STATE_OF = { upd_status_unknown: 'unknown', upd_status_uptodate: 'uptodate', upd_status_available: 'available', upd_status_skipped: 'skipped' } as const;
const AUTO_STATE_OF = { upd_auto_unset: 'unset', upd_auto_on: 'on', upd_auto_off: 'off', upd_auto_default_on: 'default-on' } as const;
const POINTS = ['upd_point_request', 'upd_point_when', 'upd_point_only', 'upd_point_now'] as const;
const linkClass = 'inline-flex h-8 items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-primary transition-colors hover:border-line-strong hover:bg-hover';

/**
 * Settings → Updates: the version in use, the newest one DatGold knows of, the last check, "Check now", and the owner's choice about looking by itself. Presentational (the container
 * below talks to the Hub), so that a test can render every state; `now` is the time the cooldown of "Check now" is counted from.
 * Under them, for a release on offer: whether it is signed, the size of its installer and the same download controls as the strip (Download only for a signature that checked). Nothing here
 * installs or runs an installer, and the page says so.
 */
export function UpdatesPanel({ update, lang: pinned, now = Date.now(), busy = false, cancelling = false, onCheck, onSkip, onToggle, onDownload, onCancel }: {
  update: UpdateInfo | null | undefined; lang?: 'vi' | 'en'; now?: number; busy?: boolean; cancelling?: boolean;
  onCheck: () => void; onSkip: (version: string | null) => void; onToggle: (enabled: boolean) => void; onDownload: (version: string) => void; onCancel: () => void;
}) {
  const { lang: current } = useTranslation();
  const lang = pinned ?? current;
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  const info = update ?? null;
  const latest = typeof info?.latest === 'string' ? info.latest : null;
  const available = info?.available === true && latest !== null;
  const skipped = available && info?.skippedVersion === latest;
  const notes = available ? safeNotesUrl(info) : null;
  const status = statusKey(info);
  const wait = Math.ceil(cooldownMs(info, now) / 1000);
  const checking = info?.checking === true;
  const auto = autoView(info);
  const download = downloadView(info);
  const signature = signatureView(info);

  return (
    <div className="space-y-5" data-testid="updates-settings">
      <SettingsCard icon={Download} title={t('upd_title')} description={t('upd_desc')}>
        <dl>
          <FactRow label={t('upd_current')}><span data-testid="updates-current">{info ? `v${info.current}` : '–'}</span></FactRow>
          <FactRow label={t('upd_latest')}><span data-testid="updates-latest">{latest ? `v${latest}` : '–'}</span></FactRow>
          <FactRow label={t('upd_checked')}><span data-testid="updates-checked">{info?.checkedAt ? formatWhen(info.checkedAt, lang) : t('upd_never')}</span></FactRow>
        </dl>
        <p data-testid="updates-status" data-state={STATE_OF[status]} className="text-[13px] font-medium text-fg">{t(status, { version: latest ?? '' })}</p>
        {info?.error && (
          <p data-testid="updates-error" className="text-[13px] leading-5 text-warning">
            {t('upd_err_label')} {t(`upd_err_${errorGroup(info.error.code)}`, { status: info.error.status ?? '' })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button data-testid="updates-check" variant="secondary" size="sm" disabled={busy || checking || wait > 0 || !info} onClick={onCheck}>
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{checking ? t('upd_checking') : t('upd_check_now')}</span>
          </Button>
          {notes && <a data-testid="updates-notes" href={notes} target="_blank" rel="noopener noreferrer" className={linkClass}>{t('upd_n_notes')}</a>}
          {notes && <span data-testid="updates-copy"><CopyButton text={notes} label={t('upd_copy_link')} /></span>}
          {available && !skipped && <Button data-testid="updates-skip" variant="secondary" size="sm" disabled={busy} onClick={() => onSkip(latest)}>{t('upd_n_skip')}</Button>}
          {skipped && <Button data-testid="updates-unskip" variant="secondary" size="sm" disabled={busy} onClick={() => onSkip(null)}>{t('upd_unskip')}</Button>}
        </div>
        {wait > 0 && !checking && <p data-testid="updates-wait" className="text-[12px] leading-5 text-muted">{t('upd_wait', { seconds: wait })}</p>}
      </SettingsCard>

      {download.kind !== 'none' && (
        <SettingsCard icon={Download} title={t('upd_dl_title')} description={t('upd_dl_desc')}>
          <dl>
            <FactRow label={t('upd_sig_label')}><span data-testid="updates-signature" data-signature={signature}>{t(`upd_sig_state_${signature}`, { kid: info?.kid ?? '' })}</span></FactRow>
            <FactRow label={t('upd_size_label')}><span data-testid="updates-size">{formatBytes(download.bytes, lang)}</span></FactRow>
          </dl>
          <DownloadControls update={info} lang={lang} busy={busy} cancelling={cancelling} ids={PANEL_IDS} onDownload={onDownload} onCancel={onCancel} onCheck={onCheck} />
        </SettingsCard>
      )}

      <SettingsCard icon={RefreshCw} title={t('upd_auto_title')} description={t('upd_auto_desc')}>
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" data-testid="updates-auto-toggle" checked={auto.checked} disabled={auto.disabled || busy} onChange={event => onToggle(event.target.checked)} />
          <span className="block text-[13px] font-medium text-fg">{t('upd_auto_label')}</span>
        </label>
        <p data-testid="updates-auto-status" data-state={AUTO_STATE_OF[auto.statusKey]} className="text-[13px] font-medium text-fg">{t(auto.statusKey)}</p>
        <ul data-testid="updates-points" className="list-disc space-y-1 pl-5 text-[12px] leading-5 text-muted">
          {POINTS.map(key => <li key={key}>{t(key, { version: info?.current ?? '' })}</li>)}
        </ul>
      </SettingsCard>
    </div>
  );
}

/** Settings → Updates (the section after Appearance). */
export function UpdatesSection() {
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: query => pollInterval(query.state.data?.update) });
  const { busy, cancelling, answer, check, skip, download, cancelDownload } = useUpdateActions();
  const update = hub?.update;
  // While "Check now" is held back, the seconds left count down: the page paints again once a second. The time they are counted from is read at every paint, never kept, so a page that was
  // asleep (a window that was minimised stops asking the Hub) and then hears of a look made long ago does not count from the time it last painted.
  const [, tick] = useReducer((count: number) => count + 1, 0);
  const now = Date.now();
  const waiting = cooldownMs(update, now) > 0;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  return (
    <UpdatesPanel
      update={update} now={now} busy={busy} cancelling={cancelling} onCheck={() => void check()} onSkip={version => void skip(version)} onToggle={enabled => void answer(enabled)}
      onDownload={version => void download(version)} onCancel={() => void cancelDownload()}
    />
  );
}
