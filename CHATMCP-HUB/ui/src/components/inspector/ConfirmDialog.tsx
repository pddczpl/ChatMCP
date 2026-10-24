import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import '@/lib/i18n-agents-sections'; // the strings only the sections ask for load with them
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** What the confirm button says. */
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  /** When set, the owner must type exactly this phrase before the button works (merging, publishing, acknowledging an interrupted run). */
  phrase?: string;
  /** The button stays off while a request is in flight. */
  busy?: boolean;
  /** Where focus goes when the dialog closes and the button that opened it is gone or off by then (a "start" that turned into "working"). */
  focusAfter?: React.RefObject<HTMLElement | null>;
  children?: React.ReactNode;
}

/**
 * A question that needs a deliberate yes, as a native modal (focus stays inside, Escape closes it, focus returns to the button that opened
 * it, or to `focusAfter` when that button is no longer usable). It replaces the browser's confirm() and prompt(): those cannot be styled,
 * cannot be read in the app's language and are dismissed by some embedded browsers. The body is only rendered while the dialog is open.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, onConfirm, phrase, busy = false, focusAfter, children }: Props) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      // The dialog shows itself in an effect of Modal; focus the safe control once it is up: the phrase box, or "cancel".
      const frame = requestAnimationFrame(() => (phrase ? inputRef.current : cancelRef.current)?.focus());
      return () => cancelAnimationFrame(frame);
    }
    setTyped('');
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // The native dialog hands focus back to the button that opened it; when that button is gone or off, focus would be nowhere.
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body || (active as HTMLButtonElement).disabled) focusAfter?.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, phrase]);

  const ready = !phrase || typed === phrase;
  return (
    <Modal open={open} onOpenChange={onOpenChange} role="alertdialog" title={title} description={open ? description : undefined}>
      {open && (
        <form onSubmit={(event) => { event.preventDefault(); if (ready && !busy) onConfirm(); }}>
          {children}
          {phrase && (
            <div className="mt-4 space-y-1.5">
              <label htmlFor="confirm-phrase" className="block text-[13px] font-medium text-fg">
                {t('coding_phrase_label')} <span className="select-text font-mono text-muted">{phrase}</span>
              </label>
              <Input id="confirm-phrase" ref={inputRef} value={typed} onChange={(event) => setTyped(event.target.value)} aria-describedby="confirm-phrase-hint"
                autoComplete="off" autoCapitalize="off" spellCheck={false} />
              <p id="confirm-phrase-hint" className="text-[12px] leading-4 text-faint">{t('coding_phrase_hint')}</p>
            </div>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button type="button" ref={cancelRef} variant="outline" onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
            <Button type="submit" variant="primary" disabled={!ready || busy}>{confirmLabel}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
