import { create } from 'zustand';

// What the owner has typed in the Agents tab, kept while they look at another tab of the work panel (the panel unmounts the tab it leaves).
// Nothing here is saved to disk and nothing is sent anywhere: it is the text of forms that have not been submitted yet.

// dependsText is what the owner has typed in the "waits for" box, kept as typed ("plan, " is a comma on its way to a second id); dependsOn is what it means.
export interface GroupNode { id: string; role: string; question: string; dependsOn: string[]; dependsText?: string }
export interface CodingTaskDraft { id: string; prompt: string; verify: boolean; dependsOn: string[]; dependsText?: string }

export interface AgentDrafts {
  /** The request in the "analyse the project" box. */
  goal: string;
  /** The hand-made group of read-only helpers. null until the owner changes it: the starting helpers are written in the language on screen. */
  groupNodes: GroupNode[] | null;
  groupConcurrency: number;
  codingGoal: string;
  codingModelAssist: boolean;
  /** The coding tasks. null until the owner (or a proposed split) fills them in. */
  codingTasks: CodingTaskDraft[] | null;
  codingConcurrency: number;
  /** How many tasks the last proposed split had, for the note under the form. null when none was proposed. */
  codingPlanCount: number | null;
}

interface AgentDraftsStore extends AgentDrafts {
  set: (patch: Partial<AgentDrafts>) => void;
  /** A fresh set of empty drafts (new arrays every time). */
  defaults: () => AgentDrafts;
}

/** The Hub takes 1..max workers at once; anything else is brought inside. */
export const clampConcurrency = (value: number, max: number): number => (Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value))) : max);

const defaults = (): AgentDrafts => ({
  goal: '',
  groupNodes: null,
  groupConcurrency: 2,
  codingGoal: '',
  codingModelAssist: false,
  codingTasks: null,
  codingConcurrency: 2,
  codingPlanCount: null,
});

export const useAgentDrafts = create<AgentDraftsStore>((set) => ({
  ...defaults(),
  set: (patch) => set(patch),
  defaults,
}));
