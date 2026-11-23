import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { PlanItem } from '@/types';
import { useTranslation, type TranslationKey } from '@/lib/i18n';
import { HiddenText } from '@/components/inspector/HiddenText';
import { cn } from '@/lib/utils';

type StepMark = PlanItem['status'] | 'reported';
const MARK_WORDS: Record<StepMark, TranslationKey> = {
  todo: 'plan_status_todo', doing: 'plan_status_doing', done: 'plan_status_done', reported: 'plan_status_reported', blocked: 'plan_status_blocked',
};

/** The mark of a step: a check only for a done step with evidence; a step the agent merely reports as done is shown as exactly that. */
export function StepIcon({ status, evidence }: Pick<PlanItem, 'status' | 'evidence'>) {
  const { t } = useTranslation();
  const proven = status === 'done' && !!evidence?.trim();
  const mark: StepMark = status === 'done' && !proven ? 'reported' : status;
  return (
    <span role="img" aria-label={t(MARK_WORDS[mark] ?? MARK_WORDS.todo)} className="mt-0.5 shrink-0">
      {proven ? <CheckCircle2 className="h-4 w-4 text-success" />
        : status === 'done' ? <AlertCircle className="h-4 w-4 text-warning" />
        : status === 'doing' ? <Loader2 className="h-4 w-4 animate-spin text-primary" />
        : status === 'blocked' ? <AlertCircle className="h-4 w-4 text-danger" />
        : <Circle className="h-4 w-4 text-faint" />}
    </span>
  );
}

/** The steps of a plan, read only: the words, the agent's mark and the evidence it attached. */
export function PlanSteps({ steps }: { steps: PlanItem[] }) {
  const { t } = useTranslation();
  return (
    <ol className="space-y-2" data-testid="plan-steps">
      {steps.map((step, index) => {
        const evidence = step.evidence?.trim();
        const proven = step.status === 'done' && !!evidence;
        return (
          <li key={index} className={cn('flex items-start gap-3 rounded-xl border px-3 py-2.5',
            step.status === 'doing' ? 'border-primary/40 bg-primary/[0.06]' : 'border-line bg-surface')}>
            <StepIcon status={step.status} evidence={step.evidence} />
            <div className="min-w-0 flex-1">
              <div className={cn('break-words font-medium text-fg', proven && 'text-muted line-through decoration-faint')}><HiddenText text={step.text} /></div>
              {step.status === 'done' && !evidence && <p className="mt-0.5 text-[12px] text-warning">{t('plan_no_evidence')}</p>}
              {evidence && <p data-testid="step-evidence" className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-muted"><HiddenText text={step.evidence ?? ''} /></p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
