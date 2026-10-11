import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { CheckCircle2, Circle, Loader2, ListTodo, AlertCircle } from 'lucide-react';

export function PlanTab() {
  const { selectedTaskId } = useAppStore();
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 2500 });
  const task = hub?.tasks?.find((t) => t.id === selectedTaskId) || hub?.tasks?.[0];

  const planSteps = task?.plan || [
    { title: 'Đọc và phân tích yêu cầu từ người dùng', status: 'completed' },
    { title: 'Quét workspace và lập danh sách file cần sửa', status: 'completed' },
    { title: 'Thực thi các thay đổi mã nguồn an toàn', status: task?.status === 'working' ? 'in_progress' : 'completed' },
    { title: 'Chạy kiểm thử và xác minh tính toàn vẹn', status: task?.status === 'working' ? 'pending' : 'completed' },
  ];

  const completedCount = planSteps.filter((s: any) => s.status === 'completed').length;
  const progressPercent = Math.round((completedCount / planSteps.length) * 100);

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-4 select-none text-xs">
      {/* Progress Bar Header */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] space-y-2 tilt-3d">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-xs text-[var(--text)]">Tiến độ kế hoạch</span>
          <span className="font-mono text-sky-400 font-bold">{progressPercent}%</span>
        </div>
        <div className="w-full h-1.5 rounded-full bg-[var(--panel)] overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-sky-500 to-teal-400 transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="text-[11px] text-[var(--faint)]">
          Đã hoàn thành {completedCount} trên {planSteps.length} bước
        </div>
      </div>

      {/* Steps List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[var(--muted)] pb-1 border-b border-[var(--line-subtle)]">
          <span className="font-semibold uppercase tracking-wider text-[10px]">Các bước thực thi</span>
        </div>

        <div className="space-y-2">
          {planSteps.map((step: any, idx: number) => {
            const isDone = step.status === 'completed';
            const isRunning = step.status === 'in_progress';
            const isError = step.status === 'failed';

            return (
              <div
                key={idx}
                className={`p-2.5 rounded-lg border flex items-start gap-2.5 transition-all tilt-3d ${
                  isRunning
                    ? 'bg-sky-500/10 border-sky-500/40 text-[var(--text)]'
                    : isDone
                    ? 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--text)]'
                    : 'bg-[var(--surface)]/50 border-transparent text-[var(--faint)]'
                }`}
              >
                <div className="mt-0.5 flex-shrink-0">
                  {isDone ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : isRunning ? (
                    <Loader2 className="w-4 h-4 text-sky-400 animate-spin" />
                  ) : isError ? (
                    <AlertCircle className="w-4 h-4 text-rose-400" />
                  ) : (
                    <Circle className="w-4 h-4 text-[var(--faint)]" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className={`font-medium ${isDone ? 'line-through opacity-75' : ''}`}>
                    {step.title || step.description}
                  </div>
                  {step.details && (
                    <p className="text-[11px] text-[var(--faint)] mt-0.5">
                      {step.details}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
