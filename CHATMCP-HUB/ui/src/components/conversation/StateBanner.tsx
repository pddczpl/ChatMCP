import { AlertTriangle, PauseCircle, XCircle, RotateCcw, Play, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface StateBannerProps {
  status?: string;
  message?: string;
  onResume?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
}

export function StateBanner({ status, message, onResume, onRetry, onCancel }: StateBannerProps) {
  if (!status || status === 'completed' || status === 'success' || status === 'working') {
    return null;
  }

  const isPaused = status === 'paused' || status === 'waiting_input';
  const isFailed = status === 'failed' || status === 'error';
  const isOffline = status === 'offline';

  return (
    <div className="mx-4 my-3 p-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] text-xs flex items-center justify-between gap-3 shadow-md animate-in fade-in slide-in-from-top-2">
      <div className="flex items-center gap-2.5 min-w-0">
        {isPaused && (
          <div className="w-7 h-7 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
            <PauseCircle className="w-4 h-4" />
          </div>
        )}
        {isFailed && (
          <div className="w-7 h-7 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center flex-shrink-0">
            <XCircle className="w-4 h-4" />
          </div>
        )}
        {isOffline && (
          <div className="w-7 h-7 rounded-full bg-slate-500/20 text-slate-400 border border-slate-500/30 flex items-center justify-center flex-shrink-0">
            <WifiOff className="w-4 h-4" />
          </div>
        )}

        <div className="min-w-0">
          <div className="font-semibold text-[var(--text)]">
            {isPaused ? 'Tác vụ đang tạm dừng' : isFailed ? 'Tác vụ gặp sự cố' : isOffline ? 'Mất kết nối với Hub' : 'Cần người dùng xác nhận'}
          </div>
          <div className="text-[11px] text-[var(--muted)] truncate">
            {message || (isPaused ? 'Chờ chỉ dẫn bổ sung để tiếp tục.' : 'Đã có lỗi xảy ra trong quá trình thực thi.')}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {isPaused && onResume && (
          <Button size="sm" variant="primary" onClick={onResume} className="gap-1.5 h-7 text-xs">
            <Play className="w-3 h-3" />
            <span>Tiếp tục</span>
          </Button>
        )}

        {isFailed && onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry} className="gap-1.5 h-7 text-xs">
            <RotateCcw className="w-3 h-3" />
            <span>Thử lại</span>
          </Button>
        )}

        {onCancel && (
          <Button size="sm" variant="danger" onClick={onCancel} className="gap-1.5 h-7 text-xs">
            <XCircle className="w-3 h-3" />
            <span>Hủy tác vụ</span>
          </Button>
        )}
      </div>
    </div>
  );
}
