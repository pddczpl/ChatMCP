import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldQuestion, ShieldX, type LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ErrorLine, LoadingLine, SectionHeading } from './parts';

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

/**
 * What the Hub itself recorded when a check ran. "Command succeeded" (exit 0) is not "tests verified": the two are labelled
 * apart, and only a check whose outcome the Hub verified gets the green shield.
 */
export function VerificationReceipts({ taskId }: Props) {
  const { lang } = useTranslation();
  const vi = lang === 'vi';
  const { data, error, isLoading } = useQuery({
    queryKey: ['verification-evidence', taskId],
    queryFn: () => api.getVerifications(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 4000,
  });
  const runs: RecordedCheck[] = Array.isArray(data?.runs) ? data.runs : [];
  return (
    <div data-testid="verification-receipts" className="space-y-2 border-t border-line-subtle pt-4">
      <SectionHeading title={vi ? 'Bằng chứng thực thi' : 'Execution evidence'} count={runs.length || undefined} />
      {isLoading && <LoadingLine text={vi ? 'Đang tải các kiểm tra đã ghi nhận…' : 'Loading recorded checks…'} />}
      {error && <ErrorLine message={`${vi ? 'Không đọc được lịch sử kiểm tra' : 'Unable to read verification history'}: ${error.message}`} />}
      {!isLoading && !error && runs.length === 0 && (
        <p className="text-[13px] leading-5 text-muted">{vi
          ? 'Chưa có kết quả kiểm thử nào được ghi nhận độc lập. Lời của model không phải bằng chứng test đã đạt.'
          : 'No independently recorded test outcome. Model claims are not proof of passing tests.'}</p>
      )}
      {runs.map((entry, index) => {
        const commandSucceeded = entry.status === 'completed' && entry.exitCode === 0;
        const checksVerified = entry.testOutcomeVerified === true;
        const running = entry.status === 'running';
        const label = checksVerified ? (vi ? 'Đã xác minh bằng chứng kiểm tra' : 'Verified check evidence') :
          commandSucceeded ? (vi ? 'Lệnh chạy xong · chưa xác minh kết quả test' : 'Command succeeded · tests unverified') :
          running ? (vi ? 'Đang chạy · chưa rõ kết quả' : 'Check running · result unknown') :
          (vi ? 'Bị chặn, gián đoạn hoặc thất bại · chưa xác minh' : 'Blocked, interrupted, or failed · not verified');
        const Icon: LucideIcon = checksVerified ? ShieldCheck : commandSucceeded || running ? ShieldQuestion : ShieldX;
        const tone = checksVerified ? 'text-success' : commandSucceeded || running ? 'text-warning' : 'text-danger';
        return (
          <div key={entry.id ?? index} className="space-y-1.5 rounded-xl border border-line bg-surface p-3">
            <div className={cn('flex items-center gap-2 text-[13px] font-semibold', tone)}><Icon className="h-4 w-4 shrink-0" />{label}</div>
            <div className="break-all font-mono text-[12px] text-muted">{entry.command || (vi ? 'Kiểm tra đã đăng ký' : 'Registered check')} · {entry.status || 'unknown'} · exit {entry.exitCode ?? '?'}</div>
            {entry.snapshotHash && <div className="font-mono text-[12px] text-faint">{vi ? 'Bản chụp' : 'Snapshot'}: {entry.snapshotHash.slice(0, 16)}…</div>}
            {entry.outputPreview && <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg p-2 font-mono text-[12px] leading-5 text-fg">{entry.outputPreview.slice(0, 1600)}</pre>}
          </div>
        );
      })}
    </div>
  );
}
