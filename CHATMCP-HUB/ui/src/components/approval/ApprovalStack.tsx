import { useState } from 'react';
import { 
  ShieldCheck, 
  ShieldAlert, 
  Check, 
  X, 
  FileEdit, 
  Terminal, 
  AlertTriangle 
} from 'lucide-react';
import { diffLines, Change } from 'diff';
import { Button } from '@/components/ui/Button';

export interface PendingApproval {
  id: string;
  tool: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  targetPath?: string;
  oldContent?: string;
  newContent?: string;
  command?: string;
}

interface ApprovalStackProps {
  approvals: PendingApproval[];
  onApprove: (id: string) => void;
  onDeny: (id: string, reason?: string) => void;
}

export function ApprovalStack({ approvals, onApprove, onDeny }: ApprovalStackProps) {
  const [denyReason, setDenyReason] = useState<Record<string, string>>({});
  const [showDenyInput, setShowDenyInput] = useState<Record<string, boolean>>({});

  if (!approvals || approvals.length === 0) return null;

  return (
    <div className="mx-4 my-3 space-y-3 z-20">
      {approvals.map((item) => {
        const isFile = !!item.targetPath || (item.oldContent !== undefined && item.newContent !== undefined);
        const diffs = isFile && item.oldContent !== undefined && item.newContent !== undefined
          ? diffLines(item.oldContent, item.newContent)
          : null;

        const riskBorder = item.risk === 'high'
          ? 'border-rose-500/60 bg-rose-950/20 shadow-rose-950/20'
          : item.risk === 'medium'
          ? 'border-amber-500/50 bg-amber-950/20 shadow-amber-950/20'
          : 'border-sky-500/40 bg-sky-950/20 shadow-sky-950/20';

        return (
          <div
            key={item.id}
            className={`rounded-xl border p-4 shadow-lg tilt-3d transition-all ${riskBorder}`}
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 select-none">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center justify-center flex-shrink-0">
                  {isFile ? (
                    <FileEdit className="w-4 h-4 text-sky-400" />
                  ) : (
                    <Terminal className="w-4 h-4 text-amber-400" />
                  )}
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs text-[var(--text)]">
                      Yêu cầu phê duyệt hành động
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                        item.risk === 'high'
                          ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                          : item.risk === 'medium'
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                          : 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                      }`}
                    >
                      Mức độ: {item.risk}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--muted)] mt-0.5">
                    {item.description || `Thực thi công cụ: ${item.tool}`}
                  </p>
                </div>
              </div>

              {/* Quick Actions */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => onApprove(item.id)}
                  className="gap-1.5 h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white border-none shadow-sm"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Phê duyệt</span>
                </Button>

                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    if (!showDenyInput[item.id]) {
                      setShowDenyInput((prev) => ({ ...prev, [item.id]: true }));
                    } else {
                      onDeny(item.id, denyReason[item.id]);
                    }
                  }}
                  className="gap-1.5 h-7 text-xs text-rose-400 hover:text-rose-300"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Từ chối</span>
                </Button>
              </div>
            </div>

            {/* Content: Diff or Command Preview */}
            {item.command && (
              <div className="mt-3 p-2.5 rounded-lg bg-[#0b0e14] border border-[var(--line)] font-mono text-[11px] text-amber-300 overflow-x-auto">
                <div className="text-[10px] text-[var(--faint)] font-sans uppercase mb-1">
                  Lệnh Shell sắp thực thi:
                </div>
                <code>$ {item.command}</code>
              </div>
            )}

            {diffs && (
              <div className="mt-3 rounded-lg bg-[#0b0e14] border border-[var(--line)] font-mono text-[11px] overflow-hidden">
                <div className="px-3 py-1.5 bg-[var(--surface)] border-b border-[var(--line)] text-[11px] text-[var(--muted)] flex items-center justify-between font-sans">
                  <span>{item.targetPath || 'Tệp thay đổi'}</span>
                  <span className="text-[10px] text-[var(--faint)]">So sánh thay đổi (Diff)</span>
                </div>
                <div className="max-h-64 overflow-y-auto p-2 leading-relaxed">
                  {diffs.map((part, index) => {
                    const color = part.added
                      ? 'bg-emerald-950/40 text-emerald-300'
                      : part.removed
                      ? 'bg-rose-950/40 text-rose-400'
                      : 'text-[var(--faint)]';
                    const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
                    return (
                      <div key={index} className={`${color} px-1.5 py-0.5 rounded whitespace-pre-wrap`}>
                        {part.value.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && !l)).map((line, li) => (
                          <div key={li}>{prefix}{line}</div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Deny Reason input if opened */}
            {showDenyInput[item.id] && (
              <div className="mt-3 flex items-center gap-2 pt-2 border-t border-[var(--line-subtle)]">
                <input
                  type="text"
                  placeholder="Lý do từ chối (tùy chọn để agent điều chỉnh)..."
                  value={denyReason[item.id] || ''}
                  onChange={(e) => setDenyReason((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  className="flex-1 bg-[var(--surface)] text-xs rounded-md px-3 py-1.5 border border-[var(--line)] focus:outline-none focus:border-rose-500"
                />
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => onDeny(item.id, denyReason[item.id])}
                  className="h-7 text-xs"
                >
                  Xác nhận từ chối
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
