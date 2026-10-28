import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';

/** Shared by messages, live text, code and tool output. Confirm only a successful copy. */
export function CopyButton({ text, label, className = '' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useAppStore(state => state.showToast);
  const { t } = useTranslation();
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      showToast(t('agents_copy_failed'), 'error');
    }
  };

  return <button type="button" onClick={() => void copy()} disabled={!text} aria-label={label ?? t('agents_copy')}
    className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-50 ${className}`}>
    {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    <span aria-live="polite">{copied ? t('agents_copied') : t('agents_copy')}</span>
  </button>;
}
