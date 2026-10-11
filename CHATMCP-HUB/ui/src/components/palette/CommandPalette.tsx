import { useEffect } from 'react';
import { Command } from 'cmdk';
import { useAppStore, InspectorTab } from '@/store/useAppStore';
import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import { 
  Plus, 
  Folder, 
  ShieldCheck, 
  ShieldAlert, 
  Bot, 
  Eye, 
  Moon, 
  Sun, 
  Activity, 
  FileCode, 
  GitBranch, 
  Terminal, 
  ListTodo, 
  Globe, 
  Cpu, 
  Puzzle, 
  Settings, 
  Search 
} from 'lucide-react';

export function CommandPalette() {
  const { 
    commandPaletteOpen, 
    setCommandPaletteOpen, 
    setSelectedTaskId, 
    setActiveTab, 
    setInspectorOpen, 
    setTheme, 
    setFullAccessModalOpen,
    showToast 
  } = useAppStore();

  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState });

  // Global Ctrl+K / Cmd+K shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      if (e.key === 'Escape' && commandPaletteOpen) {
        setCommandPaletteOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  if (!commandPaletteOpen) return null;

  const runAction = (fn: () => void) => {
    fn();
    setCommandPaletteOpen(false);
  };

  const handleCreateNewTask = async () => {
    try {
      const res = await api.createTask({ task: 'Phiên làm việc mới' });
      if (res?.task?.id) {
        setSelectedTaskId(res.task.id);
        showToast('Đã tạo phiên mới', 'success');
      }
    } catch {
      setSelectedTaskId('');
    }
  };

  const handleSelectMode = async (mode: string) => {
    if (mode === 'full-access') {
      setFullAccessModalOpen(true);
      return;
    }
    try {
      await api.setPermissions({ mode: mode as any, executionPolicy: 'review' });
      showToast(`Đã chuyển quyền sang ${mode}`, 'info');
    } catch (err: any) {
      showToast(err.message || 'Lỗi chuyển quyền', 'error');
    }
  };

  const handleBrowseWorkspace = async () => {
    try {
      const res = await api.browseWorkspace();
      if (res.path) {
        await api.selectWorkspace(res.path);
        showToast(`Đã chọn workspace: ${res.path}`, 'success');
      }
    } catch {
      // Ignore
    }
  };

  const openInspectorTab = (tab: InspectorTab) => {
    setInspectorOpen(true);
    setActiveTab(tab);
  };

  return (
    <div
      onClick={() => setCommandPaletteOpen(false)}
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 p-4 bg-black/60 backdrop-blur-sm perspective-container"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl modal-3d-enter overflow-hidden text-xs select-none"
      >
        <Command className="flex flex-col h-full">
          {/* Search Input Bar */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--line)] bg-[var(--surface)]">
            <Search className="w-4 h-4 text-sky-400 flex-shrink-0" />
            <Command.Input
              autoFocus
              placeholder="Gõ lệnh hoặc tìm kiếm thao tác (Enter để chọn)..."
              className="w-full bg-transparent text-[var(--text)] text-xs placeholder-[var(--faint)] focus:outline-none"
            />
            <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--panel)] border border-[var(--line)] text-[var(--faint)]">
              ESC
            </kbd>
          </div>

          {/* List of Suggestions */}
          <Command.List className="max-h-80 overflow-y-auto p-2 space-y-1">
            <Command.Empty className="py-6 text-center text-xs text-[var(--faint)]">
              Không tìm thấy lệnh phù hợp
            </Command.Empty>

            {/* Section: Phiên làm việc */}
            <Command.Group heading="Phiên làm việc & Workspace" className="text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)] px-2 py-1">
              <Command.Item
                onSelect={() => runAction(handleCreateNewTask)}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)] transition-colors"
              >
                <Plus className="w-3.5 h-3.5 text-sky-400" />
                <span className="flex-1 font-medium">Tạo phiên làm việc mới</span>
                <span className="text-[10px] text-[var(--faint)] font-mono">New Session</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(handleBrowseWorkspace)}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)] transition-colors"
              >
                <Folder className="w-3.5 h-3.5 text-sky-400" />
                <span className="flex-1 font-medium">Đổi thư mục Workspace</span>
                <span className="text-[10px] text-[var(--faint)] font-mono">Open Folder</span>
              </Command.Item>
            </Command.Group>

            {/* Section: Chế độ quyền */}
            <Command.Group heading="Chế độ quyền thực thi" className="text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)] px-2 py-1 mt-2">
              <Command.Item
                onSelect={() => runAction(() => handleSelectMode('readonly'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <Eye className="w-3.5 h-3.5 text-slate-400" />
                <span className="flex-1 font-medium">Chế độ Chỉ đọc (Read-only)</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(() => handleSelectMode('review'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
                <span className="flex-1 font-medium">Chế độ Review (Phê duyệt trước khi ghi)</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(() => handleSelectMode('autonomous'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <Bot className="w-3.5 h-3.5 text-purple-400" />
                <span className="flex-1 font-medium">Chế độ Tự động (Autonomous)</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(() => handleSelectMode('full-access'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-rose-950/30 text-rose-300"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                <span className="flex-1 font-medium">FULL ACCESS ⚠️ (Cần xác nhận)</span>
              </Command.Item>
            </Command.Group>

            {/* Section: Chuyển tab Inspector */}
            <Command.Group heading="Điều hướng Inspector" className="text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)] px-2 py-1 mt-2">
              <Command.Item
                onSelect={() => runAction(() => openInspectorTab('activity'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <Activity className="w-3.5 h-3.5 text-sky-400" />
                <span>Xem nhật ký Hoạt động (Activity)</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(() => openInspectorTab('git'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <GitBranch className="w-3.5 h-3.5 text-teal-400" />
                <span>Xem Git & Checkpoints</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(() => openInspectorTab('terminal'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <Terminal className="w-3.5 h-3.5 text-amber-400" />
                <span>Xem Terminal Output</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(() => openInspectorTab('intelligence'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <Cpu className="w-3.5 h-3.5 text-sky-400" />
                <span>Cấu hình AI Models & Kiểm tra kết nối</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(() => openInspectorTab('skills'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <Puzzle className="w-3.5 h-3.5 text-purple-400" />
                <span>Mở Chợ kỹ năng (Skills Marketplace)</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(() => openInspectorTab('settings'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <Settings className="w-3.5 h-3.5 text-slate-400" />
                <span>Mở Cài đặt hệ thống (Settings)</span>
              </Command.Item>
            </Command.Group>

            {/* Section: Giao diện */}
            <Command.Group heading="Giao diện (Theme)" className="text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)] px-2 py-1 mt-2">
              <Command.Item
                onSelect={() => runAction(() => setTheme('dark'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <Moon className="w-3.5 h-3.5 text-sky-400" />
                <span>Giao diện Tối (Dark mode)</span>
              </Command.Item>

              <Command.Item
                onSelect={() => runAction(() => setTheme('light'))}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface-hover)] text-[var(--text)]"
              >
                <Sun className="w-3.5 h-3.5 text-amber-400" />
                <span>Giao diện Sáng (Light mode)</span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
