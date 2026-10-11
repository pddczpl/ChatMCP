import * as React from 'react';
import { cn } from '@/lib/utils';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  tilt3D?: boolean;
  tilt3d?: boolean;
}

export function Card({ className, tilt3D = false, tilt3d = false, children, ...props }: CardProps) {
  const isTilt = tilt3D || tilt3d;
  const cardRef = React.useRef<HTMLDivElement>(null);
  const rafRef = React.useRef<number | null>(null);

  const handleMouseMove = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isTilt || !cardRef.current) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const card = cardRef.current;
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    // Subtle, clean 3D tilt (max 3 degrees)
    const rotateX = ((y - centerY) / (centerY || 1)) * -3.0;
    const rotateY = ((x - centerX) / (centerX || 1)) * 3.0;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      if (!cardRef.current) return;
      cardRef.current.style.transform = `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateY(-2px)`;
      cardRef.current.style.transition = 'none';
    });
  }, [isTilt]);

  const handleMouseLeave = React.useCallback(() => {
    if (!isTilt || !cardRef.current) return;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    cardRef.current.style.transition = 'transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s ease, border-color 0.25s ease';
    cardRef.current.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0px)';
  }, [isTilt]);

  React.useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={cn(
        'rounded-lg border border-[var(--line)] bg-[var(--panel)] text-[var(--text)] transition-colors',
        isTilt && 'transform-style-3d will-change-transform cursor-pointer shadow-sm hover:shadow-lg hover:border-sky-500/30',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
