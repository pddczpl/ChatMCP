import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { awaitingCheckWorkers } from '@/lib/agent-proof';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { agentStatusLabel } from './agentLabels';
import { ErrorLine, LoadingLine } from './parts';

type Check = { id: string; from: string; command: string; approvedGrantId?: string | null; remainingAttempts?: number };

/** The test commands one worker may be allowed to run, and the owner's permission for each (three runs, in an isolated Windows Sandbox). */
function WorkerChecks({ workerId }: { workerId: string }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['worker-checks', workerId], queryFn: () => api.getWorkerChecks(workerId), refetchInterval: 3000 });
  const grant = useMutation({
    mutationFn: (checkId: string) => api.approveIsolatedCheck(workerId, checkId, 3),
    onSuccess: () => { setConfirmation(null); void client.invalidateQueries({ queryKey: ['worker-checks', workerId] }); },
  });
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
      <p className="text-[13px] font-semibold text-fg">{t('agent_checks_for_worker', { id: workerId })}</p>
      {isLoading && <LoadingLine text={t('agent_checks_loading')} />}
      {error && <ErrorLine message={t('agent_checks_error', { message: error.message })} />}
      {data?.checks?.length === 0 && <p className="text-muted">{t('agent_checks_none')}</p>}
      {(data?.checks as Check[] | undefined)?.map((check) => (
        <div key={check.id} className="space-y-1.5 rounded-lg border border-line-subtle bg-panel p-2.5">
          <p className="break-words font-mono text-[13px] text-fg">{check.command}</p>
          <details className="break-words text-[12px] text-muted"><summary className="cursor-pointer rounded">{t('agent_checks_source')}</summary>{check.from} · {check.id}</details>
          {check.approvedGrantId
            ? <p className="text-muted">{t('agent_checks_granted', { n: check.remainingAttempts ?? 0 })}</p>
            : confirmation !== check.id
              ? <Button size="sm" onClick={() => setConfirmation(check.id)}>{t('agent_checks_review')}</Button>
              : (
                <div className="space-y-2">
                  <p className="text-fg">{t('agent_checks_confirm')}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" disabled={grant.isPending} onClick={() => grant.mutate(check.id)}>{t('agent_checks_allow')}</Button>
                    <Button size="sm" disabled={grant.isPending} onClick={() => setConfirmation(null)}>{t('agent_checks_cancel')}</Button>
                  </div>
                </div>
              )}
          {grant.error && confirmation === check.id && <ErrorLine message={t('agent_checks_grant_failed', { message: grant.error.message })} />}
        </div>
      ))}
    </div>
  );
}

/**
 * Checks that need the owner's permission, and the checks the Hub has already recorded. Only a worker that asked for verification has a
 * test broker, so only those are asked about their checks; the recorded results are the Hub's, with "verified" only where the Hub says so.
 */
export function IsolatedChecksPanel() {
  const { t } = useTranslation();
  const { data, error } = useQuery({ queryKey: ['coding-runs'], queryFn: api.getCodingRuns, refetchInterval: 3000 });
  if (error || !Array.isArray(data?.jobs) || data.jobs.length === 0) return null;
  const job = data.jobs.find((item: { id: string }) => item.id === data.activeRunId) || data.jobs.at(-1);
  const workers = awaitingCheckWorkers<{ id: string; status: string; verifyRequired?: boolean }>(job);
  const prior = (job?.workers ?? []).flatMap((worker: { id: string; verificationAttempts?: any[] }) =>
    (worker.verificationAttempts || []).map((record) => ({ ...record, workerId: worker.id })));
  if (!workers.length && !prior.length) return null;
  return (
    <section data-testid="isolated-checks-panel" aria-labelledby="isolated-checks-title" className="space-y-2 border-t border-line-subtle pt-3">
      <h3 id="isolated-checks-title" className="text-[13px] font-semibold text-fg">{t('agent_checks_title')}</h3>
      <p className="text-[12px] leading-4 text-muted">{t('agent_checks_intro')}</p>
      {workers.map((worker) => <WorkerChecks key={worker.id} workerId={worker.id} />)}
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
