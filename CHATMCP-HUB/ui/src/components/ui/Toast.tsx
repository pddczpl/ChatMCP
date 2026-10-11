import { useAppStore } from '@/store/useAppStore';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToastProps {
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  onClose?: () => void;
}

export function Toast({ message, type = 'info', onClose }: ToastProps) {
  const icons = {
    info: <Info className="w-4 h-4 text-sky-400 flex-shrink-0" />,
    success: <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />,
    warning: <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />,
    error: <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />,
  };

  const borderColors = {
    info: 'border-sky-800 bg-sky-950/90 text-sky-200',
    success: 'border-emerald-800 bg-emerald-950/90 text-emerald-200',
    warning: 'border-amber-800 bg-amber-950/90 text-amber-200',
    error: 'border-rose-800 bg-rose-950/90 text-rose-200',
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-lg border shadow-xl backdrop-blur max-w-md text-xs modal-3d-enter',
        borderColors[type]
      )}
    >
      {icons[type]}
      <span className="flex-1 font-medium">{message}</span>
      {onClose && (
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-black/20 text-current opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Đóng thông báo"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export function ToastContainer() {
  const toast = useAppStore((s) => s.toast);
  const clearToast = useAppStore((s) => s.clearToast);

  if (!toast) return null;

  return <Toast message={toast.message} type={toast.type} onClose={clearToast} />;
}
