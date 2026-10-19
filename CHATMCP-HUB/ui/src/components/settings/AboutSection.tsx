import { useQuery } from '@tanstack/react-query';
import { Download, Info, Keyboard, Server } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { SettingsCard, FactRow } from './SettingsCard';

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl K', 'Tìm kiếm và chạy lệnh'],
  ['Ctrl B', 'Ẩn / hiện danh sách hội thoại'],
  ['Ctrl J', 'Ẩn / hiện bảng bên phải'],
  ['Ctrl ,', 'Mở cài đặt'],
  ['Enter', 'Gửi tin nhắn'],
  ['Shift Enter', 'Xuống dòng'],
  ['Esc', 'Đóng hộp thoại, bảng lệnh hoặc cài đặt'],
];

/** The Hub this window talks to, the keys, and a way to take the audit data out. */
export function AboutSection() {
  const { showToast } = useAppStore();
  const { t } = useTranslation();
  const { data: hub, error: hubError } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });

  const handleExportLogs = () => {
    // The per-launch CSRF token is not part of an export: it is only meaningful to the running Hub.
    const { csrfToken: _csrf, ...exportable } = (hub || {}) as Record<string, unknown>;
    const data = JSON.stringify(exportable, null, 2);
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
    <div className="space-y-5">
      <SettingsCard icon={Server} title={t('backend_status')} description="Hub chạy trên máy này và chỉ nhận kết nối từ chính máy này.">
        <dl>
          <FactRow label="Phiên bản">{hub?.version ? `v${hub.version}` : '–'}</FactRow>
          <FactRow label="Địa chỉ">{typeof window !== 'undefined' ? window.location?.host || '127.0.0.1:3007' : '127.0.0.1:3007'}</FactRow>
          <FactRow label="Trạng thái" tone={hubError ? 'danger' : hub ? 'success' : 'warning'}>
            <span role="status">{hubError ? `Không kết nối được Hub: ${hubError.message}` : hub ? 'Đã nhận trạng thái từ Hub' : 'Đang kết nối Hub…'}</span>
          </FactRow>
        </dl>
        <p className="text-[12px] leading-4 text-faint">Local-only daemon: không hỗ trợ đặt Hub lên máy chủ bên ngoài.</p>
      </SettingsCard>

      <SettingsCard icon={Keyboard} title="Phím tắt">
        <ul className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {SHORTCUTS.map(([keys, label]) => (
            <li key={keys} className="flex items-center justify-between gap-3 border-b border-line-subtle py-2 text-[13px]">
              <span className="text-muted">{label}</span>
              <Kbd>{keys}</Kbd>
            </li>
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard icon={Info} title="Dữ liệu" description="Xuất trạng thái Hub hiện tại thành tệp JSON để lưu lại. Mã CSRF của phiên không được đưa vào tệp.">
        <Button variant="secondary" onClick={handleExportLogs} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          <span>{t('export_data')}</span>
        </Button>
      </SettingsCard>
    </div>
  );
}
