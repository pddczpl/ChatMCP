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
import { useTranslation } from '@/lib/i18n';

interface ComposerProps {
  onSendMessage: (text: string) => boolean | void | Promise<boolean | void>;
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
  placeholder,
  currentMode = 'review',
  onModeChange,
}: ComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitPending = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { setFullAccessModalOpen } = useAppStore();

  const activePlaceholder = placeholder || t('composer_placeholder');

  // Auto resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [text]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    if (!text.trim() || disabled || isWorking || submitPending.current) return;
    const submittedText = text;
    submitPending.current = true;
    setSubmitting(true);
    try {
      const accepted = await onSendMessage(submittedText.trim());
      if (accepted !== false) setText(current => current === submittedText ? '' : current);
    } finally {
      submitPending.current = false;
      setSubmitting(false);
    }
  };

  const modes = [
    { id: 'readonly', label: t('perm_read_only'), icon: Eye, desc: t('perm_read_only_desc') },
    { id: 'review', label: t('perm_review'), icon: ShieldCheck, desc: t('perm_review_desc') },
    { id: 'autonomous', label: t('perm_auto'), icon: Bot, desc: t('perm_auto_desc') },
    { id: 'full-access', label: t('perm_full_access'), icon: ShieldAlert, desc: t('perm_full_access_desc') },
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
          placeholder={activePlaceholder}
          disabled={disabled || submitting}
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
              title={t('agent_exec_mode')}
            >
              <ModeIcon className={`w-3.5 h-3.5 ${currentMode === 'full-access' ? 'text-rose-400' : 'text-sky-400'}`} />
              <span>{currentModeObj.label}</span>
              <ChevronDown className="w-3 h-3 text-[var(--faint)]" />
            </button>

            {/* Mode Dropdown */}
            {modeMenuOpen && (
              <div className="absolute left-0 bottom-full mb-1 w-64 rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-xl z-50 p-1.5 space-y-1 modal-3d-enter">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)]">
                  {t('agent_exec_mode')}
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
              {t('enter_to_send')}
            </span>

            {isWorking ? (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-md shadow-rose-900/30 transition-all"
                title={t('stop')}
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>{t('stop')}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!text.trim() || disabled || submitting}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md transition-all ${
                  text.trim() && !disabled
                    ? 'bg-sky-500 hover:bg-sky-400 text-slate-950 shadow-sky-500/20 active:scale-95'
                    : 'bg-[var(--surface-hover)] text-[var(--faint)] cursor-not-allowed opacity-50'
                }`}
                title={t('send')}
              >
                <span>{t('send')}</span>
                <Send className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
