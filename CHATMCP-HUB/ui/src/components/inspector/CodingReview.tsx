import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { DiffView } from './DiffView';

/** The exact diff of a worker's branch (or of the merge), read from Git by the Hub. Reading it is what unlocks merging and publishing. */
export function ReviewPanel({ review, onClose }: { review: { branch: string; revision: string; diff?: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const label = t('coding_review_label', { branch: review.branch });
  return (
    <section aria-label={label} data-testid="coding-review" className="space-y-2 rounded-xl border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="min-w-0 break-all font-semibold text-fg">{t('coding_review_title', { branch: review.branch })}</h4>
        <Button size="sm" variant="quiet" onClick={onClose}>{t('coding_review_close')}</Button>
      </div>
      <p className="break-all text-[12px] leading-4 text-muted">{t('coding_review_meta', { revision: review.revision })}</p>
      {review.diff ? <DiffView diff={review.diff} label={t('coding_review_diff')} /> : <p className="text-muted">{t('coding_review_empty')}</p>}
    </section>
  );
}

interface ContextFile { path: string; sha256?: string; lines?: { line: number; text: string }[] }

/** A few of the changed files as they are in the worker's commit, read on this computer. Nothing here goes to the AI and none of it is evidence. */
export function ContextPanel({ context, onClose }: { context: { workerId: string; files?: ContextFile[]; skipped?: { path: string; reason: string }[] }; onClose: () => void }) {
  const { t } = useTranslation();
  const title = t('coding_context_title', { worker: context.workerId });
  return (
    <section aria-label={title} data-testid="coding-context-preview" className="space-y-2 rounded-xl border border-line bg-panel p-3 select-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="min-w-0 break-all font-semibold text-fg">{title}</h4>
        <Button size="sm" variant="quiet" onClick={onClose}>{t('coding_context_close')}</Button>
      </div>
      <p className="text-[12px] leading-4 text-muted">{t('coding_context_note')}</p>
      {(context.files || []).map((file) => (
        <div key={file.path} className="space-y-1">
          <strong className="break-all text-fg">{file.path}</strong>
          {file.sha256 && <details className="break-all text-[12px] text-muted"><summary className="cursor-pointer rounded">{t('coding_context_hash')}</summary>SHA-256: {file.sha256}</details>}
          <pre tabIndex={0} aria-label={file.path} className="max-h-52 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-[12px] leading-5 text-fg">
            {(file.lines || []).map((line) => `${line.line}: ${line.text}`).join('\n')}
          </pre>
        </div>
      ))}
      {!!context.skipped?.length && <p className="break-words text-[12px] text-muted">{t('coding_context_skipped', { files: context.skipped.map((file) => `${file.path} (${file.reason})`).join(', ') })}</p>}
    </section>
  );
}
