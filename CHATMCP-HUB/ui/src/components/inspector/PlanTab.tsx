import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { CheckCircle2, Circle, Loader2, ListTodo, AlertCircle } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';

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
    <section aria-label="Task plan" className="h-full flex flex-col p-3 overflow-y-auto space-y-4 text-xs">
      {error ? (
        <p role="alert" className="text-rose-400">{error.message}</p>
      ) : isLoading ? (
        <p role="status" className="text-[var(--muted)]">{lang === 'vi' ? 'Đang tải kế hoạch…' : 'Loading plan…'}</p>
      ) : !selectedTaskId || planSteps.length === 0 ? (
        <div className="py-12 text-center text-[var(--faint)] flex flex-col items-center gap-2">
          <ListTodo className="w-8 h-8 opacity-40" />
          <p>{lang === 'vi' ? 'Chưa có kế hoạch' : 'No plan yet'}</p>
        </div>
      ) : (
        <>
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] space-y-2">
            {plan?.title && <h3 className="font-semibold text-[var(--text)]">{plan.title}</h3>}
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[var(--text)]">{progressLabel}</span>
              <span className="font-mono text-sky-400 font-bold">{progressPercent}%</span>
            </div>
            <div role="progressbar" aria-label={progressLabel} aria-valuenow={completedCount} aria-valuemin={0} aria-valuemax={planSteps.length} className="w-full h-1.5 rounded-full bg-[var(--panel)] overflow-hidden">
              <div className="h-full bg-sky-500 transition-all duration-500" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="text-[11px] text-[var(--faint)]">{completedCount} / {planSteps.length} {lang === 'vi' ? 'mục hoàn tất có bằng chứng đã ghi nhận' : 'done steps with recorded evidence'}</div>
            <div className="text-[11px] text-[var(--faint)]">{reportedCount} / {planSteps.length} {lang === 'vi' ? 'mục do agent báo hoàn tất' : 'agent-reported done steps'}</div>
            <p className="text-[11px] text-[var(--muted)]">{lang === 'vi' ? 'Bằng chứng do agent ghi nhận; xem kết quả công cụ để kiểm tra các tuyên bố.' : 'Evidence is recorded by the agent; inspect tool results to verify its claims.'}</p>
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold uppercase tracking-wider text-[10px] text-[var(--muted)] pb-1 border-b border-[var(--line-subtle)]">{t('plan_steps')}</h3>
            {planSteps.map((step, index) => (
              <div key={index} className={`p-2.5 rounded-lg border flex items-start gap-2.5 ${step.status === 'doing' ? 'bg-sky-500/10 border-sky-500/40' : 'bg-[var(--surface)] border-[var(--line-subtle)]'}`}>
                <div className="mt-0.5 flex-shrink-0" aria-label={step.status}>
                  {step.status === 'done' && step.evidence?.trim() ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    : step.status === 'done' ? <AlertCircle className="w-4 h-4 text-amber-400" />
                    : step.status === 'doing' ? <Loader2 className="w-4 h-4 text-sky-400 animate-spin" />
                    : step.status === 'blocked' ? <AlertCircle className="w-4 h-4 text-rose-400" />
                    : <Circle className="w-4 h-4 text-[var(--faint)]" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`font-medium ${step.status === 'done' && step.evidence?.trim() ? 'line-through opacity-75' : ''}`}>{step.text}</div>
                  {step.status === 'done' && !step.evidence?.trim() && <p className="text-[11px] text-amber-400 mt-0.5">{lang === 'vi' ? 'Agent báo hoàn tất · chưa có bằng chứng' : 'Agent reports done · no evidence'}</p>}
                  {step.evidence?.trim() && <p className="text-[11px] text-[var(--muted)] mt-0.5 whitespace-pre-wrap break-words">{step.evidence}</p>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
