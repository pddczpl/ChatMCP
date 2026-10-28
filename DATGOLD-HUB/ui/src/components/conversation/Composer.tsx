import { useState, useRef, useEffect, type ReactNode } from 'react';
import { ArrowUp, Bot, Check, ChevronDown, Eye, Paperclip, ShieldAlert, ShieldCheck, Square, X } from 'lucide-react';
import type { ChatAttachment } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { FILES_PER_MESSAGE, FILE_LIMIT_BYTES, IMAGE_LIMIT_BYTES, TOTAL_LIMIT_BYTES, fitImage, fittedName, limitLabel } from '@/lib/image-fit';
import { formatBytes } from '@/lib/project-instructions';
import { cn } from '@/lib/utils';

interface ComposerProps {
  onSendMessage: (text: string, attachments: ChatAttachment[]) => boolean | void | Promise<boolean | void>;
  onStop?: () => void;
  isWorking?: boolean;
  disabled?: boolean;
  placeholder?: string;
  currentMode?: string;
  onModeChange?: (mode: string) => void;
  dependencyOptions?: {id: string; label: string; state: string}[];
  selectedDependsOn?: string[];
  onDependsOnChange?: (ids: string[]) => void;
  /** More controls for the toolbar (for example the model profile of a new conversation). */
  extraTools?: ReactNode;
}

const chip = 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg';

export function Composer({
  onSendMessage,
  onStop,
  isWorking,
  disabled,
  placeholder,
  currentMode = 'review',
  onModeChange,
  dependencyOptions = [],
  selectedDependsOn = [],
  onDependsOnChange,
  extraTools,
}: ComposerProps) {
  const { t, lang } = useTranslation();
  const [text, setText] = useState('');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dependencyMenuOpen, setDependencyMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitPending = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { setFullAccessModalOpen, showToast } = useAppStore();

  const activePlaceholder = placeholder || t('composer_placeholder');

  // Auto resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [text]);

  // Close the open menu on an outside click or Escape.
  useEffect(() => {
    if (!modeMenuOpen && !dependencyMenuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') { setModeMenuOpen(false); setDependencyMenuOpen(false); }
        return;
      }
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) { setModeMenuOpen(false); setDependencyMenuOpen(false); }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [modeMenuOpen, dependencyMenuOpen]);

  const handleFiles = async (files: File[]) => {
    if (submitting || !files.length) return;
    if (attachments.length + files.length > FILES_PER_MESSAGE) {
      showToast(t('agents_cmp_max_files', { limit: FILES_PER_MESSAGE }),'warning');
      return;
    }
    try {
      const collected: ChatAttachment[] = [];
      for (const file of files) {
        const isImage = /^image\/(?:png|jpeg|webp|gif)$/.test(file.type);
        const limit = isImage ? IMAGE_LIMIT_BYTES : FILE_LIMIT_BYTES;
        if (/^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(file.name)) throw new Error(t('agents_cmp_private_key'));
        let blob: Blob = file;
        let name = file.name;
        let mimeType = file.type;
        if (file.size > limit) {
          // A picture over the limit is made smaller, in steps, instead of refused (a pasted screenshot is called image.png and is often a few MB). A file that is not a picture, a GIF,
          // or a picture that fits at no step is refused, and the message says what the limit is.
          let fitted = null;
          try { fitted = await fitImage(file, limit); } catch { throw new Error(t('agents_cmp_cannot_read', { name: file.name })); }
          if (!fitted) throw new Error(t('agents_cmp_too_large', { name: file.name, limit: limitLabel(limit) }));
          blob = fitted.blob;
          mimeType = fitted.type;
          name = fittedName(file.name, fitted.type);
          showToast(t('agents_cmp_image_fitted', { name: file.name, from: formatBytes(file.size, lang), to: formatBytes(fitted.blob.size, lang) }), 'info');
        }
        const data = await new Promise<string>((resolve,reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error(t('agents_cmp_cannot_read', { name: file.name })));
          reader.readAsDataURL(blob);
        });
        collected.push({name,mimeType,dataBase64:data.split(',')[1]||'',size:blob.size});
      }
      // All the files of one message together are limited too (the request the provider takes holds them, and the turns before them): over it the new ones are not added, and the person is told the way around.
      if ([...attachments, ...collected].reduce((sum, item) => sum + item.size, 0) > TOTAL_LIMIT_BYTES) throw new Error(t('agents_cmp_total_too_large', { limit: limitLabel(TOTAL_LIMIT_BYTES) }));
      setAttachments(current => [...current,...collected].slice(0,FILES_PER_MESSAGE));
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('agents_cmp_cannot_attach'),'error');
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
  const canSend = (text.trim() || attachments.length > 0) && !disabled && !submitting;

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
    <div className="@container select-none"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void handleFiles(Array.from(e.dataTransfer.files)); } }}>
      <div className="relative rounded-2xl border border-line bg-panel shadow-sm transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/20">
        <input ref={fileInputRef} className="hidden" type="file" multiple
          accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.cs,.go,.rs,.java,.html,.css,.sql,.xml,.yaml,.yml,.toml,.sh,.ps1"
          onChange={e=>{void handleFiles(Array.from(e.target.files||[]));e.target.value='';}} />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={e => {
            const files=Array.from(e.clipboardData.items).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>!!file);
            if(files.length){e.preventDefault();void handleFiles(files);}
          }}
          placeholder={isWorking ? t('agents_cmp_placeholder_running') : activePlaceholder}
          aria-label={t('agents_cmp_label')}
          disabled={disabled || submitting}
          rows={1}
          className="block max-h-56 min-h-[52px] w-full resize-none select-text bg-transparent px-4 pb-1 pt-3.5 font-sans text-[15px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
        />

        {attachments.length>0 && <div className="flex flex-wrap gap-1.5 px-3 pb-2" aria-label={t('agents_cmp_attachments')}>
          {attachments.map((file,index) => <span key={index} className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-fg">
            <Paperclip className="h-3 w-3"/><span className="max-w-40 truncate">{file.name}</span>
            <button aria-label={t('agents_cmp_remove', { name: file.name })} type="button" className="text-faint hover:text-fg" onClick={()=>setAttachments(items=>items.filter((_,i)=>i!==index))}><X className="h-3 w-3"/></button>
          </span>)}
        </div>}

        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          <div ref={menuRef} className="relative flex min-w-0 flex-wrap items-center gap-1">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={modeMenuOpen}
              onClick={() => { setModeMenuOpen(open => !open); setDependencyMenuOpen(false); }}
              className={cn(chip, 'border-line bg-surface', currentMode === 'full-access' && 'border-danger/40 bg-danger/10 text-danger')}
              title={t('agent_exec_mode')}
            >
              <ModeIcon className={cn('h-3.5 w-3.5', currentMode === 'full-access' ? 'text-danger' : 'text-primary')} />
              <span className="text-fg">{currentModeObj.label}</span>
              <ChevronDown className="h-3 w-3 text-faint" />
            </button>

            <button type="button" aria-label={t('agents_cmp_attach')} title={t('agents_cmp_attach_title')}
              onClick={()=>fileInputRef.current?.click()}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg">
              <Paperclip className="h-4 w-4"/>
            </button>
            {extraTools}
            {dependencyOptions.length > 0 && (
              <div className="relative">
                <button type="button" title={t('agents_cmp_wait_title')}
                  aria-expanded={dependencyMenuOpen}
                  className={chip}
                  onClick={() => { setDependencyMenuOpen(x=>!x); setModeMenuOpen(false); }}>
                  {t('agents_cmp_wait')} {selectedDependsOn.length ? '('+selectedDependsOn.length+')' : ''}
                  <ChevronDown className="h-3 w-3 text-faint"/>
                </button>
                {dependencyMenuOpen && <div className="anim-pop absolute bottom-full left-0 z-50 mb-2 max-h-64 w-80 overflow-y-auto rounded-xl border border-line bg-panel p-2 shadow-[var(--shadow-pop)]">
                  <p className="mb-2 px-1 text-[13px] font-semibold">{t('agents_cmp_wait_note')}</p>
                  {dependencyOptions.map(option=><label key={option.id} className="flex items-center gap-2 rounded-lg p-1.5 text-[13px] hover:bg-hover">
                    <input type="checkbox" className="accent-primary" checked={selectedDependsOn.includes(option.id)}
                      onChange={e=>onDependsOnChange?.(e.target.checked?[...selectedDependsOn,option.id]:selectedDependsOn.filter(id=>id!==option.id))}/>
                    <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
                    <span className="text-faint">{option.state}</span>
                  </label>)}
                </div>}
              </div>
            )}
            {modeMenuOpen && (
              <div role="menu" className="anim-pop absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-line bg-panel p-1.5 shadow-[var(--shadow-pop)]">
                <div className="px-2.5 py-1.5 text-[12px] font-medium text-faint">{t('agent_exec_mode')}</div>
                {modes.map((m) => {
                  const Icon = m.icon;
                  const isCurrent = m.id === currentMode;
                  const danger = m.id === 'full-access';
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrent}
                      onClick={() => handleSelectMode(m.id)}
                      className={cn('flex w-full items-start gap-2.5 rounded-lg p-2.5 text-left transition-colors', isCurrent ? 'bg-primary/10' : 'hover:bg-hover')}
                    >
                      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', danger ? 'text-danger' : isCurrent ? 'text-primary' : 'text-muted')} />
                      <div className="min-w-0 flex-1">
                        <div className={cn('text-[13px] font-semibold', danger ? 'text-danger' : isCurrent ? 'text-primary' : 'text-fg')}>{m.label}</div>
                        <div className="text-[12px] leading-4 text-muted">{m.desc}</div>
                      </div>
                      {isCurrent && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden whitespace-nowrap text-[12px] text-faint @[820px]:inline">{t('enter_to_send')}</span>
            {isWorking && (
              <button
                type="button"
                onClick={onStop}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-[13px] font-semibold text-danger-fg transition-colors hover:bg-danger/90"
                title={t('stop')}
              >
                <Square className="h-3 w-3 fill-current" />
                <span>{t('stop')}</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSend}
              className={cn('flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition-colors',
                canSend ? 'bg-primary text-primary-fg hover:bg-primary-hover' : 'cursor-not-allowed bg-hover text-faint')}
              title={t('send')}
            >
              <span>{t('send')}</span>
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
