import { useState } from 'react';
import { 
  FileCode, 
  FileEdit, 
  Terminal, 
  GitBranch, 
  Search, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  ChevronRight, 
  ChevronDown, 
  Copy, 
  Check 
} from 'lucide-react';
import { ToolCall } from '@/types';

interface ToolReceiptProps {
  tool: ToolCall;
}

export function ToolReceipt({ tool }: ToolReceiptProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const getToolIcon = (name: string) => {
    if (name.includes('write') || name.includes('create') || name.includes('replace')) {
      return FileEdit;
    }
    if (name.includes('read') || name.includes('view') || name.includes('file')) {
      return FileCode;
    }
    if (name.includes('bash') || name.includes('cmd') || name.includes('exec')) {
      return Terminal;
    }
    if (name.includes('git')) {
      return GitBranch;
    }
    return Search;
  };

  const Icon = getToolIcon(tool.name);
  const isRunning = tool.status === 'running';
  const isError = tool.status === 'error';
  const isSuccess = tool.status === 'success' || !tool.status;

  const summary = tool.args?.path || tool.args?.cmd || tool.args?.query || tool.summary || tool.args?.TargetFile || '';

  const handleCopyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    const content = typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result || tool.args, null, 2);
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-4 my-2 border border-[var(--line)] rounded-lg bg-[var(--surface)] overflow-hidden text-xs select-none shadow-sm transition-all">
      {/* Header Bar */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[var(--surface-hover)] transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <button className="text-[var(--faint)] hover:text-[var(--text)]">
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          
          <div className="w-5 h-5 rounded bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center justify-center flex-shrink-0">
            <Icon className="w-3 h-3" />
          </div>

          <span className="font-mono font-semibold text-xs text-[var(--text)]">
            {tool.name}
          </span>

          {summary && (
            <span className="font-mono text-[11px] text-[var(--faint)] truncate max-w-[280px] sm:max-w-md">
              {summary}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {tool.durationMs !== undefined && (
            <span className="text-[10px] font-mono text-[var(--faint)]">
              {tool.durationMs < 1000 ? `${tool.durationMs}ms` : `${(tool.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}

          {isRunning ? (
            <div className="flex items-center gap-1 text-sky-400 text-[11px]">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Đang chạy</span>
            </div>
          ) : isError ? (
            <div className="flex items-center gap-1 text-rose-400 text-[11px]">
              <AlertCircle className="w-3 h-3" />
              <span>Lỗi</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-emerald-400 text-[11px]">
              <CheckCircle2 className="w-3 h-3" />
              <span>Xong</span>
            </div>
          )}
        </div>
      </div>

      {/* Expanded Output / Payload */}
      {expanded && (
        <div className="border-t border-[var(--line)] bg-[#0c1016] p-3 text-[11px] font-mono">
          <div className="flex items-center justify-between mb-2 pb-1 border-b border-[var(--line-subtle)]">
            <span className="text-[var(--faint)] font-sans text-[10px] uppercase tracking-wider">
              {tool.result ? 'Kết quả phản hồi' : 'Tham số gọi tool'}
            </span>
            <button
              onClick={handleCopyOutput}
              className="flex items-center gap-1 text-[var(--faint)] hover:text-[var(--text)] transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  <span className="text-emerald-400 text-[10px]">Đã chép</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span className="text-[10px]">Sao chép</span>
                </>
              )}
            </button>
          </div>

          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap text-[var(--text)] text-[11px] leading-relaxed">
            {typeof tool.result === 'string'
              ? tool.result
              : JSON.stringify(tool.result || tool.args, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
