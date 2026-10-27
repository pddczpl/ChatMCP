// Coding workers run in the Hub, each on a Git worktree of its own. This page no longer starts, reviews or merges them; what is left of it is the test
// commands a worker waits for the owner to allow (components/inspector/IsolatedChecksPanel.tsx) and the comparison of the folder in view with the Hub's.
// Plain functions, so that a test can pin them.

/**
 * The workers of a run that may need the owner to allow a check right now: only those that asked for verification. That is the path in which
 * the Hub waits for the owner (about 90 seconds after the AI finished); a plain worker's model may still ask for a check it has a grant for, but
 * the owner is not asked about it, which also keeps the page from polling for a test broker a worker has not got yet.
 */
export function awaitingCheckWorkers<T extends { status?: string; verifyRequired?: boolean }>(job: { workers?: T[] } | null | undefined): T[] {
  return (job?.workers ?? []).filter(worker => worker.verifyRequired === true && ['running', 'awaiting_test_grant', 'testing'].includes(String(worker.status)));
}

/**
 * Coding workers act on the Hub's own project folder. The work panel can show another folder, and the panel already hides the file, Git and
 * terminal tools then; this is the same comparison, so that nobody is offered to allow a check for a folder that is not the one being looked at.
 */
export function delegationTarget(input: { selectedWorkspacePath?: string; activePath?: string; primaryPath?: string }): { blocked: boolean; primary: string; viewing: string } {
  const viewing = input.selectedWorkspacePath || input.activePath || '';
  const primary = input.primaryPath || '';
  return { blocked: Boolean(viewing && primary && viewing !== primary), primary, viewing };
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
