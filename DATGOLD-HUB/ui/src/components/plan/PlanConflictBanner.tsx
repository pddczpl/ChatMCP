import { AlertTriangle } from 'lucide-react';
import type { Plan } from '@/types';
import { Button } from '@/components/ui/Button';
import { useTranslation, type TranslationKey } from '@/lib/i18n';
import { basisOf, type PlanConflict } from '@/lib/plan-draft';
import { PlanSteps } from './PlanSteps';
import { PlanText } from './PlanText';

const WRITTEN_BY: Record<'agent' | 'user' | 'unknown', TranslationKey> = { agent: 'plan_conflict_agent', user: 'plan_conflict_user', unknown: 'plan_conflict_unknown' };

/** The plan went on while the owner was editing: what was written, by whom, and the two ways out. The draft stays as it is until one is chosen. */
export function PlanConflictBanner({ conflict, plan, disabled, onTheirs, onMine }: { conflict: PlanConflict; plan: Plan; disabled?: boolean; onTheirs: () => void; onMine: () => void }) {
  const { t } = useTranslation();
  const now = basisOf(plan);
  const { revision, base } = conflict;
  return (
    <div role="alert" data-testid="plan-conflict" className="space-y-2 rounded-xl border border-warning/40 bg-warning/[0.08] px-3 py-2.5 text-[13px] leading-5">
      <p className="flex items-start gap-2 font-semibold text-fg"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />{t('plan_conflict_title')}</p>
      <p className="text-muted">{t(WRITTEN_BY[conflict.by ?? 'unknown'], { revision, base })}</p>
      <details>
        <summary className="cursor-pointer text-muted hover:text-fg">{t('plan_conflict_show', { revision })}</summary>
        <div className="mt-2 space-y-2">
          {now.title && <p className="font-semibold text-fg">{now.title}</p>}
          {now.text.trim() && <PlanText text={now.text} />}
          {now.items.length > 0 && <PlanSteps steps={now.items} />}
        </div>
      </details>
      <p className="text-[12px] leading-4 text-muted">{t('plan_conflict_mine_note')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" data-action="conflict-mine" disabled={disabled} onClick={onMine}>{t('plan_conflict_mine', { revision })}</Button>
        <Button type="button" size="sm" variant="danger" data-action="conflict-theirs" disabled={disabled} onClick={onTheirs}>{t('plan_conflict_theirs', { revision })}</Button>
      </div>
    </div>
  );
}
