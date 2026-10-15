import { useAppStore } from '@/store/useAppStore';
import { BackgroundTasks } from '@/components/layout/BackgroundTasks';
import { InspectorPanel } from '@/components/inspector/InspectorPanel';
import { ListTodo, PanelRight, Settings } from 'lucide-react';

export function RightWorkspacePanel() {
  const {rightPanelView,setRightPanelView,setInspectorOpen}=useAppStore();
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
      {rightPanelView==='tasks'?<BackgroundTasks/>:<InspectorPanel/>}
    </div>
  </aside>;
}
