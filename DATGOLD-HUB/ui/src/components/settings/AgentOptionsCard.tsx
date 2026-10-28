import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { translations, useTranslation, type TranslationKey } from '@/lib/i18n';
import { describeOptions, parsePercent } from '@/lib/agent-options';
import type { AgentOptions } from '@/types';
import { SettingsCard } from './SettingsCard';

const fill = (text: string, values: Record<string, string | number> = {}) => text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));

/**
 * The owner's two agent options: the percent from which the history is compacted, and whether the Hub accepts the checks it ran. Presentational (the container below talks to the
 * Hub), so that a test can render every state. The second one RELAXES "only the owner accepts", so its warning is always on the page next to the switch, never behind a click.
 */
export function AgentOptionsPanel({ options, busy = false, running = false, onPercent, onAutoAccept, lang: pinned }: {
  options: AgentOptions | null | undefined; busy?: boolean; running?: boolean;
  /** `null` goes back to the default. */
  onPercent: (percent: number | null) => void; onAutoAccept: (enabled: boolean) => void;
  /** Pins the language for a caller that has none from the app (tests); the app's language is the default. */
  lang?: 'vi' | 'en';
}) {
  const { lang: current } = useTranslation();
  const lang = pinned ?? current;
  const t = (key: TranslationKey, values?: Record<string, string | number>): string => fill((translations[lang] as Record<string, string>)[key] ?? (translations.vi as Record<string, string>)[key], values);
  const view = describeOptions(options);
  // What the owner types; it follows the Hub when the Hub's answer changes (a save, a reset, another tab).
  const [draft, setDraft] = useState(String(view.percent));
  useEffect(() => { setDraft(String(view.percent)); }, [view.percent]);
  const parsed = parsePercent(draft, { minCompactPercent: view.min, maxCompactPercent: view.max });
  const invalid = draft.trim() !== '' && parsed === null;
  const canSave = view.known && !busy && parsed !== null && parsed !== view.percent;
  return (
    <div className="space-y-5 rounded-xl border border-line bg-surface p-4" data-testid="agent-options-settings">
      <section className="space-y-2" data-testid="agent-options-compaction">
        <label className="block text-[13px] font-medium text-fg" htmlFor="agent-options-percent">{t('ao_percent_label')}</label>
        <div className="flex flex-wrap items-center gap-2">
          <input id="agent-options-percent" type="number" inputMode="numeric" min={view.min} max={view.max} step={1} value={draft} disabled={!view.known || busy}
            data-testid="agent-options-percent" aria-label={t('ao_percent_aria')} onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && canSave && parsed !== null) onPercent(parsed); }}
            className="w-24 rounded-lg border border-line bg-surface p-1.5 text-[13px]" />
          <span className="text-[13px] text-muted">%</span>
          <button type="button" data-testid="agent-options-percent-save" disabled={!canSave} onClick={() => { if (parsed !== null) onPercent(parsed); }}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-hover disabled:opacity-40">{t('ao_percent_save')}</button>
          <button type="button" data-testid="agent-options-percent-reset" disabled={!view.canReset || busy} onClick={() => onPercent(null)}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-hover disabled:opacity-40">{t('ao_percent_reset', { percent: view.defaultPercent })}</button>
        </div>
        {invalid && <p data-testid="agent-options-percent-invalid" role="alert" className="text-[12px] leading-5 text-danger">{t('ao_percent_invalid', { min: view.min, max: view.max })}</p>}
        <p data-testid="agent-options-percent-status" data-saved={view.canReset ? 'true' : 'false'} className="text-[13px] font-medium text-fg">{t(view.statusKey, { percent: view.percent })}</p>
        <ul className="list-disc space-y-1 pl-5 text-[12px] leading-5 text-muted">
          <li>{t('ao_percent_point_what')}</li>
          <li>{t('ao_percent_point_check')}</li>
          <li>{t('ao_percent_point_limit')}</li>
        </ul>
      </section>

      <section className="space-y-2 border-t border-line-subtle pt-4" data-testid="agent-options-acceptance">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" data-testid="agent-options-auto-accept" checked={view.autoAccept} disabled={!view.known || busy}
            onChange={event => onAutoAccept(event.target.checked)} />
          <span className="block text-[13px] font-medium text-fg">{t('ao_accept_label')}</span>
        </label>
        <p data-testid="agent-options-auto-accept-status" data-on={view.autoAccept ? 'true' : 'false'} className="text-[13px] font-medium text-fg">{t(view.autoAccept ? 'ao_accept_status_on' : 'ao_accept_status_off')}</p>
        <div data-testid="agent-options-auto-accept-warning" className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[12px] leading-5 text-fg">
          <p className="font-semibold">{t('ao_accept_warning')}</p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>{t('ao_accept_point_what')}</li>
            <li>{t('ao_accept_point_keeps')}</li>
            <li>{t('ao_accept_point_limit')}</li>
          </ul>
        </div>
      </section>
      {running && <p data-testid="agent-options-running" className="text-[12px] leading-5 text-muted">{t('ao_running')}</p>}
    </div>
  );
}

/** Settings → Dự án: the owner's two agent options. */
export function AgentOptionsCard() {
  const { showToast } = useAppStore();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const [busy, setBusy] = useState(false);

  const change = async (patch: { autoCompactPercent?: number | null; autoAcceptChecks?: boolean }, toast: () => string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setAgentOptions(patch);
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast(toast(), 'success');
    } catch (error: any) {
      showToast(error.message || t('ao_error'), 'error');
    } finally { setBusy(false); }
  };
  const defaultPercent = hub?.agentOptions?.defaultCompactPercent ?? 80;

  return (
    <SettingsCard icon={SlidersHorizontal} title={t('ao_title')} description={t('ao_desc')}>
      <AgentOptionsPanel options={hub?.agentOptions} busy={busy} running={Boolean(hub?.agent?.activeTaskId)}
        onPercent={percent => void change({ autoCompactPercent: percent }, () => (percent === null ? t('ao_toast_reset', { percent: defaultPercent }) : t('ao_toast_percent', { percent })))}
        onAutoAccept={enabled => void change({ autoAcceptChecks: enabled }, () => t(enabled ? 'ao_toast_accept_on' : 'ao_toast_accept_off'))} />
    </SettingsCard>
  );
}
