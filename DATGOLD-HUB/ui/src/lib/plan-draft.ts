import type { Plan, PlanItem } from '../types/index';

// The owner's draft of a plan (P9 ac-11, docs/PLAN-MODE.md "The page"). What the owner types lives apart from the plan the page fetches every few seconds, so a
// refetch takes no word away. A draft remembers the revision it was opened from (`basis`). The status and the evidence of a step are the agent's: the owner can
// move, reword, add or delete a step and never write evidence for one. Pure functions: every edit answers a new draft.

/** The Hub's limits (lib/studio-workspace.mjs `plan`, PLAN_LIMITS of lib/permissions.mjs). */
export const PLAN_LIMITS = Object.freeze({ steps: 100, stepChars: 500, titleChars: 240, textChars: 40_000, feedbackChars: 4_000 });

/** The plan a draft was opened from, with the fields an older Hub does not send filled in. */
export interface PlanBasis { revision: number; updatedBy: 'agent' | 'user' | null; title: string; text: string; items: PlanItem[] }
/** A step of a draft. `from` is the step of the basis it was, null for a step the owner added. */
export interface DraftStep { id: string; text: string; from: number | null }
export interface PlanDraft { basis: PlanBasis; title: string; text: string; steps: DraftStep[]; nextId: number }
export interface PlanConflict { base: number; revision: number; by: 'agent' | 'user' | null }
export type DraftProblem = 'empty_step' | 'step_too_long' | 'too_many_steps' | 'empty_text' | 'text_too_long';

const sameText = (a: string, b: string) => a.trim() === b.trim();

export function basisOf(plan: Partial<Plan>): PlanBasis {
  return {
    revision: plan.revision ?? 0, updatedBy: plan.updatedBy ?? null, title: plan.title ?? '', text: plan.text ?? '',
    items: (plan.items ?? []).map(({ text, status, evidence }) => ({ text, status, evidence: evidence ?? '' })),
  };
}

export function openDraft(plan: Partial<Plan>): PlanDraft {
  const basis = basisOf(plan);
  return { basis, title: basis.title, text: basis.text, steps: basis.items.map((item, index) => ({ id: `s${index}`, text: item.text, from: index })), nextId: basis.items.length };
}

// ---- edits --------------------------------------------------------------------------------------------------------------------------------------

export const editTitle = (draft: PlanDraft, title: string): PlanDraft => ({ ...draft, title });
export const editText = (draft: PlanDraft, text: string): PlanDraft => ({ ...draft, text });
export const editStep = (draft: PlanDraft, id: string, text: string): PlanDraft => ({ ...draft, steps: draft.steps.map((step) => (step.id === id ? { ...step, text } : step)) });
export const removeStep = (draft: PlanDraft, id: string): PlanDraft => ({ ...draft, steps: draft.steps.filter((step) => step.id !== id) });

/** An empty step under the step `after` (at the end without one); `id` is the new step's, for the focus. */
export function addStep(draft: PlanDraft, after?: string): { draft: PlanDraft; id: string } {
  const id = `s${draft.nextId}`;
  const at = draft.steps.findIndex((step) => step.id === after);
  const place = at < 0 ? draft.steps.length : at + 1;
  return { id, draft: { ...draft, nextId: draft.nextId + 1, steps: [...draft.steps.slice(0, place), { id, text: '', from: null }, ...draft.steps.slice(place)] } };
}

/** One place up (-1) or down (1); the same draft when there is no such place. */
export function moveStep(draft: PlanDraft, id: string, by: -1 | 1): PlanDraft {
  const at = draft.steps.findIndex((step) => step.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= draft.steps.length) return draft;
  const steps = [...draft.steps];
  [steps[at], steps[to]] = [steps[to], steps[at]];
  return { ...draft, steps };
}

// ---- what a draft is ----------------------------------------------------------------------------------------------------------------------------

const stepsChanged = ({ basis, steps }: PlanDraft) =>
  steps.length !== basis.items.length || steps.some((step, index) => step.from !== index || step.text !== basis.items[index].text);

export const isDirty = (draft: PlanDraft): boolean => draft.title !== draft.basis.title || draft.text !== draft.basis.text || stepsChanged(draft);

/** Why the Hub would refuse the draft (or the approval of it), or null. A plan that had a text keeps one: a blank one cannot be approved. */
export function draftProblem(draft: PlanDraft): DraftProblem | null {
  if (draft.steps.some((step) => !step.text.trim())) return 'empty_step';
  if (draft.steps.some((step) => step.text.trim().length > PLAN_LIMITS.stepChars)) return 'step_too_long';
  if (draft.steps.length > PLAN_LIMITS.steps) return 'too_many_steps';
  if (draft.basis.text.trim() && !draft.text.trim()) return 'empty_text';
  if (draft.text.length > PLAN_LIMITS.textChars) return 'text_too_long';
  return null;
}

/**
 * The step as it would be saved. The marks of the agent (status, evidence) belong to the words it made them for: a step the owner rewords loses its evidence and
 * is no longer done, and a step the owner adds has neither.
 */
function savedStep(draft: PlanDraft, step: DraftStep): PlanItem {
  const text = step.text.trim();
  const was = step.from === null ? null : draft.basis.items[step.from];
  if (!was) return { text, status: 'todo', evidence: '' };
  if (sameText(was.text, text)) return { ...was, text };
  return { text, status: was.status === 'done' ? 'todo' : was.status, evidence: '' };
}

/** What the editor shows beside a step: the agent's marks as they would be saved, and whether the owner's words take some away (`loses`). */
export function stepView(draft: PlanDraft, step: DraftStep): { status: PlanItem['status']; evidence: string; loses: boolean } {
  const saved = savedStep(draft, step);
  const was = step.from === null ? null : draft.basis.items[step.from];
  const evidence = saved.evidence ?? '';
  return { status: saved.status, evidence, loses: !!was && (was.status !== saved.status || (!!was.evidence?.trim() && !evidence)) };
}

/** The body of POST /api/studio/plan/set for this draft (without the task). The text goes only when the owner changed it. */
export function saveBody(draft: PlanDraft): { title: string; items: PlanItem[]; baseRevision: number; text?: string } {
  return {
    title: draft.title.trim(), items: draft.steps.map((step) => savedStep(draft, step)), baseRevision: draft.basis.revision,
    ...(draft.text === draft.basis.text ? {} : { text: draft.text }),
  };
}

// ---- the plan moves on --------------------------------------------------------------------------------------------------------------------------

const sameWords = (a: PlanBasis, b: PlanBasis) =>
  a.title === b.title && a.text === b.text && a.items.length === b.items.length && a.items.every((item, index) => item.text === b.items[index].text);

/**
 * The draft against the plan as it is now. The marks of the agent (a revision whose words are the basis's) go under the owner's words; a draft nobody typed in
 * follows the plan; another revision of the words under a draft with edits is a conflict, and the draft stays as it is.
 */
export function reconcile(draft: PlanDraft, plan: Partial<Plan>): { draft: PlanDraft; conflict: PlanConflict | null } {
  const now = basisOf(plan);
  if (now.revision === draft.basis.revision) return { draft, conflict: null };
  if (sameWords(draft.basis, now)) return { draft: { ...draft, basis: now }, conflict: null };
  if (!isDirty(draft)) return { draft: openDraft(plan), conflict: null };
  return { draft, conflict: { base: draft.basis.revision, revision: now.revision, by: now.updatedBy } };
}

/**
 * The owner's edits on the plan as it is now: the title, the text and the list they changed stay theirs, the ones they did not touch are the plan's. A step of
 * theirs takes the marks of the plan's step that has its old words, or its own words for a step they added (each step of the plan once).
 */
export function keepMine(draft: PlanDraft, plan: Partial<Plan>): PlanDraft {
  const fresh = openDraft(plan);
  const { basis } = draft;
  const free = new Set(fresh.basis.items.keys());
  const match = (words: string): number | null => {
    const at = [...free].find((index) => sameText(fresh.basis.items[index].text, words));
    if (at === undefined) return null;
    free.delete(at);
    return at;
  };
  const listed = stepsChanged(draft)
    ? { steps: draft.steps.map((step) => ({ ...step, from: match(step.from === null ? step.text : basis.items[step.from].text) })), nextId: draft.nextId }
    : { steps: fresh.steps, nextId: fresh.nextId };
  return { basis: fresh.basis, title: draft.title === basis.title ? fresh.title : draft.title, text: draft.text === basis.text ? fresh.text : draft.text, ...listed };
}
