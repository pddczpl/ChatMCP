import { AlertTriangle, Ban, PauseCircle, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { taskStateLabel, isTaskActive, canContinueTask } from '@/lib/task-view';
import { cn } from '@/lib/utils';

interface StateBannerProps {
  status?: string;
  message?: string;
  onResume?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  disabled?: boolean;
}

/** Shown when a conversation stopped without a normal answer: why, and the one next step. */
export function StateBanner({ status, message, onResume, onRetry, disabled }: StateBannerProps) {
  if (!status || status === 'completed' || isTaskActive({ status })) return null;
  const failed = status === 'failed';
  const description = message || (status === 'uncertain'
    ? 'Kiểm tra thay đổi trước khi tiếp tục: một thao tác có thể đã chạy nhưng chưa có kết quả.'
    : status === 'cancelled' ? 'Việc dừng không hoàn tác những thay đổi đã thực hiện.'
      : status === 'paused' ? 'Gửi chỉ dẫn mới hoặc tiếp tục cùng cuộc hội thoại.' : 'Xem nhật ký để biết chi tiết.');
  const Icon = failed ? AlertTriangle : status === 'cancelled' ? Ban : status === 'paused' ? PauseCircle : AlertTriangle;
  const tone = failed ? 'border-danger/30 bg-danger/[0.06] text-danger' : 'border-warning/30 bg-warning/[0.06] text-warning';
  return (
    <div className="my-4 flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3 text-[13px]" role="status">
      <div className="flex min-w-0 items-start gap-3">
        <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border', tone)}><Icon className="h-4 w-4" /></span>
        <div className="min-w-0">
          <div className="font-semibold text-fg">{taskStateLabel(status)}</div>
          <p className="mt-0.5 whitespace-pre-wrap leading-5 text-muted">{description}</p>
        </div>
      </div>
      {canContinueTask({ status }) && (failed ? onRetry : onResume) && (
        <Button size="sm" variant="secondary" disabled={disabled} onClick={failed ? onRetry : onResume} className="shrink-0 gap-1.5">
          {failed ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          <span>{failed ? 'Thử lại' : 'Tiếp tục'}</span>
        </Button>
      )}
    </div>
  );
}
