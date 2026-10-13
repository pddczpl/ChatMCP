import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

/** Shared by messages, live text, code and tool output. Confirm only a successful copy. */
export function CopyButton({ text, label = 'Sao chép', className = '' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useAppStore(state => state.showToast);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      showToast('Không thể sao chép. Hãy chọn văn bản và nhấn Ctrl+C.', 'error');
    }
  };

  return <button type="button" onClick={() => void copy()} disabled={!text} aria-label={label}
    className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50 ${className}`}>
    {copied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
    <span aria-live="polite">{copied ? 'Đã sao chép' : 'Sao chép'}</span>
  </button>;
}
