import { useQuery } from '@tanstack/react-query';
import { Bot, Cpu, Eye, GitBranch, Link2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { formatNumber } from '@/lib/format';
import { StatusDot, type DotTone } from '@/components/ui/StatusDot';
import { cn } from '@/lib/utils';

/**
 * Ambient state, one line at the bottom: connection, branch, how the agent reaches its model, which model, how much it may
 * do, and the context it has. Each item is real data from the Hub: there are no placeholders for features that do not exist.
 */
export function StatusBar() {
  const { t, lang } = useTranslation();
  const { selectedTaskId, openSettings, setInspectorOpen, setActiveTab } = useAppStore();
  const { data: hub, error } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 2500 });
  const { data: task } = useQuery({
    queryKey: ['task', selectedTaskId],
    queryFn: () => api.getTask(selectedTaskId),
    enabled: !!selectedTaskId,
    refetchInterval: selectedTaskId ? 2000 : false,
  });

  const permissions = hub?.studio?.permissions;
  const isFullAccess = permissions?.executionPolicy === 'full-access';
  const mode = permissions?.mode || 'review';
  const modeInfo = isFullAccess
    ? { label: t('mode_full_access'), icon: ShieldAlert, tone: 'text-danger' }
    : mode === 'readonly' ? { label: t('mode_readonly'), icon: Eye, tone: 'text-muted' }
      : mode === 'autonomous' ? { label: t('mode_autonomous'), icon: Bot, tone: 'text-accent' }
        : { label: t('mode_review'), icon: ShieldCheck, tone: 'text-primary' };
  const ModeIcon = modeInfo.icon;

  const hubTone: DotTone = error ? 'danger' : hub ? 'success' : 'warning';
  const hubLabel = error ? t('hub_lost') : hub ? t('hub_connected') : t('hub_connecting');
  const branch = hub?.workspace?.git?.branch;
  const dirty = hub?.workspace?.git?.dirty;
  const webChannel = hub?.agent?.mode === 'chatgpt-web';
  const companion = hub?.browser;
  const modelName = webChannel ? 'ChatGPT Web' : hub?.ai?.model || t('status_no_model');
  const context = task?.contextPolicy;

  const item = 'inline-flex h-full items-center gap-1.5 px-2 transition-colors';
  const button = cn(item, 'hover:bg-hover hover:text-fg');

  return (
    <footer role="contentinfo" aria-label="Trạng thái" data-testid="status-bar"
      className="flex h-7 shrink-0 select-none items-center justify-between border-t border-line bg-panel px-1 text-[12px] text-muted">
      <div className="flex h-full min-w-0 items-center">
        <span className={item} role="status" title={error?.message}>
          <StatusDot tone={hubTone} pulse={!error && !hub} />
          <span>{hubLabel}</span>
        </span>
        {branch && (
          <span className={cn(item, 'hidden sm:inline-flex')} title={dirty ? 'Có thay đổi chưa commit' : 'Workspace sạch'}>
            <GitBranch className="h-3 w-3" />
            <span className="max-w-40 truncate">{branch}</span>
            {dirty && <span aria-label="Có thay đổi chưa commit" className="h-1.5 w-1.5 rounded-full bg-warning" />}
          </span>
        )}
        {webChannel && (
          <button type="button" className={button} onClick={() => openSettings('agent-channel')}
            title="ChatGPT Web Companion: mở cài đặt kênh agent">
            <Link2 className="h-3 w-3" />
            <span className="hidden md:inline">{companion?.connected ? t('status_companion_connected') : companion?.paired ? t('status_companion_paired') : t('status_companion_missing')}</span>
            <StatusDot tone={companion?.connected ? 'success' : companion?.paired ? 'warning' : 'danger'} />
          </button>
        )}
      </div>
      <div className="flex h-full min-w-0 items-center">
        {context && (
          <button type="button" className={cn(button, 'hidden md:inline-flex')} onClick={() => { setInspectorOpen(true); setActiveTab('activity'); }}
            title={context.source === 'conservative_fallback'
              ? `Chưa biết cửa sổ ngữ cảnh của model: đang lập kế hoạch với ${formatNumber(context.capacityTokens, lang)} token. Đặt kích thước thật trong Cài đặt → Mô hình AI.`
              : `Cửa sổ ngữ cảnh đã cấu hình: ${formatNumber(context.capacityTokens, lang)} token. Lịch sử tối đa ${formatNumber(context.maxHistoryTokens, lang)} token; dành ${formatNumber(context.reservedOutputTokens, lang)} cho đầu ra.`}>
            <span>{t('status_context')}</span>
            <span className="tabular-nums text-fg">{formatNumber(context.capacityTokens, lang)}</span>
            {context.source === 'conservative_fallback' && <span className="text-warning">~</span>}
          </button>
        )}
        <button type="button" className={cn(button, 'max-w-[220px]')} onClick={() => openSettings('model')} title={`${t('status_model')}: ${modelName}`}>
          <Cpu className="h-3 w-3" />
          <span className="truncate">{modelName}</span>
        </button>
        <button type="button" className={cn(button, modeInfo.tone)} onClick={() => openSettings('permissions')} title={`${t('status_mode')}: ${modeInfo.label}`}>
          <ModeIcon className="h-3 w-3" />
          <span className="font-medium">{modeInfo.label}</span>
        </button>
        {hub?.version && <span className={cn(item, 'hidden text-faint lg:inline-flex')}>v{hub.version}</span>}
      </div>
    </footer>
  );
}
