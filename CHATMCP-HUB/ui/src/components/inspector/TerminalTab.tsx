import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Terminal, Copy, Trash2, Check, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function TerminalTab() {
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 2000 });
  const terminalLogs = hub?.terminalLogs || hub?.logs || [];

  useEffect(() => {
    if (autoScroll) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, autoScroll]);

  const allLogsText = terminalLogs.map((l: any) => typeof l === 'string' ? l : l.message || JSON.stringify(l)).join('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(allLogsText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="h-full flex flex-col bg-[#090d12] text-xs font-mono select-none">
      {/* Terminal Toolbar */}
      <div className="px-3 py-1.5 bg-[var(--surface)] border-b border-[var(--line)] flex items-center justify-between text-[11px] text-[var(--muted)] flex-shrink-0 font-sans">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-sky-400" />
          <span className="font-semibold text-xs">Terminal Output</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
              autoScroll ? 'text-sky-400 bg-sky-950/40' : 'text-[var(--faint)]'
            }`}
            title="Tự động cuộn theo log mới"
          >
            <ArrowDown className="w-3 h-3" />
            <span>Auto-scroll</span>
          </button>

          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--line)] text-[var(--faint)] hover:text-[var(--text)] transition-colors"
            title="Sao chép toàn bộ log"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Terminal Content Screen */}
      <div className="flex-1 overflow-y-auto p-3 text-[11px] leading-relaxed text-slate-300 space-y-1">
        {terminalLogs.length === 0 ? (
          <div className="text-[var(--faint)] italic py-8 text-center font-sans">
            Không có nhật ký terminal nào đang chạy
          </div>
        ) : (
          terminalLogs.map((item: any, idx: number) => {
            const line = typeof item === 'string' ? item : item.message || JSON.stringify(item);
            const isError = line.toLowerCase().includes('error') || line.toLowerCase().includes('failed');
            const isSuccess = line.toLowerCase().includes('success') || line.toLowerCase().includes('done');
            return (
              <div
                key={idx}
                className={`whitespace-pre-wrap ${
                  isError ? 'text-rose-400' : isSuccess ? 'text-emerald-300' : 'text-slate-300'
                }`}
              >
                {line}
              </div>
            );
          })
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
