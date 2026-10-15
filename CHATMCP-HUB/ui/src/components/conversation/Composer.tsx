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
  Sparkles, X
} from 'lucide-react';
import type { ChatAttachment } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';

interface ComposerProps {
  onSendMessage: (text: string, attachments: ChatAttachment[]) => boolean | void | Promise<boolean | void>;
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
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitPending = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { setFullAccessModalOpen, showToast } = useAppStore();

  const activePlaceholder = placeholder || t('composer_placeholder');

  // Auto resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [text]);

  const handleFiles = async (files: File[]) => {
    if (submitting || !files.length) return;
    if (attachments.length + files.length > 5) {
      showToast('Tối đa 5 file mỗi tin nhắn.','warning');
      return;
    }
    try {
      const collected: ChatAttachment[] = [];
      for (const file of files) {
        const isImage = /^image\/(?:png|jpeg|webp|gif)$/.test(file.type);
        if (file.size > (isImage ? 2*1024*1024 : 200000)) throw new Error('File ' + file.name + ' quá lớn.');
        if (/^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(file.name)) throw new Error('Không đính kèm file chứa khóa riêng.');
        const data = await new Promise<string>((resolve,reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('Không thể đọc ' + file.name));
          reader.readAsDataURL(file);
        });
        collected.push({name:file.name,mimeType:file.type,dataBase64:data.split(',')[1]||'',size:file.size});
      }
      setAttachments(current => [...current,...collected].slice(0,5));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể đính kèm file.','error');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    if ((!text.trim() && !attachments.length) || disabled || submitPending.current) return;
    const submittedText = text;
    const submittedAttachments = [...attachments];
    submitPending.current = true;
    setSubmitting(true);
    try {
      const accepted = await onSendMessage(submittedText.trim(), submittedAttachments);
      if (accepted !== false) {
        setText(current => current === submittedText ? '' : current);
        setAttachments([]);
      }
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
    <div className="p-3 border-t border-[var(--line)] bg-[var(--panel)] flex-shrink-0 select-none"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void handleFiles(Array.from(e.dataTransfer.files)); } }}>
      <div className="relative border border-[var(--line)] focus-within:border-sky-500 rounded-xl bg-[var(--surface)] shadow-md transition-all">
        <input ref={fileInputRef} className="hidden" type="file" multiple
          accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.cs,.go,.rs,.java,.html,.css,.sql,.xml,.yaml,.yml,.toml,.sh,.ps1"
          onChange={e=>{void handleFiles(Array.from(e.target.files||[]));e.target.value='';}} />
        {/* Text Area */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={e => {
            const files=Array.from(e.clipboardData.items).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>!!file);
            if(files.length){e.preventDefault();void handleFiles(files);}
          }}
          placeholder={isWorking ? 'Agent đang chạy — gửi chỉ dẫn mới bất kỳ lúc nào...' : activePlaceholder}
          disabled={disabled || submitting}
          rows={1}
          className="w-full bg-transparent px-3.5 pt-3 pb-2 text-[15px] text-[var(--text)] placeholder-[var(--faint)] resize-none focus:outline-none max-h-56 min-h-[44px] leading-relaxed font-sans"
        />

        {attachments.length>0 && <div className="flex flex-wrap gap-1.5 px-3 pb-2" aria-label="Tệp đính kèm">
          {attachments.map((file,index) => <span key={index} className="flex items-center gap-1 rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)]">
            <Paperclip className="w-3 h-3"/><span className="max-w-40 truncate">{file.name}</span>
            <button aria-label={'Bỏ '+file.name} type="button" onClick={()=>setAttachments(items=>items.filter((_,i)=>i!==index))}><X className="w-3 h-3"/></button>
          </span>)}
        </div>}
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
              <ModeIcon className={`w-3.5 h-3.5 ${currentMode === 'full-access' ? 'text-rose-400' : 'text-[var(--primary)]'}`} />
              <span>{currentModeObj.label}</span>
              <ChevronDown className="w-3 h-3 text-[var(--faint)]" />
            </button>

            <button type="button" aria-label="Đính kèm file hoặc ảnh" title="Chọn file / kéo thả / Ctrl+V để dán ảnh"
              onClick={()=>fileInputRef.current?.click()}
              className="p-1.5 rounded-md hover:bg-[var(--surface-hover)] text-[var(--muted)]">
              <Paperclip className="w-4 h-4"/>
            </button>
            {/* Mode Dropdown */}
            {modeMenuOpen && (
              <div className="absolute left-0 bottom-full mb-1 w-64 rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-xl z-50 p-1.5 space-y-1 modal-3d-enter">
                <div className="px-2 py-1 text-xs font-semibold  text-[var(--faint)]">
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
                          ? 'bg-sky-500/15 text-[var(--primary)] font-medium'
                          : 'hover:bg-[var(--surface-hover)] text-[var(--muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${m.id === 'full-access' ? 'text-rose-400' : 'text-[var(--primary)]'}`} />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold">{m.label}</div>
                        <div className="text-xs text-[var(--faint)] leading-snug">{m.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Hint & Send/Stop Button */}
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-xs text-[var(--faint)]">
              {t('enter_to_send')}
            </span>

            {isWorking && (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-md shadow-rose-900/30 transition-all"
                title={t('stop')}
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>{t('stop')}</span>
              </button>
            )}
            {(
              <button
                type="button"
                onClick={handleSubmit}
                disabled={(!text.trim() && attachments.length===0) || disabled || submitting}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md transition-all ${
                  (text.trim() || attachments.length>0) && !disabled
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
