import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { agentErrorText } from '@/lib/agent-errors';
import { awaitingCheckWorkers, grantState } from '@/lib/agent-proof';
import { formatTime } from '@/lib/format';
import { useTranslation } from '@/lib/i18n';
import { useAgentDrafts } from '@/store/useAgentDrafts';
import { Button } from '@/components/ui/Button';
import { agentStatusLabel } from './agentLabels';
import { ErrorLine, LoadingLine } from './parts';
import { useDelegation } from './useDelegation';

type Check = { id: string; from: string; command: string };

/**
 * The test commands one worker may be allowed to run, and the owner's permission for each (three runs, in an isolated Windows Sandbox).
 * The Hub's list of checks does not say which are allowed, so what the Hub answered to "allow" is kept and shown until it runs out.
 */
function WorkerChecks({ workerId, blocked }: { workerId: string; blocked: boolean }) {
  const { t, lang } = useTranslation();
  const client = useQueryClient();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const grants = useAgentDrafts((state) => state.checkGrants);
  const rememberGrant = useAgentDrafts((state) => state.rememberGrant);
  const { data, isLoading, error } = useQuery({ queryKey: ['worker-checks', workerId], queryFn: () => api.getWorkerChecks(workerId), refetchInterval: 3000 });
  const grant = useMutation({
    mutationFn: (checkId: string) => api.approveIsolatedCheck(workerId, checkId, 3),
    onSuccess: (answer, checkId) => {
      rememberGrant(`${workerId}:${checkId}`, { expiresAt: Number(answer?.expiresAt), maxAttempts: Number(answer?.maxAttempts) });
      setConfirmation(null);
      void client.invalidateQueries({ queryKey: ['worker-checks', workerId] });
    },
  });
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
      <p className="text-[13px] font-semibold text-fg">{t('agent_checks_for_worker', { id: workerId })}</p>
      {isLoading && <LoadingLine text={t('agent_checks_loading')} />}
      {error && <ErrorLine message={t('agent_checks_error', { message: agentErrorText(error, t, '') })} />}
      {data?.checks?.length === 0 && <p className="text-muted">{t('agent_checks_none')}</p>}
      {(data?.checks as Check[] | undefined)?.map((check) => {
        const note = grants[`${workerId}:${check.id}`];
        const state = grantState(note, Date.now());
        return (
          <div key={check.id} data-check={check.id} data-grant={state} className="space-y-1.5 rounded-lg border border-line-subtle bg-panel p-2.5">
            <p className="break-words font-mono text-[13px] text-fg">{check.command}</p>
            <details className="break-words text-[12px] text-muted"><summary className="cursor-pointer rounded">{t('agent_checks_source')}</summary>{check.from} · {check.id}</details>
            {state === 'active'
              ? <p className="text-muted">{t('agent_checks_allowed', { n: note.maxAttempts, time: formatTime(note.expiresAt, lang) })}</p>
              : confirmation !== check.id
                ? (
                  <>
                    {state === 'expired' && <p className="text-warning">{t('agent_checks_grant_expired')}</p>}
                    <Button size="sm" disabled={blocked} onClick={() => setConfirmation(check.id)}>{t('agent_checks_review')}</Button>
                  </>
                )
                : (
                  <div className="space-y-2">
                    <p className="text-fg">{t('agent_checks_confirm')}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="primary" disabled={grant.isPending || blocked} onClick={() => grant.mutate(check.id)}>{t('agent_checks_allow')}</Button>
                      <Button size="sm" autoFocus disabled={grant.isPending} onClick={() => setConfirmation(null)}>{t('agent_checks_cancel')}</Button>
                    </div>
                  </div>
                )}
            {grant.error && confirmation === check.id && <ErrorLine message={t('agent_checks_grant_failed', { message: agentErrorText(grant.error, t, '') })} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Checks that need the owner's permission, and the checks the Hub has already recorded. Only a worker that asked for verification is waited
 * for, so only those are asked about their checks; the recorded results are the Hub's, with "verified" only where the Hub says so. With a
 * `run` it is about that run (the one on screen); without one it follows the run the Hub is running, or else the newest.
 */
export function IsolatedChecksPanel({ run }: { run?: { id: string; workers?: any[] } | null }) {
  const { t } = useTranslation();
  const { blocked } = useDelegation();
  const { data, error } = useQuery({ queryKey: ['coding-runs'], queryFn: api.getCodingRuns, refetchInterval: 3000 });
  if (error || !Array.isArray(data?.jobs) || data.jobs.length === 0) return null;
  const job = run ?? data.jobs.find((item: { id: string }) => item.id === data.activeRunId) ?? data.jobs.at(-1);
  // Only the run the Hub is running has a test broker to ask: a finished run has none, so nobody is asked about it.
  const live = Boolean(job) && job.id === data.activeRunId;
  const workers = live ? awaitingCheckWorkers<{ id: string; status: string; verifyRequired?: boolean }>(job) : [];
  const waiting = (job?.workers ?? []).some((worker: { status?: string }) => worker.status === 'awaiting_test_grant');
  const prior = (job?.workers ?? []).flatMap((worker: { id: string; verificationAttempts?: any[] }) =>
    (worker.verificationAttempts || []).map((record) => ({ ...record, workerId: worker.id })));
  if (!workers.length && !prior.length) return null;
  return (
    <section data-testid="isolated-checks-panel" aria-labelledby="isolated-checks-title" className="space-y-2 border-t border-line-subtle pt-3">
      <h3 id="isolated-checks-title" className="text-[13px] font-semibold text-fg">{t('agent_checks_title')}</h3>
      <p className="text-[12px] leading-4 text-muted">{t('agent_checks_intro')}</p>
      {waiting && <p className="text-[12px] leading-4 text-muted">{t('agent_checks_deadline')}</p>}
      {workers.map((worker) => <WorkerChecks key={worker.id} workerId={worker.id} blocked={blocked} />)}
      {prior.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-[12px] font-semibold text-fg">{t('agent_checks_recorded')}</h4>
          {prior.slice(-30).map((record: any, index: number) => (
            <div key={String(record.id || index)} className="space-y-0.5 rounded-lg border border-line p-2.5">
              <p className="text-fg">{record.workerId} · {agentStatusLabel(record.status, t)}</p>
              <p className="text-muted">{record.testOutcomeVerified === true ? t('agent_checks_recorded_verified') : t('agent_checks_recorded_unverified')}</p>
              <details className="break-all text-[12px] text-muted">
                <summary className="cursor-pointer rounded">{t('agent_checks_details')}</summary>
                <p>{t('agent_checks_detail_line', { check: record.checkId ?? '?', code: record.exitCode ?? '?' })}</p>
                {record.snapshotHash && <p>{t('agent_checks_snapshot', { hash: String(record.snapshotHash).slice(0, 16) })}</p>}
              </details>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
