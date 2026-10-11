import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { 
  GitBranch, 
  GitCommit, 
  RotateCcw, 
  Bookmark, 
  CheckCircle2, 
  AlertCircle, 
  Plus 
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';

export function GitTab() {
  const { t } = useTranslation();
  const { showToast } = useAppStore();
  const [checkpointName, setCheckpointName] = useState('');
  const [loading, setLoading] = useState(false);

  const { data: hub, refetch: refetchState } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const { data: gitStatus, refetch: refetchGitStatus } = useQuery({
    queryKey: ['gitStatus'],
    queryFn: async () => {
      try {
        return await api.getGitStatus();
      } catch {
        return null;
      }
    },
    refetchInterval: 3000,
  });
  const { data: checkpointsList = [], refetch: refetchCheckpoints } = useQuery({
    queryKey: ['checkpointsList'],
    queryFn: async () => {
      try {
        const res = await api.getCheckpoints();
        return Array.isArray(res) ? res : [];
      } catch {
        return [];
      }
    },
    refetchInterval: 5000,
  });
  const git = hub?.workspace?.git;
  const currentBranch = gitStatus?.branch || git?.branch || 'HEAD';
  const isDirty = gitStatus ? Boolean(gitStatus.dirty) : Boolean(git?.dirty);

  const handleCreateCheckpoint = async () => {
    if (!checkpointName.trim()) return;
    setLoading(true);
    try {
      await api.createCheckpoint(checkpointName.trim());
      showToast(`${t('git_checkpoint_create')}: ${checkpointName}`, 'success');
      setCheckpointName('');
      refetchCheckpoints();
      refetchState();
      refetchGitStatus();
    } catch (err: any) {
      showToast(err.message || 'Lỗi tạo checkpoint', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRevertCheckpoint = async (id: string) => {
    setLoading(true);
    try {
      // 1. Preview changes before restore
      const preview = await api.previewCheckpoint(id);
      if (!preview || !preview.ok) {
        throw new Error('Không thể tạo bản xem trước cho checkpoint.');
      }

      const fileCount = preview.files?.length ?? 0;
      const modifiedCount = preview.modifiedFilesCount ?? 0;
      const willOverwriteCount = preview.files?.filter((f: any) => f.willOverwriteNewer).length ?? 0;
      const isPartial = Boolean(preview.partial);

      let confirmMsg = `Khôi phục checkpoint này sẽ hoàn tác ${fileCount} file (${modifiedCount} file đang có thay đổi).`;
      if (willOverwriteCount > 0) {
        confirmMsg += `\nCẢNH BÁO: Có ${willOverwriteCount} file có sửa đổi mới hơn trên đĩa sẽ bị ghi đè!`;
      }
      if (isPartial) {
        confirmMsg += '\nLƯU Ý: Đây là bản checkpoint một phần (partial limitations).';
      }
      confirmMsg += '\n\nBạn có chắc chắn muốn tiếp tục?';

      if (!confirm(confirmMsg)) return;

      // 2. Build expectedShas mapping for all files
      const expectedShas: Record<string, string | null> = {};
      for (const f of preview.files || []) {
        expectedShas[f.path] = f.currentSha ?? null;
      }

      // 3. Restore with mandatory expectedShas
      const res = await api.revertCheckpoint(id, expectedShas);
      showToast(`Đã khôi phục thành công ${res.restoredCount ?? 0} file từ checkpoint!`, 'success');
      refetchCheckpoints();
      refetchState();
      refetchGitStatus();
    } catch (err: any) {
      showToast(err.message || 'Lỗi khôi phục checkpoint', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-4 select-none text-xs">
      {/* Branch & Dirty Status */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-sky-400" />
          <span className="font-mono font-semibold text-[var(--text)]">
            {currentBranch}
          </span>
        </div>
        <div>
          {isDirty ? (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">
              {t('git_dirty')}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              {t('git_clean')}
            </span>
          )}
        </div>
      </div>

      {/* Checkpoint Creator */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[var(--muted)]">
          <span className="font-semibold uppercase tracking-wider text-[10px]">{t('git_checkpoint_create')}</span>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder={t('git_checkpoint_placeholder')}
            value={checkpointName}
            onChange={(e) => setCheckpointName(e.target.value)}
            className="flex-1 bg-[var(--surface)] text-xs rounded-md px-3 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={!checkpointName.trim() || loading}
            onClick={handleCreateCheckpoint}
            className="h-8 gap-1.5 text-xs"
          >
            <Bookmark className="w-3.5 h-3.5" />
            <span>{t('git_checkpoint_save')}</span>
          </Button>
        </div>
      </div>

      {/* Checkpoints History */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[var(--muted)] border-b border-[var(--line-subtle)] pb-1">
          <span className="font-semibold uppercase tracking-wider text-[10px]">{t('git_checkpoint_history')}</span>
          <span className="text-[10px] font-mono">{checkpointsList.length}</span>
        </div>

        {checkpointsList.length === 0 ? (
          <div className="py-8 text-center text-[var(--faint)] flex flex-col items-center gap-1.5">
            <GitCommit className="w-6 h-6 opacity-40" />
            <p className="text-[11px]">{t('git_checkpoint_empty')}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {checkpointsList.map((cp: any, idx: number) => (
              <div
                key={cp.id || idx}
                className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--line-subtle)] flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-[var(--text)] truncate">{cp.label || cp.name || cp.message || 'Checkpoint'}</span>
                    {cp.partial && (
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                        Partial
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-[var(--faint)]">
                    {cp.id ? cp.id.slice(0, 12) : ''} • {cp.fileCount ?? cp.files?.length ?? 0} files • {cp.at || cp.timestamp ? new Date(cp.at || cp.timestamp).toLocaleTimeString() : ''}
                  </div>
                </div>

                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleRevertCheckpoint(cp.id)}
                  className="h-7 text-[11px] gap-1 text-amber-400 hover:text-amber-300"
                  title={t('git_checkpoint_revert')}
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{t('git_checkpoint_revert')}</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

}
