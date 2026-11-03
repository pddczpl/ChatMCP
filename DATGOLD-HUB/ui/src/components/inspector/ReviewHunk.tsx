import { forwardRef } from 'react';
import { Check, Undo2 } from 'lucide-react';
import type { Hunk } from '@/lib/review-hunks';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { ReviewRows } from './ReviewRows';

export interface ReviewHunkProps {
  path: string;
  hunk: Hunk;
  index: number;
  total: number;
  accepted: boolean;
  active: boolean;
  canAccept: boolean;
  canReject: boolean;
  busy: boolean;
  onActivate: () => void;
  onAccept: () => void;
  onReject: () => void;
}

/** One hunk of a text file: where it is, its lines, and the two things a person can do with it. The element itself takes the focus (j and k land on it). */
export const ReviewHunk = forwardRef<HTMLDivElement, ReviewHunkProps>(function ReviewHunk(props, ref) {
  const { path, hunk, index, total, accepted, active, canAccept, canReject, busy, onActivate, onAccept, onReject } = props;
  const { t } = useTranslation();
  const names = { n: index + 1, total, path };
  return (
    <div ref={ref} role="group" tabIndex={active ? 0 : -1} aria-label={t('review_hunk_region', names)} aria-current={active ? 'true' : undefined}
      data-testid="review-hunk" data-hunk-index={index} data-state={accepted ? 'accepted' : 'pending'} onFocus={onActivate}
      className={cn('rounded-xl border bg-bg outline-none focus-visible:ring-2 focus-visible:ring-primary/70', active ? 'border-primary/50' : 'border-line', accepted && 'opacity-80')}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="text-[12px] font-semibold text-fg">{t('review_hunk_title', { n: index + 1, total, line: hunk.currentStart + 1 })}</h4>
          {accepted && <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 text-[12px] font-medium text-success"><Check className="h-3 w-3" />{t('review_badge_accepted')}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="secondary" disabled={!canAccept || accepted || busy} onClick={onAccept} aria-label={t('review_accept_hunk_label', names)}>
            <Check className="h-3.5 w-3.5" />{t('review_accept_hunk')}
          </Button>
          <Button size="sm" variant="danger" disabled={!canReject || busy} onClick={onReject} aria-label={t('review_reject_hunk_label', names)}>
            <Undo2 className="h-3.5 w-3.5" />{t('review_reject_hunk')}
          </Button>
        </div>
      </div>
      {hunk.invisibleOnly && <p className="border-b border-line-subtle px-3 py-1.5 text-[12px] text-warning">{t('review_hunk_invisible')}</p>}
      <ReviewRows rows={hunk.rows} showEndings={hunk.invisibleOnly} />
    </div>
  );
});
