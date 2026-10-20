// "Reported done" is not "proven done", for agents too. A coding worker is a model: its summary is its own claim, and a status such as
// `ready_for_review` only says that it committed something and is waiting for the owner. This decides, from what the Hub recorded, how a worker
// (or a read-only report) may be shown. Plain functions, so that a test can pin them: the failure they guard against is a green mark the evidence
// does not back.

export type AgentTone = 'success' | 'warning' | 'danger' | 'neutral';
export type WorkerProofKind = 'verified' | 'unverified' | 'check-failed' | 'attention' | 'failed' | 'stopped' | 'working' | 'no-changes';
export type ReportKind = 'ai-report' | 'working' | 'attention' | 'failed' | 'stopped';

/** One check the Hub ran for a worker (the broker's record, not the model's words). */
export interface RecordedAttempt {
  id?: string;
  checkId?: string;
  status?: string;
  exitCode?: number | null;
  testOutcomeVerified?: boolean;
  snapshotHash?: string;
}

export interface WorkerRecord {
  id?: string;
  status?: string;
  verifyRequired?: boolean;
  verificationOutcome?: { state?: string } | null;
  verificationAttempts?: RecordedAttempt[] | null;
}

export interface WorkerProof {
  tone: AgentTone;
  kind: WorkerProofKind;
  /** Checks the Hub recorded for this worker, and how many of them it verified. Facts, shown whatever the tone is. */
  checks: number;
  verifiedChecks: number;
}

const WORKING = new Set(['queued', 'pending', 'preparing', 'planning', 'running', 'awaiting_test_grant', 'testing', 'committing']);

const checkFailed = (attempt: RecordedAttempt) => attempt.status === 'failed' || (typeof attempt.exitCode === 'number' && attempt.exitCode !== 0);

/**
 * How a coding worker is read. Green needs three things together: the owner asked for verification, the Hub ended the verification loop as
 * `ready_for_review`, and the latest attempt of EVERY check on record is one whose outcome the Hub verified itself (a repaired check counts by its
 * last attempt; one verified check does not vouch for another). The worker's summary is never read. A check whose latest attempt failed is red
 * whatever came before it.
 */
export function assessWorker(worker: WorkerRecord | null | undefined): WorkerProof {
  const attempts = Array.isArray(worker?.verificationAttempts) ? worker.verificationAttempts.filter(Boolean) : [];
  const facts = { checks: attempts.length, verifiedChecks: attempts.filter(attempt => attempt.testOutcomeVerified === true).length };
  const status = String(worker?.status ?? '');
  if (WORKING.has(status)) return { ...facts, tone: 'neutral', kind: 'working' };
  if (status === 'no_changes') return { ...facts, tone: 'neutral', kind: 'no-changes' };
  if (status === 'cancelled') return { ...facts, tone: 'neutral', kind: 'stopped' };
  if (status === 'failed') return { ...facts, tone: 'danger', kind: 'failed' };
  if (status !== 'ready_for_review') return { ...facts, tone: 'warning', kind: 'attention' };

  const latest = new Map<string, RecordedAttempt>();
  for (const attempt of attempts) latest.set(String(attempt.checkId ?? ''), attempt);
  const current = [...latest.values()];
  if (current.some(checkFailed)) return { ...facts, tone: 'danger', kind: 'check-failed' };
  const loopEnded = worker?.verifyRequired === true && worker.verificationOutcome?.state === 'ready_for_review';
  if (loopEnded && current.length > 0 && current.every(attempt => attempt.testOutcomeVerified === true)) return { ...facts, tone: 'success', kind: 'verified' };
  return { ...facts, tone: 'warning', kind: 'unverified' };
}

/** A read-only group or analysis: text an AI wrote from excerpts of the project. The Hub does not check it, so it is never green. */
export function assessReport(status: string | undefined): { tone: AgentTone; kind: ReportKind } {
  if (status === 'completed') return { tone: 'neutral', kind: 'ai-report' };
  if (status === 'failed') return { tone: 'danger', kind: 'failed' };
  if (status === 'cancelled') return { tone: 'neutral', kind: 'stopped' };
  if (status && WORKING.has(status)) return { tone: 'neutral', kind: 'working' };
  return { tone: 'warning', kind: 'attention' };
}

/**
 * The colour of a status word that is not an assessment of a worker (a run, a merge): red when the Hub says it failed, amber when it needs the
 * owner, plain otherwise. Never green: a word such as "completed" or "verified" in a status field is not the Hub's evidence about the work.
 */
export function statusTone(status: string | undefined): AgentTone {
  if (status === 'failed') return 'danger';
  if (status && ['needs_attention', 'partial_failure', 'interrupted', 'conflict', 'blocked'].includes(status)) return 'warning';
  return 'neutral';
}

/** The workers of a run that may need the owner to allow a check right now: only those that asked for verification. Nobody else has a test broker. */
export function awaitingCheckWorkers<T extends WorkerRecord>(job: { workers?: T[] } | null | undefined): T[] {
  return (job?.workers ?? []).filter(worker => worker.verifyRequired === true && ['running', 'awaiting_test_grant', 'testing'].includes(String(worker.status)));
}

/**
 * Delegated work (read-only groups and coding workers) acts on the Hub's own project folder. The work panel can show another folder, and the
 * panel already hides the file, Git and terminal tools then; this is the same comparison, so that the agent tools do not offer to act on a
 * folder that is not the one being looked at.
 */
export function delegationTarget(input: { selectedWorkspacePath?: string; activePath?: string; primaryPath?: string }): { blocked: boolean; primary: string; viewing: string } {
  const viewing = input.selectedWorkspacePath || input.activePath || '';
  const primary = input.primaryPath || '';
  return { blocked: Boolean(viewing && primary && viewing !== primary), primary, viewing };
}

export type CodingBlock = 'other-workspace' | 'recovery' | 'needs-autonomous' | 'busy';

/**
 * Why "start coding workers" cannot be used right now, or null. The Hub refuses a run unless the parent is in Autonomous mode (403), while
 * another run is active (409) and while an unreadable journal is unresolved; the tab says so before the owner presses the button.
 */
export function codingBlock(input: { differentRoot: boolean; mode?: string; busy: boolean; recoveryFault?: string | null }): CodingBlock | null {
  if (input.differentRoot) return 'other-workspace';
  if (input.recoveryFault) return 'recovery';
  if (input.mode !== 'autonomous') return 'needs-autonomous';
  if (input.busy) return 'busy';
  return null;
}

/**
 * Merging the ticked workers into one new branch: something is ticked, the diff of every ticked worker was read in this session (its review
 * token is what the Hub checks), the run has no merge yet (the Hub keeps one per run) and nothing else is running.
 */
export function canMerge(input: { selected: string[]; reviewed: (id: string) => boolean; hasMerge: boolean; locked: boolean }): boolean {
  return input.selected.length > 0 && input.selected.every(input.reviewed) && !input.hasMerge && !input.locked;
}

/** Asking for a draft pull request from the merge: the merge exists and is ready for review, its own diff was read, nothing else is running. */
export function canPublishMerge(input: { status?: string; reviewed: boolean; locked: boolean }): boolean {
  return input.status === 'ready_for_review' && input.reviewed && !input.locked;
}
