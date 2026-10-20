import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { translations, useTranslation, type TranslationKey } from '@/lib/i18n';
import { describeSwitch } from '@/lib/project-instructions';
import type { ProjectInstructionsSetting } from '@/types';
import { SettingsCard } from './SettingsCard';

/**
 * The switch itself: what applies, who decided, and what the setting does and does not do. Presentational (the container below talks to the Hub), so that a test can
 * render every state. `running`: a task is going; the change still applies, from the next run.
 */
export function ProjectInstructionsPanel({ setting, busy = false, running = false, onChange, lang: pinned }: {
  setting: ProjectInstructionsSetting | null | undefined; busy?: boolean; running?: boolean; onChange: (enabled: boolean) => void;
  /** Pins the language for a caller that has none from the app (tests); the app's language is the default. */
  lang?: 'vi' | 'en';
}) {
  const { lang: current } = useTranslation();
  const lang = pinned ?? current;
  const t = (key: TranslationKey): string => (translations[lang] as Record<string, string>)[key] ?? translations.vi[key];
  const view = describeSwitch(setting);
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4" data-testid="project-instructions-settings">
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" data-testid="project-instructions-toggle"
          checked={view.checked} disabled={view.disabled || busy} onChange={event => onChange(event.target.checked)} />
        <span>
          <span className="block text-[13px] font-medium text-fg">{t('pi_label')}</span>
          <span className="mt-0.5 block font-mono text-[12px] leading-4 text-muted">{(setting?.files ?? []).join(' · ')}</span>
        </span>
      </label>
      <p data-testid="project-instructions-status" data-source={setting?.source ?? 'unknown'} className="text-[13px] font-medium text-fg">
        {t(view.statusKey)}{view.locked && setting ? <> <code className="text-[12px]">{setting.variable}</code></> : null}
      </p>
      {view.locked && (
        <p data-testid="project-instructions-locked" className="text-[12px] leading-5 text-muted">
          {t('pi_locked')}{view.hiddenChoice !== null ? ` ${t(view.hiddenChoice ? 'pi_saved_on' : 'pi_saved_off')}` : ''}
        </p>
      )}
      {running && !view.locked && <p data-testid="project-instructions-running" className="text-[12px] leading-5 text-muted">{t('pi_running')}</p>}
      <ul className="list-disc space-y-1 pl-5 text-[12px] leading-5 text-muted">
        <li>{t('pi_point_untrusted')}</li>
        <li>{t('pi_point_off')}</li>
        <li>{t('pi_point_next')}</li>
        <li>{t('pi_point_scope')}</li>
      </ul>
    </div>
  );
}

/** Settings → Dự án: the owner's switch for the project's AGENTS.md / CLAUDE.md. */
export function ProjectInstructionsCard() {
  const { showToast } = useAppStore();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const [busy, setBusy] = useState(false);

  const change = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setProjectInstructions(enabled);
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast(t(enabled ? 'pi_toast_on' : 'pi_toast_off'), 'success');
    } catch (error: any) {
      showToast(error.message || t('pi_error'), 'error');
    } finally { setBusy(false); }
  };

  return (
    <SettingsCard icon={FileText} title={t('pi_title')} description={t('pi_desc')}>
      <ProjectInstructionsPanel setting={hub?.projectInstructions} busy={busy} running={Boolean(hub?.agent?.activeTaskId)} onChange={enabled => void change(enabled)} />
    </SettingsCard>
  );
}
