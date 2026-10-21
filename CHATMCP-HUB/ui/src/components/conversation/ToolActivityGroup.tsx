import { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, Loader2, Wrench } from 'lucide-react';
import type { ToolCall } from '@/types';
import { useTranslation } from '@/lib/i18n';
import { summarizeTools } from '@/lib/tool-labels';
import { cn } from '@/lib/utils';
import { ToolReceipt } from './ToolReceipt';

/** A run of tool calls between two messages, collapsed to one line: "Đọc 2 tệp · sửa 1 tệp · chạy 1 lệnh". */
export function ToolActivityGroup({ items }: { items: ToolCall[] }) {
  const { lang, t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const title = summarizeTools(items, lang);
  const running = items.some(t => t.status === 'running');
  const failed = items.some(t => t.status === 'error');
  return (
    <div className="my-1 overflow-hidden rounded-xl border border-line bg-panel" data-testid="tool-activity-group">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(x => !x)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-hover">
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform', expanded && 'rotate-90')} />
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="flex-1 truncate font-medium text-fg">{title}</span>
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-label={t('agents_tool_running')} />
          : failed ? <AlertCircle className="h-3.5 w-3.5 text-danger" aria-label={t('agents_tool_failed')} />
            : <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-label="Xong" />}
      </button>
      {expanded && (
        <div className="divide-y divide-line-subtle border-t border-line">
          {items.map((item, index) => <ToolReceipt key={item.id || index} tool={item} />)}
        </div>
      )}
    </div>
  );
}
