import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToastProps {
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  onClose?: () => void;
}

const icons = {
  info: <Info className="h-4 w-4 shrink-0 text-primary" />,
  success: <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />,
  warning: <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />,
  error: <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />,
};

const accents = {
  info: 'border-l-primary',
  success: 'border-l-success',
  warning: 'border-l-warning',
  error: 'border-l-danger',
};

export function Toast({ message, type = 'info', onClose }: ToastProps) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'anim-rise fixed bottom-10 right-4 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-line border-l-[3px] bg-panel px-4 py-3 text-[13px] leading-5 text-fg shadow-[var(--shadow-pop)] select-text',
        accents[type]
      )}
    >
      <span className="mt-0.5">{icons[type]}</span>
      <span className="flex-1 font-medium">{message}</span>
      {onClose && (
        <button
          onClick={onClose}
          className="-mr-1 rounded-md p-1 text-faint transition-colors hover:bg-hover hover:text-fg"
          aria-label={t('agents_toast_close')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * Messages. While the Settings dialog is open it covers the page, so the toast is drawn inside it (`scope="settings"`) and the
 * page's own container stays quiet: exactly one toast exists at any time.
 */
export function ToastContainer({ scope = 'app' }: { scope?: 'app' | 'settings' }) {
  const toast = useAppStore((s) => s.toast);
  const clearToast = useAppStore((s) => s.clearToast);
  const settingsOpen = useAppStore((s) => s.settingsOpen);

  if (!toast) return null;
  if ((scope === 'app') === settingsOpen) return null;

  return <Toast message={toast.message} type={toast.type} onClose={clearToast} />;
}
