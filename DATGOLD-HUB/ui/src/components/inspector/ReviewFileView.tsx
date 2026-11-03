import type { KeyboardEvent, RefObject } from 'react';
import { Check, Undo2 } from 'lucide-react';
import { fileActions, hunkAccepted } from '@/lib/review-rules';
import type { ReviewItem, WriteState } from '@/lib/review-rules';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { ReviewHunk } from './ReviewHunk';
import { ReviewRows } from './ReviewRows';

export interface ReviewFileViewProps {
  item: ReviewItem;
  state: WriteState;
  busy: boolean;
  activeHunk: number;
  listRef: RefObject<HTMLDivElement | null>;
  onActivateHunk: (index: number) => void;
  onAcceptHunk: (index: number) => void;
  onRejectHunk: (index: number) => void;
  onAcceptFile: () => void;
  onRejectFile: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/** One file open: what happened to it, what can be done with it now (and why not), and its hunks, or its lines, or the reason it has none. */
export function ReviewFileView(props: ReviewFileViewProps) {
  const { item, state, busy, activeHunk, listRef, onActivateHunk, onAcceptHunk, onRejectHunk, onAcceptFile, onRejectFile, onKeyDown } = props;
  const { file, diff, accepted } = item;
  const { t } = useTranslation();
  const actions = fileActions(file, state);
  const hunks = diff?.hunks ?? [];
  return (
    <section aria-label={t('review_file_region', { path: file.path })} data-testid="review-file-view" data-path={file.path} data-mode={actions.mode} className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-all font-mono text-[13px] font-semibold text-fg">{file.path}</h3>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[12px] font-medium">
            <span className="rounded-full border border-line bg-panel px-2 text-muted">{t(`review_status_${file.status}`)}</span>
            {file.partial && <span className="rounded-full border border-warning/30 bg-warning/10 px-2 text-warning">{t('review_badge_partial')}</span>}
            {file.accepted && <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 text-success"><Check className="h-3 w-3" />{t('review_badge_accepted')}</span>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="secondary" disabled={!actions.acceptFile || file.accepted || busy} onClick={onAcceptFile} aria-label={t('review_accept_file_label', { path: file.path })}>
            <Check className="h-3.5 w-3.5" />{t('review_accept_file')}
          </Button>
          <Button size="sm" variant="danger" disabled={!actions.rejectFile || busy} onClick={onRejectFile} aria-label={t('review_reject_file_label', { path: file.path })}>
            <Undo2 className="h-3.5 w-3.5" />{t('review_reject_file')}
          </Button>
        </div>
      </header>

      {file.partial && <p role="note" data-testid="review-partial-note" className="rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[12px] leading-5 text-muted">{t('review_partial_note')}</p>}
      {actions.note && <p role="note" data-testid="review-note" data-note={actions.note} className="rounded-lg border border-line bg-surface px-3 py-2 text-[12px] leading-5 text-muted">{t(`review_note_${actions.note}`)}</p>}

      {actions.mode === 'text' && (
        <>
          <div ref={listRef} onKeyDown={onKeyDown} data-testid="review-hunks" className="space-y-3">
            {hunks.map((hunk, index) => (
              <ReviewHunk key={hunk.fingerprint} path={file.path} hunk={hunk} index={index} total={hunks.length} accepted={hunkAccepted(file, accepted, hunk)} active={index === activeHunk}
                canAccept={actions.acceptHunk} canReject={actions.rejectHunk} busy={busy} onActivate={() => onActivateHunk(index)}
                onAccept={() => onAcceptHunk(index)} onReject={() => onRejectHunk(index)} />
            ))}
          </div>
          <p className="text-[12px] text-faint">{t('review_keys_hint')}</p>
        </>
      )}

      {actions.mode === 'created' && (
        <>
          <p className="text-[12px] leading-5 text-muted">{t('review_created_note')}</p>
          <div className="rounded-xl border border-line bg-bg" data-testid="review-new-file"><ReviewRows rows={hunks[0]?.rows ?? []} showEndings={false} /></div>
        </>
      )}

      {actions.mode === 'deleted' && <div className="rounded-xl border border-line bg-bg" data-testid="review-deleted-file"><ReviewRows rows={hunks[0]?.rows ?? []} showEndings={false} /></div>}
    </section>
  );
}
