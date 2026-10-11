import { useState, useRef, useEffect } from 'react';
import { 
  Send, 
  Square, 
  Paperclip, 
  ShieldCheck, 
  ShieldAlert, 
  Bot, 
  Eye, 
  ChevronDown, 
  Sparkles 
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

interface ComposerProps {
  onSendMessage: (text: string) => void;
  onStop?: () => void;
  isWorking?: boolean;
  disabled?: boolean;
  placeholder?: string;
  currentMode?: string;
  onModeChange?: (mode: string) => void;
}

export function Composer({
  onSendMessage,
  onStop,
  isWorking,
  disabled,
  placeholder = 'Giao việc cho agent bằng tiếng Việt hoặc tiếng Anh... (Nhấn Enter để gửi)',
  currentMode = 'review',
  onModeChange,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { setFullAccessModalOpen } = useAppStore();

  // Auto resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [text]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = () => {
    if (!text.trim() || disabled || isWorking) return;
    onSendMessage(text.trim());
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const modes = [
    { id: 'readonly', label: 'Chỉ đọc', icon: Eye, desc: 'Agent chỉ đọc file và tìm kiếm, không sửa file.' },
    { id: 'review', label: 'Review', icon: ShieldCheck, desc: 'Mặc định: Phải có bạn phê duyệt trước khi ghi file/chạy lệnh.' },
    { id: 'autonomous', label: 'Tự động', icon: Bot, desc: 'Tự động chạy các tool thông thường trong workspace.' },
    { id: 'full-access', label: 'FULL ACCESS ⚠️', icon: ShieldAlert, desc: 'Quyền tối đa không hỏi xác nhận. Cần gõ FULL ACCESS.' },
  ];

  const currentModeObj = modes.find((m) => m.id === currentMode) || modes[1];
  const ModeIcon = currentModeObj.icon;

  const handleSelectMode = (modeId: string) => {
    setModeMenuOpen(false);
    if (modeId === 'full-access') {
      setFullAccessModalOpen(true);
      return;
    }
    if (onModeChange) {
      onModeChange(modeId);
    }
  };

  return (
    <div className="p-3 border-t border-[var(--line)] bg-[var(--panel)] flex-shrink-0 select-none">
      <div className="relative border border-[var(--line)] focus-within:border-sky-500 rounded-xl bg-[var(--surface)] shadow-md transition-all">
        {/* Text Area */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="w-full bg-transparent px-3.5 pt-3 pb-2 text-[13px] text-[var(--text)] placeholder-[var(--faint)] resize-none focus:outline-none max-h-56 min-h-[44px] leading-relaxed font-sans"
        />

        {/* Bottom Toolbar */}
        <div className="px-3 pb-2.5 pt-1 flex items-center justify-between gap-2 border-t border-[var(--line-subtle)]">
          {/* Left: Mode Picker & Quick Tools */}
          <div className="relative flex items-center gap-2">
            <button
              type="button"
              onClick={() => setModeMenuOpen(!modeMenuOpen)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-[var(--surface-hover)] hover:bg-[var(--line)] text-[var(--text)] border border-[var(--line)] transition-colors"
              title="Chọn chế độ quyền"
            >
              <ModeIcon className={`w-3.5 h-3.5 ${currentMode === 'full-access' ? 'text-rose-400' : 'text-sky-400'}`} />
              <span>{currentModeObj.label}</span>
              <ChevronDown className="w-3 h-3 text-[var(--faint)]" />
            </button>

            {/* Mode Dropdown */}
            {modeMenuOpen && (
              <div className="absolute left-0 bottom-full mb-1 w-64 rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-xl z-50 p-1.5 space-y-1 modal-3d-enter">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)]">
                  Chế độ quyền thực thi
                </div>
                {modes.map((m) => {
                  const Icon = m.icon;
                  const isCurrent = m.id === currentMode;
                  return (
                    <button
                      key={m.id}
                      onClick={() => handleSelectMode(m.id)}
                      className={`w-full flex items-start gap-2.5 p-2 rounded-lg text-left transition-colors ${
                        isCurrent
                          ? 'bg-sky-500/15 text-sky-300 font-medium'
                          : 'hover:bg-[var(--surface-hover)] text-[var(--muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${m.id === 'full-access' ? 'text-rose-400' : 'text-sky-400'}`} />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold">{m.label}</div>
                        <div className="text-[11px] text-[var(--faint)] leading-snug">{m.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Hint & Send/Stop Button */}
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-[11px] text-[var(--faint)]">
              Shift + Enter xuống dòng
            </span>

            {isWorking ? (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-md shadow-rose-900/30 transition-all"
                title="Dừng tác vụ hiện tại"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Dừng</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!text.trim() || disabled}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md transition-all ${
                  text.trim() && !disabled
                    ? 'bg-sky-500 hover:bg-sky-400 text-slate-950 shadow-sky-500/20 active:scale-95'
                    : 'bg-[var(--surface-hover)] text-[var(--faint)] cursor-not-allowed opacity-50'
                }`}
                title="Gửi cho agent"
              >
                <span>Gửi</span>
                <Send className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
