import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { agentErrorText } from '@/lib/agent-errors';
import { canMerge, canPublishMerge, MERGEABLE_RUN_STATUSES, outcomeToast, reviewKey, statusTone } from '@/lib/agent-proof';
import { formatDateTime } from '@/lib/format';
import { useTranslation } from '@/lib/i18n';
import '@/lib/i18n-agents-sections'; // the strings only the sections ask for load with them
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { agentStatusLabel } from './agentLabels';
import { StatusBadge } from './agent-parts';
import { CodingWorkerCard } from './CodingWorkerCard';
import { ReviewPanel } from './CodingReview';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorLine } from './parts';

type Ask = { kind: 'integrate' } | { kind: 'publish'; workerId: string | null } | { kind: 'acknowledge' } | null;

/** What the Hub found in the recovery log of an interrupted run; a log that is not there has no status to report. */
export function RecoveryStatus({ recovery }: { recovery: { found?: boolean; status?: string; entries?: number } }) {
  const { t } = useTranslation();
  return (
    <div role="status" data-testid="coding-recovery-status" className="mt-2 rounded-lg border border-line-subtle p-2">
      {t('coding_recovery_status', {
        found: recovery.found ? t('coding_recovery_found') : t('coding_recovery_missing'),
        status: recovery.status ? agentStatusLabel(recovery.status, t) : '—',
        entries: recovery.entries ?? 0,
      })}
    </div>
  );
}

interface Props {
  run: any;
  jobs: any[];
  onPick: (id: string) => void;
  /** An operation of this tab is in flight. */
  busy: boolean;
  setBusy: (value: boolean) => void;
  /** The Hub says a run or a merge is going on: reading diffs, merging and publishing wait. */
  hubBusy: boolean;
  /** The Hub is running this very run. A run that is not going any more has no worker that is still working, whatever status was saved for it. */
  active: boolean;
  /** Another folder than the Hub's own is in view: merging, publishing and recording an interrupted run wait (reading does not). */
  blocked?: boolean;
  refetch: () => Promise<unknown>;
  /** The workers to tick when a run has just been started from this tab. */
  preselect: { runId: string; ids: string[] } | null;
}

/**
 * The newest (or the chosen) coding run: its workers, what the Hub recorded about each, the diffs to read, the merge and the draft pull
 * request. Reading a diff is what unlocks merging and publishing, and each of those asks for its phrase in a dialog first.
 */
export function CodingRunView({ run, jobs, onPick, busy, setBusy, hubBusy, active, blocked = false, refetch, preselect }: Props) {
  const { t, lang } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [selection, setSelection] = useState<{ runId: string; ids: string[] } | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ runId: string; key: string; data: any } | null>(null);
  const [context, setContext] = useState<{ runId: string; data: any } | null>(null);
  const [recovery, setRecovery] = useState<any>(null);
  const [ask, setAsk] = useState<Ask>(null);
  // Closing a review hands focus back to the button that opened it; a dialog that closes on a button now off hands it to the heading.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const readMergeRef = useRef<HTMLButtonElement>(null);

  const workers: any[] = run.workers || [];
  const locked = busy || hubBusy;
  // What changes Git (a merge, a draft on GitHub, recording an interrupted run) also waits while the Hub's other folder is not the one in view.
  const changeLocked = locked || blocked;
  const slot = (key: string) => `${run.id}:${key}`;
  const keyOf = reviewKey;
  const selected = selection && selection.runId === run.id ? selection.ids : preselect && preselect.runId === run.id ? preselect.ids : [];
  const toggle = (id: string, checked: boolean) => setSelection({ runId: run.id, ids: checked ? [...selected.filter((item) => item !== id), id] : selected.filter((item) => item !== id) });
  const integration = run.integration;
  const reviewFor = (key: string) => (review && review.runId === run.id && review.key === key ? review.data : null);
  const contextFor = (workerId: string) => (context && context.runId === run.id && context.data?.workerId === workerId ? context.data : null);

  const attempt = async (work: () => Promise<void>, failure: string) => {
    setBusy(true);
    try { await work(); } catch (e: any) { showToast(agentErrorText(e, t, failure), 'error'); } finally { setBusy(false); }
  };
  const viewDiff = (workerId?: string) => attempt(async () => {
    const data = await api.getCodingDiff(run.id, workerId);
    setReview({ runId: run.id, key: keyOf(workerId), data });
    setTokens((current) => ({ ...current, [slot(keyOf(workerId))]: data.reviewToken }));
    showToast(t('coding_review_toast'), 'info');
  }, t('coding_review_failed'));
  const viewFiles = (workerId: string) => attempt(async () => {
    try {
      setContext({ runId: run.id, data: await api.getCodingContext(run.id, workerId) });
      showToast(t('coding_files_toast'), 'info');
    } catch (e) { setContext(null); throw e; }
  }, t('coding_files_failed'));
  const viewRecovery = () => attempt(async () => {
    try {
      setRecovery(await api.getCodingRecovery(run.id));
      showToast(t('coding_recovery_toast'), 'info');
    } catch (e: any) { setRecovery(null); showToast(agentErrorText(e, t, t('coding_recovery_none')), 'error'); }
  }, t('coding_recovery_none'));

  const confirmAsk = () => {
    const current = ask;
    setAsk(null);
    if (!current) return;
    if (current.kind === 'integrate') {
      void attempt(async () => {
        const result = await api.integrateCodingAgents(run.id, selected, Object.fromEntries(selected.map((id) => [id, tokens[slot(keyOf(id))]])));
        showToast(t('coding_integrate_toast', { status: agentStatusLabel(result.status, t) }), outcomeToast(result.status));
        await refetch();
      }, t('coding_integrate_failed'));
    } else if (current.kind === 'publish') {
      void attempt(async () => {
        const result = await api.publishCodingAgents(run.id, tokens[slot(keyOf(current.workerId))], current.workerId ?? undefined);
        showToast(t('coding_publish_done', { url: result.prUrl }), 'success');
        await refetch();
      }, current.workerId ? t('coding_publish_worker_failed') : t('coding_publish_integration_failed'));
    } else {
      void attempt(async () => {
        try {
          await api.acknowledgeCodingRecovery(run.id, recovery.integrityDigest);
          setRecovery(null);
          await refetch();
          showToast(t('coding_recovery_ack_toast'), 'warning');
        } catch (e: any) { showToast(agentErrorText(e, t, t('coding_recovery_ack_failed')), 'error'); }
      }, t('coding_recovery_ack_failed'));
    }
  };
  const dialog = !ask ? null
    : ask.kind === 'integrate' ? { title: t('coding_integrate_title'), description: t('coding_integrate_body'), phrase: 'INTEGRATE WORKTREES' }
    : ask.kind === 'acknowledge' ? { title: t('coding_recovery_ack_title'), description: t('coding_recovery_ack_body'), phrase: 'REVIEW INTERRUPTED RUN' }
    : ask.workerId ? { title: t('coding_publish_worker_title', { id: ask.workerId }), description: t('coding_publish_worker_body', { id: ask.workerId }), phrase: 'PUBLISH DRAFT PR' }
    : { title: t('coding_publish_integration_title'), description: t('coding_publish_integration_body'), phrase: 'PUBLISH DRAFT PR' };

  const canAcknowledge = run.status === 'interrupted' && recovery?.runId === run.id && recovery.found && recovery.integrityDigest;
  const showIntegration = Boolean(integration) || workers.some((worker) => worker.status === 'ready_for_review');
  // The Hub merges a run that is ready for review or partly failed, and no other; a stopped or failed run keeps its committed workers unmerged.
  const statusBlocksMerge = !integration && !MERGEABLE_RUN_STATUSES.includes(String(run.status));
  return (
    <section aria-labelledby="coding-result-title" data-testid="coding-result" data-run={run.id} data-status={run.status} className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="coding-result-title" ref={headingRef} tabIndex={-1} className="text-[15px] font-semibold text-fg">{t('coding_result_title')}</h3>
        <StatusBadge tone={statusTone(run.status)}>{agentStatusLabel(run.status, t)}</StatusBadge>
      </div>
      {jobs.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor="coding-run-pick" className="shrink-0 text-[12px] text-muted">{t('coding_run_pick')}</label>
          <Select id="coding-run-pick" className="min-w-0 flex-1" value={run.id} onChange={(event) => onPick(event.target.value)}>
            {[...jobs].reverse().map((job) => <option key={job.id} value={job.id}>{formatDateTime(job.createdAt, lang)} · {agentStatusLabel(job.status, t)}</option>)}
          </Select>
        </div>
      )}
      {run.error && <ErrorLine message={run.error} />}
      <details className="text-[12px] text-muted">
        <summary className="cursor-pointer rounded">{t('coding_run_details')}</summary>
        <p className="mt-2 break-all font-mono">{t('coding_run_id', { id: String(run.id).slice(0, 8) })}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={locked} onClick={viewRecovery}>{t('coding_recovery_view')}</Button>
          {canAcknowledge && <Button size="sm" variant="outline" disabled={changeLocked} onClick={() => setAsk({ kind: 'acknowledge' })}>{t('coding_recovery_ack')}</Button>}
        </div>
        <p className="mt-2">{t('coding_recovery_only')}</p>
        {recovery?.runId === run.id && <RecoveryStatus recovery={recovery} />}
      </details>
      {workers.map((worker) => (
        <CodingWorkerCard key={worker.id} worker={worker} selected={selected.includes(worker.id)} onSelect={(checked) => toggle(worker.id, checked)}
          reviewed={Boolean(tokens[slot(keyOf(worker.id))])} busy={locked} runActive={active} blocked={blocked}
          review={reviewFor(keyOf(worker.id))} context={contextFor(worker.id)}
          onViewDiff={() => viewDiff(worker.id)} onViewFiles={() => viewFiles(worker.id)} onPublish={() => setAsk({ kind: 'publish', workerId: worker.id })}
          onCloseReview={() => setReview(null)} onCloseContext={() => setContext(null)} />
      ))}
      {showIntegration && (
        <div data-testid="coding-integration" className="space-y-2 rounded-xl border border-line bg-surface p-3">
          {integration && (
            <p className="break-words font-medium text-fg">{t('coding_integration_line', { status: agentStatusLabel(integration.status, t), branch: integration.branch })}</p>
          )}
          {integration?.error && <ErrorLine message={integration.error} />}
          <p className="text-[12px] text-muted">{t('coding_integrate_hint')}</p>
          {statusBlocksMerge && <p id="coding-merge-status-hint" className="text-[12px] text-warning">{t('coding_integrate_status_hint', { status: agentStatusLabel(run.status, t) })}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" aria-describedby={statusBlocksMerge ? 'coding-merge-status-hint' : undefined}
              disabled={!canMerge({ selected, reviewed: (id) => Boolean(tokens[slot(keyOf(id))]), hasMerge: Boolean(integration), locked: changeLocked, runStatus: run.status })} onClick={() => setAsk({ kind: 'integrate' })}>{t('coding_integrate')}</Button>
            {integration?.status === 'ready_for_review' && <Button ref={readMergeRef} size="sm" variant="outline" disabled={locked} onClick={() => viewDiff()}>{t('coding_view_integration')}</Button>}
            <Button size="sm" variant="outline" disabled={!canPublishMerge({ status: integration?.status, reviewed: Boolean(tokens[slot(keyOf())]), locked: changeLocked })} onClick={() => setAsk({ kind: 'publish', workerId: null })}>{t('coding_publish_integration')}</Button>
          </div>
          {integration?.prUrl && <p className="break-all text-muted">{t('coding_pr', { url: integration.prUrl })}</p>}
          {reviewFor(keyOf()) && <ReviewPanel review={reviewFor(keyOf())} onClose={() => { setReview(null); requestAnimationFrame(() => readMergeRef.current?.focus()); }} />}
        </div>
      )}
      <ConfirmDialog open={Boolean(ask)} onOpenChange={(open) => { if (!open) setAsk(null); }} title={dialog?.title ?? ''} description={dialog?.description ?? ''}
        phrase={dialog?.phrase} confirmLabel={t('coding_phrase_confirm')} cancelLabel={t('coding_phrase_cancel')} onConfirm={confirmAsk} busy={changeLocked} focusAfter={headingRef} />
    </section>
  );
}
