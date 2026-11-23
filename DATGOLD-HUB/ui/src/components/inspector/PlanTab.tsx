import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListTodo, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { draftProblem, isDirty, keepMine, saveBody } from '@/lib/plan-draft';
import { isPlanConflict, planEditable, planHead } from '@/lib/plan-view';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { PlanConflictBanner } from '@/components/plan/PlanConflictBanner';
import { PlanEditor, planWhy } from '@/components/plan/PlanEditor';
import { PlanSteps } from '@/components/plan/PlanSteps';
import { PlanText } from '@/components/plan/PlanText';
import { useFocusBack } from '@/components/plan/useFocusBack';
import { usePlan } from '@/components/plan/usePlan';
import { VerificationReceipts } from './VerificationReceipts';
import { IsolatedChecksPanel } from './IsolatedChecksPanel';
import { EmptyBlock, ErrorLine, LoadingLine, SectionHeading, TabBody } from './parts';

/**
 * The plan of the conversation, its progress and its evidence. A step counts as done in the bar only when the agent attached evidence to it; a step the agent
 * merely reports as done is shown as exactly that, with no check mark. The owner can edit the plan (P9 ac-11): the words and the order, never the evidence.
 */
export function PlanTab() {
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  // A conversation has a tab of its own: what is being saved, and which editor takes the focus, is not the next one's.
  return <TaskPlan key={selectedTaskId} taskId={selectedTaskId} />;
}

function TaskPlan({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const ask = useConfirm();
  const showToast = useAppStore((state) => state.showToast);
  const { plan, error, isLoading, draft, conflict, open, change, drop, adopt, reread } = usePlan(taskId);
  // The conversation reads its record every 2 s; this only needs to know which transport it is on.
  const { data: task } = useQuery({ queryKey: ['task', taskId], queryFn: () => api.getTask(taskId), enabled: Boolean(taskId) });
  const [saving, setSaving] = useState(false);
  // The draft is shared with the approval card: only an editor opened from this tab takes the focus.
  const [openedHere, setOpenedHere] = useState(false);
  const { button: editButton, focusBack } = useFocusBack();
  const planSteps = plan?.items ?? [];
  const planText = plan?.text ?? '';
  const reportedCount = planSteps.filter((step) => step.status === 'done').length;
  const completedCount = planSteps.filter((step) => step.status === 'done' && step.evidence?.trim()).length;
  const progressPercent = planSteps.length ? Math.round((completedCount / planSteps.length) * 100) : 0;
  const progressLabel = t('plan_progress');
  const editable = planEditable(task);
  const editing = editable && !!draft && !!plan;
  const head = planHead(plan);
  const empty = planSteps.length === 0 && !planText.trim();
  const dirty = !!draft && isDirty(draft);
  const why = conflict ? 'conflict' as const : draft && dirty ? draftProblem(draft) : null;

  const save = async () => {
    if (!draft || !dirty || why || saving) return;
    setSaving(true);
    try {
      const { title, items, baseRevision, text } = saveBody(draft);
      const saved = await api.savePlan(taskId, title, items, baseRevision, text);
      await adopt(saved);
      showToast(t('plan_saved', { revision: saved.revision }), 'success');
      focusBack();
    } catch (refusal) {
      if (isPlanConflict(refusal)) {
        void reread();
        showToast(t('plan_moved'), 'warning');
      } else showToast((refusal instanceof Error && refusal.message) || t('plan_save_failed'), 'error');
    } finally { setSaving(false); }
  };
  const close = async () => {
    if (dirty && !(await ask({ title: t('plan_discard_title'), body: t('plan_discard_body'), confirmLabel: t('plan_discard'), tone: 'danger' }))) return;
    drop();
    focusBack();
  };
  const editControl = editable && !editing && plan && (
    <Button ref={editButton} type="button" size="sm" variant="secondary" data-action="plan-edit" onClick={() => { setOpenedHere(true); open(); }} className="shrink-0"><Pencil className="h-3.5 w-3.5" aria-hidden="true" />{t('plan_edit')}</Button>
  );

  return (
    <TabBody label={t('plan_tab_label')} testId="plan-tab">
      {error && !editing ? (
        <ErrorLine message={error.message} />
      ) : isLoading ? (
        <LoadingLine text={t('plan_loading')} />
      ) : editing && draft && plan ? (
        <div className="space-y-4" data-testid="plan-tab-editor">
          {error && <ErrorLine message={error.message} />}
          {conflict && <PlanConflictBanner conflict={conflict} plan={plan} disabled={saving} onTheirs={() => { drop(); focusBack(); }} onMine={() => change(keepMine(draft, plan))} />}
          <PlanEditor draft={draft} onChange={change} disabled={saving} autoFocus={openedHere} />
          <p role="status" data-testid="plan-why" className="text-[12px] leading-4 text-warning empty:hidden">{why ? planWhy(why, t) : ''}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="primary" data-action="plan-save" disabled={saving || !dirty || why !== null} onClick={() => void save()}>{t('plan_save')}</Button>
            <Button type="button" size="sm" variant={dirty ? 'danger' : 'secondary'} data-action="plan-close" disabled={saving} onClick={() => void close()}>{t(dirty ? 'plan_discard' : 'plan_close')}</Button>
            {dirty && <span className="text-[12px] text-muted">{t('plan_unsaved')}</span>}
          </div>
        </div>
      ) : !taskId || empty ? (
        <>
          <EmptyBlock icon={ListTodo} title={t('plan_empty_title')} hint={t('plan_empty_hint')} />
          {editControl && <div className="flex justify-center">{editControl}</div>}
        </>
      ) : (
        <>
          <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
            {plan?.title && <h3 className="break-words text-[14px] font-semibold text-fg">{plan.title}</h3>}
            {(head || editControl) && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                {head && (
                  <p className="text-[12px] text-muted">
                    {t('plan_revision', { revision: head.revision })}{head.by && <> · {t(head.by === 'user' ? 'plan_by_user' : 'plan_by_agent')}</>}
                  </p>
                )}
                {editControl}
              </div>
            )}
            {head?.approved && <Badge variant={head.approved.current ? 'success' : 'neutral'} className="whitespace-normal">{t(head.approved.current ? 'plan_approved_current' : 'plan_approved_older', { revision: head.approved.revision })}</Badge>}
            {planText.trim() && <PlanText text={planText} />}
            {planSteps.length > 0 && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-muted">{progressLabel}</span>
                  <span className="font-mono text-[14px] font-semibold tabular-nums text-fg">{progressPercent}%</span>
                </div>
                <div role="progressbar" aria-label={progressLabel} aria-valuenow={completedCount} aria-valuemin={0} aria-valuemax={planSteps.length} className="h-2 w-full overflow-hidden rounded-full bg-hover">
                  <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${progressPercent}%` }} />
                </div>
                <div className="space-y-0.5 text-[12px] text-muted">
                  <p>{t('plan_count_proven', { n: completedCount, total: planSteps.length })}</p>
                  <p>{t('plan_count_reported', { n: reportedCount, total: planSteps.length })}</p>
                </div>
                <p className="text-[12px] leading-4 text-faint">{t('plan_evidence_note')}</p>
              </>
            )}
          </div>

          {planSteps.length > 0 && (
            <div className="space-y-2">
              <SectionHeading title={t('plan_steps')} count={planSteps.length} />
              <PlanSteps steps={planSteps} />
            </div>
          )}
        </>
      )}
      {taskId && <VerificationReceipts taskId={taskId} />}
      <IsolatedChecksPanel />
    </TabBody>
  );
}
