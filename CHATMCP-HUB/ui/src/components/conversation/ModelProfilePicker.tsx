import { ChevronDown, Cpu, Users } from 'lucide-react';
import type { HubState } from '@/types';
import { Textarea } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n';

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
