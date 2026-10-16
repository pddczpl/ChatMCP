import { useAppStore } from '@/store/useAppStore';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { BackgroundTasks } from '@/components/layout/BackgroundTasks';
import { InspectorPanel } from '@/components/inspector/InspectorPanel';
import { ListTodo, PanelRight, Settings } from 'lucide-react';

export function RightWorkspacePanel() {
  const {rightPanelView,setRightPanelView,setInspectorOpen,selectedWorkspacePath}=useAppStore();
  const {data:hub}=useQuery({queryKey:['hubState'],queryFn:api.getState,refetchInterval:3000});
  const current=selectedWorkspacePath||hub?.workspaces?.activePath;
  const legacy=hub?.workspace?.path;
  const inspectorDifferentRoot=Boolean(current&&legacy&&current!==legacy);
  return <aside className="w-full h-full flex flex-col border-l border-[var(--line)] bg-[var(--panel)] min-w-0">
    <div className="flex items-center gap-1 px-2 py-2 border-b border-[var(--line)] flex-shrink-0">
      <button aria-pressed={rightPanelView==='tasks'} onClick={()=>setRightPanelView('tasks')}
        className={'px-2 py-1.5 rounded-md flex items-center gap-1.5 text-xs '+(rightPanelView==='tasks'?'bg-[var(--surface-hover)] text-[var(--text)]':'text-[var(--muted)]')}>
        <ListTodo className="w-3.5 h-3.5"/> Background tasks
      </button>
      <button aria-pressed={rightPanelView==='inspector'} onClick={()=>setRightPanelView('inspector')}
        className={'px-2 py-1.5 rounded-md flex items-center gap-1.5 text-xs '+(rightPanelView==='inspector'?'bg-[var(--surface-hover)] text-[var(--text)]':'text-[var(--muted)]')}>
        <Settings className="w-3.5 h-3.5"/> Inspector
      </button>
      <button aria-label="Ẩn bảng bên phải" className="ml-auto p-1 text-[var(--faint)]" onClick={()=>setInspectorOpen(false)}>
        <PanelRight className="w-3.5 h-3.5"/>
      </button>
    </div>
    <div className="flex-1 min-h-0">
      {rightPanelView==='tasks'?<BackgroundTasks/>:inspectorDifferentRoot
        ?<div role="status" className="p-4 text-xs text-[var(--muted)] space-y-2">
          <p className="font-semibold text-[var(--text)]">Workspace Inspector</p>
          <p>Agent đang xử lý thư mục đã chọn độc lập. Inspector file/Git/terminal cũ chỉ gắn với workspace chính.</p>
          <p>Để tránh sửa nhầm một dự án khác, các thao tác Inspector bị ẩn ở workspace thứ hai.
            Bạn vẫn có thể giao nhiều task, xem kết quả và dừng subagent trong Background Tasks.</p>
        </div>
        :<InspectorPanel/>}
    </div>
  </aside>;
}
