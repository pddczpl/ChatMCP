import { cn } from '@/lib/utils';

export type DotTone = 'neutral' | 'success' | 'warning' | 'danger' | 'primary';

const tones: Record<DotTone, string> = {
  neutral: 'bg-faint',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  primary: 'bg-primary',
};

/** An 8px status dot. The meaning must also be in text next to it (or in `label`): colour alone is not enough. */
export function StatusDot({ tone = 'neutral', pulse = false, label, className }: { tone?: DotTone; pulse?: boolean; label?: string; className?: string }) {
  return <span role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    className={cn('inline-block h-2 w-2 shrink-0 rounded-full', tones[tone], pulse && 'pulse-dot', className)} />;
}
