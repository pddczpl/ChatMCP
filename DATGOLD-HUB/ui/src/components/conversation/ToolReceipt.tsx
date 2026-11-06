import { useState } from 'react';
import {
  AlertCircle, Bot, CheckCircle2, ChevronRight, FileEdit, FileText, GitBranch, ListTodo, Loader2, ScanSearch, Search, Terminal, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { ToolCall } from '@/types';
import { CopyButton } from '@/components/ui/CopyButton';
import { formatToolOutput } from '@/lib/tool-output';
import { describeTool, type ToolKind } from '@/lib/tool-labels';
import { formatDuration } from '@/lib/format';
import { receiptTarget } from '@/lib/review-offer';
import { undoTarget } from '@/lib/rollback';
import { UndoStepButton } from './UndoStepButton';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText, search: Search, edit: FileEdit, run: Terminal, git: GitBranch, plan: ListTodo, agent: Bot, code: ScanSearch, tool: Wrench,
};

interface ToolReceiptProps {
  tool: ToolCall;
}

/** One tool call: what it did in words, the technical name on hover, and the recorded output when opened. */
export function ToolReceipt({ tool }: ToolReceiptProps) {
  const { lang, t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const focusReview = useAppStore((state) => state.focusReview);
  const reviewTarget = receiptTarget(tool);
  const undo = undoTarget(tool);

  const { kind, verb, target } = describeTool(tool, lang);
  const Icon = ICONS[kind];
  const isRunning = tool.status === 'running';
  const isError = tool.status === 'error';
  const isSuccess = tool.status === 'success';
  const output = formatToolOutput(tool.result ?? tool.args ?? tool.summary);
  const duration = formatDuration(tool.durationMs);

  return (
    <div className="text-[13px]" data-testid="tool-receipt" data-status={tool.status || 'unknown'}>
      <div className="flex items-center">
      <div
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${tool.name}: ${target}`}
        title={tool.name}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded(!expanded); } }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-hover"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform', expanded && 'rotate-90')} />
        <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md border',
          isError ? 'border-danger/30 bg-danger/10 text-danger' : 'border-line bg-surface text-muted')}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="shrink-0 font-medium text-fg">{verb}</span>
        {target && <span className="min-w-0 truncate font-mono text-[12px] text-muted">{target}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {duration && <span className="hidden text-[12px] tabular-nums text-faint sm:inline">{duration}</span>}
          {isRunning ? (
            <span className="flex items-center gap-1 text-[12px] text-primary"><Loader2 className="h-3 w-3 animate-spin" />{t('agents_tool_running')}</span>
          ) : isError ? (
            <span className="flex items-center gap-1 text-[12px] text-danger"><AlertCircle className="h-3 w-3" />{t('agents_tool_error')}</span>
          ) : isSuccess ? (
            <span className="flex items-center gap-1 text-[12px] text-success"><CheckCircle2 className="h-3 w-3" />{t('agents_tool_done')}</span>
          ) : <span className="text-[12px] text-warning">{t('agents_tool_unknown')}</span>}
        </span>
      </div>

      {/* Beside the row, not inside it: a button inside a button is not one control. Only an edit that went through, with the checkpoint the Hub made for that very call, leads to the review. */}
      {undo && <UndoStepButton checkpointId={undo.checkpointId} label={t('rollback_undo_step_label', { path: target || tool.name })} />}
      {reviewTarget && (
        <button type="button" onClick={() => focusReview(reviewTarget.path)} aria-label={t('review_receipt_link_label', { path: reviewTarget.path })} data-testid="receipt-review-link"
          className="mr-2 shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-hover">
          {t('review_receipt_link')}
        </button>
      )}
      </div>

      {expanded && (
        <div className="border-t border-line-subtle bg-bg px-4 py-3 select-text" data-testid="tool-output">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-muted">
              {tool.result !== undefined ? t('agents_tool_result') : t('agents_tool_recorded')}
              <span className="ml-2 font-mono font-normal text-faint">{tool.name}</span>
            </span>
            <CopyButton text={output} label={t('agents_tool_copy_result')} />
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel p-3 text-[12px] leading-6 text-fg" tabIndex={0}>
            {output || (isRunning ? t('agents_tool_waiting') : t('agents_tool_empty'))}
          </pre>
        </div>
      )}
    </div>
  );
}
