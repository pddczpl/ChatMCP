import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Bookmark, GitBranch, GitCommit, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useTranslation } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { EmptyBlock, ErrorLine, LoadingLine, RowCard, SectionHeading, TabBody } from './parts';
import { DiffView } from './DiffView';

export function GitTab() {
  const { t, lang } = useTranslation();
  const { showToast } = useAppStore();
  const [checkpointName, setCheckpointName] = useState('');
  const [loading, setLoading] = useState(false);
  const [staged, setStaged] = useState(false);
  const hubQuery = useQuery({ queryKey: ['hubState'], queryFn: api.getState });
  const workspace = hubQuery.data?.workspace?.path ?? '';
  const gitQuery = useQuery({ queryKey: ['gitStatus', workspace], queryFn: api.getGitStatus, enabled: Boolean(workspace), refetchInterval: 3000 });
  const checkpointsQuery = useQuery({ queryKey: ['checkpointsList', workspace], queryFn: api.getCheckpoints, enabled: Boolean(workspace), refetchInterval: 5000 });
  const diffQuery = useQuery({ queryKey: ['gitDiff', workspace, staged], queryFn: () => api.getGitDiff(staged), enabled: Boolean(workspace), refetchInterval: 3000 });
  const gitStatus = gitQuery.data;
  const checkpoints = checkpointsQuery.data ?? [];
  const statusError = hubQuery.error || gitQuery.error;

  const refresh = async () => {
    await Promise.all([checkpointsQuery.refetch(), gitQuery.refetch(), diffQuery.refetch()]);
  };
  const handleCreateCheckpoint = async () => {
    if (!checkpointName.trim()) return;
    setLoading(true);
    try {
      await api.createCheckpoint(checkpointName.trim());
      showToast(`${t('git_checkpoint_create')}: ${checkpointName}`, 'success');
      setCheckpointName('');
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Lỗi tạo checkpoint', 'error');
    } finally { setLoading(false); }
  };
  const handleRevertCheckpoint = async (id: string) => {
    setLoading(true);
    try {
      const preview = await api.previewCheckpoint(id);
      if (!preview?.ok) throw new Error('Không thể tạo bản xem trước cho checkpoint.');
      const fileCount = preview.files?.length ?? 0;
      const newerCount = preview.files?.filter((file) => file.willOverwriteNewer).length ?? 0;
      let message = lang === 'vi' ? `Khôi phục checkpoint này sẽ hoàn tác ${fileCount} file (${preview.modifiedFilesCount ?? 0} file đang có thay đổi).` : `Restore this checkpoint for ${fileCount} files (${preview.modifiedFilesCount ?? 0} changed files)?`;
      if (newerCount) message += lang === 'vi' ? `\nCẢNH BÁO: ${newerCount} file có thay đổi mới hơn sẽ bị ghi đè.` : `\nWARNING: ${newerCount} files have newer changes that will be overwritten.`;
      if (preview.partial) message += lang === 'vi' ? '\nCheckpoint chỉ chứa một phần workspace.' : '\nThis checkpoint contains only part of the workspace.';
      message += lang === 'vi' ? '\n\nBạn có chắc chắn muốn tiếp tục?' : '\n\nContinue?';
      if (!confirm(message)) return;
      const expectedShas: Record<string, string | null> = {};
      for (const file of preview.files ?? []) expectedShas[file.path] = file.currentSha ?? null;
      const result = await api.revertCheckpoint(id, expectedShas);
      if (!result.ok) throw new Error('Checkpoint restore was not completed.');
      showToast(lang === 'vi' ? `Đã khôi phục ${result.restoredCount} file.` : `Restored ${result.restoredCount} files.`, 'success');
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Lỗi khôi phục checkpoint', 'error');
    } finally { setLoading(false); }
  };

  return (
    <TabBody label="Git workspace">
      {statusError ? <ErrorLine message={statusError.message} />
        : hubQuery.isLoading || gitQuery.isLoading ? <LoadingLine text={lang === 'vi' ? 'Đang tải Git…' : 'Loading Git…'} />
        : !workspace ? <p className="text-muted">{lang === 'vi' ? 'Chọn workspace để xem Git.' : 'Select a workspace to view Git.'}</p>
        : gitStatus && (
          <RowCard className="flex items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-2"><GitBranch className="h-4 w-4 shrink-0 text-primary" /><span className="break-all font-mono text-[13px] font-semibold text-fg">{gitStatus.branch || gitStatus.head || '—'}</span></div>
            {typeof gitStatus.dirty === 'boolean' && (
              <span className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-[12px] font-medium', gitStatus.dirty ? 'border-warning/30 bg-warning/10 text-warning' : 'border-success/30 bg-success/10 text-success')}>
                {gitStatus.dirty ? t('git_dirty') : t('git_clean')}
              </span>
            )}
          </RowCard>
        )}
      {workspace && (
        <>
          <div className="space-y-2.5">
            <SectionHeading title="Git diff" action={
              <div role="group" aria-label="Git diff scope" className="flex rounded-lg border border-line bg-surface p-0.5">
                {([false, true] as const).map(value => (
                  <button key={String(value)} type="button" aria-pressed={staged === value} onClick={() => setStaged(value)}
                    className={cn('h-7 rounded-md px-2.5 text-[12px] font-medium transition-colors', staged === value ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg')}>
                    {value ? (lang === 'vi' ? 'Đã stage' : 'Staged') : (lang === 'vi' ? 'Chưa stage' : 'Unstaged')}
                  </button>
                ))}
              </div>
            } />
            {diffQuery.error ? <ErrorLine message={diffQuery.error.message} />
              : diffQuery.isLoading ? <LoadingLine text={lang === 'vi' ? 'Đang tải diff…' : 'Loading diff…'} />
              : diffQuery.data?.diff ? <DiffView diff={diffQuery.data.diff} />
              : <p className="text-muted">{lang === 'vi' ? 'Không có diff được Git theo dõi trong phạm vi này. Tệp mới chưa được stage không có trong diff.' : 'No tracked diff in this scope. Untracked files appear after staging.'}</p>}
            {diffQuery.data?.truncated && <p className="text-warning">{lang === 'vi' ? 'Diff bị cắt do giới hạn dung lượng.' : 'Diff truncated at the output limit.'}</p>}
          </div>

          <div className="space-y-2.5">
            <SectionHeading title={t('git_checkpoint_create')} />
            <div className="flex gap-2">
              <Input aria-label={t('git_checkpoint_placeholder')} type="text" placeholder={t('git_checkpoint_placeholder')} value={checkpointName} onChange={(event) => setCheckpointName(event.target.value)} className="min-w-0 flex-1" />
              <Button size="md" variant="primary" disabled={!checkpointName.trim() || loading} onClick={handleCreateCheckpoint} className="gap-1.5"><Bookmark className="h-3.5 w-3.5" /><span>{t('git_checkpoint_save')}</span></Button>
            </div>
          </div>

          <div className="space-y-2.5">
            <SectionHeading title={t('git_checkpoint_history')} count={checkpoints.length} />
            {checkpointsQuery.error ? <ErrorLine message={checkpointsQuery.error.message} />
              : checkpointsQuery.isLoading ? <LoadingLine text={lang === 'vi' ? 'Đang tải checkpoint…' : 'Loading checkpoints…'} />
              : checkpoints.length === 0 ? <EmptyBlock icon={GitCommit} title={t('git_checkpoint_empty')} />
              : checkpoints.map((checkpoint) => (
                <RowCard key={checkpoint.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5"><span className="truncate font-medium text-fg">{checkpoint.label || 'Checkpoint'}</span>{checkpoint.partial && <span className="rounded-full border border-warning/30 bg-warning/10 px-1.5 text-[12px] text-warning">Partial</span>}</div>
                    <div className="font-mono text-[12px] text-faint">{checkpoint.id.slice(0, 12)} · {checkpoint.fileCount ?? '—'} files{checkpoint.at ? ` · ${formatDateTime(checkpoint.at, lang)}` : ''}</div>
                  </div>
                  <Button size="sm" variant="secondary" disabled={loading} onClick={() => handleRevertCheckpoint(checkpoint.id)} className="shrink-0 gap-1 text-warning" title={t('git_checkpoint_revert')}><RotateCcw className="h-3 w-3" /><span>{t('git_checkpoint_revert')}</span></Button>
                </RowCard>
              ))}
          </div>
        </>
      )}
    </TabBody>
  );
}
