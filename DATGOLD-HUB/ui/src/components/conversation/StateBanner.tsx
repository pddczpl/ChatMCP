import { AlertTriangle, Ban, ClipboardList, PauseCircle, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { isTaskActive, canContinueTask } from '@/lib/task-view';
import type { PlanLine, PlanLineKind } from '@/lib/plan-view';
import { useTranslation, type Translate, type TranslationKey } from '@/lib/i18n';
import { taskStateText } from '@/components/inspector/agentLabels';
import { cn } from '@/lib/utils';

interface StateBannerProps {
  status?: string;
  message?: string;
  /** Where a plan-mode conversation stands (lib/plan-view.ts `planLine`); null for any other. */
  plan?: PlanLine | null;
  onResume?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  disabled?: boolean;
}

const PLAN_LINE: Record<PlanLineKind, TranslationKey> = {
  planning: 'plan_line_planning', waiting: 'plan_line_waiting', denied: 'plan_line_denied', expired: 'plan_line_expired', unanswerable: 'plan_line_unanswerable', approved: 'plan_line_approved',
};
const planWords = (line: PlanLine, t: Translate) => t(PLAN_LINE[line.kind], {
  revision: line.revision ?? '?', edited: line.edited ? t('plan_line_edited') : '',
  runs: line.execution ? t('plan_line_runs', { mode: t(line.execution === 'review' ? 'mode_review' : 'mode_autonomous') }) : '',
});

/**
 * Shown when a conversation stopped without a normal answer: why, and the one next step. What the Hub wrote about it (`message`) comes first and is
 * shown as written. A conversation that plan mode holds read-only says so in every state, also while it runs and after it answered: it can change nothing
 * until the owner approves its plan. The words are asked for before the early return: a hook belongs before any return, whatever state the conversation is in.
 */
export function StateBanner({ status, message, plan = null, onResume, onRetry, disabled }: StateBannerProps) {
  const { t } = useTranslation();
  const stopped = !!status && status !== 'completed' && !isTaskActive({ status });
  if (!stopped && !plan?.held) return null;
  if (!stopped && plan) {
    return (
      <div className="my-4 flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-[13px]" role="status">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/[0.06] text-primary"><ClipboardList className="h-4 w-4" aria-hidden="true" /></span>
        <div className="min-w-0">
          <div className="font-semibold text-fg">{t('plan_line_title')}</div>
          <p data-testid="plan-line" className="mt-0.5 leading-5 text-muted">{planWords(plan, t)}</p>
        </div>
      </div>
    );
  }
  const failed = status === 'failed';
  const description = message || t(status === 'uncertain' ? 'agents_banner_uncertain'
    : status === 'cancelled' ? 'agents_banner_cancelled'
      : status === 'paused' ? 'agents_banner_paused' : 'agents_banner_default');
  const Icon = failed ? AlertTriangle : status === 'cancelled' ? Ban : status === 'paused' ? PauseCircle : AlertTriangle;
  const tone = failed ? 'border-danger/30 bg-danger/[0.06] text-danger' : 'border-warning/30 bg-warning/[0.06] text-warning';
  return (
    <div className="my-4 flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3 text-[13px]" role="status">
      <div className="flex min-w-0 items-start gap-3">
        <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border', tone)}><Icon className="h-4 w-4" /></span>
        <div className="min-w-0">
          <div className="font-semibold text-fg">{taskStateText(status, t)}</div>
          <p className="mt-0.5 whitespace-pre-wrap leading-5 text-muted">{description}</p>
          {plan && <p data-testid="plan-line" className="mt-1 leading-5 text-muted"><span className="font-semibold text-fg">{t('plan_line_title')}</span> · {planWords(plan, t)}</p>}
        </div>
      </div>
      {canContinueTask({ status }) && (failed ? onRetry : onResume) && (
        <Button size="sm" variant="secondary" disabled={disabled} onClick={failed ? onRetry : onResume} className="shrink-0 gap-1.5">
          {failed ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          <span>{t(failed ? 'agents_banner_retry' : 'agents_banner_continue')}</span>
        </Button>
      )}
    </div>
  );
}
