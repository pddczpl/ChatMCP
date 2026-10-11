import { useState } from 'react';
import { ShieldAlert, AlertTriangle, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/Button';

export function FullAccessDialog() {
  const { fullAccessModalOpen, setFullAccessModalOpen, showToast } = useAppStore();
  const [confirmText, setConfirmText] = useState('');
  const [loading, setLoading] = useState(false);

  if (!fullAccessModalOpen) return null;

  const handleConfirm = async () => {
    if (confirmText !== 'FULL ACCESS') return;
    setLoading(true);
    try {
      await api.setPermissions({
        mode: 'autonomous',
        executionPolicy: 'full-access',
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm perspective-container">
      <div className="w-full max-w-md rounded-2xl border border-rose-500/40 bg-[var(--panel)] p-6 shadow-2xl modal-3d-enter text-xs select-none">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center flex-shrink-0">
              <ShieldAlert className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-rose-400">
                Xác nhận quyền FULL ACCESS
              </h2>
              <p className="text-[11px] text-[var(--muted)]">
                Quyền thực thi tối đa không qua bước phê duyệt
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-md text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Warning Box */}
        <div className="my-4 p-3 rounded-lg bg-rose-950/30 border border-rose-800/40 text-[var(--muted)] space-y-2 leading-relaxed">
          <div className="flex items-center gap-2 text-rose-300 font-semibold">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>CẢNH BÁO BẢO MẬT QUAN TRỌNG</span>
          </div>
          <p className="text-[11px]">
            Ở chế độ này, AI Agent có thể <strong>sửa file</strong>, <strong>xóa file</strong> và <strong>chạy lệnh shell terminal</strong> trực tiếp mà <strong>không hỏi ý kiến bạn</strong>.
          </p>
          <p className="text-[11px]">
            Chỉ bật chế độ này nếu bạn hoàn toàn tin tưởng prompt hoặc đang chạy trong môi trường sandbox / container an toàn.
          </p>
        </div>

        {/* Typed Input */}
        <div className="space-y-1.5 my-4">
          <label className="text-[11px] text-[var(--muted)] block">
            Để xác nhận, vui lòng gõ chính xác cụm từ <strong className="text-rose-400 font-mono">FULL ACCESS</strong>:
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="FULL ACCESS"
            className="w-full bg-[var(--surface)] font-mono text-xs rounded-md px-3 py-2 border border-[var(--line)] focus:outline-none focus:border-rose-500 text-[var(--text)]"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--line-subtle)]">
          <Button variant="secondary" onClick={handleClose}>
            Hủy bỏ
          </Button>
          <Button
            variant="danger"
            disabled={confirmText !== 'FULL ACCESS' || loading}
            onClick={handleConfirm}
            className="gap-1.5"
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>{loading ? 'Đang kích hoạt...' : 'Kích hoạt FULL ACCESS'}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
