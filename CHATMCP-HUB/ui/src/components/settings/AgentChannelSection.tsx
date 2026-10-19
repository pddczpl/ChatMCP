import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CircleCheck, Copy, Download, Link2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { formatTime } from '@/lib/format';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { ChatGptWebRiskNote } from '@/components/approval/ChatGptWebRiskNote';
import { SettingsCard } from './SettingsCard';

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase() === b.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase();

/**
 * How the agent reaches its model: the configured Model API, or the ChatGPT tab of the person's own browser through the
 * Companion extension (never a ChatGPT API token, never the login credentials).
 */
export function AgentChannelSection() {
  const { showToast, selectedWorkspacePath } = useAppStore();
  const queryClient = useQueryClient();
  const { lang } = useTranslation();
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });

  const currentWs = (hub?.workspaces?.items?.some(w => w.path === selectedWorkspacePath) ? selectedWorkspacePath :
    hub?.workspaces?.activePath) || hub?.workspace?.path || '';
  const [changingTransport, setChangingTransport] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairCode, setPairCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const transport = hub?.agent?.mode || 'api';
  const companion = hub?.browser;

  const changeTransport = async (mode: 'api' | 'chatgpt-web') => {
    if (changingTransport) return;
    setChangingTransport(true);
    try {
      await api.setAgentMode(mode);
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast(mode === 'api' ? 'Đã chọn agent dùng Model API.' :
        'Đã chọn ChatGPT Web Companion. Hãy ghép extension và đăng nhập ChatGPT trên trình duyệt.', 'success');
    } catch (e: any) { showToast(e.message || 'Không thể chuyển chế độ agent.', 'error'); }
    finally { setChangingTransport(false); }
  };

  // "Review before send": off unless chosen; one global switch and an optional override for the workspace shown above.
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const reviewGlobal = companion?.privacy?.reviewBeforeSend === true;
  const workspaceOverride = companion?.privacy?.workspaces?.find(item => currentWs && samePath(item.path, currentWs));
  const savePrivacy = async (payload: { reviewBeforeSend?: boolean; workspacePath?: string; workspaceReview?: boolean | null }, message: string) => {
    if (savingPrivacy) return;
    setSavingPrivacy(true);
    try {
      await api.configureBrowserPrivacy(payload);
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast(message, 'success');
    } catch (e: any) { showToast(e.message || 'Không thể lưu cài đặt riêng tư.', 'error'); }
    finally { setSavingPrivacy(false); }
  };

  const issuePairCode = async () => {
    if (pairingBusy) return;
    setPairingBusy(true);
    try {
      const code = await api.createBrowserPairCode();
      setPairCode(code);
      showToast('Mã ghép có hiệu lực 5 phút. Nhập vào extension ChatMCP Hub Companion.', 'info');
    } catch (e: any) { showToast(e.message || 'Không thể tạo mã ghép.', 'error'); }
    finally { setPairingBusy(false); }
  };
  const disconnectCompanion = async () => {
    if (!window.confirm('Ngắt ghép ChatMCP Companion trên trình duyệt? Các cuộc chat đã lưu vẫn được giữ.')) return;
    setPairingBusy(true);
    try {
      await api.unpairBrowser();
      setPairCode(null);
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast('Đã ngắt ghép tiện ích.', 'info');
    } catch (e: any) { showToast(e.message || 'Không thể ngắt ghép.', 'error'); }
    finally { setPairingBusy(false); }
  };

  const options = [
    { id: 'api', label: 'Model API', hint: 'Provider và API key đã cấu hình' },
    { id: 'chatgpt-web', label: 'ChatGPT Web', hint: 'Qua extension Companion; không cần ChatGPT API key' },
  ] as const;

  return (
    <div className="space-y-5">
      {/* The browser transport is an existing paired extension, NOT a ChatGPT API token, and never receives the login credentials. */}
      <SettingsCard data-testid="agent-transport-settings" icon={Bot} title="Kênh điều khiển Coding Agent"
        description="Kênh được chọn xử lý lượt tiếp theo, kể cả trong hội thoại cũ. Khi đổi kênh, ChatMCP chuyển tóm tắt ngữ cảnh, liên kết với hội thoại gốc và không tự phát lại các thao tác sửa file chưa xác minh.">
        <div className="grid grid-cols-2 gap-3">
          {options.map(option => (
            <button type="button" key={option.id} disabled={changingTransport}
              aria-pressed={transport === option.id} aria-label={'Kênh agent: ' + option.label}
              onClick={() => void changeTransport(option.id)}
              className={cn('space-y-1 rounded-xl border p-3.5 text-left transition-colors disabled:opacity-50',
                transport === option.id ? 'border-primary bg-primary/10' : 'border-line bg-surface hover:border-line-strong hover:bg-hover')}>
              <span className={cn('block text-[13px] font-semibold', transport === option.id && 'text-primary')}>{option.label}</span>
              <span className="block text-[12px] leading-4 text-muted">{option.hint}</span>
            </button>
          ))}
        </div>

        {/* Visible BEFORE the person switches to this channel: what it automates, the Terms-of-Use risk, where content goes. */}
        <ChatGptWebRiskNote testId="chatgpt-web-risk-note" />

        <div className="space-y-3 rounded-xl border border-line bg-surface p-4" data-testid="chatgpt-web-privacy-settings">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" data-testid="review-before-send-toggle" checked={reviewGlobal} disabled={savingPrivacy}
              onChange={event => void savePrivacy({ reviewBeforeSend: event.target.checked }, event.target.checked ? 'Đã bật xem lại trước khi gửi (mọi workspace, trừ nơi có cài đặt riêng).' : 'Đã tắt xem lại trước khi gửi.')} />
            <span>
              <span className="block text-[13px] font-medium text-fg">Xem lại trước khi gửi sang ChatGPT</span>
              <span className="mt-0.5 block text-[12px] leading-4 text-muted">Mỗi kết quả công cụ được giữ trên máy bạn cho tới khi bạn duyệt, che thêm hoặc giữ lại. Không có gì tự gửi; hết thời gian chờ thì nhiệm vụ dừng. Mặc định tắt.</span>
            </span>
          </label>
          <label className="flex items-center gap-3 text-[13px] text-muted">
            <span className="shrink-0">Workspace hiện tại</span>
            <Select data-testid="review-before-send-workspace" disabled={savingPrivacy || !currentWs} aria-label="Xem lại trước khi gửi cho workspace hiện tại"
              value={workspaceOverride ? (workspaceOverride.review ? 'on' : 'off') : ''}
              onChange={event => void savePrivacy({ workspacePath: currentWs, workspaceReview: event.target.value === 'on' ? true : event.target.value === 'off' ? false : null }, 'Đã lưu cài đặt cho workspace.')}>
              <option value="">Theo cài đặt chung ({reviewGlobal ? 'bật' : 'tắt'})</option>
              <option value="on">Luôn xem lại</option>
              <option value="off">Không xem lại</option>
            </Select>
          </label>
        </div>

        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Link2 className="h-3.5 w-3.5" />
          <span>{!companion?.paired ? 'Chưa ghép ChatMCP Hub Companion' :
            companion.connected ? 'Companion đã ghép và đang kết nối' :
              'Companion đã ghép; chờ mở tab ChatGPT với extension đang bật'}</span>
          {companion?.connected && <CircleCheck className="h-3.5 w-3.5 text-success" />}
        </div>

        <div className="flex flex-wrap gap-2" data-testid="browser-companion-install-links">
          <a className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-primary transition-colors hover:border-line-strong hover:bg-hover"
            href="https://github.com/pddczpl/ChatMCP/releases/latest/download/ChatMCP-Browser-Companion.zip"
            target="_blank" rel="noopener noreferrer"
            aria-label="Tải Browser Companion ZIP từ GitHub Releases">
            <Download className="h-3.5 w-3.5" /> Tải Browser Companion (.zip)
          </a>
          <a className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-[13px] text-muted transition-colors hover:border-line-strong hover:bg-hover hover:text-fg"
            href="https://github.com/pddczpl/ChatMCP/blob/main/CHATMCP-HUB/extension/INSTALL-EXTENSION.txt"
            target="_blank" rel="noopener noreferrer">Hướng dẫn cài / khôi phục</a>
        </div>
        <p className="text-[12px] leading-5 text-muted">
          Giải nén file ZIP, sau đó mở <code>chrome://extensions</code> hoặc <code>edge://extensions</code> →
          Developer mode → Load unpacked, chọn <strong>thư mục đã giải nén có manifest.json</strong>.
          Nếu đã cài ứng dụng Windows, bạn cũng có thể chọn <code>CHATMCP-HUB/extension</code>
          trong thư mục ChatMCP đã cài. Trình duyệt yêu cầu bạn tự xác nhận quyền cài đặt;
          ChatMCP không cài extension âm thầm.
          Đăng nhập <a className="text-primary underline"
            href="https://chatgpt.com" target="_blank" rel="noreferrer">chatgpt.com</a> trên trình duyệt,
          mở extension ChatMCP Hub Companion và nhập mã ghép bên dưới.
        </p>
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => void issuePairCode()} disabled={pairingBusy || companion?.pairingAvailable === false}>
            {pairingBusy ? 'Đang xử lý…' : 'Tạo mã ghép 5 phút'}
          </Button>
          {companion?.paired && <button type="button" onClick={() => void disconnectCompanion()}
            disabled={pairingBusy} className="text-[13px] text-danger hover:underline disabled:opacity-50">Ngắt ghép</button>}
        </div>
        {pairCode && <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-surface p-3">
          <code data-testid="chatgpt-pair-code" className="text-lg font-semibold tracking-widest text-fg">{pairCode.code}</code>
          <button type="button" aria-label="Sao chép mã ghép"
            onClick={() => void navigator.clipboard.writeText(pairCode.code)
              .then(() => showToast('Đã sao chép mã ghép.', 'success'))
              .catch(() => showToast('Hãy chọn và sao chép mã ghép thủ công.', 'info'))}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"><Copy className="h-3.5 w-3.5" /></button>
          <span className="ml-auto text-[12px] text-faint">Hết hạn: {formatTime(pairCode.expiresAt, lang)}</span>
        </div>}
        {transport === 'chatgpt-web' && <p className="text-[12px] leading-5 text-warning">
          ChatGPT Web dùng ô chat và model của tab trình duyệt thông qua Companion,
          không sử dụng cookie, API nội bộ hay ChatGPT API key. Một task web được thực hiện tại một thời điểm.
          Chọn workspace trước khi giao việc; không thể bảo đảm giao diện ChatGPT Web luôn tương thích.
        </p>}
      </SettingsCard>
    </div>
  );
}
