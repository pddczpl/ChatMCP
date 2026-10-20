import * as React from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
}

/** A small status label. Sentence case, no monospace: it is read, not parsed. */
export function Badge({ className, variant = 'neutral', children, ...props }: BadgeProps) {
  const variants = {
    neutral: 'bg-surface text-muted border-line',
    primary: 'bg-primary/10 text-primary border-primary/30',
    info: 'bg-primary/10 text-primary border-primary/30',
    success: 'bg-success/10 text-success border-success/30',
    warning: 'bg-warning/10 text-warning border-warning/30',
    danger: 'bg-danger/10 text-danger border-danger/30',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[12px] font-medium leading-4',
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
