import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { isTaskActive, taskStateLabel } from '@/lib/task-view';
import { Loader2, StopCircle, Clock, CheckCircle2, ChevronRight, GitBranch } from 'lucide-react';

export function BackgroundTasks() {
  const { data: hub } = useQuery({queryKey:['hubState'],queryFn:api.getState,refetchInterval:2000});
  const queryClient = useQueryClient();
  const {selectedTaskId,setSelectedTaskId,showToast} = useAppStore();
  const tasks = [...(hub?.tasks || [])].sort((a,b) => {
    const active = (t: typeof a) => isTaskActive(t) ? 0 : 1;
    return active(a)-active(b) ||
      String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt));
  }).slice(0,40);
  const activeCount = tasks.filter(isTaskActive).length;
  const cancel = async (id:string) => {
    try {
      await api.cancelTask(id);
      await queryClient.invalidateQueries({queryKey:['hubState']});
      showToast('Đã gửi yêu cầu dừng task', 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể dừng task','error');
    }
  };
  return (
    <div className="h-full flex flex-col bg-[var(--panel)] min-h-0">
      <div className="px-3 py-2 border-b border-[var(--line)] text-xs text-[var(--muted)]">
        {activeCount} đang chạy / chuẩn bị · {tasks.length} phiên
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {!tasks.length && <p className="p-4 text-xs text-[var(--faint)]">Chưa có công việc nền. Bạn có thể tạo chat mới trong khi chat khác đang chạy.</p>}
        {tasks.map((task) => {
          const active = isTaskActive(task);
          const selected = selectedTaskId===task.id;
          return <div key={task.id} className={'rounded-lg border p-2 transition-colors '+(selected?'border-sky-500/50 bg-sky-500/10':'border-[var(--line)] hover:bg-[var(--surface-hover)]')}>
            <div className="flex items-center gap-1.5">
              {active?<Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400"/>:
                task.state==='completed'?<CheckCircle2 className="w-3.5 h-3.5 text-emerald-400"/>:<Clock className="w-3.5 h-3.5 text-[var(--faint)]"/>}
              <button className="flex-1 min-w-0 text-left text-xs font-medium truncate" title={task.task||task.prompt} onClick={()=>setSelectedTaskId(task.id)}>
                {task.task||task.prompt||'Task '+task.id.slice(0,8)}
              </button>
              <button type="button" aria-label={'Mở '+task.id} onClick={()=>setSelectedTaskId(task.id)}><ChevronRight className="w-3.5 h-3.5"/></button>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
              <span>{taskStateLabel(task.state||task.status||'')}</span>
              {task.branch && <span className="flex gap-1 items-center truncate"><GitBranch className="w-3 h-3"/>{task.branch}</span>}
            </div>
            {task.dependsOn && task.dependsOn.length>0 && <p className="mt-1 text-[11px] text-amber-400 truncate" title={task.dependsOn.join(', ')}>
              Phụ thuộc: {task.dependsOn.map(id=>id.slice(0,8)).join(', ')}
            </p>}
            {active && <button className="mt-2 flex items-center gap-1 text-[11px] text-rose-400 hover:underline" onClick={()=>void cancel(task.id)}>
              <StopCircle className="w-3 h-3"/> Dừng task này
            </button>}
          </div>;
        })}
      </div>
    </div>
  );
}
