import * as React from 'react';
import { cn } from '@/lib/utils';

export type CardProps = React.HTMLAttributes<HTMLDivElement>;

/** A bordered surface. No shadow and no motion: depth comes from the border and the surface colour. */
export function Card({ className, children, ...props }: CardProps) {
  return (
    <div
      className={cn('rounded-xl border border-line bg-panel text-fg transition-colors', className)}
      {...props}
    >
      {children}
    </div>
  );
}
