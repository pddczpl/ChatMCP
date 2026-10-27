import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Terminal, Copy, Check, ArrowDown } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function TerminalTab() {
  const { t, lang } = useTranslation();
  const { showToast } = useAppStore();
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);
  const hubQuery = useQuery({ queryKey: ['hubState'], queryFn: api.getState });
  const workspace = hubQuery.data?.workspace?.path ?? '';
  const terminalQuery = useQuery({ queryKey: ['terminals', workspace], queryFn: api.getTerminals, enabled: Boolean(workspace), refetchInterval: 2000 });
  const sessions = terminalQuery.data ?? [];
  const error = hubQuery.error || terminalQuery.error;
  const allLogsText = sessions.map((session) => `$ ${session.command}\n${session.status} · Exit: ${session.exitCode ?? '—'}\n${(session.logs ?? []).map((line) => line.message).join('')}`).join('\n\n');

  useEffect(() => {
    if (autoScroll) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allLogsText, autoScroll]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(allLogsText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not copy terminal output', 'error');
    }
  };

  return (
    <section aria-label="Terminal sessions" className="flex h-full flex-col bg-bg font-mono text-[12px]">
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-panel px-4 py-2 font-sans">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-fg"><Terminal className="h-4 w-4 text-primary" /><span>{t('terminal_title')}</span></div>
        <div className="flex items-center gap-1">
          <button aria-pressed={autoScroll} onClick={() => setAutoScroll(!autoScroll)}
            className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium transition-colors', autoScroll ? 'bg-primary/10 text-primary' : 'text-muted hover:bg-hover hover:text-fg')} title={t('terminal_autoscroll')}>
            <ArrowDown className="h-3 w-3" /><span>{t('terminal_autoscroll')}</span>
          </button>
          <button aria-label="Copy terminal output" disabled={!sessions.length} onClick={handleCopy}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40" title="Copy terminal output">
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4 leading-relaxed text-muted select-text">
        {error ? <p role="alert" className="font-sans text-[13px] text-danger">{error.message}</p>
          : hubQuery.isLoading || terminalQuery.isLoading ? <p role="status" className="font-sans text-[13px]">{lang === 'vi' ? 'Đang tải terminal…' : 'Loading terminals…'}</p>
          : !workspace ? <p className="font-sans text-[13px]">{lang === 'vi' ? 'Chọn workspace để xem terminal.' : 'Select a workspace to view terminals.'}</p>
          : sessions.length === 0 ? <p className="py-10 text-center font-sans text-[13px] text-faint">{t('terminal_empty')}</p>
          : sessions.map((session) => (
            <article key={session.id} className="space-y-1.5 rounded-xl border border-line bg-panel p-3">
              <div className="break-words text-primary">$ {session.command || (session.interactive ? 'Interactive shell' : session.id)}</div>
              <div className={session.status === 'failed' ? 'text-danger' : 'text-faint'}>{session.status} · Exit: {session.exitCode ?? '—'}{session.mode && ` · ${session.mode}`}</div>
              <pre className="whitespace-pre-wrap break-words font-mono text-fg">{(session.logs ?? []).map((line, index) => <span key={line.seq ?? index} className={line.type === 'stderr' ? 'text-danger' : undefined}>{line.message}</span>)}</pre>
            </article>
          ))}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}
