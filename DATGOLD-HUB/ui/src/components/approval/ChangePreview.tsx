import type { KeyboardEvent } from 'react';
import { ChevronRight, FileDiff } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { refusalSentenceKey, type ChangeFile, type ChangePreview as ChangePreviewView } from '@/lib/change-preview';
import { ReviewRows } from '@/components/inspector/ReviewRows';

const ACTION_KEYS = { create: 'agents_apr_changes_create', overwrite: 'agents_apr_changes_overwrite', edit: 'agents_apr_changes_edit' } as const;

/** Escape on a file that is open closes it and keeps the focus on its summary, so that the keyboard goes back where it was. A closed file leaves the key to the page. */
function collapseOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== 'Escape') return;
  const details = event.currentTarget;
  if (!details.open) return;
  event.preventDefault();
  event.stopPropagation();
  details.open = false;
  details.querySelector('summary')?.focus();
}

function ChangeFileView({ file }: { file: ChangeFile }) {
  const { t } = useTranslation();
  const action = t(ACTION_KEYS[file.action]);
  return (
    <details data-testid="change-file" data-path={file.path} onKeyDown={collapseOnEscape} className="group rounded-xl border border-line bg-bg">
      <summary
        aria-label={t('agents_apr_changes_file_label', { action, path: file.path, added: file.additions, removed: file.deletions })}
        className="flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl px-3 py-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/70 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
        <span data-testid="change-file-action" className="rounded-full border border-line bg-surface px-2 text-[12px] font-medium text-fg">{action}</span>
        <code data-testid="change-file-path" className="min-w-0 break-all font-mono text-[12px] text-fg">{file.path}</code>
        <span data-testid="change-file-counts" className="ml-auto font-mono text-[12px] text-muted">{`+${file.additions} -${file.deletions}`}</span>
      </summary>
      <div className="space-y-2 border-t border-line-subtle px-3 py-2.5">
        <p data-testid="change-base" className="text-[12px] text-faint">
          {file.baseSha ? t('agents_apr_changes_base', { sha: file.baseSha.slice(0, 8) }) : t('agents_apr_changes_new_file')}
        </p>
        {file.unchanged && <p data-testid="change-unchanged" className="text-[13px] text-muted">{t('agents_apr_changes_unchanged')}</p>}
        {file.oldUnreadable && <p data-testid="change-unreadable" className="text-[13px] text-warning">{t('agents_apr_changes_unreadable')}</p>}
        {file.hunks.map((hunk, index) => (
          <div key={index} data-testid="change-hunk" className="rounded-xl border border-line bg-bg">
            <h4 data-testid="change-hunk-title" className="border-b border-line-subtle px-3 py-1.5 text-[12px] font-semibold text-fg">{t('agents_apr_changes_hunk', { line: hunk.currentStart + 1 })}</h4>
            {hunk.invisibleOnly && <p className="border-b border-line-subtle px-3 py-1.5 text-[12px] text-warning">{t('review_hunk_invisible')}</p>}
            <ReviewRows rows={hunk.rows} showEndings={hunk.invisibleOnly} />
          </div>
        ))}
        {file.hiddenRows > 0 && <p data-testid="change-more-rows" className="text-[12px] text-muted">{t('agents_apr_changes_more_rows', { count: file.hiddenRows })}</p>}
      </div>
    </details>
  );
}

/**
 * The part of the approval card that shows what a file change would do: for each file, collapsed, what the call does to it, its counts and the hunks as the Review tab draws them.
 * The Hub worked all of it out from the same plan the tool writes with, from the files as they are when it asks; it is read-only (the owner decides on the whole call, with the
 * two buttons of the card) and says what it leaves out and how much.
 */
export function ChangePreview({ preview }: { preview: ChangePreviewView }) {
  const { t } = useTranslation();
  const complete = preview.hiddenFiles === 0;
  const added = preview.files.reduce((total, file) => total + file.additions, 0);
  const removed = preview.files.reduce((total, file) => total + file.deletions, 0);
  // A code the page has a sentence for is told in the language on screen; any other is told in the Hub's own words.
  const refusal = preview.error && { ...preview.error, sentence: refusalSentenceKey(preview.error.code) };
  return (
    <section data-testid="change-preview" aria-label={t('agents_apr_changes_title')} className="space-y-2.5 rounded-lg border border-line bg-surface px-3 py-3 text-[13px]">
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-medium text-fg">
        <FileDiff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span data-testid="change-title">{t('agents_apr_changes_title')}</span>
        {preview.fileCount > 0 && <span data-testid="change-count" className="font-normal text-muted">{t(preview.fileCount === 1 ? 'agents_apr_changes_count_one' : 'agents_apr_changes_count_other', { n: preview.fileCount })}</span>}
        {complete && preview.files.length > 0 && <span data-testid="change-total" className="font-mono text-[12px] font-normal text-muted">{`+${added} -${removed}`}</span>}
      </p>
      {refusal && (
        <p role="note" data-testid="change-error" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-fg">
          {t('agents_apr_changes_error', { code: refusal.code, message: refusal.sentence ? t(refusal.sentence) : refusal.message })}
        </p>
      )}
      {preview.files.length > 0 && (
        <div className="space-y-2">
          {preview.files.map((file, index) => <ChangeFileView key={`${file.path}-${index}`} file={file} />)}
        </div>
      )}
      {preview.hiddenFiles > 0 && <p data-testid="change-more-files" className="text-muted">{t('agents_apr_changes_more_files', { count: preview.hiddenFiles })}</p>}
      <p className="text-[12px] text-faint">{t('agents_apr_changes_note')}</p>
    </section>
  );
}
