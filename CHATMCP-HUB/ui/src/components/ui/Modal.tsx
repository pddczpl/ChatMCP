import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  role?: 'dialog' | 'alertdialog';
  className?: string;
  children: ReactNode;
};

// Native modal dialogs provide focus containment, Escape handling and focus
// restoration without injecting styles that conflict with the Hub's CSP.
export function Modal({ open, onOpenChange, title, description, role = 'dialog', className, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return <dialog ref={ref} role={role} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}
    onCancel={() => onOpenChange(false)} onClose={() => onOpenChange(false)}
    className={cn('fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5 text-sm leading-relaxed text-[var(--text)] shadow-xl select-text backdrop:bg-black/50', className)}>
    <h3 id={`${id}-title`} className="text-lg font-semibold">{title}</h3>
    {description && <p id={`${id}-description`} className="mt-3 text-[var(--muted)]">{description}</p>}
    {children}
  </dialog>;
}
