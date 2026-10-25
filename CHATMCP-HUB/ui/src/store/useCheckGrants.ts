import { create } from 'zustand';
import type { GrantNote } from '@/lib/agent-proof';

// What the Hub answered when the owner allowed a test command, kept while they look at another tab of the work panel (the panel unmounts the tab it leaves).
// Nothing here is saved to disk and nothing is sent anywhere.

interface CheckGrantsStore {
  /** By "worker:check". The Hub's list of checks does not show grants, so this is how the page knows which are allowed and until when. */
  checkGrants: Record<string, GrantNote>;
  rememberGrant: (key: string, note: GrantNote) => void;
}

export const useCheckGrants = create<CheckGrantsStore>((set) => ({
  checkGrants: {},
  rememberGrant: (key, note) => set((state) => ({ checkGrants: { ...state.checkGrants, [key]: note } })),
}));
