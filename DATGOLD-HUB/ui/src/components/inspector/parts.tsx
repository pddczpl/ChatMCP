import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The scrolling body of a work-panel tab: one padding, one rhythm. */
export function TabBody({ label, className, testId, children }: { label: string; className?: string; testId?: string; children: React.ReactNode }) {
  return <section aria-label={label} data-testid={testId} className={cn('h-full space-y-5 overflow-y-auto px-4 py-4 text-[13px] leading-5 select-text', className)}>{children}</section>;
}

/** A section title with an optional count and a control on the right. */
export function SectionHeading({ title, count, action, className }: { title: React.ReactNode; count?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
        {title}
        {count !== undefined && <span className="rounded-full bg-hover px-1.5 text-[12px] font-medium tabular-nums text-muted">{count}</span>}
      </h3>
      {action}
    </div>
  );
}

/** Nothing here yet: an icon, one line, and (optionally) what to do next. */
export function EmptyBlock({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface text-faint"><Icon className="h-5 w-5" /></span>
      <p className="text-[13px] font-medium text-muted">{title}</p>
      {hint && <p className="max-w-xs text-[12px] leading-4 text-faint">{hint}</p>}
    </div>
  );
}

export function ErrorLine({ message }: { message: string }) {
  return <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">{message}</p>;
}

export function LoadingLine({ text }: { text: string }) {
  return <p role="status" className="text-[13px] text-muted">{text}</p>;
}

/** A bordered row of the work panel (a plan step, a file, a checkpoint, an event). */
export function RowCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('rounded-xl border border-line bg-surface px-3 py-2.5', className)}>{children}</div>;
}
