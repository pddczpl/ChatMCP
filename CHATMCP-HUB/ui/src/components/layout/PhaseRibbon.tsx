import { useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, ChevronDown, Loader2, PauseCircle, Square } from 'lucide-react';
import type { Task } from '@/types';
import { isTaskActive, taskStateLabel } from '@/lib/task-view';
import { useTranslation } from '@/lib/i18n';
import { formatDuration, formatNumber, formatTime, formatTokens } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

const unavailable = (missing?: number, reported?: number) => !!missing && !reported;

/**
 * The header of a conversation: which request this is, what state it is in, how long it ran, and Stop while it runs.
 * The numbers the Hub reports (requests, tokens, context, cost) are one click away, not always on screen.
 */
export function PhaseRibbon({ task, onCancel }: { task?: Task; onCancel?: () => void }) {
  const { lang } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!task) return null;
  const vi = lang === 'vi';
  const active = isTaskActive(task);
  const hasToolErrors = task.toolCalls?.some(tool => tool.status === 'error');
  const failed = task.status === 'failed' || hasToolErrors;
  const Icon = active ? Loader2 : task.status === 'failed' ? AlertTriangle : task.status === 'cancelled' ? Ban : task.status === 'paused' ? PauseCircle : hasToolErrors ? AlertTriangle : CheckCircle2;
  const iconTone = active ? 'animate-spin text-primary' : failed ? 'text-warning' : task.status === 'completed' ? 'text-muted' : 'text-muted';
  const title = (task.task || task.prompt || task.messages?.find(message => message.role === 'user')?.content || '').trim();
  const started = task.startedAt || task.createdAt;
  const duration = task.finishedAt && started ? new Date(task.finishedAt).getTime() - new Date(started).getTime() : null;
  const usage = task.usage;

  const input = unavailable(usage?.inputUsageMissing, usage?.inputUsageReported) ? (vi ? 'không có' : 'unavailable')
    : formatTokens(usage?.inputTokens ?? 0) + (usage?.inputUsageMissing ? '+' : '');
  const output = unavailable(usage?.outputUsageMissing, usage?.outputUsageReported) ? (vi ? 'không có' : 'unavailable')
    : formatTokens(usage?.outputTokens ?? 0) + (usage?.outputUsageMissing ? '+' : '');
  const meta = [
    started && (vi ? `Bắt đầu ${formatTime(started, lang)}` : `Started ${formatTime(started, lang)}`),
    duration !== null && formatDuration(duration),
    usage && (vi ? `${usage.httpRequests ?? 0} yêu cầu model` : `${usage.httpRequests ?? 0} model requests`),
    usage && (vi ? `vào ${input} · ra ${output} token` : `in ${input} · out ${output} tokens`),
  ].filter(Boolean).join(' · ');

  const rows: Array<[string, string, string?]> = [];
  if (usage) {
    rows.push([vi ? 'Yêu cầu HTTP tới model' : 'Model HTTP requests', String(usage.httpRequests ?? 0)]);
    rows.push([vi ? 'Token đầu vào (nhà cung cấp báo)' : 'Input tokens (provider-reported)', unavailable(usage.inputUsageMissing, usage.inputUsageReported) ? (vi ? 'không có' : 'unavailable') : formatNumber(usage.inputTokens ?? 0, lang) + (usage.inputUsageMissing ? (vi ? ' (+ chưa rõ)' : ' (+ unknown)') : ''), vi ? 'Chỉ tính token do nhà cung cấp báo. Thiếu báo cáo là chưa rõ, không phải bằng 0.' : 'Only provider-reported tokens. A missing report is unknown, not zero.']);
    rows.push([vi ? 'Token đầu ra (nhà cung cấp báo)' : 'Output tokens (provider-reported)', unavailable(usage.outputUsageMissing, usage.outputUsageReported) ? (vi ? 'không có' : 'unavailable') : formatNumber(usage.outputTokens ?? 0, lang) + (usage.outputUsageMissing ? (vi ? ' (+ chưa rõ)' : ' (+ unknown)') : '')]);
    if ((usage.cachedInputTokens ?? 0) > 0) rows.push([vi ? 'Cache đã dùng' : 'Cache hit', formatNumber(usage.cachedInputTokens, lang)]);
    if ((usage.cacheWriteTokens ?? 0) > 0) rows.push([vi ? 'Cache đã ghi' : 'Cache write', formatNumber(usage.cacheWriteTokens, lang)]);
    if ((usage.reasoningTokens ?? 0) > 0) rows.push([vi ? 'Token suy luận' : 'Reasoning tokens', formatNumber(usage.reasoningTokens, lang)]);
  }
  if (task.contextPolicy) {
    rows.push([vi ? 'Cửa sổ ngữ cảnh' : 'Context window', `${formatNumber(task.contextPolicy.capacityTokens, lang)} (${task.contextPolicy.source === 'conservative_fallback' ? (vi ? 'ước tính' : 'estimated') : (vi ? 'đã cấu hình' : 'configured')})`,
      vi ? `Lịch sử tối đa ${formatNumber(task.contextPolicy.maxHistoryTokens, lang)} token; dành ${formatNumber(task.contextPolicy.reservedOutputTokens, lang)} cho đầu ra. Không phải số token đã tính phí.` : `History up to ${formatNumber(task.contextPolicy.maxHistoryTokens, lang)} tokens; ${formatNumber(task.contextPolicy.reservedOutputTokens, lang)} reserved for output. Not billed usage.`]);
  }
  if (task.modelCost) {
    rows.push([vi ? 'Chi phí ghi nhận' : 'Recorded cost', task.modelCost.complete && task.modelCost.totalUsd !== null ? 'USD ' + task.modelCost.totalUsd.toFixed(6) : 'USD ' + task.modelCost.knownSubtotalUsd.toFixed(6) + (vi ? ' (tạm tính, tổng chưa rõ)' : ' (known subtotal, total unknown)'),
      vi ? 'Chỉ gồm giá do chủ máy nhập và số liệu nhà cung cấp báo. Retry và lỗi có thể phát sinh phí chưa rõ.' : 'Owner-supplied prices and provider-reported usage only. Retries and errors can produce unknown charges.']);
  }
  if (task.completionOutcome?.requirements === 'unverified') {
    rows.push([vi ? 'Yêu cầu chưa xác minh' : 'Requirements unverified', String(task.completionOutcome.unresolvedObjectiveIds.length), task.completionOutcome.note]);
  }
  if (task.verificationOutcome?.ready === false) {
    rows.push([vi ? 'Kiểm tra còn thiếu' : 'Checks missing', String(task.verificationOutcome.missing.length), task.verificationOutcome.missing.join('; ')]);
  }

  return (
    <div className="shrink-0 border-b border-line bg-panel" data-testid="task-status" data-status={task.status}>
      <div className="flex items-center gap-3 px-5 py-2.5">
        <Icon className={cn('h-[18px] w-[18px] shrink-0', iconTone)} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-semibold leading-5" title={title}>{title || (vi ? 'Cuộc hội thoại' : 'Conversation')}</span>
            <Badge variant={active ? 'primary' : failed ? 'warning' : 'neutral'} className="shrink-0">{taskStateLabel(task.status)}</Badge>
          </div>
          {meta && <p className="truncate text-[12px] leading-4 text-muted">{meta}</p>}
        </div>
        {rows.length > 0 && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg">
            {vi ? 'Chi tiết' : 'Details'}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        )}
        {active && onCancel && (
          <Button variant="danger" size="sm" onClick={onCancel} className="shrink-0 gap-1.5">
            <Square className="h-3 w-3 fill-current" />
            <span>Dừng agent</span>
          </Button>
        )}
      </div>
      {open && rows.length > 0 && (
        <dl data-testid="agent-request-budget" role="status" className="grid grid-cols-1 gap-x-8 gap-y-0 border-t border-line-subtle px-5 py-2 text-[12px] sm:grid-cols-2">
          {rows.map(([label, value, hint]) => (
            <div key={label} title={hint} className="flex items-baseline justify-between gap-3 border-b border-line-subtle py-1.5 last:border-b-0">
              <dt className="text-muted">{label}</dt>
              <dd className="text-right font-medium tabular-nums text-fg">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
