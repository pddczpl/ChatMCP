import { useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, ChevronDown, Loader2, PauseCircle, Square } from 'lucide-react';
import type { Task } from '@/types';
import { isTaskActive } from '@/lib/task-view';
import { useTranslation, type Translate } from '@/lib/i18n';
import { formatDuration, formatNumber, formatTime, formatTokens, type FormatLang } from '@/lib/format';
import { taskStateText } from '@/components/inspector/agentLabels';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

const unavailable = (missing?: number, reported?: number) => !!missing && !reported;

/**
 * What the Hub counted for a conversation, one row per fact: [label, value, a note on what the fact does not mean]. The words are the language on
 * screen's, the numbers are the Hub's; a figure the provider did not report is "unavailable" or "+ unknown", never zero.
 */
export function ribbonRows(task: Task, t: Translate, lang: FormatLang): Array<[string, string, string?]> {
  const rows: Array<[string, string, string?]> = [];
  const usage = task.usage;
  const unknownMore = ` ${t('agents_ribbon_plus_unknown')}`;
  if (usage) {
    rows.push([t('agents_ribbon_http_requests'), String(usage.httpRequests ?? 0)]);
    rows.push([t('agents_ribbon_input_tokens'), unavailable(usage.inputUsageMissing, usage.inputUsageReported) ? t('agents_ribbon_unavailable') : formatNumber(usage.inputTokens ?? 0, lang) + (usage.inputUsageMissing ? unknownMore : ''), t('agents_ribbon_input_hint')]);
    rows.push([t('agents_ribbon_output_tokens'), unavailable(usage.outputUsageMissing, usage.outputUsageReported) ? t('agents_ribbon_unavailable') : formatNumber(usage.outputTokens ?? 0, lang) + (usage.outputUsageMissing ? unknownMore : '')]);
    if ((usage.cachedInputTokens ?? 0) > 0) rows.push([t('agents_ribbon_cache_hit'), formatNumber(usage.cachedInputTokens, lang)]);
    if ((usage.cacheWriteTokens ?? 0) > 0) rows.push([t('agents_ribbon_cache_write'), formatNumber(usage.cacheWriteTokens, lang)]);
    if ((usage.reasoningTokens ?? 0) > 0) rows.push([t('agents_ribbon_reasoning'), formatNumber(usage.reasoningTokens, lang)]);
  }
  if (task.contextPolicy) {
    // A window the Hub does not know is "unknown", not a quiet "estimated" (the notice under the header says what to do about it).
    const policy = task.contextPolicy;
    const planned = policy.plannedOutputTokens ?? policy.reservedOutputTokens;
    rows.push([t('agents_ribbon_window'),
      `${formatNumber(policy.capacityTokens, lang)} (${t(policy.source === 'conservative_fallback' ? 'agents_ribbon_window_unknown' : 'agents_ribbon_window_configured')})`,
      t('agents_ribbon_window_hint', { history: formatNumber(policy.maxHistoryTokens, lang), reserved: formatNumber(policy.reservedOutputTokens, lang), planned: formatNumber(planned, lang) })]);
  }
  if (task.modelCost) {
    rows.push([t('agents_ribbon_cost'), task.modelCost.complete && task.modelCost.totalUsd !== null ? 'USD ' + task.modelCost.totalUsd.toFixed(6) : 'USD ' + task.modelCost.knownSubtotalUsd.toFixed(6) + ` ${t('agents_ribbon_cost_partial')}`,
      t('agents_ribbon_cost_hint')]);
  }
  if (task.completionOutcome?.requirements === 'unverified') {
    rows.push([t('agents_ribbon_unverified'), String(task.completionOutcome.unresolvedObjectiveIds.length), task.completionOutcome.note]);
  }
  if (task.verificationOutcome?.ready === false) {
    rows.push([t('agents_ribbon_missing'), String(task.verificationOutcome.missing.length), task.verificationOutcome.missing.join('; ')]);
  }
  return rows;
}

/**
 * The header of a conversation: which request this is, what state it is in, how long it ran, and Stop while it runs.
 * The numbers the Hub reports (requests, tokens, context, cost) are one click away, not always on screen.
 */
export function PhaseRibbon({ task, onCancel }: { task?: Task; onCancel?: () => void }) {
  const { t, lang } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!task) return null;
  const active = isTaskActive(task);
  const hasToolErrors = task.toolCalls?.some(tool => tool.status === 'error');
  const failed = task.status === 'failed' || hasToolErrors;
  const Icon = active ? Loader2 : task.status === 'failed' ? AlertTriangle : task.status === 'cancelled' ? Ban : task.status === 'paused' ? PauseCircle : hasToolErrors ? AlertTriangle : CheckCircle2;
  const iconTone = active ? 'animate-spin text-primary' : failed ? 'text-warning' : task.status === 'completed' ? 'text-muted' : 'text-muted';
  const title = (task.task || task.prompt || task.messages?.find(message => message.role === 'user')?.content || '').trim();
  const started = task.startedAt || task.createdAt;
  const duration = task.finishedAt && started ? new Date(task.finishedAt).getTime() - new Date(started).getTime() : null;
  const usage = task.usage;

  const input = unavailable(usage?.inputUsageMissing, usage?.inputUsageReported) ? t('agents_ribbon_unavailable')
    : formatTokens(usage?.inputTokens ?? 0) + (usage?.inputUsageMissing ? '+' : '');
  const output = unavailable(usage?.outputUsageMissing, usage?.outputUsageReported) ? t('agents_ribbon_unavailable')
    : formatTokens(usage?.outputTokens ?? 0) + (usage?.outputUsageMissing ? '+' : '');
  const requests = usage?.httpRequests ?? 0;
  const meta = [
    started && t('agents_ribbon_started', { time: formatTime(started, lang) }),
    duration !== null && formatDuration(duration),
    usage && t(requests === 1 ? 'agents_ribbon_requests_one' : 'agents_ribbon_requests_other', { n: requests }),
    usage && t('agents_ribbon_tokens', { input, output }),
  ].filter(Boolean).join(' · ');

  const rows = ribbonRows(task, t, lang);

  return (
    <div className="shrink-0 border-b border-line bg-panel" data-testid="task-status" data-status={task.status}>
      <div className="flex items-center gap-3 px-5 py-2.5">
        <Icon className={cn('h-[18px] w-[18px] shrink-0', iconTone)} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-semibold leading-5" title={title}>{title || t('agents_bg_untitled_chat')}</span>
            <Badge variant={active ? 'primary' : failed ? 'warning' : 'neutral'} className="shrink-0">{taskStateText(task.status, t)}</Badge>
          </div>
          {meta && <p className="truncate text-[12px] leading-4 text-muted">{meta}</p>}
        </div>
        {rows.length > 0 && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg">
            {t('agents_ribbon_details')}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        )}
        {active && onCancel && (
          <Button variant="danger" size="sm" onClick={onCancel} className="shrink-0 gap-1.5">
            <Square className="h-3 w-3 fill-current" />
            <span>{t('agents_ribbon_stop')}</span>
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
