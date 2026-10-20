import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { assessReport, outcomeToast } from '@/lib/agent-proof';
import { draftIssues, parseDeps, GROUP_LIMITS } from '@/lib/agent-draft';
import { useTranslation, type Translate } from '@/lib/i18n';
import { useAppStore } from '@/store/useAppStore';
import { useAgentDrafts, clampConcurrency, type GroupNode } from '@/store/useAgentDrafts';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { agentRoleLabel, agentStatusLabel } from './agentLabels';
import { AiReport, EvidenceLine, issueMessage } from './agent-parts';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorLine } from './parts';
import { useDelegation } from './useDelegation';

const ROLES = ['planner', 'researcher', 'tester', 'reviewer', 'security', 'summarizer'];

/** The three helpers a hand-made group starts with, written in the language on screen. */
const startingGroup = (t: Translate): GroupNode[] => [
  { id: 'plan', role: 'planner', question: t('group_default_plan'), dependsOn: [] },
  { id: 'research', role: 'researcher', question: t('group_default_research'), dependsOn: [] },
  { id: 'review', role: 'reviewer', question: t('group_default_review'), dependsOn: ['plan', 'research'] },
];

/** The owner picks the roles, the jobs and the order. The helpers are read-only: they search the project and report in words. */
export function ManualGroup() {
  const { t } = useTranslation();
  const { blocked } = useDelegation();
  const showToast = useAppStore((state) => state.showToast);
  const stored = useAgentDrafts((state) => state.groupNodes);
  const concurrency = useAgentDrafts((state) => state.groupConcurrency);
  const setDraft = useAgentDrafts((state) => state.set);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { data: latest, refetch, error } = useQuery({ queryKey: ['delegates'], queryFn: api.getOrchestrator, refetchInterval: 4000 });
  const nodes = stored ?? startingGroup(t);
  // Busy comes from the Hub as well as from this page, so a reopened tab does not offer a second run.
  const running = busy || latest?.running === true;
  const last = latest?.last;
  const report = last ? assessReport(last.status) : null;
  const issues = draftIssues(nodes, GROUP_LIMITS);
  const issuesOf = (index: number) => issues.filter((issue) => issue.index === index);

  const update = (index: number, patch: Partial<GroupNode>) => setDraft({ groupNodes: nodes.map((node, i) => (i === index ? { ...node, ...patch } : node)) });
  const run = async () => {
    setConfirmOpen(false);
    setBusy(true);
    try {
      const answer = await api.orchestrateAgents(nodes.map(({ id, role, question, dependsOn }) => ({ id: id.trim(), role, question, dependsOn })), clampConcurrency(concurrency, 3));
      await refetch();
      showToast(agentStatusLabel(answer.status, t), outcomeToast(answer.status));
    } catch (e: any) {
      showToast(e?.message || t('group_start_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    try {
      await api.cancelOrchestrator();
      showToast(t('group_stop_toast'), 'info');
    } catch (e: any) {
      showToast(e?.message || t('group_stop_failed'), 'error');
    }
  };

  return (
    <details data-testid="manual-agents" className="border-t border-line pt-4">
      <summary className="cursor-pointer rounded font-semibold text-fg">{t('group_manual_title')}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-muted">{t('group_manual_intro')}</p>
        <fieldset disabled={blocked} className="min-w-0 space-y-3 border-0 p-0">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="group-concurrency" className="font-medium text-fg">{t('group_concurrency_label')}</label>
          <Select id="group-concurrency" className="w-20" value={clampConcurrency(concurrency, 3)} disabled={running}
            onChange={(event) => setDraft({ groupConcurrency: Number(event.target.value) })}>
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </div>
        {nodes.map((node, i) => {
          const problems = issuesOf(i);
          const textProblems = problems.filter((issue) => issue.field === 'text' && issue.code !== 'empty');
          const idProblems = problems.filter((issue) => issue.field === 'id');
          const depProblems = problems.filter((issue) => issue.field === 'deps');
          return (
            <div key={i} data-testid="group-node" className="space-y-2 rounded-xl border border-line bg-surface p-3">
              <div className="flex items-center gap-2">
                <Select aria-label={t('group_node_role', { n: i + 1 })} className="min-w-0 flex-1" value={node.role} disabled={running}
                  onChange={(event) => update(i, { role: event.target.value })}>
                  {ROLES.map((role) => <option key={role} value={role}>{agentRoleLabel(role, t)}</option>)}
                </Select>
                <Button size="sm" variant="danger" aria-label={t('group_node_remove_label', { n: i + 1 })} disabled={nodes.length === 1 || running}
                  onClick={() => setDraft({ groupNodes: nodes.filter((_, j) => j !== i) })}>{t('group_node_remove')}</Button>
              </div>
              <div className="space-y-1">
                <label htmlFor={`group-task-${i}`} className="block text-[12px] font-medium text-muted">{t('group_node_task', { n: i + 1 })}</label>
                <Textarea id={`group-task-${i}`} rows={3} className="min-w-0" value={node.question} disabled={running}
                  aria-invalid={textProblems.length > 0 || undefined} onChange={(event) => update(i, { question: event.target.value })} />
                {textProblems.map((issue) => <p key={issue.code} role="alert" className="text-[12px] text-danger">{issueMessage(issue, t)}</p>)}
              </div>
              <details className="text-[12px] text-muted">
                <summary className="cursor-pointer rounded">{t('group_node_order')}</summary>
                <div className="mt-2 space-y-2">
                  <div className="space-y-1">
                    <label htmlFor={`group-id-${i}`} className="block">{t('group_node_id')}</label>
                    <Input id={`group-id-${i}`} value={node.id} disabled={running} aria-invalid={idProblems.length > 0 || undefined}
                      onChange={(event) => update(i, { id: event.target.value })} />
                    {idProblems.map((issue) => <p key={issue.code} role="alert" className="text-danger">{issueMessage(issue, t)}</p>)}
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`group-waits-${i}`} className="block">{t('group_node_waits')}</label>
                    <Input id={`group-waits-${i}`} value={node.dependsText ?? node.dependsOn.join(', ')} disabled={running} placeholder={t('group_node_waits_placeholder')}
                      aria-invalid={depProblems.length > 0 || undefined}
                      onChange={(event) => update(i, { dependsText: event.target.value, dependsOn: parseDeps(event.target.value) })} />
                    {depProblems.map((issue) => <p key={`${issue.code}-${issue.detail}`} role="alert" className="text-danger">{issueMessage(issue, t)}</p>)}
                  </div>
                </div>
              </details>
            </div>
          );
        })}
        </fieldset>
        {issues.some((issue) => issue.code !== 'empty' || issue.field !== 'text') && <p id="group-fix" className="text-[12px] text-warning">{t('agent_draft_fix')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={blocked || nodes.length >= GROUP_LIMITS.maxItems || running}
            onClick={() => setDraft({ groupNodes: [...nodes, { id: `worker${nodes.length + 1}`, role: 'researcher', question: '', dependsOn: [] }] })}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t('group_add')}
          </Button>
          {running && <Button size="sm" variant="danger" onClick={stop}>{t('group_stop')}</Button>}
          <Button size="sm" variant="primary" disabled={blocked || running || issues.length > 0} onClick={() => setConfirmOpen(true)}>
            {running ? t('group_analyze_busy') : t('group_start')}
          </Button>
        </div>
        <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={t('group_confirm_title')} description={t('group_confirm_body')}
          confirmLabel={t('group_confirm_go')} cancelLabel={t('group_confirm_later')} onConfirm={run} busy={running || issues.length > 0} />
        {error && <ErrorLine message={t('group_state_error', { message: error.message })} />}
        {last && report && (
          <section aria-labelledby="group-result-title" data-testid="group-result" data-tone={report.tone} data-kind={report.kind} className="select-text space-y-2">
            <h4 id="group-result-title" className="font-semibold text-fg">{t('group_manual_result_title')}</h4>
            <EvidenceLine tone={report.tone} kind={report.kind} />
            {(last.workers || []).map((worker: any) => (
              <div key={worker.id} className="space-y-2 rounded-lg border border-line p-3">
                <div className="font-medium text-fg">{agentRoleLabel(worker.role || 'researcher', t)} · {agentStatusLabel(worker.status, t)}</div>
                {worker.summary ? <AiReport text={worker.summary} /> : worker.error ? <ErrorLine message={worker.error} /> : <p className="text-muted">{t('group_waiting_result')}</p>}
              </div>
            ))}
            {last.conclusion && <AiReport label={t('group_conclusion_title')} text={last.conclusion} />}
            {last.error && <ErrorLine message={last.error} />}
          </section>
        )}
      </div>
    </details>
  );
}
