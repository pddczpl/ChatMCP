import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Activity, AlertCircle, Terminal } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { EmptyBlock, ErrorLine, LoadingLine, SectionHeading, TabBody } from './parts';

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
    <TabBody label="Task activity" className="space-y-3">
      <SectionHeading title={`${t('activity_title')}${!selectedTaskId ? ' · Hub' : ''}`} count={`${selectedTaskId ? activities.length : logs.length} ${t('activity_events')}`} />
      {error ? <ErrorLine message={error.message} />
        : isLoading ? <LoadingLine text={lang === 'vi' ? 'Đang tải hoạt động…' : 'Loading activity…'} />
        : !selectedTaskId ? (
          logs.length
            ? <ul className="space-y-1 font-mono text-[12px] leading-5 text-muted">{logs.map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">{line}</li>)}</ul>
            : <EmptyBlock icon={Activity} title={t('activity_empty')} />
        ) : activities.length === 0 ? (
          <EmptyBlock icon={Activity} title={t('activity_empty')} />
        ) : (
          <ol className="relative space-y-3 border-l border-line pl-5">
            {activities.map((event, index) => {
              const isError = event.type === 'tool_error' || event.type === 'failed' || event.status === 'error' || event.status === 'failed';
              const at = event.at ? formatTime(event.at, lang) : '';
              const Icon = isError ? AlertCircle : event.toolName ? Terminal : Activity;
              return (
                <li key={`${event.at}-${index}`} className="relative">
                  <span className={cn('absolute -left-[31px] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border bg-panel',
                    isError ? 'border-danger/40 text-danger' : 'border-line text-muted')}><Icon className="h-3 w-3" /></span>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="break-words font-medium text-fg">{event.toolName || event.type}</span>
                    {at && <time className="shrink-0 font-mono text-[12px] tabular-nums text-faint" dateTime={event.at}>{at}</time>}
                  </div>
                  {event.message && <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-5 text-muted">{event.message}</p>}
                </li>
              );
            })}
          </ol>
        )}
    </TabBody>
  );
}
