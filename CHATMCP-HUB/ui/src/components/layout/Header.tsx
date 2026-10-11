import { useAppStore } from '@/store/useAppStore';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { 
  Folder, 
  Search, 
  Sun, 
  Moon, 
  PanelRightClose, 
  PanelRightOpen, 
  ShieldCheck, 
  ShieldAlert, 
  Bot, 
  Eye, 
  RefreshCw,
  Cpu
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';

export function Header() {
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 2500 });
  const { t, lang } = useTranslation();
  const { 
    theme, 
    setTheme, 
    inspectorOpen, 
    toggleInspector, 
    setCommandPaletteOpen,
    setActiveTab,
    setInspectorOpen
  } = useAppStore();

  const workspacePath = hub?.workspace?.path || hub?.studio?.workspace || 'Chưa chọn workspace';
  const shortWs = workspacePath.split(/[\\/]/).filter(Boolean).pop() || 'Workspace';
  const mode = hub?.studio?.permissions?.mode || 'review';
  const isFullAccess = hub?.studio?.permissions?.executionPolicy === 'full-access';

  const handleBrowseWorkspace = async () => {
    try {
      const res = await api.browseWorkspace();
      if (res.path) {
        await api.selectWorkspace(res.path);
      }
    } catch {
      // Ignored
    }
  };

  const getModeInfo = () => {
    if (isFullAccess) {
      return { label: 'FULL ACCESS ⚠️', color: 'text-rose-400 border-rose-500/60 bg-rose-950/40 animate-pulse', icon: ShieldAlert };
    }
    if (mode === 'readonly') return { label: 'Chỉ đọc', color: 'text-slate-400 border-slate-700 bg-slate-900', icon: Eye };
    if (mode === 'autonomous') return { label: 'Tự động', color: 'text-purple-400 border-purple-700/60 bg-purple-950/30', icon: Bot };
    return { label: 'Review', color: 'text-sky-400 border-sky-700/60 bg-sky-950/30', icon: ShieldCheck };
  };

  const modeInfo = getModeInfo();
  const ModeIcon = modeInfo.icon;

  return (
    <header className="h-12 border-b border-[var(--line)] bg-[var(--panel)] px-3 flex items-center justify-between select-none z-20 flex-shrink-0">
      {/* Brand & Workspace */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 font-bold text-sm tracking-tight">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-sky-400 to-teal-400 flex items-center justify-center text-slate-950 font-black text-xs shadow-sm shadow-sky-500/20">
            C
          </div>
          <span>ChatMCP <span className="font-normal text-[var(--muted)]">Studio</span></span>
        </div>

        <button
          onClick={handleBrowseWorkspace}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-[var(--surface)] hover:bg-[var(--surface-hover)] border border-[var(--line)] text-[var(--text)] transition-colors"
          title={`Thư mục: ${workspacePath} (Nhấp để đổi)`}
        >
          <Folder className="w-3.5 h-3.5 text-sky-400" />
          <span className="max-w-[150px] truncate">{shortWs}</span>
        </button>
      </div>

      {/* Center Search / Command Palette */}
      <button
        onClick={() => setCommandPaletteOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs bg-[var(--surface)] hover:bg-[var(--surface-hover)] border border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)] transition-colors w-64 shadow-inner"
      >
        <Search className="w-3.5 h-3.5 text-[var(--faint)]" />
        <span className="flex-1 text-left">Tìm kiếm hoặc lệnh...</span>
        <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--panel)] border border-[var(--line)] text-[var(--faint)]">
          Ctrl K
        </kbd>
      </button>

      {/* Right Controls */}
      <div className="flex items-center gap-2">
        {/* Hub Connection Badge */}
        <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--muted)]">
          <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
          <span className="hidden sm:inline">{t('hub_connected')}</span>
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
