import { useId } from 'react';

/**
 * The mark of DatGold: a gold "D" on a dark rounded square, the icon of the application, the setup and the browser tab drawn as an image that scales with the page. It has the palette and the
 * geometry of scripts/generate-brand-icon.py (the D is a rectangle with a half circle on its right and a counter of the same kind cut out of it; the square has a thin gold rim inside its edge)
 * and leaves out what a 24 px picture can not show: the shadow, the glow and the pale edge of the strokes. It decorates the name that is written beside it, so it is hidden from screen readers.
 * The ids of its gradients are its own, so that two marks on one page, or one that is hidden, do not blank each other.
 */
export function BrandMark({ className }: { className?: string }) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const slate = `${id}-slate`;
  const gold = `${id}-gold`;
  return (
    <svg aria-hidden="true" focusable="false" viewBox="82 82 860 860" className={className} data-testid="brand-mark">
      <defs>
        <linearGradient id={slate} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#111827" />
          <stop offset="0.5" stopColor="#0d1220" />
          <stop offset="1" stopColor="#090d1a" />
        </linearGradient>
        <linearGradient id={gold} gradientUnits="userSpaceOnUse" x1="0" y1="256" x2="0" y2="768">
          <stop offset="0" stopColor="#ffe28a" />
          <stop offset="0.5" stopColor="#f2b416" />
          <stop offset="1" stopColor="#b07004" />
        </linearGradient>
      </defs>
      <rect x="82" y="82" width="860" height="860" rx="225" fill={`url(#${slate})`} />
      {/* The rim is 12 wide and is drawn on a line 6 inside the edge of the square (82 to 942), as a shape of its own: all of it lies inside the edge and over the dark, and none of it is cut off by the picture. */}
      <rect x="88" y="88" width="848" height="848" rx="219" fill="none" stroke="#f2b416" strokeOpacity="0.6" strokeWidth="12" />
      <path fillRule="evenodd" fill={`url(#${gold})`} d="M304 256H488A256 256 0 0 1 488 768H304ZM432 384H488A128 128 0 0 1 488 640H432Z" />
    </svg>
  );
}
