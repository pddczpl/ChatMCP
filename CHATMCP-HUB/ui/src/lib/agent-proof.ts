// "Reported done" is not "proven done", for agents too. A coding worker is a model: its summary is its own claim, and a status such as
// `ready_for_review` only says that it committed something and is waiting for the owner. This decides, from what the Hub recorded, how a worker
// (or a read-only report) may be shown. Plain functions, so that a test can pin them: the failure they guard against is a green mark the evidence
// does not back.

export type AgentTone = 'success' | 'warning' | 'danger' | 'neutral';
export type WorkerProofKind = 'verified' | 'unverified' | 'check-failed' | 'attention' | 'failed' | 'stopped' | 'working' | 'awaiting-grant' | 'no-changes';
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

/**
 * What the Hub says in its own words about how a worker's verification ended (lib/coding-orchestrator.mjs). `code` is what this page translates; `text` is
 * the Hub's English sentence, for a code this page does not know; `detail` is the part of the sentence that varies (the reason the loop gave up).
 */
export interface VerificationNote {
  code: string;
  text?: string;
  detail?: string;
}

export interface WorkerRecord {
  id?: string;
  status?: string;
  verifyRequired?: boolean;
  verificationOutcome?: { state?: string } | null;
  verificationAttempts?: RecordedAttempt[] | null;
  verificationNote?: VerificationNote | null;
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
export function assessWorker(worker: WorkerRecord | null | undefined, options: { runActive?: boolean } = {}): WorkerProof {
  const attempts = Array.isArray(worker?.verificationAttempts) ? worker.verificationAttempts.filter(Boolean) : [];
  const facts = { checks: attempts.length, verifiedChecks: attempts.filter(attempt => attempt.testOutcomeVerified === true).length };
  const status = String(worker?.status ?? '');
  if (WORKING.has(status)) {
    // A worker still "queued" or "running" in a run that is not going any more (stopped, failed, the Hub restarted) will never finish: it is stopped.
    if (options.runActive === false) return { ...facts, tone: 'neutral', kind: 'stopped' };
    // Waiting for a test grant is waiting for the owner, for a limited time.
    if (status === 'awaiting_test_grant') return { ...facts, tone: 'warning', kind: 'awaiting-grant' };
    return { ...facts, tone: 'neutral', kind: 'working' };
  }
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

/**
 * The Hub's own sentence about how a worker's verification ended, which is a field of its own: the worker's summary is what its model said and nothing
 * else. It is shown beside the evidence line, labelled as the Hub's, and is never green. A code the page does not know is passed on with the Hub's text.
 * The note that every check has fresh evidence repeats what the evidence line says, so it is shown only where `assessWorker` agrees: after a commit that
 * failed, a restart, a later attempt that failed or one the Hub did not verify, repeating it would read as proof that the record does not back.
 */
export function hubNoteOf(worker: WorkerRecord | null | undefined, proof: WorkerProof): VerificationNote | null {
  const raw: unknown = worker?.verificationNote;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { code, text, detail } = raw as Record<string, unknown>;
  if (typeof code !== 'string' || code === '') return null;
  if (code === 'verified' && proof.kind !== 'verified') return null;
  return { code, ...(typeof text === 'string' ? { text } : {}), ...(typeof detail === 'string' ? { detail } : {}) };
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
 * The Hub saves the status of a group of helpers while it runs, and keeps what it saved if it stops. A status that says "in progress" or
 * "still to come" while the Hub says nothing is running is a run that was cut off.
 */
export function effectiveReportStatus(status: string | undefined, running: boolean): string | undefined {
  return !running && status && WORKING.has(status) ? 'interrupted' : status;
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

/**
 * The kind of notice shown when a run ends: information, or a warning when the status needs the owner. Never a success: that a run ended is
 * not a verdict on what the AI produced, which only the evidence of a worker can give.
 */
export function outcomeToast(status: string | undefined): 'info' | 'warning' {
  return statusTone(status) === 'neutral' ? 'info' : 'warning';
}

/**
 * The workers of a run that may need the owner to allow a check right now: only those that asked for verification. That is the path in which
 * the Hub waits for the owner (about 90 seconds after the AI finished); a plain worker's model may still ask for a check it has a grant for, but
 * the owner is not asked about it, which also keeps the page from polling for a test broker a worker has not got yet.
 */
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

/**
 * The runs of the folder in view. The Hub keeps one list of runs for every folder it has worked on and says which folder each belongs to; a run is shown
 * only when that is exactly the folder in view (the Hub compares the same way before it reads or changes a run, so a run of another folder could not be
 * read from here anyway), and the others are counted so that the page can say they exist. A run with no recorded folder belongs to none.
 */
export function runsOfFolder<T extends { workspace?: unknown }>(jobs: unknown, folder: string | null | undefined): { shown: T[]; hidden: number } {
  const list = Array.isArray(jobs) ? (jobs as T[]) : [];
  const shown = typeof folder === 'string' && folder !== '' ? list.filter((job) => Boolean(job) && job.workspace === folder) : [];
  return { shown, hidden: list.length - shown.length };
}

export type CodingBlock = 'other-workspace' | 'recovery' | 'needs-autonomous' | 'agent-busy' | 'group-running' | 'busy';

/**
 * Why "start coding workers" cannot be used right now, or null. The Hub refuses a run unless the parent is in Autonomous mode (403), while
 * the main agent or a group of helpers is running, while another run is active (409) and while an unreadable journal is unresolved; the tab
 * says so before the owner presses the button.
 */
export function codingBlock(input: {
  differentRoot: boolean; mode?: string; busy: boolean; recoveryFault?: string | null; agentBusy?: boolean; groupRunning?: boolean;
}): CodingBlock | null {
  if (input.differentRoot) return 'other-workspace';
  if (input.recoveryFault) return 'recovery';
  if (input.mode !== 'autonomous') return 'needs-autonomous';
  if (input.agentBusy) return 'agent-busy';
  if (input.groupRunning) return 'group-running';
  if (input.busy) return 'busy';
  return null;
}

export type AnalysisBlock = 'other-workspace' | 'agent-busy' | 'coding-running' | 'group-running' | 'ai-busy';

/** Why "start the analysis" (the AI plans its own helpers) cannot be used: the Hub refuses it while the main agent, coding workers, a group or a model request is running. */
export function analysisBlock(input: { differentRoot: boolean; agentBusy: boolean; codingActive: boolean; groupRunning: boolean; aiBusy: boolean }): AnalysisBlock | null {
  if (input.differentRoot) return 'other-workspace';
  if (input.agentBusy) return 'agent-busy';
  if (input.codingActive) return 'coding-running';
  if (input.groupRunning) return 'group-running';
  if (input.aiBusy) return 'ai-busy';
  return null;
}

/** Why "start with this group" cannot be used: the Hub only refuses it while the main agent is running. */
export function groupBlock(input: { differentRoot: boolean; agentBusy: boolean }): 'other-workspace' | 'agent-busy' | null {
  if (input.differentRoot) return 'other-workspace';
  if (input.agentBusy) return 'agent-busy';
  return null;
}

/** The states of a run in which the Hub merges its workers (a run that was stopped or failed is not one of them). */
export const MERGEABLE_RUN_STATUSES = ['ready_for_review', 'partial_failure'];

/**
 * Merging the ticked workers into one new branch: something is ticked, the diff of every ticked worker was read in this session (its review
 * token is what the Hub checks), the run is in a state the Hub merges, it has no merge yet (the Hub keeps one per run) and nothing else is running.
 */
export function canMerge(input: { selected: string[]; reviewed: (id: string) => boolean; hasMerge: boolean; locked: boolean; runStatus?: string }): boolean {
  return input.selected.length > 0 && input.selected.every(input.reviewed) && !input.hasMerge && !input.locked
    && MERGEABLE_RUN_STATUSES.includes(String(input.runStatus));
}

/**
 * The key a worker's review (the diff the owner read, and the token the Hub gave for it) is kept under; the merge has a key of its own. A
 * worker may be called anything that is a valid id, "integration" and "merge" included, and must not take over the merge's review.
 */
export const reviewKey = (workerId?: string | null): string => (workerId ? `worker:${workerId}` : 'merge');

/** The workers a run that has just ended starts with ticked: those ready for review, and only when the Hub would merge this run at all. */
export function preselectIds(run: { status?: string; workers?: { id: string; status?: string }[] } | null | undefined): string[] {
  if (!MERGEABLE_RUN_STATUSES.includes(String(run?.status))) return [];
  return (run?.workers ?? []).filter(worker => worker.status === 'ready_for_review').map(worker => worker.id);
}

/** What the Hub answered when the owner allowed a check: up to `maxAttempts` runs, until `expiresAt` (milliseconds since 1970). */
export interface GrantNote { expiresAt: number; maxAttempts: number }

/**
 * Whether a permission the owner gave still stands. The Hub does not list grants again (its list of checks only has the checks), so the page
 * remembers the Hub's answer; once the time has passed the permission is over and the owner may be asked again.
 */
export function grantState(note: GrantNote | null | undefined, now: number): 'none' | 'active' | 'expired' {
  if (!note) return 'none';
  return note.expiresAt > now ? 'active' : 'expired';
}

/** Asking for a draft pull request from the merge: the merge exists and is ready for review, its own diff was read, nothing else is running. */
export function canPublishMerge(input: { status?: string; reviewed: boolean; locked: boolean }): boolean {
  return input.status === 'ready_for_review' && input.reviewed && !input.locked;
}
