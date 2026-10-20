import { cn } from '@/lib/utils';

/** A unified diff, one line per element, tinted by what the line does. The text of every line is kept exactly as Git printed it. */
export function DiffView({ diff, label = 'Git diff', className }: { diff: string; label?: string; className?: string }) {
  const lines = diff.replace(/\n$/, '').split('\n');
  return (
    <pre aria-label={label} tabIndex={0} className={cn('max-h-[28rem] overflow-auto rounded-xl border border-line bg-bg py-1 font-mono text-[12px] leading-5', className)}>
      {lines.map((line, index) => {
        const kind = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line) ? 'meta'
          : line.startsWith('@@') ? 'hunk'
          : line.startsWith('+') ? 'add'
          : line.startsWith('-') ? 'del' : 'ctx';
        return (
          <div key={index} className={cn('min-w-max whitespace-pre border-l-2 px-3',
            kind === 'add' && 'border-success bg-success/10 text-success',
            kind === 'del' && 'border-danger bg-danger/10 text-danger',
            kind === 'hunk' && 'border-transparent bg-primary/10 text-primary',
            kind === 'meta' && 'border-transparent font-semibold text-muted',
            kind === 'ctx' && 'border-transparent text-muted')}>{line || ' '}</div>
        );
      })}
    </pre>
  );
}
