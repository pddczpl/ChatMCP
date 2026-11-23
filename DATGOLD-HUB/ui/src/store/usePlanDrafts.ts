import { create } from 'zustand';
import type { PlanDraft } from '@/lib/plan-draft';

// The owner's unsaved edits of a plan, one draft per task (lib/plan-draft.ts). They live here and not in the Plan tab: the panel unmounts the tab it leaves, and the
// approval card of the same plan shows and approves the same draft. Nothing here is saved to disk.

interface PlanDraftsStore {
  drafts: Record<string, PlanDraft>;
  setDraft: (taskId: string, draft: PlanDraft | null) => void;
}

export const usePlanDrafts = create<PlanDraftsStore>((set) => ({
  drafts: {},
  setDraft: (taskId, draft) => set((state) => {
    const { [taskId]: _gone, ...others } = state.drafts;
    return { drafts: draft ? { ...others, [taskId]: draft } : others };
  }),
}));
