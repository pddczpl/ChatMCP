import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useTranslation, type Translate, type TranslationKey } from '@/lib/i18n';
import { PLAN_LIMITS, addStep, editStep, editText, editTitle, moveStep, removeStep, stepView, type DraftProblem, type PlanDraft } from '@/lib/plan-draft';
import { HiddenText } from '@/components/inspector/HiddenText';
import { StepIcon } from './PlanSteps';

const WHY: Record<DraftProblem | 'conflict', [TranslationKey, number?]> = {
  empty_step: ['plan_why_empty_step'], step_too_long: ['plan_why_step_too_long', PLAN_LIMITS.stepChars], too_many_steps: ['plan_why_too_many_steps', PLAN_LIMITS.steps],
  empty_text: ['plan_why_empty_text'], text_too_long: ['plan_why_text_too_long', PLAN_LIMITS.textChars], conflict: ['plan_why_conflict'],
};
/** Why a plan cannot be saved or approved as it is, in words. */
export const planWhy = (why: DraftProblem | 'conflict', t: Translate): string => t(WHY[why][0], { limit: WHY[why][1] ?? 0 });

/**
 * The owner's draft of a plan: its title, its text and its steps. Every edit goes to the draft (lib/plan-draft.ts) at once; nothing is sent from here. The agent's
 * marks are shown beside a step and are no field. The focus goes to a step that was added, to the step that takes the place of a deleted one, and stays with a step
 * that moves; what happened is said to a screen reader.
 */
export function PlanEditor({ draft, onChange, disabled, autoFocus = false }: { draft: PlanDraft; onChange: (draft: PlanDraft) => void; disabled?: boolean; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState('');
  // The control that takes the focus once the next draft is drawn; the first one that is there and enabled.
  const focusNext = useRef<string[]>(autoFocus ? ['[data-field="plan-title"]'] : []);
  useEffect(() => {
    const wanted = focusNext.current;
    focusNext.current = [];
    for (const selector of wanted) {
      const target = root.current?.querySelector<HTMLElement>(selector);
      if (target && !(target as HTMLButtonElement).disabled) { target.focus(); return; }
    }
  });
  const edit = (next: PlanDraft, focus: string[], words: string) => { focusNext.current = focus; setSaid(words); onChange(next); };
  const add = (after?: string) => {
    const added = addStep(draft, after);
    edit(added.draft, [`[data-field="step-${added.id}"]`], t('plan_said_added', { n: added.draft.steps.findIndex((step) => step.id === added.id) + 1 }));
  };
  const remove = (stepId: string, index: number) => {
    const next = removeStep(draft, stepId);
    const neighbour = next.steps[Math.min(index, next.steps.length - 1)];
    edit(next, [...(neighbour ? [`[data-field="step-${neighbour.id}"]`] : []), '[data-action="step-add"]'], t('plan_said_deleted', { n: index + 1 }));
  };
  const move = (stepId: string, index: number, by: -1 | 1) => {
    const [same, other] = by < 0 ? ['up', 'down'] : ['down', 'up'];
    edit(moveStep(draft, stepId, by), [`[data-action="step-${same}-${stepId}"]`, `[data-action="step-${other}-${stepId}"]`], t('plan_said_moved', { n: index + 1 + by }));
  };

  return (
    <div ref={root} className="space-y-4" data-testid="plan-editor">
      <div className="space-y-1">
        <label htmlFor={`${id}-title`} className="block text-[12px] font-medium text-muted">{t('plan_field_title')}</label>
        <Input id={`${id}-title`} data-field="plan-title" value={draft.title} maxLength={PLAN_LIMITS.titleChars} disabled={disabled} onChange={(event) => onChange(editTitle(draft, event.target.value))} />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-text`} className="block text-[12px] font-medium text-muted">{t('plan_field_text')}</label>
        <Textarea id={`${id}-text`} data-field="plan-text" value={draft.text} rows={8} disabled={disabled} spellCheck={false} className="max-h-96 min-h-32 resize-y font-mono text-[12px]" onChange={(event) => onChange(editText(draft, event.target.value))} />
      </div>
      <div className="space-y-2">
        <p className="text-[12px] font-medium text-muted" id={`${id}-steps`}>{t('plan_steps')}</p>
        <ol className="space-y-2" aria-labelledby={`${id}-steps`}>
          {draft.steps.map((step, index) => {
            const n = index + 1;
            const view = stepView(draft, step);
            const evidence = view.evidence.trim();
            return (
              <li key={step.id} className="rounded-xl border border-line bg-surface px-2.5 py-2">
                <div className="flex items-start gap-2">
                  <span className="pt-1.5"><StepIcon status={view.status} evidence={view.evidence} /></span>
                  <Textarea data-field={`step-${step.id}`} aria-label={t('plan_step', { n })} value={step.text} rows={1} disabled={disabled} className="[field-sizing:content] min-h-9 resize-none"
                    onChange={(event) => onChange(editStep(draft, step.id, event.target.value.replace(/\r\n|\r|\n/g, ' ')))}
                    onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add(step.id); } }} />
                  <div className="flex shrink-0 items-center">
                    <Button type="button" variant="quiet" size="icon" data-action={`step-up-${step.id}`} aria-label={t('plan_step_up', { n })} title={t('plan_step_up', { n })} disabled={disabled || index === 0} onClick={() => move(step.id, index, -1)}><ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                    <Button type="button" variant="quiet" size="icon" data-action={`step-down-${step.id}`} aria-label={t('plan_step_down', { n })} title={t('plan_step_down', { n })} disabled={disabled || index === draft.steps.length - 1} onClick={() => move(step.id, index, 1)}><ArrowDown className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                    <Button type="button" variant="quiet" size="icon" data-action={`step-delete-${step.id}`} aria-label={t('plan_step_delete', { n })} title={t('plan_step_delete', { n })} disabled={disabled} onClick={() => remove(step.id, index)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                  </div>
                </div>
                {evidence && <p data-testid="step-evidence" className="mt-1 whitespace-pre-wrap break-words pl-6 text-[12px] text-muted"><HiddenText text={view.evidence} /></p>}
                {view.loses && <p className="mt-1 pl-6 text-[12px] text-warning">{t('plan_step_loses')}</p>}
              </li>
            );
          })}
        </ol>
        <Button type="button" variant="secondary" size="sm" data-action="step-add" disabled={disabled} onClick={() => add()}><Plus className="h-3.5 w-3.5" aria-hidden="true" />{t('plan_step_add')}</Button>
      </div>
      <p role="status" className="sr-only">{said}</p>
    </div>
  );
}
