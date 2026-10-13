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
  ChevronDown
} from 'lucide-react';
import { ToolCall } from '@/types';
import { CopyButton } from '@/components/ui/CopyButton';
import { formatToolOutput } from '@/lib/tool-output';

interface ToolReceiptProps {
  tool: ToolCall;
}

export function ToolReceipt({ tool }: ToolReceiptProps) {
  const [expanded, setExpanded] = useState(false);

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
  const isSuccess = tool.status === 'success';

  const summary = tool.args?.path || tool.args?.command || tool.args?.cmd || tool.args?.query || tool.summary || tool.args?.TargetFile || '';

  const output = formatToolOutput(tool.result ?? tool.args ?? tool.summary);

  return (
    <div className="mx-4 my-2 border border-[var(--line)] rounded-lg bg-[var(--panel)] overflow-hidden text-xs" data-testid="tool-receipt" data-status={tool.status || 'unknown'}>
      {/* Header Bar */}
      <div
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${tool.name}: ${summary}`}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded(!expanded); } }}
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[var(--surface-hover)] transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[var(--faint)] hover:text-[var(--text)]">
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </span>
          
          <div className="w-5 h-5 rounded bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center justify-center flex-shrink-0">
            <Icon className="w-3 h-3" />
          </div>

          <span className="font-medium text-xs text-[var(--text)] truncate shrink-0 max-w-[50%]">
            {tool.name}
          </span>

          {summary && (
            <span className="text-xs text-[var(--muted)] truncate">
              {summary}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {tool.durationMs !== undefined && (
            <span className="text-xs tabular-nums text-[var(--muted)] hidden sm:inline">
              {tool.durationMs < 1000 ? `${tool.durationMs}ms` : `${(tool.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}

          {isRunning ? (
            <div className="flex items-center gap-1 text-[var(--primary)] text-xs">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Đang chạy</span>
            </div>
          ) : isError ? (
            <div className="flex items-center gap-1 text-[var(--danger)] text-xs">
              <AlertCircle className="w-3 h-3" />
              <span>Lỗi</span>
            </div>
          ) : isSuccess ? (
            <div className="flex items-center gap-1 text-[var(--success)] text-xs">
              <CheckCircle2 className="w-3 h-3" />
              <span>Xong</span>
            </div>
          ) : <span className="text-[var(--warning)] text-xs">Chưa rõ kết quả</span>}
        </div>
      </div>

      {/* Expanded Output / Payload */}
      {expanded && (
        <div className="border-t border-[var(--line)] bg-[var(--bg)] p-3 select-text" data-testid="tool-output">
          <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-[var(--line-subtle)]">
            <span className="text-[var(--muted)] text-xs font-medium">
              {tool.result !== undefined ? 'Kết quả phản hồi' : 'Chi tiết công cụ đã ghi nhận'}
            </span>
            <CopyButton text={output} label="Sao chép kết quả" />
          </div>

          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-[var(--text)] text-xs leading-7" tabIndex={0}>
            {output || (isRunning ? 'Đang chờ kết quả…' : 'Không có nội dung phản hồi.')}
          </pre>
        </div>
      )}
    </div>
  );
}
