import { useEffect, useRef } from 'react';

/**
 * The button that opened an editor takes the focus back when the editor closes. The button is drawn again by the same change, so the focus is given after the
 * next render that has it, enabled, and not before.
 */
export function useFocusBack() {
  const button = useRef<HTMLButtonElement>(null);
  const wanted = useRef(false);
  useEffect(() => {
    if (!wanted.current || !button.current || button.current.disabled) return;
    wanted.current = false;
    button.current.focus();
  });
  return { button, focusBack: () => { wanted.current = true; } };
}
