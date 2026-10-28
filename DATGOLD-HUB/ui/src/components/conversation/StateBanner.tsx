import { AlertTriangle, Ban, PauseCircle, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { isTaskActive, canContinueTask } from '@/lib/task-view';
import { useTranslation } from '@/lib/i18n';
import { taskStateText } from '@/components/inspector/agentLabels';
import { cn } from '@/lib/utils';

interface StateBannerProps {
  status?: string;
  message?: string;
  onResume?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  disabled?: boolean;
}

/**
 * Shown when a conversation stopped without a normal answer: why, and the one next step. What the Hub wrote about it (`message`) comes first and is
 * shown as written. The words are asked for before the early return: a hook belongs before any return, whatever state the conversation is in.
 */
export function StateBanner({ status, message, onResume, onRetry, disabled }: StateBannerProps) {
  const { t } = useTranslation();
  if (!status || status === 'completed' || isTaskActive({ status })) return null;
  const failed = status === 'failed';
  const description = message || t(status === 'uncertain' ? 'agents_banner_uncertain'
    : status === 'cancelled' ? 'agents_banner_cancelled'
      : status === 'paused' ? 'agents_banner_paused' : 'agents_banner_default');
  const Icon = failed ? AlertTriangle : status === 'cancelled' ? Ban : status === 'paused' ? PauseCircle : AlertTriangle;
  const tone = failed ? 'border-danger/30 bg-danger/[0.06] text-danger' : 'border-warning/30 bg-warning/[0.06] text-warning';
  return (
    <div className="my-4 flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3 text-[13px]" role="status">
      <div className="flex min-w-0 items-start gap-3">
        <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border', tone)}><Icon className="h-4 w-4" /></span>
        <div className="min-w-0">
          <div className="font-semibold text-fg">{taskStateText(status, t)}</div>
          <p className="mt-0.5 whitespace-pre-wrap leading-5 text-muted">{description}</p>
        </div>
      </div>
      {canContinueTask({ status }) && (failed ? onRetry : onResume) && (
        <Button size="sm" variant="secondary" disabled={disabled} onClick={failed ? onRetry : onResume} className="shrink-0 gap-1.5">
          {failed ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          <span>{t(failed ? 'agents_banner_retry' : 'agents_banner_continue')}</span>
        </Button>
      )}
    </div>
  );
}
