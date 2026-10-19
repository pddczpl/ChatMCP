import { ChevronDown, Cpu, Users } from 'lucide-react';
import type { HubState } from '@/types';
import { Textarea } from '@/components/ui/Input';
import { cn } from '@/lib/utils';

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
  const profiles = hub?.ai?.profiles || [];
  return (
    <span data-testid="new-task-model-profile" className="flex min-w-0 shrink items-center gap-1">
      <label htmlFor="chatmcp-task-profile" className="relative inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors focus-within:bg-hover hover:bg-hover hover:text-fg">
        <Cpu className="h-3.5 w-3.5" />
        <span className="sr-only">Model profile</span>
        <select id="chatmcp-task-profile" aria-label="Task model profile" value={value} onChange={event => onChange(event.target.value)}
          className="max-w-[9.5rem] cursor-pointer appearance-none truncate bg-transparent pr-4 text-[13px] font-medium text-fg focus:outline-none @[640px]:max-w-52">
          <option value="">Mặc định ({hub?.ai?.defaultProfileId ? 'profile đã lưu' : 'gateway'})</option>
          {profiles.length > 0 && <option value="__global__">Global gateway (không dùng profile)</option>}
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name || p.id} · {p.model} {p.isDefault ? '(mặc định)' : ''}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-faint" />
      </label>
      <button type="button" onClick={onToggleRoles} aria-expanded={rolesOpen} title="Chọn model riêng cho từng vai trò subagent"
        className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors hover:bg-hover', rolesOpen ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}>
        <Users className="h-3.5 w-3.5" />
        <span className="hidden whitespace-nowrap @[720px]:inline">Role overrides</span>
        <span className="sr-only @[720px]:hidden">Role overrides</span>
      </button>
    </span>
  );
}

export function RoleOverridesField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1.5 rounded-xl border border-line bg-panel p-3">
      <label htmlFor="chatmcp-task-role-profiles" className="block text-[13px] font-medium text-fg">Vai trò → ID profile đã lưu (JSON, tối đa 12)</label>
      <Textarea id="chatmcp-task-role-profiles" aria-label="Task role model profiles" rows={2} value={value}
        onChange={event => onChange(event.target.value)} placeholder='{"reviewer":"review-profile","tester":"test-profile"}' className="font-mono text-[12px]" />
      <p className="text-[12px] leading-4 text-faint">Profile được chọn khi task bắt đầu. Tên vai trò phải khớp với vai trò của subagent được tạo.</p>
    </div>
  );
}
