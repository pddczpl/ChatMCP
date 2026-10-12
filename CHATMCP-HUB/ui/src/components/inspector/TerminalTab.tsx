import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Terminal, Copy, Check, ArrowDown } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';

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
    <section aria-label="Terminal sessions" className="h-full flex flex-col bg-[#090d12] text-xs font-mono">
      <div className="px-3 py-1.5 bg-[var(--surface)] border-b border-[var(--line)] flex items-center justify-between text-[11px] text-[var(--muted)] flex-shrink-0 font-sans">
        <div className="flex items-center gap-2"><Terminal className="w-3.5 h-3.5 text-sky-400" /><span className="font-semibold text-xs">{t('terminal_title')}</span></div>
        <div className="flex items-center gap-2">
          <button aria-pressed={autoScroll} onClick={() => setAutoScroll(!autoScroll)} className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${autoScroll ? 'text-sky-400 bg-sky-950/40' : 'text-[var(--faint)]'}`} title={t('terminal_autoscroll')}><ArrowDown className="w-3 h-3" /><span>{t('terminal_autoscroll')}</span></button>
          <button aria-label="Copy terminal output" disabled={!sessions.length} onClick={handleCopy} className="p-1 rounded hover:bg-[var(--line)] disabled:opacity-40" title="Copy terminal output">{copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-[11px] leading-relaxed text-slate-300 space-y-3">
        {error ? <p role="alert" className="text-rose-400">{error.message}</p>
          : hubQuery.isLoading || terminalQuery.isLoading ? <p role="status">{lang === 'vi' ? 'Đang tải terminal…' : 'Loading terminals…'}</p>
          : !workspace ? <p>{lang === 'vi' ? 'Chọn workspace để xem terminal.' : 'Select a workspace to view terminals.'}</p>
          : sessions.length === 0 ? <p className="text-[var(--faint)] italic py-8 text-center font-sans">{t('terminal_empty')}</p>
          : sessions.map((session) => (
            <article key={session.id} className="border border-[var(--line-subtle)] rounded p-2 space-y-2">
              <div className="break-words text-sky-300">$ {session.command || (session.interactive ? 'Interactive shell' : session.id)}</div>
              <div className={session.status === 'failed' ? 'text-rose-400' : 'text-[var(--muted)]'}>{session.status} · Exit: {session.exitCode ?? '—'}{session.mode && ` · ${session.mode}`}</div>
              <pre className="whitespace-pre-wrap break-words font-mono">{(session.logs ?? []).map((line, index) => <span key={line.seq ?? index} className={line.type === 'stderr' ? 'text-rose-300' : undefined}>{line.message}</span>)}</pre>
            </article>
          ))}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}
