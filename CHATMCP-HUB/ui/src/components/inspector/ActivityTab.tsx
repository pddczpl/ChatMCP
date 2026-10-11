import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Activity, Clock, CheckCircle2, AlertCircle, FileEdit, Terminal } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';

export function ActivityTab() {
  const { t } = useTranslation();
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 2500 });
  const activities = hub?.activity || hub?.auditLogs || [];

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-2 select-none text-xs">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--line-subtle)] text-[var(--muted)]">
        <span className="font-semibold uppercase tracking-wider text-[10px]">{t('activity_title')}</span>
        <span className="text-[10px] font-mono">{activities.length} {t('activity_events')}</span>
      </div>

      {activities.length === 0 ? (
        <div className="py-12 text-center text-[var(--faint)] flex flex-col items-center gap-2">
          <Activity className="w-8 h-8 opacity-40" />
          <p className="text-xs">{t('activity_empty')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {activities.map((act: any, idx: number) => {
            const isError = act.level === 'error' || act.status === 'failed';
            const isTool = !!act.tool || act.type === 'tool';
            const timeStr = act.timestamp ? new Date(act.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

            return (
              <div
                key={idx}
                className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--line-subtle)] flex items-start gap-2.5 transition-colors"
              >
                <div className="mt-0.5">
                  {isError ? (
                    <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
                  ) : isTool ? (
                    <Terminal className="w-3.5 h-3.5 text-sky-400" />
                  ) : (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-[var(--text)] truncate">
                      {act.title || act.action || act.tool || 'Action'}
                    </span>
                    {timeStr && (
                      <span className="font-mono text-[10px] text-[var(--faint)] flex-shrink-0">
                        {timeStr}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-[var(--muted)] mt-0.5 line-clamp-2">
                    {act.details || act.message || JSON.stringify(act.params || '')}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
