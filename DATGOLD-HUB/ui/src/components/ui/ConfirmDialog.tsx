import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface ConfirmNote { tone: 'warn' | 'info'; text: string }

/** What a confirmation says. Every word is given by the caller, in the language of the page; the dialog only lays it out. */
export interface ConfirmRequest {
  title: string;
  /** A sentence under the title. */
  body?: string;
  /** One line for each thing that is about to happen (a file). */
  details?: string[];
  notes?: ConfirmNote[];
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` makes the confirm button red and puts the focus on Cancel; `primary` (the default) puts it on the confirm button. */
  tone?: 'primary' | 'danger';
  /** Words the person must type, exactly, before the confirm button works (and then Enter in the field confirms). */
  phrase?: string;
}

export type Ask = (request: ConfirmRequest) => Promise<boolean>;

// A screen without the provider (a test, a component rendered alone) confirms nothing, so that an action that needs a question is never taken without one. It is exported so that a
// test can answer the questions itself.
export const ConfirmContext = createContext<Ask>(async () => false);

/** The one way the page asks "are you sure?": `if (!(await ask({ ... }))) return;`. It replaces confirm() and prompt(), which the Hub's page does not use. */
export function useConfirm(): Ask {
  return useContext(ConfirmContext);
}

/**
 * Holds the one confirmation dialog of the page. The dialog is the project's own (a native <dialog> with the alertdialog role, components/ui/Modal.tsx): Radix's AlertDialog adds a
 * <style> element for its scroll lock, which the Hub's Content-Security-Policy blocks (style-src 'self'). Escape answers no; so does the Cancel button; a second question asked while
 * one is open makes the first a no.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const waiting = useRef<((answer: boolean) => void) | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // The control that had the focus when the question was asked is the one the focus goes back to. It is remembered as it takes the focus: by the time a question is asked (after a request
  // to the Hub) the control may have been disabled for its work, and a disabled control has already lost the focus.
  const focused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target !== document.body && !target.closest('dialog')) focused.current = target;
    };
    document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, []);
  const ask = useCallback<Ask>((next) => new Promise<boolean>((resolve) => {
    waiting.current?.(false);
    waiting.current = resolve;
    opener.current ??= focused.current;
    setRequest(next);
  }), []);
  const answer = useCallback((value: boolean) => {
    const resolve = waiting.current;
    waiting.current = null;
    setRequest(null);
    returnFocus(opener.current);
    opener.current = null;
    resolve?.(value);
  }, []);
  return <ConfirmContext.Provider value={ask}>{children}<ConfirmDialog request={request} onAnswer={answer} /></ConfirmContext.Provider>;
}

/**
 * The focus goes back to the control that asked, once the dialog is gone and the control can take it: a button that is disabled while its work is going on (and was while the question was open)
 * gets the focus when it is enabled again. If the person has put the focus somewhere else by then, it stays there. A control that stays disabled (the work took away what it was for: nothing
 * is left to undo) hands the focus to the panel it is in, so that the focus is not lost to the page.
 */
function returnFocus(target: HTMLElement | null) {
  if (!target) return;
  let tries = 0;
  const attempt = () => {
    if (!target.isConnected) return;
    const dialogOpen = document.querySelector('dialog[open]') !== null;
    if (!dialogOpen && document.activeElement && document.activeElement !== document.body) return;
    if (!dialogOpen && !(target as HTMLButtonElement).disabled) { target.focus(); return; }
    tries += 1;
    if (!dialogOpen && tries >= 30) {
      const region = target.closest<HTMLElement>('[role="tabpanel"], section, main');
      if (region) {
        if (!region.hasAttribute('tabindex')) region.setAttribute('tabindex', '-1');
        region.focus({ preventScroll: true });
      }
      return;
    }
    if (tries < 120) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

export function ConfirmDialog({ request, onAnswer }: { request: ConfirmRequest | null; onAnswer: (answer: boolean) => void }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const allowed = !request?.phrase || typed.trim() === request.phrase;

  useEffect(() => { setTyped(''); }, [request]);
  // The dialog is opened by Modal's effect, which runs before this one: the focus then goes to where an unthinking Enter does the least harm.
  useEffect(() => {
    if (!request) return;
    (request.phrase ? fieldRef : request.tone === 'danger' ? cancelRef : confirmRef).current?.focus();
  }, [request]);

  return (
    <Modal open={request !== null} onOpenChange={(open) => { if (!open && request) onAnswer(false); }} role="alertdialog" title={request?.title ?? ''} description={request?.body}>
      {request && (
        <form data-testid="confirm-form" className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); if (allowed) onAnswer(true); }}>
          {request.notes?.map((note, index) => (
            <p key={index} role="note" data-tone={note.tone}
              className={cn('rounded-lg border px-3 py-2 text-[13px] leading-5', note.tone === 'warn' ? 'border-warning/30 bg-warning/10 text-warning' : 'border-line bg-surface text-muted')}>{note.text}</p>
          ))}
          {request.details && request.details.length > 0 && (
            <ul data-testid="confirm-details" className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line bg-bg px-3 py-2 text-[13px] leading-5 text-fg">
              {request.details.map((line, index) => <li key={index} className="break-words">{line}</li>)}
            </ul>
          )}
          {request.phrase && (
            <label className="block text-[13px] text-muted">
              {t('confirm_type_label', { phrase: request.phrase })}
              <Input ref={fieldRef} aria-label={t('confirm_type_field')} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} className="mt-1.5 w-full font-mono" />
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button ref={cancelRef} type="button" variant="secondary" onClick={() => onAnswer(false)}>{request.cancelLabel ?? t('confirm_cancel')}</Button>
            <Button ref={confirmRef} type="submit" variant={request.tone === 'danger' ? 'danger' : 'primary'} disabled={!allowed}>{request.confirmLabel}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
