import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

type Props = { taskId: string };
type RecordedCheck = {
  id?: string;
  command?: string;
  status?: string;
  exitCode?: number | null;
  startedAt?: string;
  outputPreview?: string;
  testOutcomeVerified?: boolean;
  snapshotHash?: string;
};
export function VerificationReceipts({ taskId }: Props) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['verification-evidence', taskId],
    queryFn: () => api.getVerifications(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 4000,
  });
  const runs: RecordedCheck[] = Array.isArray(data?.runs) ? data.runs : [];
  return (
    <div data-testid="verification-receipts" className="border-t border-[var(--line-subtle)] pt-3 space-y-2">
      <h3 className="font-semibold uppercase tracking-wide text-[var(--muted)] text-[11px]">Execution evidence / Bằng chứng thực thi</h3>
      {isLoading && <p role="status">Loading recorded checks…</p>}
      {error && <p role="alert" className="text-rose-400">Unable to read verification history: {error.message}</p>}
      {!isLoading && !error && runs.length === 0 && <p className="text-[var(--faint)]">No independently recorded test outcome. Model claims are not proof of passing tests.</p>}
      {runs.map((entry, index) => {
        const commandSucceeded = entry.status === 'completed' && entry.exitCode === 0;
        const checksVerified = entry.testOutcomeVerified === true;
        const label = checksVerified ? 'Verified check evidence' :
          commandSucceeded ? 'Command succeeded · tests unverified' :
          entry.status === 'running' ? 'Check running · result unknown' :
          'Blocked, interrupted, or failed · not verified';
        return <div key={entry.id ?? index} className="p-2 rounded border border-[var(--line)] bg-[var(--surface)]">
          <div className="font-semibold">{label}</div>
          <div className="text-[var(--muted)] break-all">{entry.command || 'Registered check'} · {entry.status || 'unknown'} · exit {entry.exitCode ?? '?'}</div>
          {entry.snapshotHash && <div className="font-mono text-[10px] text-[var(--muted)]">Snapshot: {entry.snapshotHash.slice(0, 16)}…</div>}
          {entry.outputPreview && <pre className="mt-1 whitespace-pre-wrap break-words max-h-28 overflow-y-auto">{entry.outputPreview.slice(0, 1600)}</pre>}
        </div>;
      })}
    </div>
  );
}
