import { Loader2, Circle, XCircle, AlertTriangle } from 'lucide-react';
import type { Task } from '@/types';
import { isTaskActive, taskStateLabel } from '@/lib/task-view';

export function PhaseRibbon({ task, onCancel }: { task?: Task; onCancel?: () => void }) {
  if (!task) return null;
  const active = isTaskActive(task);
  const hasToolErrors = task.toolCalls?.some(tool => tool.status === 'error');
  const Icon = active ? Loader2 : task.status === 'failed' || hasToolErrors ? AlertTriangle : Circle;
  return (
    <div className="border-b border-[var(--line)] bg-[var(--panel)] px-4 py-2 flex items-center justify-between gap-3 text-xs flex-shrink-0" data-testid="task-status" data-status={task.status}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[var(--text)]">
          <Icon className={`w-4 h-4 ${active ? 'animate-spin text-sky-400' : hasToolErrors || task.status === 'failed' ? 'text-amber-400' : 'text-[var(--muted)]'}`} />
          <span>{taskStateLabel(task.status)}</span>
        </div>
        {task.status === 'completed' && (
          <p className="text-[11px] text-[var(--muted)] mt-1">
            {hasToolErrors ? 'Có công cụ báo lỗi. Xem kết quả và bằng chứng kiểm tra bên dưới.' : 'Phản hồi kết thúc không xác nhận kiểm thử đã chạy hoặc đạt.'}
          </p>
        )}
      </div>
      {active && onCancel && <button onClick={onCancel} className="flex items-center gap-1 text-rose-400 flex-shrink-0"><XCircle className="w-3 h-3" /><span>Dừng agent</span></button>}
    </div>
  );
}
