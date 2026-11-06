import { useState } from 'react';
import type { DiffRow } from '@/lib/review-hunks';
import { ROW_LIMIT, lineBody, terminatorOf, visibleRows } from '@/lib/review-rules';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { HiddenText } from './HiddenText';

const GUTTER = { context: ' ', removed: '-', added: '+' } as const;

/**
 * The lines of a hunk, one row each, tinted by what the line does. A line is shown without the characters that end it (its ending is named instead, for a hunk whose only change is
 * an ending), and characters nobody can see are shown as markers. A long hunk shows its first rows and a button for the rest.
 */
export function ReviewRows({ rows, showEndings }: { rows: readonly DiffRow[]; showEndings: boolean }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(ROW_LIMIT);
  const { rows: open, hidden } = visibleRows(rows, shown);
  return (
    <div className="overflow-x-auto py-1 font-mono text-[12px] leading-5">
      {open.map((row, index) => (
        <div key={index} data-row={row.kind}
          className={cn('flex min-w-max gap-2 whitespace-pre border-l-2 px-2',
            row.kind === 'added' && 'border-success bg-success/10 text-success',
            row.kind === 'removed' && 'border-danger bg-danger/10 text-danger',
            row.kind === 'context' && 'border-transparent text-muted')}>
          <span aria-hidden="true" className="w-3 shrink-0 select-none opacity-70">{GUTTER[row.kind]}</span>
          <span><HiddenText text={lineBody(row.text) || ' '} /></span>
          {row.omitted ? <span data-testid="row-cut" className="select-none pl-1 font-sans text-[12px] opacity-70">{t('review_row_cut', { count: row.omitted })}</span> : null}
          {showEndings && row.kind !== 'context' && <span className="select-none pl-3 font-sans text-[12px] opacity-70">{t(`review_eol_${terminatorOf(row.text)}`)}</span>}
        </div>
      ))}
      {hidden > 0 && (
        <button type="button" onClick={() => setShown((count) => count + ROW_LIMIT)}
          className="mx-2 mt-1 rounded-md px-2 py-1 font-sans text-[12px] font-medium text-primary transition-colors hover:bg-hover">
          {t('review_more_lines', { count: hidden })}
        </button>
      )}
    </div>
  );
}
