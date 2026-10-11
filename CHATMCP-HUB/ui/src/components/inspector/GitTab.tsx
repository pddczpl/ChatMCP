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

export function GitTab() {
  const { showToast } = useAppStore();
  const [checkpointName, setCheckpointName] = useState('');
  const [loading, setLoading] = useState(false);

  const { data: hub, refetch } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const git = hub?.workspace?.git;

  const handleCreateCheckpoint = async () => {
    if (!checkpointName.trim()) return;
    setLoading(true);
    try {
      await api.createCheckpoint(checkpointName.trim());
      showToast(`Đã tạo checkpoint: ${checkpointName}`, 'success');
      setCheckpointName('');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi tạo checkpoint', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRevertCheckpoint = async (id: string) => {
    if (!confirm('Khôi phục checkpoint này sẽ hoàn tác các thay đổi chưa lưu. Tiếp tục?')) return;
    try {
      await api.revertCheckpoint(id);
      showToast('Đã khôi phục checkpoint', 'success');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi khôi phục checkpoint', 'error');
    }
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-4 select-none text-xs">
      {/* Branch & Dirty Status */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between tilt-3d">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-sky-400" />
          <span className="font-mono font-semibold text-[var(--text)]">
            {git?.branch || 'main'}
          </span>
        </div>
        <div>
          {git?.dirty ? (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">
              Có thay đổi chưa commit
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              Workspace sạch
            </span>
          )}
        </div>
      </div>

      {/* Checkpoint Creator */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[var(--muted)]">
          <span className="font-semibold uppercase tracking-wider text-[10px]">Tạo điểm an toàn (Checkpoint)</span>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Tên checkpoint (vd: Trước khi refactor)..."
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
            <span>Lưu</span>
          </Button>
        </div>
      </div>

      {/* Checkpoints History */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[var(--muted)] border-b border-[var(--line-subtle)] pb-1">
          <span className="font-semibold uppercase tracking-wider text-[10px]">Lịch sử Checkpoints</span>
          <span className="text-[10px] font-mono">{git?.checkpoints?.length || 0} điểm lưu</span>
        </div>

        {!git?.checkpoints || git.checkpoints.length === 0 ? (
          <div className="py-8 text-center text-[var(--faint)] flex flex-col items-center gap-1.5">
            <GitCommit className="w-6 h-6 opacity-40" />
            <p className="text-[11px]">Chưa có checkpoint nào được tạo</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {git.checkpoints.map((cp: any, idx: number) => (
              <div
                key={idx}
                className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--line-subtle)] flex items-center justify-between gap-2 tilt-3d"
              >
                <div className="min-w-0">
                  <div className="font-medium text-[var(--text)] truncate">{cp.name || cp.message}</div>
                  <div className="text-[10px] font-mono text-[var(--faint)]">
                    {cp.hash ? cp.hash.slice(0, 7) : 'checkpoint'} • {cp.timestamp ? new Date(cp.timestamp).toLocaleTimeString() : ''}
                  </div>
                </div>

                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleRevertCheckpoint(cp.id || cp.hash)}
                  className="h-7 text-[11px] gap-1 text-amber-400 hover:text-amber-300"
                  title="Hoàn tác về điểm lưu này"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Khôi phục</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
