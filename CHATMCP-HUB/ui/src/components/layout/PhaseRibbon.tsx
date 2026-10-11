import { CheckCircle2, Clock, Loader2, Sparkles, XCircle } from 'lucide-react';
import { Task } from '@/types';

interface PhaseRibbonProps {
  task?: Task;
  onCancel?: () => void;
}

export function PhaseRibbon({ task, onCancel }: PhaseRibbonProps) {
  if (!task) return null;

  const isWorking = task.status === 'working' || task.status === 'in_progress';
  const isFailed = task.status === 'failed' || task.status === 'error';
  const isCompleted = task.status === 'completed' || task.status === 'success';

  // Phases in ChatMCP workflow
  const phases = [
    { key: 'plan', label: '1. Kế hoạch', desc: 'Đọc code & lập plan' },
    { key: 'exec', label: '2. Thực thi', desc: 'Sửa file & chạy tool' },
    { key: 'verify', label: '3. Kiểm chứng', desc: 'Chạy test & lint' },
    { key: 'report', label: '4. Báo cáo', desc: 'Tổng kết & commit' },
  ];

  // Determine current active phase from task step or stage
  let activeIndex = 0;
  if (isCompleted) {
    activeIndex = 3;
  } else if (task.phase === 'verify' || task.stage?.includes('test') || task.stage?.includes('verify')) {
    activeIndex = 2;
  } else if (task.phase === 'exec' || task.stage?.includes('exec') || task.stage?.includes('edit') || task.stage?.includes('tool')) {
    activeIndex = 1;
  } else {
    activeIndex = 0;
  }

  const durationSec = task.startedAt 
    ? Math.max(0, Math.floor(((task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now()) - new Date(task.startedAt).getTime()) / 1000))
    : 0;

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="border-b border-[var(--line)] bg-[var(--panel)]/90 backdrop-blur-md px-4 py-2 flex items-center justify-between text-xs select-none shadow-sm perspective-container z-10 flex-shrink-0">
      {/* 3D Stages Track */}
      <div className="flex items-center gap-1.5 sm:gap-3 flex-wrap transform-style-3d">
        {phases.map((p, idx) => {
          const isDone = isCompleted || idx < activeIndex;
          const isCurrent = isWorking && idx === activeIndex;
          const isPending = idx > activeIndex && !isCompleted;

          return (
            <div
              key={p.key}
              className={`flex items-center gap-2 px-2.5 py-1 rounded-md transition-all duration-300 ${
                isCurrent
                  ? 'bg-sky-500/15 border border-sky-400/50 text-sky-400 font-semibold floating-step shadow-lg shadow-sky-500/10'
                  : isDone
                  ? 'text-emerald-400 font-medium hover:bg-emerald-500/10'
                  : 'text-[var(--faint)] opacity-60'
              }`}
            >
              <div className="flex items-center justify-center">
                {isDone ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : isCurrent ? (
                  <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-current text-[10px] flex items-center justify-center">
                    {idx + 1}
                  </span>
                )}
              </div>
              <div className="flex flex-col">
                <span className="leading-tight">{p.label}</span>
                <span className="text-[10px] text-[var(--muted)] font-normal hidden lg:inline">{p.desc}</span>
              </div>
              {idx < phases.length - 1 && (
                <div className="w-3 h-[1px] bg-[var(--line)] hidden sm:block ml-1 opacity-50" />
              )}
            </div>
          );
        })}
      </div>

      {/* Status & Actions */}
      <div className="flex items-center gap-3">
        {durationSec > 0 && (
          <div className="flex items-center gap-1 text-[var(--muted)] font-mono text-[11px]" title="Thời gian thực thi">
            <Clock className="w-3.5 h-3.5 text-[var(--faint)]" />
            <span>{formatDuration(durationSec)}</span>
          </div>
        )}

        {isWorking && onCancel && (
          <button
            onClick={onCancel}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 border border-rose-800/40 transition-colors"
          >
            <XCircle className="w-3 h-3" />
            <span>Dừng agent</span>
          </button>
        )}

        {isCompleted && (
          <div className="flex items-center gap-1 text-emerald-400 font-medium text-[11px]">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Hoàn thành</span>
          </div>
        )}

        {isFailed && (
          <div className="flex items-center gap-1 text-rose-400 font-medium text-[11px]">
            <XCircle className="w-3.5 h-3.5" />
            <span>Thất bại</span>
          </div>
        )}
      </div>
    </div>
  );
}
