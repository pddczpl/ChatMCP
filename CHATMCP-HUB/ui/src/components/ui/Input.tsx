import * as React from 'react';
import { cn } from '@/lib/utils';

/** One look for every text control: 36px tall, a quiet border, a visible focus ring. */
export const controlClass = 'w-full rounded-lg border border-line bg-surface px-3 text-[13px] text-fg placeholder:text-faint transition-colors hover:border-line-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(controlClass, 'h-9', className)} {...props} />,
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(controlClass, 'py-2 leading-5', className)} {...props} />,
);
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => <select ref={ref} className={cn(controlClass, 'h-9 pr-8', className)} {...props}>{children}</select>,
);
Select.displayName = 'Select';

/** A label above a control, with an optional hint underneath. */
export function Field({ label, hint, htmlFor, className, children }: { label: React.ReactNode; hint?: React.ReactNode; htmlFor?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-fg">{label}</label>
      {children}
      {hint && <p className="text-[12px] leading-4 text-faint">{hint}</p>}
    </div>
  );
}
