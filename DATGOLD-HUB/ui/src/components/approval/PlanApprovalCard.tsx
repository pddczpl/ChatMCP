import { useId, useState } from 'react';
import { Check, ClipboardList, MessageSquare, Pencil } from 'lucide-react';
import { api, type PlanExecution } from '@/lib/api';
import { PLAN_LIMITS, isDirty, keepMine, saveBody } from '@/lib/plan-draft';
import { approvePlan, feedbackProblem, isPlanConflict, nextApproval, planCard, type PlanRequest } from '@/lib/plan-view';
import type { ApprovalView } from '@/lib/task-view';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { formatTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { PlanConflictBanner } from '@/components/plan/PlanConflictBanner';
import { PlanEditor, planWhy } from '@/components/plan/PlanEditor';
import { PlanSteps } from '@/components/plan/PlanSteps';
import { PlanText } from '@/components/plan/PlanText';
import { useFocusBack } from '@/components/plan/useFocusBack';
import { usePlan } from '@/components/plan/usePlan';
import { cn } from '@/lib/utils';

interface PlanApprovalCardProps {
  approval: ApprovalView;
  request: PlanRequest;
  /** The permission mode in force (readonly, review, autonomous, full-access): the card says where it outweighs the choice. */
  gateMode?: string;
  expired: boolean;
  /** How long until the request expires, as the stack counts it; null when it does not. */
  remaining: string | null;
  busy?: boolean;
  /** The Hub took the answer: the caller refreshes the task and takes the focus, which was on a button that is about to go. */
  onAnswered?: () => void;
}

/**
 * The plan of a plan-mode task (exit_plan_mode): the plan as the Hub would give it to the agent, an editor, and the three answers. Approving names the revision shown
 * here and the execution the owner chose; edits are saved first, and then that revision is approved. Nothing is answered over a plan that moved on.
 */
export function PlanApprovalCard({ approval, request, gateMode, expired, remaining, busy, onAnswered }: PlanApprovalCardProps) {
  const { t, lang } = useTranslation();
  const ask = useConfirm();
  const showToast = useAppStore((state) => state.showToast);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const { plan, draft, conflict, open, change, drop, adopt, reread } = usePlan(request.taskId);
  const id = useId();
  const edit = useFocusBack();
  const changes = useFocusBack();
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [sending, setSending] = useState(false);
  const [answered, setAnswered] = useState(false);

  const card = planCard(request, plan);
  const dirty = !!draft && isDirty(draft);
  const shown = dirty && draft ? { title: draft.title, text: draft.text, steps: saveBody(draft).items } : card;
  const move = nextApproval(card, draft, conflict);
  const off = expired || answered || sending || !!busy;
  const noWords = feedbackProblem(feedback) !== null;

  /** One answer at a time. A plan that moved on is read again and nothing is answered; any other refusal is the Hub's own sentence. */
  const answer = async (work: () => Promise<string>, tone: 'success' | 'info') => {
    if (off) return;
    setSending(true);
    try {
      const words = await work();
      setAnswered(true);
      showToast(words, tone);
      onAnswered?.();
    } catch (error) {
      if (isPlanConflict(error)) {
        void reread();
        showToast(t('plan_moved'), 'warning');
      } else showToast((error instanceof Error && error.message) || t('plan_answer_failed'), 'error');
    } finally { setSending(false); }
  };
  const approve = (execution: PlanExecution) => {
    if (move.kind === 'blocked') return;
    void answer(async () => {
      const revision = await approvePlan(api, request.taskId, move, execution, adopt);
      drop();
      return t('plan_said_approved', { revision });
    }, 'success');
  };
  const requestChanges = () => {
    if (noWords) return;
    void answer(async () => {
      await api.decidePlan(request.taskId, card.revision, 'request_changes', { feedback: feedback.trim() });
      return t('plan_said_changes');
    }, 'info');
  };
  const startEditing = () => { if (!draft) open(); setEditing(true); };
  const closeEditor = () => { setEditing(false); edit.focusBack(); };
  const stopEditing = () => { if (draft && !dirty) drop(); closeEditor(); };
  const discard = async () => {
    if (dirty && !(await ask({ title: t('plan_discard_title'), body: t('plan_discard_body'), confirmLabel: t('plan_discard'), tone: 'danger' }))) return;
    drop();
    closeEditor();
  };
  const stopAsking = () => { setAsking(false); changes.focusBack(); };

  return (
    <section aria-label={t('plan_card_label')} data-approval-id={approval.id} data-testid="plan-approval"
      className={cn('anim-rise overflow-hidden rounded-xl border bg-panel select-text', off ? 'border-line' : 'border-primary/50')}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-primary/[0.06] px-4 py-2.5">
        <ClipboardList className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <h3 className="text-[14px] font-semibold">{t(expired ? 'agents_apr_expired' : 'plan_card_title')}</h3>
        <Badge variant="info">{t('plan_revision', { revision: card.revision })}</Badge>
        {request.taskId !== selectedTaskId && <Badge variant="neutral">{t('plan_card_other')}</Badge>}
        {dirty && <Badge variant="warning">{t('plan_unsaved')}</Badge>}
        {!expired && remaining !== null && (
          <span className="ml-auto text-[12px] tabular-nums text-muted" title={approval.expiresAt ? `${t('agents_apr_expires_at')} ${formatTime(approval.expiresAt, lang)}` : undefined}>
            {t('agents_apr_auto_deny')} {remaining}
          </span>
        )}
      </header>

      <div className="space-y-3 px-4 py-3.5">
        <p className="text-[13px] leading-5 text-muted">{t(card.loaded ? 'plan_card_note' : 'plan_card_loading')}</p>
        {card.changed && <p className="text-[13px] leading-5 text-warning">{t(card.by === 'user' ? 'plan_card_by_user' : 'plan_card_by_agent', { revision: request.revision })}</p>}
        {conflict && plan && <PlanConflictBanner conflict={conflict} plan={plan} disabled={off} onTheirs={() => { drop(); closeEditor(); }} onMine={() => { if (draft) change(keepMine(draft, plan)); }} />}
        {editing && draft ? (
          <>
            <PlanEditor draft={draft} onChange={change} disabled={off} autoFocus />
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" data-action="plan-done" disabled={off} onClick={stopEditing}>{t('plan_done_editing')}</Button>
              {dirty && <Button type="button" size="sm" variant="danger" data-action="plan-discard" disabled={off} onClick={() => void discard()}>{t('plan_discard')}</Button>}
            </div>
          </>
        ) : (
          <>
            {shown.title && <p className="break-words text-[14px] font-semibold text-fg">{shown.title}</p>}
            {shown.text.trim() && <PlanText text={shown.text} />}
            {shown.steps.length > 0 && <PlanSteps steps={shown.steps} />}
            <Button ref={edit.button} type="button" size="sm" variant="secondary" data-action="plan-edit" disabled={off || !card.loaded} onClick={startEditing}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />{t('plan_edit')}</Button>
          </>
        )}
      </div>

      <footer className="space-y-3 border-t border-line-subtle bg-surface px-4 py-3">
        {asking ? (
          <div className="space-y-2">
            <label htmlFor={`${id}-feedback`} className="block text-[13px] font-medium text-fg">{t('plan_changes_field')}</label>
            <Textarea id={`${id}-feedback`} data-field="plan-feedback" value={feedback} rows={3} maxLength={PLAN_LIMITS.feedbackChars} disabled={off} autoFocus onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); stopAsking(); } }} />
            {dirty && <p className="text-[12px] leading-4 text-warning">{t('plan_changes_unsaved')}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="secondary" data-action="changes-cancel" disabled={off} onClick={stopAsking}>{t('plan_changes_cancel')}</Button>
              <Button type="button" size="sm" variant="primary" data-action="changes-send" disabled={off || noWords} onClick={requestChanges}>{t('plan_changes_send')}</Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[12px] leading-4 text-muted">{t('plan_approve_note')}</p>
            {gateMode === 'readonly' && <p className="text-[12px] leading-4 text-warning">{t('plan_note_readonly')}</p>}
            {gateMode === 'full-access' && <p className="text-[12px] leading-4 text-warning">{t('plan_note_full_access')}</p>}
            <p id={`${id}-why`} role="status" className="text-[12px] leading-4 text-warning empty:hidden">{move.kind === 'blocked' ? planWhy(move.why, t) : ''}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button ref={changes.button} type="button" size="sm" variant="secondary" data-action="changes" disabled={off} onClick={() => setAsking(true)}><MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />{t('plan_changes')}</Button>
              <Button type="button" size="sm" variant="secondary" data-action="approve-autonomous" aria-describedby={`${id}-why`} disabled={off || move.kind === 'blocked'} onClick={() => approve('autonomous')}><Check className="h-3.5 w-3.5" aria-hidden="true" />{t('plan_approve_autonomous')}</Button>
              <Button type="button" size="sm" variant="primary" data-action="approve-review" aria-describedby={`${id}-why`} disabled={off || move.kind === 'blocked'} onClick={() => approve('review')}><Check className="h-3.5 w-3.5" aria-hidden="true" />{t('plan_approve_review')}</Button>
            </div>
          </>
        )}
      </footer>
    </section>
  );
}
