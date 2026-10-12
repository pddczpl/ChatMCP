import { useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { api } from '@/lib/api';
import { 
  Folder, 
  Cpu, 
  ShieldCheck, 
  CheckCircle2, 
  ArrowRight, 
  Sparkles, 
  X, 
  Check 
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IntelligenceTab } from '@/components/inspector/IntelligenceTab';
import { useQueryClient } from '@tanstack/react-query';

export function OnboardingModal() {
  const { onboardingOpen, setOnboardingOpen, showToast } = useAppStore();
  const [step, setStep] = useState(1);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [permMode, setPermMode] = useState('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [appliedFolder, setAppliedFolder] = useState('');
  const queryClient = useQueryClient();

  if (!onboardingOpen) return null;

  const handleBrowseFolder = async () => {
    setError('');
    try {
      const res = await api.browseWorkspace();
      if (res.path) {
        setSelectedFolder(res.path);
        await api.selectWorkspace(res.path);
        setAppliedFolder(res.path);
        await queryClient.invalidateQueries();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể chọn workspace.');
    }
  };

  const handleApplyFolder = async () => {
    setBusy(true); setError('');
    try {
      await api.selectWorkspace(selectedFolder.trim());
      setAppliedFolder(selectedFolder.trim());
      await queryClient.invalidateQueries();
    } catch (err) { setError(err instanceof Error ? err.message : 'Không thể chọn workspace.'); }
    finally { setBusy(false); }
  };

  const handleDismiss = () => {
    try {
      localStorage.setItem('chatmcp:onboarding-completed', 'true');
    } catch {
      // Ignored
    }
    setOnboardingOpen(false);
    showToast('Bạn có thể chọn lại thư mục và cấu hình AI bất cứ lúc nào trong tab Cài đặt', 'info');
  };

  const handleFinish = async () => {
    setBusy(true); setError('');
    try {
      // Choosing a permission mode does not grant permission to lower sandbox-only.
      const current = await api.getState();
      await api.configurePermissions({ mode: permMode, ...(current.studio?.permissions?.executionPolicy === 'full-access' ? { executionPolicy: 'host-review' } : {}) });
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      localStorage.setItem('chatmcp:onboarding-completed', 'true');
      setOnboardingOpen(false);
      showToast('Chào mừng bạn đến với ChatMCP Studio!', 'success');
    } catch (err) { setError(err instanceof Error ? err.message : 'Không thể lưu quyền thực thi.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm perspective-container">
      <div role="dialog" aria-label="Thiết lập ChatMCP" className="w-full max-w-lg max-h-[95vh] overflow-y-auto rounded-2xl border border-sky-500/30 bg-[var(--panel)] p-6 shadow-2xl modal-3d-enter text-xs select-none">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[var(--line-subtle)]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-500 to-teal-400 flex items-center justify-center text-slate-950 font-bold shadow-md shadow-sky-500/20">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[var(--text)]">
                Chào mừng đến với ChatMCP Studio
              </h2>
              <p className="text-[11px] text-[var(--muted)]">
                Thiết lập nhanh 3 bước để bắt đầu làm việc cùng Agent
              </p>
            </div>
          </div>
          <button
            aria-label="Đóng thiết lập"
            onClick={handleDismiss}
            className="p-1 rounded text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 3D Floating Steps Track */}
        <div className="flex items-center justify-between my-5 px-2">
          {[
            { num: 1, label: 'Thư mục dự án' },
            { num: 2, label: 'Mô hình AI' },
            { num: 3, label: 'Quyền thực thi' },
          ].map((s) => (
            <div key={s.num} className="flex items-center gap-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                  step === s.num
                    ? 'bg-sky-500 text-slate-950 floating-step'
                    : step > s.num
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                    : 'bg-[var(--surface)] text-[var(--faint)]'
                }`}
              >
                {step > s.num ? <Check className="w-3.5 h-3.5" /> : s.num}
              </div>
              <span className={`text-[11px] ${step === s.num ? 'font-semibold text-sky-400' : 'text-[var(--faint)]'}`}>
                {s.label}
              </span>
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div className="min-h-[160px] py-2">
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-[11px] text-[var(--muted)]">
                Chọn thư mục mã nguồn trên máy tính của bạn mà AI Agent sẽ làm việc trực tiếp:
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  aria-label="Đường dẫn workspace"
                  placeholder="Chưa chọn thư mục..."
                  value={selectedFolder}
                  onChange={(e) => setSelectedFolder(e.target.value)}
                  className="flex-1 bg-[var(--surface)] font-mono text-xs rounded-lg px-3 py-2 border border-[var(--line)] text-[var(--text)]"
                />
                <Button variant="secondary" onClick={handleBrowseFolder} className="gap-1.5">
                  <Folder className="w-3.5 h-3.5 text-sky-400" />
                  <span>Duyệt...</span>
                </Button>
              </div>
              <Button onClick={handleApplyFolder} disabled={busy || !selectedFolder.trim()}>Áp dụng workspace</Button>
              {appliedFolder && <p role="status">Workspace đã chọn: {appliedFolder}</p>}
            </div>
          )}

          {step === 2 && <IntelligenceTab />}

          {step === 3 && (
            <div className="space-y-3">
              <p className="text-[11px] text-[var(--muted)]">
                Chọn mức độ quyền mặc định khi agent cần sửa code hoặc chạy lệnh:
              </p>
              <div className="space-y-2">
                {[
                  { id: 'review', label: 'Review (Khuyên dùng)', desc: 'Agent hỏi phê duyệt trước mỗi lần ghi file hoặc chạy lệnh' },
                  { id: 'readonly', label: 'Chỉ đọc', desc: 'Chỉ phân tích mã nguồn và giải thích, không sửa file' },
                  { id: 'autonomous', label: 'Tự động', desc: 'Tự sửa file và chạy kiểm tra đã nhận diện; thao tác rủi ro vẫn cần duyệt' },
                ].map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setPermMode(m.id)}
                    className={`w-full p-2.5 rounded-lg border text-left transition-all ${
                      permMode === m.id
                        ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                        : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)]'
                    }`}
                  >
                    <div className="text-xs">{m.label}</div>
                    <div className="text-[10px] text-[var(--faint)] mt-0.5">{m.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {error && <p role="alert" className="text-rose-400 py-2">{error}</p>}

        {/* Footer Navigation */}
        <div className="flex items-center justify-between pt-4 border-t border-[var(--line-subtle)]">
          <button
            onClick={handleDismiss}
            className="text-[11px] text-[var(--faint)] hover:text-[var(--text)]"
          >
            Bỏ qua
          </button>

          <div className="flex items-center gap-2">
            {step > 1 && (
              <Button variant="secondary" onClick={() => setStep(step - 1)}>
                Quay lại
              </Button>
            )}

            {step < 3 ? (
              <Button variant="primary" onClick={() => setStep(step + 1)} className="gap-1.5">
                <span>Tiếp tục</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            ) : (
              <Button variant="primary" onClick={handleFinish} disabled={busy} className="gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Bắt đầu làm việc ngay</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
