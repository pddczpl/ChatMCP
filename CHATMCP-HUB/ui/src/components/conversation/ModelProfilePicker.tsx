import { Brain, ChevronDown, Cpu, Users } from 'lucide-react';
import type { HubState, Task } from '@/types';
import { Textarea } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { hasTranslation, useTranslation } from '@/lib/i18n';
import { REASONING_AUTO, reasoningChoices, reasoningLabelKey } from '@/lib/reasoning-effort';
import { taskConnection } from '@/lib/task-reasoning';
import { useModelInfo } from '@/lib/useModelInfo';

interface PickerProps {
  hub?: HubState;
  value: string;
  onChange: (profileId: string) => void;
  rolesOpen: boolean;
  onToggleRoles: () => void;
}

/**
 * Which model profile a NEW conversation uses (an existing one keeps its saved profile revision). A compact chip in the
 * composer toolbar; "Role overrides" is a second chip that opens the JSON field.
 */
export function ModelProfilePicker({ hub, value, onChange, rolesOpen, onToggleRoles }: PickerProps) {
  const { t } = useTranslation();
  const profiles = hub?.ai?.profiles || [];
  return (
    <span data-testid="new-task-model-profile" className="flex min-w-0 shrink items-center gap-1">
      <label htmlFor="chatmcp-task-profile" className="relative inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors focus-within:bg-hover hover:bg-hover hover:text-fg">
        <Cpu className="h-3.5 w-3.5" />
        <span className="sr-only">{t('agents_mp_label')}</span>
        <select id="chatmcp-task-profile" aria-label={t('agents_mp_select_label')} value={value} onChange={event => onChange(event.target.value)}
          className="max-w-[9.5rem] cursor-pointer appearance-none truncate bg-transparent pr-4 text-[13px] font-medium text-fg focus:outline-none @[640px]:max-w-52">
          <option value="">{t('agents_mp_default', { what: hub?.ai?.defaultProfileId ? t('agents_mp_saved_profile') : t('agents_mp_gateway') })}</option>
          {profiles.length > 0 && <option value="__global__">{t('agents_mp_global')}</option>}
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name || p.id} · {p.model} {p.isDefault ? t('agents_mp_is_default') : ''}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-faint" />
      </label>
      <button type="button" onClick={onToggleRoles} aria-expanded={rolesOpen} title={t('agents_mp_roles_title')}
        className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors hover:bg-hover', rolesOpen ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}>
        <Users className="h-3.5 w-3.5" />
        <span className="hidden whitespace-nowrap @[720px]:inline">{t('agents_mp_roles')}</span>
        <span className="sr-only @[720px]:hidden">{t('agents_mp_roles')}</span>
      </button>
    </span>
  );
}

interface ReasoningPickerProps {
  hub?: HubState;
  /** The profile chosen for a NEW conversation: '' for the default one, '__global__' for the global connection. An existing conversation passes `task` instead. */
  profileId?: string;
  task?: Task | null;
  /** '' = what is in force (the default shown first), 'auto', or a level. */
  value: string;
  onChange: (effort: string) => void;
}

/**
 * The thinking effort of ONE task, over the one saved with its connection: a chip in the composer toolbar. It offers "Default (what is in force)", Auto and the levels the Hub says
 * the model of the task takes (from its model catalog, GET /api/ai/model-info). It is not there when the model does not think or when there is no connection to ask about.
 */
export function TaskReasoningPicker({ hub, profileId, task = null, value, onChange }: ReasoningPickerProps) {
  const { t } = useTranslation();
  const connection = taskConnection(hub, profileId, task);
  const { data: info } = useModelInfo({ preset: connection?.preset, protocol: connection?.protocol, apiBaseUrl: connection?.apiBaseUrl ?? '', model: connection?.model ?? '' });
  if (!connection || (info && info.reasoning.levels.length === 0)) return null;
  const name = (level: string) => {
    if (level === REASONING_AUTO) return t('agents_tr_auto');
    const key = reasoningLabelKey(level);
    return hasTranslation(key) ? t(key) : level;
  };
  const choices = reasoningChoices(info, value === '' ? REASONING_AUTO : value);
  return (
    <span data-testid="new-task-reasoning" className="flex min-w-0 shrink items-center gap-1">
      <label htmlFor="chatmcp-task-reasoning" title={t('agents_tr_title')} className="relative inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors focus-within:bg-hover hover:bg-hover hover:text-fg">
        <Brain className="h-3.5 w-3.5" />
        <span className="sr-only">{t('agents_tr_label')}</span>
        <select id="chatmcp-task-reasoning" aria-label={t('agents_tr_select_label')} value={value} onChange={event => onChange(event.target.value)}
          className="max-w-[8.5rem] cursor-pointer appearance-none truncate bg-transparent pr-4 text-[13px] font-medium text-fg focus:outline-none @[640px]:max-w-44">
          <option value="">{t('agents_tr_default', { level: name(connection.saved) })}</option>
          {choices.map(choice => (
            <option key={choice.value} value={choice.value}>{choice.offered ? name(choice.value) : t('ai_reasoning_not_offered', { level: name(choice.value) })}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-faint" />
      </label>
    </span>
  );
}

export function RoleOverridesField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5 rounded-xl border border-line bg-panel p-3">
      <label htmlFor="chatmcp-task-role-profiles" className="block text-[13px] font-medium text-fg">{t('agents_mp_roles_label')}</label>
      <Textarea id="chatmcp-task-role-profiles" aria-label={t('agents_mp_roles_field')} rows={2} value={value}
        onChange={event => onChange(event.target.value)} placeholder='{"reviewer":"review-profile","tester":"test-profile"}' className="font-mono text-[12px]" />
      <p className="text-[12px] leading-4 text-faint">{t('agents_mp_roles_help')}</p>
    </div>
  );
}
