import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { agentErrorText } from '@/lib/agent-errors';
import { codingBlock, outcomeToast, preselectIds } from '@/lib/agent-proof';
import { draftIssues, parseDeps, CODING_LIMITS } from '@/lib/agent-draft';
import { useTranslation, hasTranslation, type TranslationKey } from '@/lib/i18n';
import '@/lib/i18n-agents-sections'; // the strings only the sections ask for load with them
import { useAppStore } from '@/store/useAppStore';
import { useAgentDrafts, clampConcurrency, type CodingTaskDraft } from '@/store/useAgentDrafts';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { agentStatusLabel } from './agentLabels';
import { DelegationNotice, FieldIssues, NoticeLine } from './agent-parts';
import { CodingRunView } from './CodingRunView';
import { ConfirmDialog } from './ConfirmDialog';
import { IsolatedChecksPanel } from './IsolatedChecksPanel';
import { EmptyBlock, ErrorLine, LoadingLine, TabBody } from './parts';
import { useDelegation } from './useDelegation';

const blankTask = (): CodingTaskDraft => ({ id: 'task-a', prompt: '', verify: false, dependsOn: [] });

/**
 * Coding workers: each task is edited by an AI on its own Git branch and working copy, never on the owner's checkout. The owner plans the
 * tasks, starts them (after a question), reads every diff, and only then merges or asks for a draft pull request.
 */
export function CodingWorkers() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const openSettings = useAppStore((state) => state.openSettings);
  const delegation = useDelegation();
  const goal = useAgentDrafts((state) => state.codingGoal);
  const assist = useAgentDrafts((state) => state.codingModelAssist);
  const stored = useAgentDrafts((state) => state.codingTasks);
  const concurrency = useAgentDrafts((state) => state.codingConcurrency);
  const planCount = useAgentDrafts((state) => state.codingPlanCount);
  const setDraft = useAgentDrafts((state) => state.set);
  const tasks = stored ?? [blankTask()];
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  // Where focus goes when a button it was on goes away: the heading after a start, the Add button after a task is removed.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [askRun, setAskRun] = useState(false);
  const [pickedRunId, setPickedRunId] = useState('');
  const [preselect, setPreselect] = useState<{ runId: string; ids: string[] } | null>(null);
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['coding-runs'], queryFn: api.getCodingRuns, refetchInterval: 3000 });

  const jobs: any[] = Array.isArray(data?.jobs) ? data.jobs : [];
  const run = jobs.find((job) => job.id === pickedRunId) ?? jobs.find((job) => job.id === data?.activeRunId) ?? jobs.at(-1);
  // Busy comes from the Hub as well as from this page: a reopened tab must not offer a second run.
  const hubBusy = Boolean(data?.activeRunId) || data?.integrating === true;
  const recoveryFault: string | null = data?.recoveryFault ?? null;
  const block = codingBlock({
    differentRoot: delegation.blocked, mode: delegation.mode, busy: hubBusy, recoveryFault, agentBusy: delegation.agentBusy, groupRunning: delegation.groupRunning,
  });
  const issues = draftIssues(tasks, CODING_LIMITS);
  const issuesOf = (index: number) => issues.filter((issue) => issue.index === index);
  const modeKey = `mode_${delegation.mode}`;
  const modeLabel = delegation.mode && hasTranslation(modeKey) ? t(modeKey as TranslationKey) : delegation.mode || '—';

  const update = (index: number, patch: Partial<CodingTaskDraft>) => setDraft({ codingTasks: tasks.map((task, i) => (i === index ? { ...task, ...patch } : task)) });
  const plan = async () => {
    setBusy(true);
    try {
      const proposal = await api.planCodingAgents(goal, assist);
      setDraft({ codingTasks: proposal.tasks, codingPlanCount: proposal.taskCount ?? proposal.tasks.length });
      showToast(t('coding_plan_toast'), 'info');
    } catch (e: any) {
      showToast(agentErrorText(e, t, t('coding_plan_failed')), 'error');
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setAskRun(false);
    setBusy(true);
    setStarting(true);
    // The view follows the run that is about to start, not one picked earlier, and the split that was proposed has been used.
    setPickedRunId('');
    setPreselect(null);
    setDraft({ codingPlanCount: null });
    try {
      const job = await api.runCodingAgents(tasks.map(({ id, prompt, verify, dependsOn }) => ({ id: id.trim(), prompt, verify, dependsOn })), clampConcurrency(concurrency, 2));
      setPickedRunId(job.id);
      setPreselect({ runId: job.id, ids: preselectIds(job) });
      await refetch();
      // The run ended; whether its work holds up is for the evidence under each worker to say.
      showToast(agentStatusLabel(job.status, t), outcomeToast(job.status));
    } catch (e: any) {
      showToast(agentErrorText(e, t, t('coding_start_failed')), 'error');
    } finally {
      setBusy(false);
      setStarting(false);
    }
  };
  const stop = async () => {
    try {
      await api.cancelCodingAgents();
      showToast(t('coding_stop_toast'), 'info');
    } catch (e: any) {
      showToast(agentErrorText(e, t, t('coding_stop_failed')), 'error');
    }
  };

  const working = busy || hubBusy;
  const running = starting || Boolean(data?.activeRunId);
  return (
    <TabBody label={t('agents_view_coding')} testId="coding-agents">
      <div className="space-y-1.5">
        <h3 ref={headingRef} tabIndex={-1} className="text-[15px] font-semibold text-fg">{t('coding_title')}</h3>
        <p className="leading-relaxed text-muted">{t('coding_intro')}</p>
      </div>
      <DelegationNotice blocked={delegation.blocked} primary={delegation.primary} viewing={delegation.viewing} />
      {block === 'recovery' && <NoticeLine tone="danger" role="alert">{t('coding_block_recovery', { fault: recoveryFault ?? '' })}</NoticeLine>}
      {/* Start stays off until the mode is known, but nothing is said about a mode that has not been reported yet. */}
      {block === 'needs-autonomous' && delegation.mode !== undefined && (
        <NoticeLine testId="coding-needs-autonomous">
          <p>{t('coding_block_needs_autonomous', { mode: modeLabel })}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => openSettings('permissions')}>{t('coding_open_permissions')}</Button>
        </NoticeLine>
      )}
      {block === 'agent-busy' && <NoticeLine tone="neutral" testId="coding-block-agent-busy">{t('coding_block_agent_busy')}</NoticeLine>}
      {block === 'group-running' && <NoticeLine tone="neutral" testId="coding-block-group-running">{t('coding_block_group_running')}</NoticeLine>}
      {block === 'busy' && <NoticeLine tone="neutral">{t('coding_block_busy')}</NoticeLine>}

      <fieldset disabled={delegation.blocked} className="min-w-0 space-y-3 border-0 p-0">
        <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <label htmlFor="coding-goal" className="block text-[13px] font-semibold text-fg">{t('coding_goal_label')}</label>
          <Textarea id="coding-goal" rows={3} className="min-w-0 bg-panel" placeholder={t('coding_goal_placeholder')} value={goal} disabled={working}
            onChange={(event) => setDraft({ codingGoal: event.target.value })} />
          <label className="flex items-start gap-2 text-[12px] leading-4 text-muted">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={assist} disabled={working} onChange={(event) => setDraft({ codingModelAssist: event.target.checked })} />
            <span>{t('coding_assist_label')}</span>
          </label>
          <Button size="sm" variant="outline" disabled={!goal.trim() || working} onClick={plan}>{t('coding_plan_button')}</Button>
          {planCount !== null && <p role="status" className="text-[12px] text-muted">{t('coding_plan_note', { n: planCount })}</p>}
        </div>

        {tasks.map((task, i) => {
          const problems = issuesOf(i);
          const textProblems = problems.filter((issue) => issue.field === 'text' && issue.code !== 'empty');
          const idProblems = problems.filter((issue) => issue.field === 'id');
          const depProblems = problems.filter((issue) => issue.field === 'deps');
          return (
            <div key={i} data-testid="coding-task" className="space-y-3 rounded-xl border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`coding-task-${i}`} className="font-medium text-fg">{t('coding_task_label', { n: i + 1 })}</label>
                <Button size="sm" variant="danger" aria-label={t('coding_task_remove_label', { n: i + 1 })} disabled={working || tasks.length <= 1}
                  onClick={() => { setDraft({ codingTasks: tasks.filter((_, j) => j !== i), codingPlanCount: null }); requestAnimationFrame(() => addRef.current?.focus()); }}>{t('coding_task_remove')}</Button>
              </div>
              <Textarea id={`coding-task-${i}`} rows={3} className="min-w-0" placeholder={t('coding_task_placeholder')} value={task.prompt} disabled={working}
                aria-invalid={textProblems.length > 0 || undefined} aria-describedby={textProblems.length > 0 ? `coding-task-${i}-issues` : undefined}
                onChange={(event) => update(i, { prompt: event.target.value })} />
              <FieldIssues id={`coding-task-${i}-issues`} issues={textProblems} />
              <details className="text-[12px] text-muted">
                <summary className="cursor-pointer rounded">{t('coding_task_order')}</summary>
                <div className="mt-2 space-y-2">
                  <div className="space-y-1">
                    <label htmlFor={`coding-id-${i}`} className="block">{t('coding_task_id')}</label>
                    <Input id={`coding-id-${i}`} value={task.id} disabled={working} aria-invalid={idProblems.length > 0 || undefined}
                      aria-describedby={idProblems.length > 0 ? `coding-id-${i}-issues` : undefined} onChange={(event) => update(i, { id: event.target.value })} />
                    <FieldIssues id={`coding-id-${i}-issues`} issues={idProblems} />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`coding-waits-${i}`} className="block">{t('coding_task_waits')}</label>
                    <Input id={`coding-waits-${i}`} value={task.dependsText ?? task.dependsOn.join(', ')} disabled={working} placeholder={t('coding_task_waits_placeholder')}
                      aria-invalid={depProblems.length > 0 || undefined} aria-describedby={depProblems.length > 0 ? `coding-waits-${i}-issues` : undefined}
                      onChange={(event) => update(i, { dependsText: event.target.value, dependsOn: parseDeps(event.target.value) })} />
                    <FieldIssues id={`coding-waits-${i}-issues`} issues={depProblems} />
                  </div>
                  <p>{t('coding_task_inherit')}</p>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={task.verify} disabled={working} onChange={(event) => update(i, { verify: event.target.checked })} />
                    <span>{t('coding_task_verify')}</span>
                  </label>
                </div>
              </details>
            </div>
          );
        })}
        {issues.some((issue) => issue.code !== 'empty' || issue.field !== 'text') && <p className="text-[12px] text-warning">{t('agent_draft_fix')}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <Button ref={addRef} size="sm" variant="outline" disabled={tasks.length >= CODING_LIMITS.maxItems || working}
            onClick={() => setDraft({ codingTasks: [...tasks, { id: `task-${tasks.length + 1}`, prompt: '', verify: false, dependsOn: [] }], codingPlanCount: null })}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t('coding_add')}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="coding-concurrency" className="text-[12px] text-muted">{t('coding_concurrency_label')}</label>
            <Select id="coding-concurrency" className="w-20" value={clampConcurrency(concurrency, 2)} disabled={working} onChange={(event) => setDraft({ codingConcurrency: Number(event.target.value) })}>
              {[1, 2].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </div>
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button size="md" variant="primary" disabled={working || block !== null || issues.length > 0} onClick={() => setAskRun(true)}>
          {running ? t('coding_busy') : t('coding_start')}
        </Button>
        {running && <Button size="md" variant="danger" onClick={stop}>{t('coding_stop')}</Button>}
      </div>

      <ConfirmDialog open={askRun} onOpenChange={setAskRun} title={t('coding_confirm_title')} description={t('coding_confirm_body')}
        confirmLabel={t('coding_confirm_go')} cancelLabel={t('group_confirm_later')} onConfirm={start} busy={working || block !== null || issues.length > 0} focusAfter={headingRef}>
        <p className="mt-3 text-[13px] font-medium text-fg">{t('coding_confirm_tasks', { n: tasks.length })}</p>
        <ul className="mt-1 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-muted">
          {tasks.map((task, i) => <li key={i} className="break-words">{task.prompt}</li>)}
        </ul>
      </ConfirmDialog>

      <IsolatedChecksPanel run={run} />

      {error ? <ErrorLine message={t('coding_load_error', { message: agentErrorText(error, t, '') })} />
        : isLoading ? <LoadingLine text={t('coding_loading')} />
        : !run ? <EmptyBlock icon={GitBranch} title={t('coding_empty_title')} hint={t('coding_empty_hint')} />
        : <CodingRunView run={run} jobs={jobs} onPick={setPickedRunId} busy={busy} setBusy={setBusy} hubBusy={hubBusy} active={Boolean(data?.activeRunId) && data.activeRunId === run.id}
          blocked={delegation.blocked} refetch={refetch} preselect={preselect} />}
    </TabBody>
  );
}
