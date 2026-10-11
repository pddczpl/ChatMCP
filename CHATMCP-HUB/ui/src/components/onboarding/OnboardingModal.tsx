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

export function OnboardingModal() {
  const { onboardingOpen, setOnboardingOpen, showToast } = useAppStore();
  const [step, setStep] = useState(1);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [aiProvider, setAiProvider] = useState('anthropic');
  const [permMode, setPermMode] = useState('review');

  if (!onboardingOpen) return null;

  const handleBrowseFolder = async () => {
    try {
      const res = await api.browseWorkspace();
      if (res.path) {
        setSelectedFolder(res.path);
        await api.selectWorkspace(res.path);
      }
    } catch {
      setSelectedFolder('F:\\Personal_Project\\Vin\\ChatMCP');
    }
  };

  const handleFinish = async () => {
    try {
      localStorage.setItem('chatmcp:onboarding-completed', 'true');
      setOnboardingOpen(false);
      showToast('Chào mừng bạn đến với ChatMCP Studio!', 'success');
    } catch {
      setOnboardingOpen(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm perspective-container">
      <div className="w-full max-w-lg rounded-2xl border border-sky-500/30 bg-[var(--panel)] p-6 shadow-2xl modal-3d-enter text-xs select-none">
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
            onClick={() => setOnboardingOpen(false)}
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
                  readOnly
                  value={selectedFolder || 'Chưa chọn thư mục...'}
                  className="flex-1 bg-[var(--surface)] font-mono text-xs rounded-lg px-3 py-2 border border-[var(--line)] text-[var(--text)]"
                />
                <Button variant="secondary" onClick={handleBrowseFolder} className="gap-1.5">
                  <Folder className="w-3.5 h-3.5 text-sky-400" />
                  <span>Duyệt...</span>
                </Button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-[11px] text-[var(--muted)]">
                Chọn nhà cung cấp AI bạn muốn sử dụng (có thể cấu hình API key sau):
              </p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'anthropic', name: 'Anthropic (Claude 3.5 Sonnet)' },
                  { id: 'openai', name: 'OpenAI (GPT-4o)' },
                  { id: 'gemini', name: 'Google Gemini (1.5 Pro)' },
                  { id: 'deepseek', name: 'DeepSeek / Ollama' },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setAiProvider(item.id)}
                    className={`p-2.5 rounded-lg border text-left transition-all ${
                      aiProvider === item.id
                        ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                        : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)]'
                    }`}
                  >
                    <div className="text-xs">{item.name}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <p className="text-[11px] text-[var(--muted)]">
                Chọn mức độ quyền mặc định khi agent cần sửa code hoặc chạy lệnh:
              </p>
              <div className="space-y-2">
                {[
                  { id: 'review', label: 'Review (Khuyên dùng)', desc: 'Agent hỏi phê duyệt trước mỗi lần ghi file hoặc chạy lệnh' },
                  { id: 'readonly', label: 'Chỉ đọc', desc: 'Chỉ phân tích mã nguồn và giải thích, không sửa file' },
                  { id: 'autonomous', label: 'Tự động', desc: 'Cho phép agent tự động ghi file và thực thi tool' },
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

        {/* Footer Navigation */}
        <div className="flex items-center justify-between pt-4 border-t border-[var(--line-subtle)]">
          <button
            onClick={() => setOnboardingOpen(false)}
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
              <Button variant="primary" onClick={handleFinish} className="gap-1.5">
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
