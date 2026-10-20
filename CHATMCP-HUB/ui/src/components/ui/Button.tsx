import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'quiet' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg' | 'icon';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'outline', size = 'md', children, ...props }, ref) => {
    const base = 'inline-flex items-center justify-center whitespace-nowrap rounded-lg font-medium select-none transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-panel';

    const variants = {
      primary: 'bg-primary text-primary-fg hover:bg-primary-hover font-semibold border border-transparent',
      secondary: 'bg-surface text-fg border border-line hover:bg-hover hover:border-line-strong',
      outline: 'bg-surface text-fg border border-line hover:bg-hover hover:border-line-strong',
      quiet: 'bg-transparent text-muted border border-transparent hover:bg-hover hover:text-fg',
      danger: 'bg-transparent text-danger border border-danger/40 hover:bg-danger/10 hover:border-danger/60',
      ghost: 'bg-transparent text-fg border border-transparent hover:bg-hover',
    };

    const sizes = {
      sm: 'h-8 px-3 text-xs gap-1.5',
      md: 'h-9 px-3.5 text-sm gap-2',
      lg: 'h-10 px-4 text-sm gap-2.5',
      icon: 'h-8 w-8 p-0 gap-0',
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
