import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { 
  Settings, 
  Shield, 
  Moon, 
  Sun, 
  Globe, 
  Download, 
  Server, 
  UserCheck,
  Folder,
  Sparkles,
  RefreshCw
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function SettingsTab() {
  const { theme, setTheme, lang, setLang, showToast, setFullAccessModalOpen, setOnboardingOpen } = useAppStore();
  const { t } = useTranslation();

  const { data: hub, error: hubError, refetch } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const { data: sandboxStatus, isLoading: isSandboxLoading } = useQuery({
    queryKey: ['sandboxStatus'],
    queryFn: api.getSandboxStatus,
    refetchInterval: 5000,
  });
  const permissions: any = hub?.studio?.permissions || {};
  const currentMode = permissions.mode || 'review';
  const isFullAccess = permissions.executionPolicy === 'full-access';

  const currentWs = hub?.workspace?.path || hub?.studio?.workspace || '';
  const [wsInput, setWsInput] = useState(currentWs);
  const [applyingWs, setApplyingWs] = useState(false);

  useEffect(() => {
    if (currentWs && !wsInput) {
      setWsInput(currentWs);
    }
  }, [currentWs]);

  const handleBrowseWs = async () => {
    try {
      const res = await api.browseWorkspace();
      if (res.path) {
        setWsInput(res.path);
        await api.selectWorkspace(res.path);
        showToast(`${t('workspace_changed_toast')}: ${res.path}`, 'success');
        refetch();
      }
    } catch (err: any) {
      showToast(err.message || 'Lỗi duyệt thư mục', 'error');
    }
  };

  const handleApplyWs = async () => {
    if (!wsInput.trim()) return;
    setApplyingWs(true);
    try {
      await api.selectWorkspace(wsInput.trim());
      showToast(`${t('workspace_changed_toast')}: ${wsInput.trim()}`, 'success');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi thay đổi thư mục', 'error');
    } finally {
      setApplyingWs(false);
    }
  };

  const handleModeChange = async (mode: string) => {
    if (mode === 'full-access') {
      setFullAccessModalOpen(true);
      return;
    }
    try {
      await api.setPermissions({ mode, ...(isFullAccess ? { executionPolicy: 'host-review' } : {}) });
      showToast(`Đã đổi quyền sang ${mode}`, 'info');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi cập nhật quyền', 'error');
    }
  };

  const handleExportLogs = () => {
    const data = JSON.stringify(hub || {}, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chatmcp-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Đã xuất nhật ký hệ thống', 'success');
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-4 select-none text-xs">
      {/* Workspace Directory Selector */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-sky-500/30 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 flex items-center justify-center">
              <Folder className="w-4 h-4" />
            </div>
            <div>
              <div className="font-semibold text-[var(--text)]">
                {t('workspace_setting_title')}
              </div>
              <div className="text-[10px] text-[var(--faint)]">
                {t('workspace_setting_desc')}
              </div>
            </div>
          </div>
          <button
            onClick={() => setOnboardingOpen(true)}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--panel)] hover:bg-[var(--surface-hover)] border border-[var(--line-subtle)] text-[10px] text-sky-400 hover:text-sky-300 transition-colors"
            title={t('workspace_reopen_onboarding')}
          >
            <Sparkles className="w-3 h-3" />
            <span>{t('workspace_reopen_onboarding')}</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={wsInput}
            onChange={(e) => setWsInput(e.target.value)}
            placeholder="Đường dẫn thư mục dự án..."
            className="flex-1 bg-[var(--panel)] font-mono text-[11px] rounded-md px-2.5 py-1.5 border border-[var(--line)] text-[var(--text)] focus:border-sky-500 focus:outline-none"
          />
          <Button
            variant="secondary"
            onClick={handleBrowseWs}
            className="h-7 px-2.5 text-[11px] gap-1"
          >
            <Folder className="w-3 h-3 text-sky-400" />
            <span>{t('workspace_browse_btn')}</span>
          </Button>
          <Button
            variant="primary"
            onClick={handleApplyWs}
            disabled={applyingWs || !wsInput.trim() || wsInput === currentWs}
            className="h-7 px-2.5 text-[11px]"
          >
            {t('workspace_apply_btn')}
          </Button>
        </div>

        {currentWs && (
          <div className="text-[10px] text-[var(--muted)] font-mono truncate">
            <span className="text-[var(--faint)]">Đang dùng: </span>
            <span className="text-emerald-400 font-semibold">{currentWs}</span>
          </div>
        )}
      </div>

      {/* Local desktop scope */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 flex items-center justify-center">
            <UserCheck className="w-4 h-4" />
          </div>
          <div>
            <div className="font-semibold text-[var(--text)]">
              Máy tính cá nhân
            </div>
            <div className="text-[10px] text-[var(--faint)] font-mono uppercase">
              Một người dùng · Local Hub
            </div>
          </div>
        </div>

        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-sky-500/20 text-sky-400 border border-sky-500/30">
          Local-only
        </span>
      </div>

      {/* Execution Backend & OS Isolation */}
      <div data-testid="execution-backend-card" className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center border ${
              isSandboxLoading
                ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                : sandboxStatus?.osIsolated && sandboxStatus?.available
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
            }`}>
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <div className="font-semibold text-[var(--text)]">
                {t('sandbox_title')}
              </div>
              <div className="text-[10px] text-[var(--faint)]">
                {t('sandbox_desc')}
              </div>
            </div>
          </div>

          <span
            data-testid="backend-status-badge"
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
              isSandboxLoading
                ? 'bg-sky-500/20 text-sky-400 border-sky-500/30'
                : !sandboxStatus?.available
                  ? 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                  : sandboxStatus?.osIsolated
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                    : 'bg-amber-500/20 text-amber-400 border-amber-500/30'
            }`}
          >
            {isSandboxLoading
              ? t('sandbox_probing')
              : !sandboxStatus?.available
                ? (lang === 'vi' ? 'Không khả dụng' : 'Unavailable')
                : sandboxStatus?.osIsolated
                  ? t('sandbox_isolated')
                  : t('sandbox_unisolated')}
          </span>
        </div>

        <div className="space-y-1.5 font-mono text-[10px] bg-[var(--panel)] p-2.5 rounded border border-[var(--line-subtle)]">
          <div className="flex justify-between items-center text-[var(--text)]">
            <span className="text-[var(--faint)]">{t('sandbox_backend')}:</span>
            <span className="font-semibold">{sandboxStatus?.backend || 'host'} ({sandboxStatus?.platform || 'local'})</span>
          </div>
          <div className="flex justify-between items-center text-[var(--text)]">
            <span className="text-[var(--faint)]">{t('sandbox_os_isolation')}:</span>
            <span className={sandboxStatus?.osIsolated ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
              {sandboxStatus?.osIsolated ? t('sandbox_isolation_active') : t('sandbox_isolation_none')}
            </span>
          </div>
          <div className="flex justify-between items-center text-[var(--text)]">
            <span className="text-[var(--faint)]">{t('sandbox_enforced')}:</span>
            <span className="text-emerald-400">
              {sandboxStatus?.enforcedLimits?.join(', ') || 'timeoutSeconds, maxOutputBytes'}
            </span>
          </div>
          <div className="flex justify-between items-center text-[var(--text)]">
            <span className="text-[var(--faint)]">{t('sandbox_unsupported')}:</span>
            <span className="text-amber-400/90">
              {sandboxStatus?.unsupportedLimits?.join(', ') || 'maxMemoryMb, maxCpuCores'} ({t('sandbox_unenforced_hint')})
            </span>
          </div>
          {sandboxStatus?.reasons && sandboxStatus.reasons.length > 0 && (
            <div className="pt-1 text-[10px] border-t border-[var(--line-subtle)] space-y-0.5">
              {sandboxStatus.reasons.map((r: string, idx: number) => (
                <div key={idx} className="leading-tight text-amber-400/80">• {r}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Permission Execution Modes */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          {t('agent_exec_mode')}
        </label>
        <div className="space-y-1.5">
          {[
            { id: 'readonly', label: t('perm_read_only'), desc: t('perm_read_only_desc') },
            { id: 'review', label: t('perm_review'), desc: t('perm_review_desc') },
            { id: 'autonomous', label: t('perm_auto'), desc: t('perm_auto_desc') },
            { id: 'full-access', label: t('perm_full_access'), desc: t('perm_full_access_desc') },
          ].map((m) => {
            const isSelected = m.id === 'full-access' ? isFullAccess : currentMode === m.id && !isFullAccess;
            return (
              <button
                key={m.id}
                onClick={() => handleModeChange(m.id)}
                className={`w-full p-2.5 rounded-lg border text-left transition-all ${
                  isSelected
                    ? m.id === 'full-access'
                      ? 'bg-rose-950/30 border-rose-500 text-rose-300 font-medium'
                      : 'bg-sky-500/15 border-sky-500 text-sky-300 font-medium'
                    : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
                }`}
              >
                <div className="text-xs font-semibold">{m.label}</div>
                <div className="text-[11px] text-[var(--faint)] mt-0.5">{m.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Theme */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          {t('theme_label')}
        </label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 'dark', label: t('theme_dark'), icon: Moon },
            { id: 'light', label: t('theme_light'), icon: Sun },
            { id: 'system', label: t('theme_system'), icon: Globe },
          ].map((tItem) => {
            const Icon = tItem.icon;
            const isSelected = theme === tItem.id;
            return (
              <button
                key={tItem.id}
                onClick={() => setTheme(tItem.id as any)}
                className={`flex items-center justify-center gap-1.5 p-2 rounded-lg border text-xs transition-all ${
                  isSelected
                    ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                    : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tItem.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Language */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          {t('lang_label')}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => {
              setLang('vi');
              showToast('Đã chuyển ngôn ngữ sang Tiếng Việt', 'info');
            }}
            className={`p-2 rounded-lg border text-xs text-center transition-all ${
              lang === 'vi'
                ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
            }`}
          >
            {t('lang_vi')}
          </button>
          <button
            onClick={() => {
              setLang('en');
              showToast('Switched language to English', 'info');
            }}
            className={`p-2 rounded-lg border text-xs text-center transition-all ${
              lang === 'en'
                ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
            }`}
          >
            {t('lang_en')}
          </button>
        </div>
      </div>

      {/* Server & Port Info */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] space-y-1.5 font-mono text-[11px]">
        <div className="flex items-center gap-2 text-sky-400 font-sans font-semibold text-xs">
          <Server className="w-3.5 h-3.5" />
          <span>{t('backend_status')}</span>
        </div>
        <div className="text-[var(--faint)]">
          Host: {typeof window !== 'undefined' ? window.location?.host || '127.0.0.1:3007' : '127.0.0.1:3007'} (Local-only daemon; external hosting is not supported)
        </div>
        <div className={hubError ? 'text-rose-400' : 'text-[var(--faint)]'} role="status">
          {hubError ? `Không kết nối được Hub: ${hubError.message}` : hub ? 'Đã nhận trạng thái từ Hub' : 'Đang kết nối Hub…'}
        </div>
      </div>

      {/* Export / Reset Actions */}
      <div className="pt-2 border-t border-[var(--line-subtle)] flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={handleExportLogs}
          className="flex-1 gap-1.5 h-8 text-xs"
        >
          <Download className="w-3.5 h-3.5" />
          <span>{t('export_data')}</span>
        </Button>
      </div>
    </div>
  );
}
