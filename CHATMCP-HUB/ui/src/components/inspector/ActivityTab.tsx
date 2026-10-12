import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Activity, AlertCircle, Terminal } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';

export function ActivityTab() {
  const { t, lang } = useTranslation();
  const { selectedTaskId } = useAppStore();
  const taskQuery = useQuery({ queryKey: ['task', selectedTaskId], queryFn: () => api.getTask(selectedTaskId), enabled: Boolean(selectedTaskId), refetchInterval: 2500 });
  const hubQuery = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 2500 });
  const activities = taskQuery.data?.events ?? [];
  const error = selectedTaskId ? taskQuery.error : hubQuery.error;
  const isLoading = selectedTaskId ? taskQuery.isLoading : hubQuery.isLoading;
  const logs = hubQuery.data?.logs ?? [];

  return (
    <section aria-label="Task activity" className="h-full flex flex-col p-3 overflow-y-auto space-y-2 text-xs">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--line-subtle)] text-[var(--muted)]">
        <span className="font-semibold uppercase tracking-wider text-[10px]">{t('activity_title')}{!selectedTaskId && ' · Hub'}</span>
        <span className="text-[10px] font-mono">{selectedTaskId ? activities.length : logs.length} {t('activity_events')}</span>
      </div>
      {error ? <p role="alert" className="text-rose-400">{error.message}</p>
        : isLoading ? <p role="status">{lang === 'vi' ? 'Đang tải hoạt động…' : 'Loading activity…'}</p>
        : !selectedTaskId ? (
          logs.length ? logs.map((line, index) => <p key={index} className="whitespace-pre-wrap break-words text-[var(--muted)]">{line}</p>) : <p className="py-12 text-center text-[var(--faint)]">{t('activity_empty')}</p>
        ) : activities.length === 0 ? (
          <div className="py-12 text-center text-[var(--faint)] flex flex-col items-center gap-2"><Activity className="w-8 h-8 opacity-40" /><p>{t('activity_empty')}</p></div>
        ) : activities.map((event, index) => {
          const isError = event.type === 'tool_error' || event.type === 'failed' || event.status === 'error' || event.status === 'failed';
          const time = event.at ? new Date(event.at) : null;
          return (
            <div key={`${event.at}-${index}`} className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--line-subtle)] flex items-start gap-2.5">
              <div className="mt-0.5">{isError ? <AlertCircle className="w-3.5 h-3.5 text-rose-400" /> : event.toolName ? <Terminal className="w-3.5 h-3.5 text-sky-400" /> : <Activity className="w-3.5 h-3.5 text-[var(--muted)]" />}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-[var(--text)] break-words">{event.toolName || event.type}</span>
                  {time && !Number.isNaN(time.getTime()) && <time className="font-mono text-[10px] text-[var(--faint)] flex-shrink-0" dateTime={event.at}>{time.toLocaleTimeString()}</time>}
                </div>
                {event.message && <p className="text-[11px] text-[var(--muted)] mt-0.5 whitespace-pre-wrap break-words">{event.message}</p>}
              </div>
            </div>
          );
        })}
    </section>
  );
}
