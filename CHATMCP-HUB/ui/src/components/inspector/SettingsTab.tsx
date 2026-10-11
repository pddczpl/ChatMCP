import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { 
  Settings, 
  Shield, 
  Moon, 
  Sun, 
  Globe, 
  Download, 
  RotateCcw, 
  Server, 
  UserCheck 
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function SettingsTab() {
  const { theme, setTheme, showToast, setFullAccessModalOpen } = useAppStore();
  const [lang, setLang] = useState<'vi' | 'en'>('vi');

  const { data: hub, refetch } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const permissions: any = hub?.studio?.permissions || {};
  const currentMode = permissions.mode || 'review';
  const isFullAccess = permissions.executionPolicy === 'full-access';
  const role = hub?.user?.role || 'admin';

  const handleModeChange = async (mode: string) => {
    if (mode === 'full-access') {
      setFullAccessModalOpen(true);
      return;
    }
    try {
      await api.setPermissions({ mode: mode as any, executionPolicy: 'review' });
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
      {/* RBAC Profile Box */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between tilt-3d">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 flex items-center justify-center">
            <UserCheck className="w-4 h-4" />
          </div>
          <div>
            <div className="font-semibold text-[var(--text)]">
              Vai trò người dùng (RBAC)
            </div>
            <div className="text-[10px] text-[var(--faint)] font-mono uppercase">
              Cấp bậc: {role}
            </div>
          </div>
        </div>

        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-sky-500/20 text-sky-400 border border-sky-500/30">
          Đầy đủ quyền
        </span>
      </div>

      {/* Permission Execution Modes */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          Chế độ quyền thực thi của Agent
        </label>
        <div className="space-y-1.5">
          {[
            { id: 'readonly', label: 'Chỉ đọc (Read-only)', desc: 'Agent chỉ đọc file và tìm kiếm, không sửa đổi.' },
            { id: 'review', label: 'Review (Mặc định)', desc: 'Yêu cầu phê duyệt trước khi ghi file hoặc chạy lệnh shell.' },
            { id: 'autonomous', label: 'Tự động (Autonomous)', desc: 'Tự động chạy các tool trong workspace mà không hỏi lại.' },
            { id: 'full-access', label: 'FULL ACCESS ⚠️', desc: 'Quyền tối đa không giới hạn, vượt qua xác nhận.' },
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
          Giao diện (Theme)
        </label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 'dark', label: 'Tối', icon: Moon },
            { id: 'light', label: 'Sáng', icon: Sun },
            { id: 'system', label: 'Hệ thống', icon: Globe },
          ].map((t) => {
            const Icon = t.icon;
            const isSelected = theme === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id as any)}
                className={`flex items-center justify-center gap-1.5 p-2 rounded-lg border text-xs transition-all ${
                  isSelected
                    ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                    : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Language */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          Ngôn ngữ (Language)
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setLang('vi')}
            className={`p-2 rounded-lg border text-xs text-center transition-all ${
              lang === 'vi'
                ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)]'
            }`}
          >
            Tiếng Việt (Mặc định)
          </button>
          <button
            onClick={() => {
              setLang('en');
              showToast('English i18n mode enabled', 'info');
            }}
            className={`p-2 rounded-lg border text-xs text-center transition-all ${
              lang === 'en'
                ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)]'
            }`}
          >
            English
          </button>
        </div>
      </div>

      {/* Server & Port Info */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] space-y-1.5 font-mono text-[11px]">
        <div className="flex items-center gap-2 text-sky-400 font-sans font-semibold text-xs">
          <Server className="w-3.5 h-3.5" />
          <span>ChatMCP Hub Backend</span>
        </div>
        <div className="text-[var(--faint)]">Host: 127.0.0.1 (Loopback)</div>
        <div className="text-[var(--faint)]">CSP: Strict Self + No Unsafe-Inline</div>
        <div className="text-[var(--faint)]">Status: Hoạt động bình thường</div>
      </div>

      {/* Export / Reset Actions */}
      <div className="pt-2 border-t border-[var(--line-subtle)] flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={handleExportLogs}
          className="flex-1 gap-1.5 h-8 text-xs"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Xuất dữ liệu</span>
        </Button>
      </div>
    </div>
  );
}
