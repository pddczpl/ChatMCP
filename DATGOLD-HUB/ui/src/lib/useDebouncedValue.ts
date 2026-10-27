import { useEffect, useState } from 'react';

/** `value` once it has stayed the same for `delayMs`: a field that is typed into asks the Hub after the typing stops, not at every key. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
