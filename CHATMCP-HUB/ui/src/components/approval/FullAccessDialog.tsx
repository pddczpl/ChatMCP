import { useState } from 'react';
import { ShieldAlert, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

/**
 * Turning FULL ACCESS on needs the exact words typed. It is a native modal dialog, so it opens above Settings as well
 * (the permission list lives there) and keeps focus inside until the person decides.
 */
export function FullAccessDialog() {
  const { fullAccessModalOpen, setFullAccessModalOpen, showToast } = useAppStore();
  const [confirmText, setConfirmText] = useState('');
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    if (confirmText.trim() !== 'FULL ACCESS') return;
    setLoading(true);
    try {
      await api.setPermissions({
        mode: 'autonomous',
        executionPolicy: 'full-access',
        confirmation: 'FULL ACCESS',
      });
      showToast('Đã kích hoạt chế độ FULL ACCESS', 'warning');
      setFullAccessModalOpen(false);
      setConfirmText('');
    } catch (err: any) {
      showToast(err.message || 'Không thể cấp quyền FULL ACCESS', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setConfirmText('');
    setFullAccessModalOpen(false);
  };

  if (!fullAccessModalOpen) return null;
  return (
    <Modal
      open
      onOpenChange={(open) => { if (!open) handleClose(); }}
      role="alertdialog"
      title="Xác nhận quyền FULL ACCESS"
      description="Bỏ qua phê duyệt cho việc thường ngày — thao tác nguy hiểm vẫn hỏi lại"
      className="max-w-md border-danger/40 text-[13px] select-none [&_h3]:text-danger"
    >
      <div className="my-4 space-y-2 rounded-xl border border-danger/30 bg-danger/10 p-3.5 leading-5 text-muted">
        <div className="flex items-center gap-2 font-semibold text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Cảnh báo bảo mật quan trọng</span>
        </div>
        <p className="text-[13px]">
          Ở chế độ này, AI Agent có thể <strong className="text-fg">sửa file</strong>, <strong className="text-fg">chạy lệnh shell terminal</strong>, cài gói và truy cập mạng trực tiếp mà <strong className="text-fg">không hỏi ý kiến bạn</strong>.
        </p>
        <p className="text-[13px]">
          Những thao tác <strong className="text-fg">không thể hoàn tác</strong> vẫn luôn xin phê duyệt: <strong className="text-fg">xóa file/dữ liệu</strong>, <strong className="text-fg">git push</strong>, <strong className="text-fg">merge pull request</strong>, <strong className="text-fg">tạo hoặc xóa release/repo GitHub</strong>, xuất bản gói (npm publish, docker push) và các lệnh nguy hiểm khác. Agent chạy nền (worker, agent con) không có ai để hỏi nên các thao tác này bị từ chối ngay.
        </p>
        <p className="text-[13px]">
          Chỉ bật chế độ này nếu bạn hoàn toàn tin tưởng prompt hoặc đang chạy trong môi trường sandbox / container an toàn.
        </p>
      </div>

      <div className="my-4 space-y-1.5">
        <label htmlFor="full-access-confirm" className="block text-[13px] text-muted">
          Để xác nhận, vui lòng gõ chính xác cụm từ <strong className="font-mono text-danger">FULL ACCESS</strong>:
        </label>
        <input
          id="full-access-confirm"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="FULL ACCESS"
          autoComplete="off"
          className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-[13px] text-fg placeholder:text-faint transition-colors focus:border-danger focus:outline-none focus:ring-2 focus:ring-danger/25"
        />
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line-subtle pt-4">
        <Button variant="secondary" onClick={handleClose}>Hủy bỏ</Button>
        <Button variant="danger" disabled={confirmText.trim() !== 'FULL ACCESS' || loading} onClick={handleConfirm} className="gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5" />
          <span>{loading ? 'Đang kích hoạt...' : 'Kích hoạt FULL ACCESS'}</span>
        </Button>
      </div>
    </Modal>
  );
}
