import * as React from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}

export function Badge({ className, variant = 'neutral', children, ...props }: BadgeProps) {
  const variants = {
    neutral: 'bg-[var(--surface)] text-[var(--muted)] border-[var(--line)]',
    success: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50',
    warning: 'bg-amber-950/40 text-amber-300 border-amber-800/50',
    danger: 'bg-rose-950/40 text-rose-300 border-rose-800/50',
    info: 'bg-sky-950/40 text-sky-300 border-sky-800/50',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border font-mono tracking-tight',
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
