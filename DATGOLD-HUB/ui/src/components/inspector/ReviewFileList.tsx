import { Check, FilePlus2, FileX2, FileDiff, FileQuestion } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { fileMode, summarizeFile } from '@/lib/review-rules';
import type { FileMode, ReviewItem } from '@/lib/review-rules';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const ICONS: Record<FileMode, LucideIcon> = { text: FileDiff, created: FilePlus2, deleted: FileX2, binary: FileQuestion, unavailable: FileQuestion };

/** The files the conversation changed: what happened to each, whether its original is only approximate, whether it was accepted, and how much is still to be looked at. */
export function ReviewFileList({ items, selectedPath, onSelect }: { items: readonly ReviewItem[]; selectedPath: string; onSelect: (path: string) => void }) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('review_files_label')} className="space-y-1.5">
      {items.map(({ file, diff, accepted }) => {
        const mode = fileMode(file);
        const summary = summarizeFile(file, diff, accepted);
        const Icon = ICONS[mode];
        const selected = file.path === selectedPath;
        return (
          <li key={file.path}>
            <button type="button" onClick={() => onSelect(file.path)} aria-current={selected ? 'true' : undefined}
              data-testid="review-file" data-path={file.path} data-status={file.status}
              className={cn('flex w-full flex-col gap-1 rounded-xl border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/70',
                selected ? 'border-primary/50 bg-primary/10' : 'border-line bg-surface hover:bg-hover')}>
              <span className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={file.path}>{file.path}</span>
                <span className="shrink-0 rounded-full border border-line bg-panel px-2 text-[12px] font-medium text-muted">{t(`review_status_${file.status}`)}</span>
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                {(summary.added > 0 || summary.removed > 0) && (
                  <span title={t('review_lines_changed', { added: summary.added, removed: summary.removed })}>
                    <span className="text-success">+{summary.added}</span> <span className="text-danger">-{summary.removed}</span>
                  </span>
                )}
                {mode === 'text' && <span>{t('review_pending', { pending: summary.pending, total: summary.hunks })}</span>}
                {file.partial && <span className="rounded-full border border-warning/30 bg-warning/10 px-2 text-[12px] font-medium text-warning">{t('review_badge_partial')}</span>}
                {file.accepted && <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 text-[12px] font-medium text-success"><Check className="h-3 w-3" />{t('review_badge_accepted')}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
