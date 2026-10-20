import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { assessReport } from '@/lib/agent-proof';
import { useTranslation } from '@/lib/i18n';
import { useAppStore } from '@/store/useAppStore';
import { useAgentDrafts } from '@/store/useAgentDrafts';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { agentRoleLabel, agentStatusLabel } from './agentLabels';
import { AiReport, EvidenceLine } from './agent-parts';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorLine } from './parts';
import { useDelegation } from './useDelegation';

/** The read-only analysis the AI plans for itself: a goal in, a few helpers out. Their text is the AI's report, never a verified result. */
export function DynamicSubagents() {
  const { t } = useTranslation();
  const { blocked } = useDelegation();
  const showToast = useAppStore((state) => state.showToast);
  const goal = useAgentDrafts((state) => state.goal);
  const setDraft = useAgentDrafts((state) => state.set);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { data, refetch, error } = useQuery({ queryKey: ['dynamic-delegates'], queryFn: api.getDynamicDelegates, refetchInterval: 3000 });
  // Busy comes from the Hub, not only from this page: closing and reopening the tab must not offer a second run.
  const active = Boolean(data?.activeRunId);
  const last = data?.last;
  const report = last ? assessReport(last.status) : null;
  const suggestions = [
    { label: t('group_suggest_explore'), goal: t('group_suggest_explore_goal') },
    { label: t('group_suggest_review'), goal: t('group_suggest_review_goal') },
    { label: t('group_suggest_plan'), goal: t('group_suggest_plan_goal') },
  ];

  const startAnalysis = async () => {
    if (active || busy || !goal.trim()) return;
    setConfirmOpen(false);
    setBusy(true);
    try {
      const value = await api.runDynamicDelegates(goal);
      await refetch();
      // The run ended; that is not a verdict on what the AI wrote.
      showToast(agentStatusLabel(value.status, t), value.status === 'completed' ? 'info' : 'warning');
    } catch (e: any) {
      showToast(e?.message || t('group_analyze_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const stopAnalysis = async () => {
    try {
      await api.cancelDynamicDelegates();
      await refetch();
      showToast(t('group_analyze_stop_toast'), 'info');
    } catch (e: any) {
      showToast(e?.message || t('group_analyze_stop_failed'), 'error');
    }
  };

  return (
    <section aria-labelledby="agent-goal-heading" className="space-y-4">
      <div className="space-y-1.5">
        <h3 id="agent-goal-heading" className="text-[15px] font-semibold text-fg">{t('group_goal_title')}</h3>
        <p className="leading-relaxed text-muted">{t('group_goal_intro')}</p>
      </div>
      <fieldset disabled={blocked} className="min-w-0 space-y-2 border-0 p-0">
        <label htmlFor="agent-goal" className="block font-medium text-fg">{t('group_goal_label')}</label>
        <Textarea id="agent-goal" rows={4} maxLength={2000} aria-describedby="agent-goal-help" placeholder={t('group_goal_placeholder')}
          className="min-w-0 resize-y leading-relaxed" value={goal} onChange={(event) => setDraft({ goal: event.target.value })} disabled={active || busy} />
        <div role="group" aria-label={t('group_suggestions_label')} className="flex flex-wrap gap-2">
          {suggestions.map((suggestion) => (
            <Button key={suggestion.label} size="sm" variant="outline" disabled={active || busy} onClick={() => setDraft({ goal: suggestion.goal })}>{suggestion.label}</Button>
          ))}
        </div>
        <p id="agent-goal-help" className="text-[12px] leading-4 text-faint">{t('group_goal_help')}</p>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="lg" disabled={blocked || active || busy || !goal.trim()} onClick={() => setConfirmOpen(true)}>
          {active || busy ? t('group_analyze_busy') : t('group_analyze_start')}
        </Button>
        {(active || busy) && <Button size="md" variant="danger" onClick={stopAnalysis}>{t('group_analyze_stop')}</Button>}
      </div>
      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={t('group_confirm_title')} description={t('group_confirm_body')}
        confirmLabel={t('group_confirm_go')} cancelLabel={t('group_confirm_later')} onConfirm={startAnalysis} busy={active || busy || !goal.trim()}>
        <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3">{goal}</p>
      </ConfirmDialog>
      {(active || busy) && <p role="status" className="text-muted">{t('group_running_note')}</p>}
      {error && <ErrorLine message={t('group_state_error', { message: error.message })} />}
      {last && report && (
        <div data-testid="analysis-result" data-tone={report.tone} data-kind={report.kind} className="select-text space-y-3 border-t border-line pt-4">
          <div>
            <h4 className="font-semibold text-fg">{t('group_result_title')}</h4>
            <p className="mt-1 text-[12px] text-muted">{t('group_result_meta', { status: agentStatusLabel(last.status, t), n: (last.workers || []).length })}</p>
          </div>
          <EvidenceLine tone={report.tone} kind={report.kind} />
          {(last.workers || []).map((worker: any) => (
            <details key={worker.id} className="rounded-lg border border-line p-3" open={worker.status === 'failed'}>
              <summary className="cursor-pointer rounded font-medium">
                {agentRoleLabel(worker.role, t)} <span className="font-normal text-muted">· {agentStatusLabel(worker.status, t)}</span>
              </summary>
              <div className="mt-3 space-y-2">
                {worker.summary ? <AiReport text={worker.summary} /> : worker.error ? <ErrorLine message={worker.error} /> : <p className="text-muted">{t('group_no_result')}</p>}
              </div>
            </details>
          ))}
          {last.conclusion && <AiReport text={last.conclusion} />}
          {last.error && <ErrorLine message={last.error} />}
        </div>
      )}
    </section>
  );
}
