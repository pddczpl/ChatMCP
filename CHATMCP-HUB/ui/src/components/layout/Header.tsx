import { useAppStore } from '@/store/useAppStore';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { 
  Folder, 
  Search, 
  Sun, 
  Moon, 
  PanelRightClose, 
  PanelRightOpen, 
  PanelLeft,
  ShieldCheck, 
  ShieldAlert, 
  Bot, 
  Eye, 
  RefreshCw,
  Cpu
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';
import { GitWorkspacePicker } from './GitWorkspacePicker';

export function Header() {
  const queryClient=useQueryClient();
  const { data: hub, error } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 2500 });
  const { t, lang } = useTranslation();
  const { 
    theme, 
    sidebarOpen,
    toggleSidebar,
    setTheme, 
    inspectorOpen, 
    toggleInspector, 
    setCommandPaletteOpen,
    setActiveTab,
    setInspectorOpen,
    showToast,
    selectedWorkspacePath,
    setSelectedWorkspacePath,
    setSelectedTaskId
  } = useAppStore();

  const registered=hub?.workspaces?.items || [];
  const workspacePath = (selectedWorkspacePath && registered.some(x=>x.path===selectedWorkspacePath)
    ? selectedWorkspacePath : hub?.workspaces
      ? hub.workspaces.activePath
      : hub?.workspace?.path) || 'Chưa chọn workspace';
  const shortWs = workspacePath.split(/[\\/]/).filter(Boolean).pop() || 'Workspace';
  const mode = hub?.studio?.permissions?.mode || 'review';
  const isFullAccess = hub?.studio?.permissions?.executionPolicy === 'full-access';

  const handleBrowseWorkspace = async () => {
    try {
      const res = await api.browseWorkspace(workspacePath==='Chưa chọn workspace'?null:workspacePath);
      if (res.path) {
        const added = await api.addWorkspace(res.path);
        await api.activateWorkspace(added.workspace.path);
        setSelectedWorkspacePath(added.workspace.path);
        setSelectedTaskId('');
        await queryClient.invalidateQueries({queryKey:['hubState']});
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không thể chọn workspace.', 'error');
    }
  };

  const getModeInfo = () => {
    if (isFullAccess) {
      return { label: 'FULL ACCESS ⚠️', color: 'text-[var(--danger)] border-[var(--danger)] bg-[var(--danger-bg)]', icon: ShieldAlert };
    }
    if (mode === 'readonly') return { label: 'Chỉ đọc', color: 'text-[var(--muted)] border-[var(--line)] bg-[var(--surface)]', icon: Eye };
    if (mode === 'autonomous') return { label: 'Tự động', color: 'text-[var(--primary)] border-[var(--line)] bg-[var(--primary-bg)]', icon: Bot };
    return { label: 'Review', color: 'text-[var(--primary)] border-[var(--line)] bg-[var(--primary-bg)]', icon: ShieldCheck };
  };

  const modeInfo = getModeInfo();
  const ModeIcon = modeInfo.icon;

  return (
    <header className="h-14 border-b border-[var(--line)] bg-[var(--panel)] px-3 flex items-center justify-between gap-3 select-none z-20 flex-shrink-0">
      {/* Brand & Workspace */}
      <div className="flex items-center gap-2 min-w-0">
        <Button variant="quiet" size="icon" onClick={toggleSidebar} aria-label={sidebarOpen ? 'Thu gọn hội thoại' : 'Mở danh sách hội thoại'} title="Danh sách hội thoại (Ctrl+B)"><PanelLeft className="w-4 h-4" /></Button>
        <div className="flex items-center gap-2 font-bold text-sm tracking-tight">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-sky-400 to-teal-400 flex items-center justify-center text-slate-950 font-black text-xs shadow-sm shadow-sky-500/20">
            C
          </div>
          <span className="hidden sm:inline">ChatMCP <span className="font-normal text-[var(--muted)]">Studio</span></span>
        </div>

        <button
          onClick={handleBrowseWorkspace}
          className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-[var(--surface)] hover:bg-[var(--surface-hover)] border border-[var(--line)] text-[var(--text)] transition-colors"
          title={`Thư mục: ${workspacePath} (Nhấp để đổi)`}
        >
          <Folder className="w-3.5 h-3.5 text-[var(--primary)]" />
          <span className="max-w-[150px] truncate">{shortWs}</span>
        </button>
        <GitWorkspacePicker workspace={workspacePath === 'Chưa chọn workspace' ? '' : workspacePath} />
      </div>

      {/* Center Search / Command Palette */}
      <button
        onClick={() => setCommandPaletteOpen(true)}
        aria-label="Tìm kiếm hoặc lệnh"
        className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-md text-xs bg-[var(--surface)] hover:bg-[var(--surface-hover)] border border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)] transition-colors max-w-64 min-w-32 flex-1"
      >
        <Search className="w-3.5 h-3.5 text-[var(--faint)]" />
        <span className="flex-1 text-left">Tìm kiếm hoặc lệnh...</span>
        <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-[var(--panel)] border border-[var(--line)] text-[var(--faint)]">
          Ctrl K
        </kbd>
      </button>

      {/* Right Controls */}
      <div className="flex items-center gap-2">
        {/* Hub Connection Badge */}
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--muted)]">
          <span className={`w-2 h-2 rounded-full ${error ? 'bg-rose-400' : hub ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span className="hidden sm:inline" title={error?.message}>{error ? (lang === 'en' ? 'Hub disconnected' : 'Mất kết nối Hub') : hub ? t('hub_connected') : (lang === 'en' ? 'Connecting to Hub' : 'Đang kết nối Hub')}</span>
        </div>

        {/* Mode Pill */}
        <button
          onClick={() => {
            setInspectorOpen(true);
            setActiveTab('settings');
          }}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${modeInfo.color}`}
          title="Quy định quyền của agent (Nhấp để chỉnh trong Cài đặt)"
        >
          <ModeIcon className="w-3.5 h-3.5" />
          <span>{modeInfo.label}</span>
        </button>

        {/* AI Provider Chip */}
        <button
          onClick={() => {
            setInspectorOpen(true);
            setActiveTab('intelligence');
          }}
          className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-[var(--surface)] hover:bg-[var(--surface-hover)] border border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
          title="Cấu hình mô hình AI"
        >
          <Cpu className="w-3.5 h-3.5 text-teal-400" />
          <span className="max-w-[120px] truncate">{hub?.ai?.model || (lang === 'en' ? 'No AI configured' : 'Chưa kết nối AI')}</span>
        </button>

        {/* Theme Switcher */}
        <Button
          variant="quiet"
          size="icon"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          title="Chuyển theme sáng / tối"
        >
          {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </Button>

        {/* Inspector Toggle */}
        <Button
          variant="quiet"
          size="icon"
          onClick={toggleInspector}
          title={inspectorOpen ? 'Thu gọn Inspector (Ctrl+J)' : 'Mở Inspector (Ctrl+J)'}
        >
          {inspectorOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
        </Button>
      </div>
    </header>
  );
}
