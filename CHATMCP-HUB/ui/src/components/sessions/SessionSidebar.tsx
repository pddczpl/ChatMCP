import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { 
  Plus, 
  Search, 
  FolderGit2, 
  Trash2, 
  CheckCircle2, 
  Loader2, 
  AlertCircle, 
  Clock, 
  MessageSquare
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function SessionSidebar() {
  const { selectedTaskId, setSelectedTaskId } = useAppStore();
  const [search, setSearch] = useState('');

  const { data: hub, refetch: refetchHub } = useQuery({ 
    queryKey: ['hubState'], 
    queryFn: api.getState,
    refetchInterval: 3000 
  });

  const tasks = hub?.tasks || [];
  const workspace = hub?.workspace;

  // Filter tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (!search.trim()) return true;
      const text = `${t.task || ''} ${t.id || ''}`.toLowerCase();
      return text.includes(search.toLowerCase());
    });
  }, [tasks, search]);

  // Group tasks into "Hôm nay", "7 ngày qua", "Cũ hơn"
  const groupedTasks = useMemo(() => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const sevenDays = 7 * oneDay;

    const today: typeof tasks = [];
    const week: typeof tasks = [];
    const older: typeof tasks = [];

    filteredTasks.forEach((t) => {
      const time = t.createdAt ? new Date(t.createdAt).getTime() : now;
      const diff = now - time;
      if (diff < oneDay) {
        today.push(t);
      } else if (diff < sevenDays) {
        week.push(t);
      } else {
        older.push(t);
      }
    });

    return { today, week, older };
  }, [filteredTasks]);

  const handleCreateNewTask = async () => {
    try {
      const res = await api.createTask({
        task: 'Phiên làm việc mới',
      });
      if (res?.task?.id) {
        setSelectedTaskId(res.task.id);
        refetchHub();
      }
    } catch {
      // Fallback: clear selected task to show composer welcome
      setSelectedTaskId('');
    }
  };

  const handleDeleteTask = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Bạn có chắc muốn xóa phiên làm việc này?')) return;
    try {
      await api.deleteTask(id);
      if (selectedTaskId === id) {
        setSelectedTaskId('');
      }
      refetchHub();
    } catch {
      // Ignore
    }
  };

  const renderStatusIcon = (status: string) => {
    if (status === 'working' || status === 'in_progress') {
      return <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />;
    }
    if (status === 'completed' || status === 'success') {
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
    }
    if (status === 'failed' || status === 'error') {
      return <AlertCircle className="w-3.5 h-3.5 text-rose-400" />;
    }
    return <Clock className="w-3.5 h-3.5 text-[var(--faint)]" />;
  };

  const renderTaskItem = (t: (typeof tasks)[0]) => {
    const isSelected = selectedTaskId === t.id;
    const title = t.task || `Phiên #${t.id.slice(0, 8)}`;
    const timeStr = t.createdAt ? new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    return (
      <div
        key={t.id}
        onClick={() => setSelectedTaskId(t.id)}
        className={`group relative flex items-start gap-2.5 p-2.5 rounded-lg cursor-pointer transition-all duration-200 select-none tilt-3d ${
          isSelected
            ? 'bg-sky-500/10 border border-sky-500/30 text-[var(--text)] shadow-sm'
            : 'hover:bg-[var(--surface-hover)] border border-transparent text-[var(--muted)] hover:text-[var(--text)]'
        }`}
      >
        <div className="mt-0.5 flex-shrink-0">
          {renderStatusIcon(t.status)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className={`text-xs truncate font-medium ${isSelected ? 'text-sky-300' : ''}`}>
              {title}
            </span>
            {timeStr && (
              <span className="text-[10px] text-[var(--faint)] flex-shrink-0">
                {timeStr}
              </span>
            )}
          </div>
          <p className="text-[11px] text-[var(--faint)] line-clamp-1 mt-0.5">
            {t.stage || t.lastMessage || 'Chưa có hoạt động'}
          </p>
        </div>
        <button
          onClick={(e) => handleDeleteTask(t.id, e)}
          className="opacity-0 group-hover:opacity-100 p-1 hover:text-rose-400 rounded transition-opacity"
          title="Xóa phiên"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  };

  return (
    <aside className="w-full h-full flex flex-col bg-[var(--panel)] border-r border-[var(--line)] select-none">
      {/* Top Header & New Button */}
      <div className="p-3 border-b border-[var(--line)] flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
            Phiên làm việc
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={handleCreateNewTask}
            className="h-7 text-xs px-2.5 gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Phiên mới</span>
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm kiếm phiên..."
            className="w-full bg-[var(--surface)] text-[var(--text)] text-xs rounded-md pl-8 pr-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500 transition-colors"
          />
        </div>
      </div>

      {/* Workspace Quick Card */}
      {workspace && (
        <div className="p-2.5 mx-2.5 my-2 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center gap-2.5 text-xs text-[var(--muted)] tilt-3d">
          <FolderGit2 className="w-4 h-4 text-sky-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[11px] truncate text-[var(--text)] font-medium">
              {workspace.path?.split(/[\\/]/).filter(Boolean).pop() || 'Workspace'}
            </div>
            <div className="text-[10px] text-[var(--faint)] flex items-center gap-2">
              <span>{workspace.git?.branch || 'main'}</span>
              {workspace.git?.dirty && <span className="text-amber-400 font-semibold">• Có thay đổi</span>}
            </div>
          </div>
        </div>
      )}

      {/* Session Lists Grouped */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {filteredTasks.length === 0 ? (
          <div className="py-12 px-4 text-center text-[var(--faint)] flex flex-col items-center gap-2">
            <MessageSquare className="w-8 h-8 opacity-40" />
            <p className="text-xs">Chưa có phiên làm việc nào</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleCreateNewTask}
              className="text-xs mt-1"
            >
              Bắt đầu ngay
            </Button>
          </div>
        ) : (
          <>
            {groupedTasks.today.length > 0 && (
              <div>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)]">
                  Hôm nay
                </div>
                <div className="space-y-1 mt-1">
                  {groupedTasks.today.map(renderTaskItem)}
                </div>
              </div>
            )}

            {groupedTasks.week.length > 0 && (
              <div>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)]">
                  7 ngày qua
                </div>
                <div className="space-y-1 mt-1">
                  {groupedTasks.week.map(renderTaskItem)}
                </div>
              </div>
            )}

            {groupedTasks.older.length > 0 && (
              <div>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)]">
                  Cũ hơn
                </div>
                <div className="space-y-1 mt-1">
                  {groupedTasks.older.map(renderTaskItem)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
