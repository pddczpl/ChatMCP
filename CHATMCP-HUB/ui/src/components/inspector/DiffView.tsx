import { hasHidden } from '@/lib/hidden-chars';
import { cn } from '@/lib/utils';
import { HiddenNote, HiddenText } from './HiddenText';

type LineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

/**
 * What each line of a unified diff is. File headers (`--- a/x`, `+++ b/x`) only exist between "diff --git" and the first hunk; inside a hunk every
 * line starts with a space, "+" or "-", so a removed line whose text begins with "-- " (a comment) is still a removed line.
 */
function classify(lines: string[]): LineKind[] {
  let inHunk = false;
  return lines.map((line) => {
    if (line.startsWith('diff --git ')) { inHunk = false; return 'meta'; }
    if (line.startsWith('@@')) { inHunk = true; return 'hunk'; }
    if (!inHunk) return 'meta';
    return line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
  });
}

/**
 * A unified diff, one line per element, tinted by what the line does. The text of every line is kept exactly as Git printed it, except that
 * characters nobody can see are shown as markers (and the diff says so).
 */
export function DiffView({ diff, label, className }: { diff: string; label: string; className?: string }) {
  const lines = diff.replace(/\n$/, '').split('\n');
  const kinds = classify(lines);
  return (
    <>
      <HiddenNote show={hasHidden(diff)} />
      <pre role="region" aria-label={label} tabIndex={0} className={cn('max-h-[28rem] overflow-auto rounded-xl border border-line bg-bg py-1 font-mono text-[12px] leading-5', className)}>
        {lines.map((line, index) => {
          const kind = kinds[index];
          return (
            <div key={index} data-line={kind} className={cn('min-w-max whitespace-pre border-l-2 px-3',
              kind === 'add' && 'border-success bg-success/10 text-success',
              kind === 'del' && 'border-danger bg-danger/10 text-danger',
              kind === 'hunk' && 'border-transparent bg-primary/10 text-primary',
              kind === 'meta' && 'border-transparent font-semibold text-muted',
              kind === 'ctx' && 'border-transparent text-muted')}><HiddenText text={line || ' '} /></div>
          );
        })}
      </pre>
    </>
  );
}
