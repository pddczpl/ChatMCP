import { useRef } from 'react';
import { assessWorker, hubNoteOf } from '@/lib/agent-proof';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { agentStatusLabel } from './agentLabels';
import { AiReport, EvidenceLine, HubNote, StatusBadge } from './agent-parts';
import { ContextPanel, ReviewPanel } from './CodingReview';
import { ErrorLine } from './parts';

/** The states in which a worker stopped without committing what it had done. */
const UNCOMMITTED = new Set(['needs_attention', 'failed', 'interrupted', 'cancelled']);

interface Props {
  worker: any;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  /** The diff of this worker was read in this session, so its review token is known. */
  reviewed: boolean;
  /** Something else is running (this tab or the Hub): the actions wait. */
  busy: boolean;
  /** The Hub is running this worker's run. A worker of a run that is not going any more is shown as stopped, whatever status was saved. */
  runActive: boolean;
  /** Another folder than the Hub's own is in view. The Hub reads and changes only the runs of its own folder, so nothing is read or sent from here. */
  blocked?: boolean;
  review: { branch: string; revision: string; diff?: string } | null;
  context: { workerId: string; files?: any[]; skipped?: any[] } | null;
  onViewDiff: () => void;
  onViewFiles: () => void;
  onPublish: () => void;
  onCloseReview: () => void;
  onCloseContext: () => void;
}

/**
 * One coding worker. Three things are kept apart on purpose: what the Hub recorded (the status, the evidence line, the checks it ran), what the
 * Hub said in its own words about the verification (its note, beside the evidence line) and what the AI said about itself (its summary, under
 * "AI report"). Only the evidence line can be green.
 */
export function CodingWorkerCard({ worker, selected, onSelect, reviewed, busy, runActive, blocked = false, review, context, onViewDiff, onViewFiles, onPublish, onCloseReview, onCloseContext }: Props) {
  const { t } = useTranslation();
  const proof = assessWorker(worker, { runActive });
  const hubNote = hubNoteOf(worker, proof);
  const ready = worker.status === 'ready_for_review';
  // A worker that stopped before it committed leaves its edits, if any, in its own working copy: the owner is told where.
  const leftBehind = UNCOMMITTED.has(worker.status) && typeof worker.worktree === 'string' && worker.worktree !== '';
  const hintId = `publish-hint-${worker.id}`;
  // Closing a panel hands focus back to the button that opened it, so a keyboard user does not start over from the top of the tab.
  const diffRef = useRef<HTMLButtonElement>(null);
  const filesRef = useRef<HTMLButtonElement>(null);
  const closeReview = () => { onCloseReview(); requestAnimationFrame(() => diffRef.current?.focus()); };
  const closeContext = () => { onCloseContext(); requestAnimationFrame(() => filesRef.current?.focus()); };
  return (
    <article data-testid="coding-worker" data-worker={worker.id} data-tone={proof.tone} data-kind={proof.kind} className="space-y-3 rounded-xl border border-line bg-surface p-3 select-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-0 items-center gap-2">
          <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" aria-label={t('coding_worker_select', { id: worker.id })} disabled={!ready} checked={selected} onChange={(event) => onSelect(event.target.checked)} />
          <strong className="break-all text-fg">{worker.id}</strong>
        </label>
        <StatusBadge tone={proof.tone}>{agentStatusLabel(worker.status, t)}</StatusBadge>
      </div>
      {worker.branch && <p className="break-all font-mono text-[12px] leading-4 text-muted">{t('coding_branch', { branch: worker.branch })}</p>}
      {worker.dependsOn?.length > 0 && <p className="text-[12px] text-muted">{t('coding_waits_for', { ids: worker.dependsOn.join(', ') })}</p>}
      {worker.inheritedCommits && (
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer rounded">{t('coding_inherited')}</summary>
          <p className="mt-1 break-all font-mono">{Object.entries(worker.inheritedCommits).map(([id, sha]) => `${id}: ${String(sha).slice(0, 8)}`).join(', ')}</p>
        </details>
      )}
      <p className="break-words text-muted">{t('coding_changed_files', { files: (worker.changedFiles || []).join(', ') || t('coding_changed_none') })}</p>
      <EvidenceLine tone={proof.tone} kind={proof.kind} facts={proof.checks > 0 ? t('agent_proof_facts', { checks: proof.checks, verified: proof.verifiedChecks }) : undefined} />
      <HubNote note={hubNote} />
      {worker.summary && <AiReport text={worker.summary} />}
      {worker.error && <ErrorLine message={worker.error} />}
      {leftBehind && <p data-testid="coding-worktree" className="break-all text-[12px] leading-4 text-muted select-text">{t('coding_worktree', { path: worker.worktree })}</p>}
      {ready && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-2">
            <Button ref={diffRef} size="sm" variant="outline" disabled={busy || blocked} onClick={onViewDiff}>{t('coding_view_diff')}</Button>
            <Button ref={filesRef} size="sm" variant="outline" disabled={busy || blocked} onClick={onViewFiles}>{t('coding_view_files')}</Button>
            <Button size="sm" variant="outline" disabled={busy || blocked || !reviewed} aria-describedby={reviewed ? undefined : hintId} onClick={onPublish}>{t('coding_publish_worker')}</Button>
          </div>
          {!reviewed && <p id={hintId} className="text-[12px] text-faint">{t('coding_publish_hint')}</p>}
        </div>
      )}
      {worker.prUrl && <p className="break-all text-muted">{t('coding_pr', { url: worker.prUrl })}</p>}
      {review && <ReviewPanel review={review} onClose={closeReview} />}
      {context && <ContextPanel context={context} onClose={closeContext} />}
    </article>
  );
}
