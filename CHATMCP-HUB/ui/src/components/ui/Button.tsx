import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'quiet' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg' | 'icon';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'outline', size = 'md', children, ...props }, ref) => {
    const base = 'inline-flex items-center justify-center font-medium rounded-md transition-all duration-150 select-none disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-1 active:scale-[0.98]';
    
    const variants = {
      primary: 'bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--primary-foreground)] font-semibold border border-transparent',
      secondary: 'bg-[var(--surface)] hover:bg-[var(--surface-hover)] text-[var(--text)] border border-[var(--line)]',
      outline: 'bg-[var(--surface)] hover:bg-[var(--surface-hover)] text-[var(--text)] border border-[var(--line)]',
      quiet: 'bg-transparent hover:bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)]',
      danger: 'bg-transparent hover:bg-[var(--danger-bg)] text-[var(--danger)] border border-[var(--line)]',
      ghost: 'bg-transparent hover:bg-[var(--surface-hover)] text-[var(--text)]',
    };

    const sizes = {
      sm: 'min-h-8 px-2.5 py-1 text-xs gap-1.5',
      md: 'min-h-9 px-3 py-1.5 text-sm gap-2',
      lg: 'h-10 px-4 text-sm gap-2.5',
      icon: 'h-8 w-8 p-0',
    };

    return (
      <button
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      >
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';
