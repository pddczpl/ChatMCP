import type { Plan, PlanItem, Task, TaskSummary } from '../types/index';
import type { PlanDecisionAnswer, PlanExecution } from './api';
import type { ApprovalView } from './task-view';
import { PLAN_LIMITS, basisOf, draftProblem, isDirty, saveBody, type DraftProblem, type PlanConflict, type PlanDraft } from './plan-draft.ts';

// What the page shows of plan mode and what it sends (P9 ac-11, docs/PLAN-MODE.md "The page"). Pure: the components draw these and the tests read them.

const PLAN_TOOL = 'chatmcp.exit_plan_mode';
const EXECUTIONS: PlanExecution[] = ['review', 'autonomous'];
const wholeFrom = (value: unknown, least: number): value is number => Number.isSafeInteger(value) && (value as number) >= least;

// ---- the approval card ----------------------------------------------------------------------------------------------------------------------------

export interface PlanRequest { taskId: string; text: string; revision: number }

/** The plan a pending request of exit_plan_mode asks about, or null for any other request (and for an answered one): those have the ordinary card. */
export function planRequest(approval: ApprovalView): PlanRequest | null {
  const detail = approval.detail;
  if (approval.risk !== 'plan' || approval.tool !== PLAN_TOOL || approval.decision || !approval.taskId || detail?.kind !== 'plan') return null;
  if (typeof detail.plan !== 'string' || !detail.plan.trim() || !wholeFrom(detail.revision, 1)) return null;
  return { taskId: approval.taskId, text: detail.plan, revision: detail.revision };
}

export interface PlanCard {
  text: string; title: string; steps: PlanItem[]; revision: number;
  /** The plan file was read (not only the request's copy of its text): only then can it be edited. */
  loaded: boolean;
  /** The plan was written after the proposal, by `by`. */
  changed: boolean; by: 'agent' | 'user' | null;
}

/**
 * What the card shows and what an approval answers. It is the plan file, which is what the Hub gives the model on an approval; the request holds a masked copy of
 * its text, shown until the file is read (and never edited: an edit of it would write the masks into the plan). A copy of the plan read before the proposal does
 * not count.
 */
export function planCard(request: PlanRequest, plan?: Partial<Plan>): PlanCard {
  const now = basisOf(plan ?? {});
  if (now.revision < request.revision) return { text: request.text, title: '', steps: [], revision: request.revision, loaded: false, changed: false, by: null };
  return { text: now.text, title: now.title, steps: now.items, revision: now.revision, loaded: true, changed: now.revision !== request.revision, by: now.updatedBy };
}

export type ApprovalMove =
  | { kind: 'decide'; revision: number }
  | { kind: 'save'; body: ReturnType<typeof saveBody> }
  | { kind: 'blocked'; why: 'conflict' | DraftProblem };

/** What Approve does now: answer the revision on the card, save the owner's edits first, or nothing until something is settled. */
export function nextApproval(card: PlanCard, draft: PlanDraft | null, conflict: PlanConflict | null): ApprovalMove {
  if (conflict) return { kind: 'blocked', why: 'conflict' };
  if (draft && isDirty(draft)) {
    const why = draftProblem(draft);
    return why ? { kind: 'blocked', why } : { kind: 'save', body: saveBody(draft) };
  }
  return card.text.trim() ? { kind: 'decide', revision: card.revision } : { kind: 'blocked', why: 'empty_text' };
}

export interface PlanClient {
  savePlan: (taskId: string, title: string, items: PlanItem[], baseRevision?: number | null, text?: string) => Promise<Plan>;
  decidePlan: (taskId: string, revision: number, decision: 'approve', extras: { execution: PlanExecution }) => Promise<PlanDecisionAnswer>;
}

/**
 * Carries out an Approve and answers the revision that was approved. An edit is saved on its base first and the revision the save answered is approved; `onSaved`
 * hears of the save before the decision is asked, so a decision that fails leaves no draft of an edit that is saved.
 */
export async function approvePlan(client: PlanClient, taskId: string, move: Exclude<ApprovalMove, { kind: 'blocked' }>, execution: PlanExecution, onSaved?: (plan: Plan) => void): Promise<number> {
  let revision: number;
  if (move.kind === 'save') {
    const { title, items, baseRevision, text } = move.body;
    const saved = await client.savePlan(taskId, title, items, baseRevision, text);
    onSaved?.(saved);
    revision = saved.revision;
  } else revision = move.revision;
  await client.decidePlan(taskId, revision, 'approve', { execution });
  return revision;
}

/** The Hub's answer to a write or a decision about a revision the plan has left (409). */
export const isPlanConflict = (error: unknown): boolean => (error as { code?: unknown } | null | undefined)?.code === 'plan_conflict';

/** Why a request for changes cannot be sent yet, or null. */
export const feedbackProblem = (text: string): 'empty' | 'too_long' | null => (!text.trim() ? 'empty' : text.length > PLAN_LIMITS.feedbackChars ? 'too_long' : null);

// ---- the composer ---------------------------------------------------------------------------------------------------------------------------------

type PlanFields = Pick<TaskSummary, 'planMode' | 'planOnly' | 'planApproval'>;
export interface ComposerPlan {
  /** The transport of the next message has plan mode (the Browser Companion has none). */
  offered: boolean;
  checked: boolean;
  /** 'held': the task is read-only until its plan is approved. 'running': a run cannot be put in plan mode, only a new one. */
  locked: 'held' | 'running' | null;
}

/** The Plan entry of the composer: a flag of the conversation's next message, never the permission mode, which every conversation shares. */
export function composerPlan({ agentMode, task, working, wanted }: { agentMode: string; task?: PlanFields | null; working: boolean; wanted: boolean }): ComposerPlan {
  const offered = agentMode === 'api';
  const held = task?.planOnly === true;
  const locked = held ? 'held' : working ? 'running' : null;
  return { offered, checked: offered && (held || (wanted && !locked)), locked };
}

/** Whether the next message carries planMode: true. A held task stays held without it. */
export const sendsPlanMode = (plan: ComposerPlan, wanted: boolean): boolean => plan.offered && wanted && !plan.locked;

// ---- the banner and the Plan tab ------------------------------------------------------------------------------------------------------------------

export type PlanLineKind = 'planning' | 'waiting' | 'denied' | 'expired' | 'unanswerable' | 'approved';
export interface PlanLine { kind: PlanLineKind; held: boolean; revision: number | null; execution: PlanExecution | null; edited: boolean }

/** Where a plan-mode task stands, for the banner; null for a task that is not in plan mode. `waiting`: its plan is on the approval stack now. */
export function planLine(task: PlanFields | null | undefined, waiting: boolean): PlanLine | null {
  if (task?.planMode !== true) return null;
  const approval = task.planApproval ?? null;
  if (task.planOnly !== true) {
    if (approval?.status !== 'approved') return null;
    const execution = EXECUTIONS.find((name) => name === approval.execution) ?? null;
    return { kind: 'approved', held: false, revision: approval.revision ?? null, execution, edited: approval.editedByUser === true };
  }
  const known = (['denied', 'expired', 'unanswerable'] as const).find((status) => status === approval?.status);
  if (waiting || !known) return { kind: waiting ? 'waiting' : 'planning', held: true, revision: null, execution: null, edited: false };
  return { kind: known, held: true, revision: approval?.revision ?? null, execution: null, edited: false };
}

/** Whether the Plan tab offers its edit controls: the plan of a Companion task is only read. */
export const planEditable = (task: Pick<Task, 'transport'> | null | undefined): boolean => !!task && task.transport !== 'chatgpt-web';

export interface PlanHead { revision: number; by: 'agent' | 'user' | null; approved: { revision: number; current: boolean } | null }

/** The revision of the plan, who wrote it, and which revision was approved; null while nothing was written. */
export function planHead(plan: Partial<Plan> | undefined): PlanHead | null {
  const { revision, updatedBy } = basisOf(plan ?? {});
  if (revision < 1) return null;
  const approved = plan?.approvedRevision ?? null;
  return { revision, by: updatedBy, approved: approved === null ? null : { revision: approved, current: approved === revision } };
}
