import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { GitBranch, GitCommit, RotateCcw, Bookmark } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';

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
    <section aria-label="Git workspace" className="h-full flex flex-col p-3 overflow-y-auto space-y-4 text-xs">
      {statusError ? <p role="alert" className="text-rose-400">{statusError.message}</p>
        : hubQuery.isLoading || gitQuery.isLoading ? <p role="status">{lang === 'vi' ? 'Đang tải Git…' : 'Loading Git…'}</p>
        : !workspace ? <p>{lang === 'vi' ? 'Chọn workspace để xem Git.' : 'Select a workspace to view Git.'}</p>
        : gitStatus && (
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0"><GitBranch className="w-4 h-4 text-sky-400 flex-shrink-0" /><span className="font-mono font-semibold text-[var(--text)] break-all">{gitStatus.branch || gitStatus.head || '—'}</span></div>
            {typeof gitStatus.dirty === 'boolean' && <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${gitStatus.dirty ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'}`}>{gitStatus.dirty ? t('git_dirty') : t('git_clean')}</span>}
          </div>
        )}
      {workspace && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-[var(--muted)]">Git diff</h3>
              <select aria-label="Git diff scope" value={staged ? 'staged' : 'unstaged'} onChange={(event) => setStaged(event.target.value === 'staged')} className="rounded bg-[var(--surface)] border border-[var(--line)] p-1">
                <option value="unstaged">{lang === 'vi' ? 'Chưa stage' : 'Unstaged'}</option>
                <option value="staged">{lang === 'vi' ? 'Đã stage' : 'Staged'}</option>
              </select>
            </div>
            {diffQuery.error ? <p role="alert" className="text-rose-400">{diffQuery.error.message}</p>
              : diffQuery.isLoading ? <p role="status">{lang === 'vi' ? 'Đang tải diff…' : 'Loading diff…'}</p>
              : diffQuery.data?.diff ? <pre aria-label="Git diff" className="p-2 rounded bg-[var(--surface)] border border-[var(--line-subtle)] text-[11px] font-mono overflow-x-auto whitespace-pre">{diffQuery.data.diff}</pre>
              : <p className="text-[var(--faint)]">{lang === 'vi' ? 'Không có diff được Git theo dõi trong phạm vi này. Tệp mới chưa được stage không có trong diff.' : 'No tracked diff in this scope. Untracked files appear after staging.'}</p>}
            {diffQuery.data?.truncated && <p className="text-amber-400">{lang === 'vi' ? 'Diff bị cắt do giới hạn dung lượng.' : 'Diff truncated at the output limit.'}</p>}
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold uppercase tracking-wider text-[10px] text-[var(--muted)]">{t('git_checkpoint_create')}</h3>
            <div className="flex gap-2">
              <input aria-label={t('git_checkpoint_placeholder')} type="text" placeholder={t('git_checkpoint_placeholder')} value={checkpointName} onChange={(event) => setCheckpointName(event.target.value)} className="flex-1 min-w-0 bg-[var(--surface)] text-xs rounded-md px-3 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500" />
              <Button size="sm" variant="primary" disabled={!checkpointName.trim() || loading} onClick={handleCreateCheckpoint} className="h-8 gap-1.5 text-xs"><Bookmark className="w-3.5 h-3.5" /><span>{t('git_checkpoint_save')}</span></Button>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[var(--muted)] border-b border-[var(--line-subtle)] pb-1"><h3 className="font-semibold uppercase tracking-wider text-[10px]">{t('git_checkpoint_history')}</h3><span className="text-[10px] font-mono">{checkpoints.length}</span></div>
            {checkpointsQuery.error ? <p role="alert" className="text-rose-400">{checkpointsQuery.error.message}</p>
              : checkpointsQuery.isLoading ? <p role="status">{lang === 'vi' ? 'Đang tải checkpoint…' : 'Loading checkpoints…'}</p>
              : checkpoints.length === 0 ? <div className="py-8 text-center text-[var(--faint)] flex flex-col items-center gap-1.5"><GitCommit className="w-6 h-6 opacity-40" /><p>{t('git_checkpoint_empty')}</p></div>
              : checkpoints.map((checkpoint) => (
                <div key={checkpoint.id} className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--line-subtle)] flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5"><span className="font-medium text-[var(--text)] truncate">{checkpoint.label || 'Checkpoint'}</span>{checkpoint.partial && <span className="px-1.5 rounded text-[9px] bg-amber-500/15 text-amber-400">Partial</span>}</div>
                    <div className="text-[10px] font-mono text-[var(--faint)]">{checkpoint.id.slice(0, 12)} · {checkpoint.fileCount ?? '—'} files · {checkpoint.at ? new Date(checkpoint.at).toLocaleString() : ''}</div>
                  </div>
                  <Button size="sm" variant="secondary" disabled={loading} onClick={() => handleRevertCheckpoint(checkpoint.id)} className="h-7 text-[11px] gap-1 text-amber-400" title={t('git_checkpoint_revert')}><RotateCcw className="w-3 h-3" /><span>{t('git_checkpoint_revert')}</span></Button>
                </div>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
