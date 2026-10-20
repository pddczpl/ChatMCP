import { useQuery } from '@tanstack/react-query';
import { Bot, Eye, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SettingsCard, FactRow } from './SettingsCard';

const MODE_ICONS = { readonly: Eye, review: ShieldCheck, autonomous: Bot, 'full-access': ShieldAlert } as const;

/** What the agent may do without asking, and what it runs on. */
export function PermissionsSection() {
  const { showToast, setFullAccessModalOpen } = useAppStore();
  const { t, lang } = useTranslation();
  const { data: hub, refetch } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const { data: sandboxStatus, isLoading: isSandboxLoading } = useQuery({
    queryKey: ['sandboxStatus'],
    queryFn: api.getSandboxStatus,
    refetchInterval: 5000,
  });
  const permissions: any = hub?.studio?.permissions || {};
  const currentMode = permissions.mode || 'review';
  const isFullAccess = permissions.executionPolicy === 'full-access';

  const handleModeChange = async (mode: string) => {
    if (mode === 'full-access') {
      setFullAccessModalOpen(true);
      return;
    }
    try {
      await api.setPermissions({ mode, ...(isFullAccess ? { executionPolicy: 'host-review' } : {}) });
      showToast(`Đã đổi quyền sang ${mode}`, 'info');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi cập nhật quyền', 'error');
    }
  };

  const badge = isSandboxLoading
    ? { text: t('sandbox_probing'), tone: 'border-primary/30 bg-primary/10 text-primary' }
    : !sandboxStatus?.available
      ? { text: lang === 'vi' ? 'Không khả dụng' : 'Unavailable', tone: 'border-danger/30 bg-danger/10 text-danger' }
      : sandboxStatus?.osIsolated
        ? { text: t('sandbox_isolated'), tone: 'border-success/30 bg-success/10 text-success' }
        : { text: t('sandbox_unisolated'), tone: 'border-warning/30 bg-warning/10 text-warning' };

  return (
    <div className="space-y-5">
      <SettingsCard icon={ShieldCheck} title={t('agent_exec_mode')} description="Chọn mức agent được tự làm. Việc nguy hiểm luôn hỏi lại, ở mọi chế độ.">
        <div className="space-y-2" role="group" aria-label={t('agent_exec_mode')}>
          {[
            { id: 'readonly', label: t('perm_read_only'), desc: t('perm_read_only_desc') },
            { id: 'review', label: t('perm_review'), desc: t('perm_review_desc') },
            { id: 'autonomous', label: t('perm_auto'), desc: t('perm_auto_desc') },
            { id: 'full-access', label: t('perm_full_access'), desc: t('perm_full_access_desc') },
          ].map((m) => {
            const isSelected = m.id === 'full-access' ? isFullAccess : currentMode === m.id && !isFullAccess;
            const Icon = MODE_ICONS[m.id as keyof typeof MODE_ICONS];
            const danger = m.id === 'full-access';
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => handleModeChange(m.id)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors',
                  isSelected
                    ? danger ? 'border-danger bg-danger/10' : 'border-primary bg-primary/10'
                    : 'border-line bg-surface hover:border-line-strong hover:bg-hover',
                )}
              >
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', danger ? 'text-danger' : isSelected ? 'text-primary' : 'text-muted')} />
                <span className="min-w-0">
                  <span className={cn('block text-[13px] font-semibold', isSelected && (danger ? 'text-danger' : 'text-primary'))}>{m.label}</span>
                  <span className="mt-0.5 block text-[12px] leading-4 text-muted">{m.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        data-testid="execution-backend-card"
        icon={Shield}
        title={t('sandbox_title')}
        description={t('sandbox_desc')}
        action={
          <span data-testid="backend-status-badge" className={cn('inline-flex rounded-full border px-2.5 py-0.5 text-[12px] font-semibold', badge.tone)}>
            {badge.text}
          </span>
        }
      >
        <dl>
          <FactRow label={t('sandbox_backend')}>{sandboxStatus?.backend || 'host'} ({sandboxStatus?.platform || 'local'})</FactRow>
          <FactRow label={t('sandbox_os_isolation')} tone={sandboxStatus?.osIsolated ? 'success' : 'warning'}>
            {sandboxStatus?.osIsolated ? t('sandbox_isolation_active') : t('sandbox_isolation_none')}
          </FactRow>
          <FactRow label={t('sandbox_enforced')} tone="success">
            {sandboxStatus?.enforcedLimits?.join(', ') || 'timeoutSeconds, maxOutputBytes'}
          </FactRow>
          <FactRow label={t('sandbox_unsupported')} tone="warning">
            {sandboxStatus?.unsupportedLimits?.join(', ') || 'maxMemoryMb, maxCpuCores'} ({t('sandbox_unenforced_hint')})
          </FactRow>
        </dl>
        {sandboxStatus?.reasons && sandboxStatus.reasons.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-warning/30 bg-warning/10 p-3 text-[12px] leading-4 text-warning">
            {sandboxStatus.reasons.map((r: string, idx: number) => <li key={idx}>• {r}</li>)}
          </ul>
        )}
      </SettingsCard>
    </div>
  );
}
