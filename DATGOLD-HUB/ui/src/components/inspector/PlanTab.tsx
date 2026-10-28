import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { AlertCircle, CheckCircle2, Circle, ListTodo, Loader2 } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { VerificationReceipts } from './VerificationReceipts';
import { IsolatedChecksPanel } from './IsolatedChecksPanel';
import { EmptyBlock, ErrorLine, LoadingLine, SectionHeading, TabBody } from './parts';

/**
 * Progress and evidence. A step counts as done in the bar only when the agent attached evidence to it; a step the agent
 * merely reports as done is shown as exactly that, with no check mark.
 */
export function PlanTab() {
  const { t, lang } = useTranslation();
  const { selectedTaskId } = useAppStore();
  const { data: plan, error, isLoading } = useQuery({
    queryKey: ['plan', selectedTaskId],
    queryFn: () => api.getPlan(selectedTaskId),
    enabled: Boolean(selectedTaskId),
    refetchInterval: 2500,
  });
  const planSteps = plan?.items ?? [];
  const reportedCount = planSteps.filter((step) => step.status === 'done').length;
  const completedCount = planSteps.filter((step) => step.status === 'done' && step.evidence?.trim()).length;
  const progressPercent = planSteps.length ? Math.round((completedCount / planSteps.length) * 100) : 0;
  const progressLabel = lang === 'vi' ? 'Tiến độ theo bằng chứng đã ghi nhận' : 'Progress with recorded evidence';

  return (
    <TabBody label="Task plan">
      {error ? (
        <ErrorLine message={error.message} />
      ) : isLoading ? (
        <LoadingLine text={lang === 'vi' ? 'Đang tải kế hoạch…' : 'Loading plan…'} />
      ) : !selectedTaskId || planSteps.length === 0 ? (
        <EmptyBlock icon={ListTodo} title={lang === 'vi' ? 'Chưa có kế hoạch' : 'No plan yet'}
          hint={lang === 'vi' ? 'Khi agent lập kế hoạch, từng bước và bằng chứng của nó hiện ở đây.' : 'When the agent makes a plan, each step and its evidence appear here.'} />
      ) : (
        <>
          <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
            {plan?.title && <h3 className="text-[14px] font-semibold text-fg">{plan.title}</h3>}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-muted">{progressLabel}</span>
              <span className="font-mono text-[14px] font-semibold tabular-nums text-fg">{progressPercent}%</span>
            </div>
            <div role="progressbar" aria-label={progressLabel} aria-valuenow={completedCount} aria-valuemin={0} aria-valuemax={planSteps.length} className="h-2 w-full overflow-hidden rounded-full bg-hover">
              <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="space-y-0.5 text-[12px] text-muted">
              <p>{completedCount} / {planSteps.length} {lang === 'vi' ? 'mục hoàn tất có bằng chứng đã ghi nhận' : 'done steps with recorded evidence'}</p>
              <p>{reportedCount} / {planSteps.length} {lang === 'vi' ? 'mục do agent báo hoàn tất' : 'agent-reported done steps'}</p>
            </div>
            <p className="text-[12px] leading-4 text-faint">{lang === 'vi' ? 'Bằng chứng do agent ghi nhận; xem kết quả công cụ để kiểm tra các tuyên bố.' : 'Evidence is recorded by the agent; inspect tool results to verify its claims.'}</p>
          </div>

          <div className="space-y-2">
            <SectionHeading title={t('plan_steps')} count={planSteps.length} />
            {planSteps.map((step, index) => {
              const proven = step.status === 'done' && !!step.evidence?.trim();
              return (
                <div key={index} className={cn('flex items-start gap-3 rounded-xl border px-3 py-2.5',
                  step.status === 'doing' ? 'border-primary/40 bg-primary/[0.06]' : 'border-line bg-surface')}>
                  <div className="mt-0.5 shrink-0" aria-label={step.status}>
                    {proven ? <CheckCircle2 className="h-4 w-4 text-success" />
                      : step.status === 'done' ? <AlertCircle className="h-4 w-4 text-warning" />
                      : step.status === 'doing' ? <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      : step.status === 'blocked' ? <AlertCircle className="h-4 w-4 text-danger" />
                      : <Circle className="h-4 w-4 text-faint" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={cn('font-medium text-fg', proven && 'text-muted line-through decoration-faint')}>{step.text}</div>
                    {step.status === 'done' && !step.evidence?.trim() && <p className="mt-0.5 text-[12px] text-warning">{lang === 'vi' ? 'Agent báo hoàn tất · chưa có bằng chứng' : 'Agent reports done · no evidence'}</p>}
                    {step.evidence?.trim() && <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-muted">{step.evidence}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {selectedTaskId && <VerificationReceipts taskId={selectedTaskId} />}
      <IsolatedChecksPanel />
    </TabBody>
  );
}
