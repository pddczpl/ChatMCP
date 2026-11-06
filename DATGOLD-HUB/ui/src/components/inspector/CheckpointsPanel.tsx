import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, GitCommit } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { formatDateTime } from '@/lib/format';
import { useTranslation } from '@/lib/i18n';
import { planSelection } from '@/lib/rollback';
import type { PreviewFile } from '@/lib/rollback';
import { useRestoreFlow } from '@/lib/use-restore-flow';
import type { RestoreOutcome } from '@/lib/use-restore-flow';
import { useAppStore } from '@/store/useAppStore';
import { cn } from '@/lib/utils';
import type { Checkpoint } from '@/types';
import { EmptyBlock, ErrorLine, LoadingLine, RowCard, SectionHeading } from './parts';
import { DiffView } from './DiffView';
import { LastRestoreBar } from './LastRestoreBar';

type Flow = ReturnType<typeof useRestoreFlow>;

const badge = (tone: 'warn' | 'info') => cn('rounded-full border px-1.5 text-[12px]', tone === 'warn' ? 'border-warning/30 bg-warning/10 text-warning' : 'border-line bg-hover text-muted');

/**
 * The checkpoints of the workspace, newest first: what each holds, which are only snapshots taken before a command (incomplete) and which are the backup of a restore. A checkpoint opens
 * to its files, each compared with the workspace as it is now: tick the ones to bring back (also one file, or a few) and restore them; every restore saves the files first, so it can be undone.
 */
export function CheckpointsPanel({ workspace }: { workspace: string }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const flow = useRestoreFlow();
  const query = useQuery({ queryKey: ['checkpointsList', workspace], queryFn: api.getCheckpoints, enabled: Boolean(workspace), refetchInterval: 5000 });
  const checkpoints = query.data ?? [];
  const [openId, setOpenId] = useState('');
  const report = (outcome: RestoreOutcome) => {
    if (outcome.kind === 'done') showToast(outcome.text, outcome.tone === 'ok' ? 'success' : 'warning');
    else if (outcome.kind === 'error') showToast(outcome.text, 'error');
  };
  return (
    <div className="space-y-2.5">
      <SectionHeading title={t('git_checkpoint_history')} count={checkpoints.length} />
      <LastRestoreBar onOutcome={report} />
      {flow.running && <p role="note" data-testid="checkpoints-blocked" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-warning">{t('ckpt_agent_running')}</p>}
      {query.error ? <ErrorLine message={query.error.message} />
        : query.isLoading ? <LoadingLine text={t('git_checkpoint_loading')} />
        : checkpoints.length === 0 ? <EmptyBlock icon={GitCommit} title={t('git_checkpoint_empty')} />
        : checkpoints.map((checkpoint) => (
          <CheckpointRow key={checkpoint.id} checkpoint={checkpoint} open={openId === checkpoint.id} onToggle={() => setOpenId(openId === checkpoint.id ? '' : checkpoint.id)} flow={flow} report={report} />
        ))}
    </div>
  );
}

function CheckpointRow({ checkpoint, open, onToggle, flow, report }: { checkpoint: Checkpoint; open: boolean; onToggle: () => void; flow: Flow; report: (outcome: RestoreOutcome) => void }) {
  const { t, lang } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const undoBackup = checkpoint.kind === 'undo';
  const incomplete = !undoBackup && checkpoint.targeted === false;
  const created = checkpoint.absentCount ?? 0;

  // Every file that differs, ticked: the person confirms before anything is written.
  const restoreAll = async () => {
    setBusy(true);
    try {
      const preview = await api.previewCheckpoint(checkpoint.id);
      if (!preview?.ok) throw new Error(t('git_checkpoint_preview_failed'));
      report(await flow.run({
        plan: planSelection(preview, new Set((preview.files ?? []).map((file) => file.path))), tone: 'danger', source: 'panel',
        title: t('ckpt_confirm_title'), body: t('ckpt_confirm_body'), confirmLabel: t('ckpt_confirm'),
        execute: ({ files, expectedShas }) => api.revertCheckpoint(checkpoint.id, expectedShas, { files, onConflict: 'skip' }),
      }));
    } catch (error) {
      showToast(error instanceof Error && error.message ? error.message : t('git_checkpoint_restore_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <RowCard className="space-y-2">
      <div data-testid="checkpoint-row" data-checkpoint-id={checkpoint.id} data-kind={undoBackup ? 'undo' : 'checkpoint'} data-targeted={String(checkpoint.targeted === true)} className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium text-fg">{checkpoint.label || checkpoint.id.slice(0, 8)}</span>
            {undoBackup && <span className={badge('info')} data-testid="checkpoint-undo-badge">{t('ckpt_badge_undo')}</span>}
            {incomplete && <span className={badge('warn')} title={t('ckpt_badge_incomplete_hint')} data-testid="checkpoint-incomplete-badge">{t('ckpt_badge_incomplete')}</span>}
          </div>
          <div className="font-mono text-[12px] text-faint">
            {t('ckpt_meta', { id: checkpoint.id.slice(0, 12), count: checkpoint.fileCount ?? 0 })}{created > 0 ? t('ckpt_meta_created', { count: created }) : ''}{checkpoint.at ? ` · ${formatDateTime(checkpoint.at, lang)}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="quiet" aria-expanded={open} aria-controls={`checkpoint-files-${checkpoint.id}`} onClick={onToggle} data-testid="checkpoint-toggle" className="gap-1">
            <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} aria-hidden="true" />{open ? t('ckpt_hide_files') : t('ckpt_show_files')}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy || flow.running} title={flow.running ? t('rollback_undo_blocked') : t('git_checkpoint_revert')} onClick={() => void restoreAll()} className="gap-1 text-warning" data-testid="checkpoint-restore-all">
            {t('git_checkpoint_revert')}
          </Button>
        </div>
      </div>
      {open && <CheckpointFiles checkpoint={checkpoint} flow={flow} report={report} />}
    </RowCard>
  );
}

function fileStatus(file: PreviewFile, t: ReturnType<typeof useTranslation>['t']): string {
  if (file.action === 'unchanged') return t('ckpt_file_same');
  if (file.kind === 'absent') return t('ckpt_file_created');
  if (file.currentSha === null) return t('ckpt_file_deleted');
  return file.changedSinceStep === true ? t('ckpt_file_changed_later') : t('ckpt_file_differs');
}

function CheckpointFiles({ checkpoint, flow, report }: { checkpoint: Checkpoint; flow: Flow; report: (outcome: RestoreOutcome) => void }) {
  const { t } = useTranslation();
  const preview = useQuery({ queryKey: ['checkpointPreview', checkpoint.id], queryFn: () => api.previewCheckpoint(checkpoint.id), staleTime: 0, refetchOnWindowFocus: false });
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [diffPath, setDiffPath] = useState('');
  const [busy, setBusy] = useState(false);
  const files = preview.data?.files ?? [];
  const changed = files.filter((file) => file.action !== 'unchanged');
  const selected = new Set(changed.filter((file) => !unticked.has(file.path)).map((file) => file.path));
  const tick = (path: string) => setUnticked((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });

  const restoreSelected = async () => {
    if (!preview.data) return;
    setBusy(true);
    try {
      report(await flow.run({
        plan: planSelection(preview.data, selected), tone: 'danger', source: 'panel',
        title: t('ckpt_confirm_title'), body: t('ckpt_confirm_body'), confirmLabel: t('ckpt_confirm'),
        execute: ({ files: wanted, expectedShas }) => api.revertCheckpoint(checkpoint.id, expectedShas, { files: wanted, onConflict: 'skip' }),
      }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id={`checkpoint-files-${checkpoint.id}`} data-testid="checkpoint-files" className="space-y-2 border-t border-line-subtle pt-2">
      {preview.error ? <ErrorLine message={t('ckpt_preview_failed', { message: preview.error.message })} />
        : preview.isPending ? <LoadingLine text={t('ckpt_loading_files')} />
        : (
          <>
            <ul className="space-y-1.5">
              {files.map((file) => (
                <li key={file.path} data-testid="checkpoint-file" data-path={file.path} data-action={file.action} className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={file.action !== 'unchanged' && !unticked.has(file.path)} disabled={file.action === 'unchanged'}
                      aria-label={t('ckpt_select_file', { path: file.path })} onChange={() => tick(file.path)} />
                    <span className="min-w-0 break-all font-mono text-[12px] text-fg">{file.path}</span>
                    <span data-testid="checkpoint-file-status" className={cn('text-[12px]', file.action === 'unchanged' ? 'text-faint' : file.changedSinceStep === true ? 'text-warning' : 'text-muted')}>{fileStatus(file, t)}</span>
                    {file.action !== 'unchanged' && (
                      <Button size="sm" variant="quiet" className="ml-auto h-7" aria-expanded={diffPath === file.path} data-testid="checkpoint-diff-toggle" onClick={() => setDiffPath(diffPath === file.path ? '' : file.path)}>
                        {diffPath === file.path ? t('ckpt_hide_diff') : t('ckpt_show_diff')}
                      </Button>
                    )}
                  </div>
                  {diffPath === file.path && <FileChanges checkpointId={checkpoint.id} file={file} />}
                </li>
              ))}
            </ul>
            {changed.length === 0 ? <p role="note" className="text-[12px] text-muted">{t('ckpt_all_same')}</p> : selected.size === 0 && <p role="note" className="text-[12px] text-muted">{t('ckpt_nothing_selected')}</p>}
            <Button size="sm" variant="secondary" disabled={busy || flow.running || selected.size === 0} title={flow.running ? t('rollback_undo_blocked') : undefined} onClick={() => void restoreSelected()} data-testid="checkpoint-restore-selected">
              {t('ckpt_restore_selected', { count: selected.size })}
            </Button>
          </>
        )}
    </div>
  );
}

/** What changed in one file since the checkpoint (the diff from the copy the checkpoint holds to the file now). A file the checkpoint records as absent has no copy to compare with. */
function FileChanges({ checkpointId, file }: { checkpointId: string; file: PreviewFile }) {
  const { t } = useTranslation();
  const diff = useQuery({ queryKey: ['checkpointDiff', checkpointId, file.path], queryFn: () => api.getReview(checkpointId, file.path), enabled: file.kind === 'copy', staleTime: 0, refetchOnWindowFocus: false });
  if (file.kind === 'absent') return <p role="note" className="text-[12px] text-muted">{t('ckpt_diff_absent')}</p>;
  if (diff.error) return <ErrorLine message={t('ckpt_diff_failed', { message: diff.error.message })} />;
  if (diff.isPending) return <LoadingLine text={t('ckpt_diff_loading')} />;
  const text = diff.data?.changes?.find((change) => change.path === file.path)?.diff;
  return text ? <DiffView diff={text} label={t('ckpt_diff_label', { path: file.path })} /> : <p role="note" className="text-[12px] text-muted">{t('ckpt_diff_none')}</p>;
}
