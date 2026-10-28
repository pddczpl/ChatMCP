/**
 * The keys of an ARIA tablist with automatic activation (the chosen tab follows the focus). Returns the index to move to, or null for a key
 * the tablist does not handle. Shared by the work panel's tab strip and the section switch of the Agents tab, so both behave the same.
 */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return null;
  if (index < 0) return key === 'ArrowRight' ? 0 : count - 1;
  return (index + (key === 'ArrowRight' ? 1 : -1) + count) % count;
}
