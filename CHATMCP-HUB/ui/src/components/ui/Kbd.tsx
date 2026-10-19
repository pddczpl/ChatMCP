import { cn } from '@/lib/utils';

/** A keyboard shortcut hint, e.g. <Kbd>Ctrl K</Kbd>. */
export function Kbd({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <kbd className={cn('inline-flex h-5 items-center rounded-md border border-line bg-panel px-1.5 font-mono text-[11px] font-medium leading-none text-faint', className)}>
      {children}
    </kbd>
  );
}
