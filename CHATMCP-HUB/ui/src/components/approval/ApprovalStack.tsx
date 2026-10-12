import { useState, useEffect } from 'react';
import { Check, X, ShieldAlert } from 'lucide-react';
import { diffLines } from 'diff';
import { Button } from '@/components/ui/Button';
import type { ApprovalView } from '@/lib/task-view';

export type PendingApproval = ApprovalView;
interface ApprovalStackProps {
  approvals: PendingApproval[];
  onApprove: (id: string) => void | Promise<void>;
  onDeny: (id: string, reason?: string) => void | Promise<void>;
  busy?: boolean;
}
const decisions: Record<string, string> = { approved: 'Đã phê duyệt', denied: 'Đã từ chối', expired: 'Đã hết hạn', cancelled: 'Đã hủy', blocked: 'Bị chặn', policy: 'Bị từ chối theo chính sách' };

export function ApprovalStack({ approvals, onApprove, onDeny, busy }: ApprovalStackProps) {
  const [now, setNow] = useState(Date.now);
  const [confirmDeny, setConfirmDeny] = useState<string | null>(null);
  useEffect(() => {
    if (!approvals.some(item => !item.decision && item.expiresAt)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approvals]);
  if (!approvals.length) return null;
  return (
    <div className="mx-4 my-3 space-y-3">
      {approvals.map(item => {
        const expired = !!item.expiresAt && Date.parse(item.expiresAt) <= now;
        const decision = item.decision || (expired ? 'expired' : undefined);
        const disabled = !!decision || busy;
        const diffs = item.oldContent !== undefined && item.newContent !== undefined ? diffLines(item.oldContent, item.newContent) : null;
        return (
          <section key={item.id} className="rounded-xl border border-amber-500/50 bg-[var(--surface)] p-4" aria-label={`Phê duyệt ${item.tool}`} data-approval-id={item.id}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0 text-xs">
                <div className="flex items-center gap-2 font-semibold"><ShieldAlert className="w-4 h-4 text-amber-400" />{decision ? decisions[decision] || decision : 'Yêu cầu phê duyệt hành động'}</div>
                <div className="font-mono mt-1 text-sky-300">{item.tool}</div>
                <p className="mt-1">{item.description}</p>
                <p className="mt-1 text-amber-300">Phân loại rủi ro: {item.risk}</p>
                {item.reason && <p className="mt-1 text-[var(--muted)]">{item.reason}</p>}
                {item.expiresAt && <p className="mt-1 text-[var(--muted)]">Hết hạn: <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleString()}</time></p>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" disabled={disabled} onClick={() => { if (!disabled) void onApprove(item.id); }} className="gap-1"><Check className="w-3 h-3" />Phê duyệt</Button>
                <Button size="sm" variant="secondary" disabled={disabled} onClick={() => { if (!disabled) { if (confirmDeny === item.id) void onDeny(item.id); else setConfirmDeny(item.id); } }} className="gap-1"><X className="w-3 h-3" />Từ chối</Button>
              </div>
            </div>
            {confirmDeny === item.id && !decision && <Button size="sm" variant="danger" disabled={disabled} onClick={() => void onDeny(item.id)} className="mt-2">Xác nhận từ chối</Button>}
            {item.targetPath && <p className="font-mono text-xs mt-3 break-all">{item.targetPath}</p>}
            {item.command && <pre className="mt-3 p-3 text-xs bg-[var(--bg)] rounded overflow-auto whitespace-pre-wrap"><code>{item.command}</code></pre>}
            {diffs && <div className="mt-3 font-mono text-xs bg-[var(--bg)] rounded p-2 max-h-64 overflow-auto" aria-label="Diff được yêu cầu">{diffs.map((part, index) => <pre key={index} className={`whitespace-pre-wrap ${part.added ? 'text-emerald-300' : part.removed ? 'text-rose-400' : 'text-[var(--muted)]'}`}>{part.added ? '+ ' : part.removed ? '- ' : '  '}{part.value}</pre>)}</div>}
            {item.diff && <pre className="mt-3 text-xs whitespace-pre-wrap max-h-64 overflow-auto">{item.diff}</pre>}
            {item.detail && <details className="mt-3 text-xs"><summary>Chi tiết thao tác (bản xem trước do Hub cung cấp)</summary><pre className="mt-2 whitespace-pre-wrap max-h-64 overflow-auto">{JSON.stringify(item.detail, null, 2)}</pre></details>}
            {!item.detail && item.preview && <pre className="mt-3 text-xs whitespace-pre-wrap max-h-64 overflow-auto">{item.preview}</pre>}
          </section>
        );
      })}
    </div>
  );
}
