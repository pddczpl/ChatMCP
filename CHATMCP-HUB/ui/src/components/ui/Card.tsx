import * as React from 'react';
import { cn } from '@/lib/utils';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  tilt3D?: boolean;
  tilt3d?: boolean;
}

export function Card({ className, tilt3D = false, tilt3d = false, children, ...props }: CardProps) {
  const isTilt = tilt3D || tilt3d;
  const [style, setStyle] = React.useState<React.CSSProperties>({});
  const cardRef = React.useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isTilt || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    // Very subtle tilt: max 3.5 degrees
    const rotateX = ((y - centerY) / centerY) * -3.5;
    const rotateY = ((x - centerX) / centerX) * 3.5;

    setStyle({
      transform: `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.01, 1.01, 1.01)`,
      transition: 'transform 0.08s ease-out',
    });
  };

  const handleMouseLeave = () => {
    if (!isTilt) return;
    setStyle({
      transform: 'perspective(800px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)',
      transition: 'transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)',
    });
  };

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={style}
      className={cn(
        'rounded-lg border border-[var(--line)] bg-[var(--panel)] text-[var(--text)] transition-colors',
        isTilt && 'transform-style-3d will-change-transform cursor-pointer',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
