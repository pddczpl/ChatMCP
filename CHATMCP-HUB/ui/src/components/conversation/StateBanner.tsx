import { AlertTriangle, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { taskStateLabel, isTaskActive, canContinueTask } from '@/lib/task-view';

interface StateBannerProps {
  status?: string;
  message?: string;
  onResume?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  disabled?: boolean;
}

export function StateBanner({ status, message, onResume, onRetry, disabled }: StateBannerProps) {
  if (!status || status === 'completed' || isTaskActive({ status })) return null;
  const failed = status === 'failed';
  const description = message || (status === 'uncertain'
    ? 'Kiểm tra thay đổi trước khi tiếp tục: một thao tác có thể đã chạy nhưng chưa có kết quả.'
    : status === 'cancelled' ? 'Việc dừng không hoàn tác những thay đổi đã thực hiện.'
      : status === 'paused' ? 'Gửi chỉ dẫn mới hoặc tiếp tục cùng cuộc hội thoại.' : 'Xem nhật ký để biết chi tiết.');
  return (
    <div className="mx-4 my-3 p-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] text-xs flex items-center justify-between gap-3" role="status">
      <div className="flex items-start gap-2.5 min-w-0">
        <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
        <div><div className="font-semibold">{taskStateLabel(status)}</div><p className="mt-1 text-[var(--muted)] whitespace-pre-wrap">{description}</p></div>
      </div>
      {canContinueTask({ status }) && (failed ? onRetry : onResume) && (
        <Button size="sm" variant="secondary" disabled={disabled} onClick={failed ? onRetry : onResume} className="gap-1.5 flex-shrink-0">
          {failed ? <RotateCcw className="w-3 h-3" /> : <Play className="w-3 h-3" />}
          <span>{failed ? 'Thử lại' : 'Tiếp tục'}</span>
        </Button>
      )}
    </div>
  );
}
