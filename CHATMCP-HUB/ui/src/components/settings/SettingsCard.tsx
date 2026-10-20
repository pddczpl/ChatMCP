import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type SettingsCardProps = Omit<React.HTMLAttributes<HTMLElement>, 'title'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  /** Something on the right of the heading: a status badge, a button. */
  action?: React.ReactNode;
};

/** The one container of every settings section: a heading, a sentence about it, and the controls. */
export function SettingsCard({ title, description, icon: Icon, action, children, className, ...rest }: SettingsCardProps) {
  return (
    <section className={cn('rounded-xl border border-line bg-panel', className)} {...rest}>
      <div className="flex items-start justify-between gap-4 px-5 pt-5">
        <div className="flex min-w-0 items-start gap-3">
          {Icon && (
            <span aria-hidden="true" className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-primary">
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold leading-6 tracking-tight text-fg">{title}</h3>
            {description && <p className="mt-0.5 text-[13px] leading-5 text-muted">{description}</p>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

/** A key / value line used for read-only facts (host, backend, limits). */
export function FactRow({ label, children, tone }: { label: React.ReactNode; children: React.ReactNode; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line-subtle py-2 text-[13px] last:border-b-0">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className={cn('min-w-0 text-right font-medium text-fg', tone === 'success' && 'text-success', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger')}>{children}</dd>
    </div>
  );
}
