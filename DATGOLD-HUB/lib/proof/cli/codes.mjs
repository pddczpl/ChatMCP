// The fixed tables of `chatmcp verify` (docs/PROOF-CLI.md): the commands, the exit codes and the answer codes. Every answer the CLI gives
// has exactly one code, and a code always means the same exit code, whatever the command; the suite holds the doc to these tables.

/** The format name of every --json answer. */
export const CLI_FORMAT = 'chatmcp.verify-cli/1';
/** The format of a proof session (session.json and the ledger's task_start record). */
export const SESSION_FORMAT = 'chatmcp.verify-session/1';

/** The commands of the plan (pod-24), in the plan's order. */
export const COMMANDS = Object.freeze(['init', 'trust', 'snapshot', 'run', 'exec', 'check', 'show', 'pack']);

/** The commands of the plan that later tasks build; until then they answer `not_built`. */
export const NOT_BUILT = Object.freeze({ check: 'pod-32' });

/** The exit code of each outcome. */
export const EXIT = Object.freeze({ pass: 0, unverified: 1, usage: 2, integrity: 3, environment: 4 });

/** Every answer code and its outcome (so its exit code). */
export const CODES = Object.freeze({
  // 0: the command did what was asked, and what it checked holds
  help: 'pass',
  version: 'pass',
  acceptance_written: 'pass',
  acceptance_printed: 'pass',
  trusted: 'pass',
  revoked: 'pass',
  already_untrusted: 'pass',
  snapshot_taken: 'pass',
  check_passed: 'pass',
  session_intact: 'pass',
  pack_evidenced: 'pass',
  exec_evidenced: 'pass',
  // 1: not verified, or not done: the answer itself is "no"
  acceptance_exists: 'unverified',
  acceptance_missing: 'unverified',
  acceptance_invalid: 'unverified',
  not_trusted: 'unverified',
  check_failed: 'unverified',
  pack_unverified: 'unverified',
  claim_refuted: 'unverified',
  claim_unverified: 'unverified',
  agent_blocked: 'unverified',
  no_claim: 'unverified',
  agent_failed: 'unverified',
  agent_timed_out: 'unverified',
  exec_interrupted: 'unverified',
  // 2: the command line is wrong (or the commands come in the wrong order)
  no_command: 'usage',
  unknown_command: 'usage',
  unknown_option: 'usage',
  unexpected_argument: 'usage',
  missing_value: 'usage',
  bad_value: 'usage',
  repeated_option: 'usage',
  missing_command_text: 'usage',
  bad_workspace: 'usage',
  bad_cwd: 'usage',
  no_session: 'usage',
  unsafe_argument: 'usage',
  bad_command: 'usage',
  // 3: recorded evidence does not verify, or bytes are not the ones named
  sha256_mismatch: 'integrity',
  ledger_broken: 'integrity',
  session_broken: 'integrity',
  session_edited: 'integrity',
  baseline_missing: 'integrity',
  baseline_edited: 'integrity',
  baseline_mismatch: 'integrity',
  baseline_bad_record: 'integrity',
  baseline_wrong_workspace: 'integrity',
  baseline_objects_missing: 'integrity',
  baseline_objects_mismatch: 'integrity',
  baseline_objects_unreadable: 'integrity',
  patch_does_not_reproduce: 'integrity',
  store_object_mismatch: 'integrity',
  // 4: this machine, this folder or this version of the CLI cannot do it
  not_built: 'environment',
  state_inside_workspace: 'environment',
  acceptance_outside: 'environment',
  not_a_repository: 'environment',
  repository_unreadable: 'environment',
  git_missing: 'environment',
  object_format_changed: 'environment',
  patch_too_large: 'environment',
  baseline_busy: 'environment',
  workspace_too_large: 'environment',
  workspace_changed: 'environment',
  shell_unavailable: 'environment',
  io_error: 'environment',
  internal_error: 'environment',
});

/** An answer that stops a command: its code, the facts the message and `detail` carry. */
export class CliStop extends Error {
  constructor(code, detail = {}) {
    super(code);
    if (!Object.hasOwn(CODES, code)) throw new TypeError(`unknown answer code ${code}`);
    this.code = code;
    this.detail = detail;
  }
}
export const stop = (code, detail) => new CliStop(code, detail);
