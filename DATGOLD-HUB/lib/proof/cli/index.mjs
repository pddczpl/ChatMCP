// `chatmcp verify`: the command line of Proof-of-Done (P4 pod-24, docs/PROOF-CLI.md). bin/chatmcp.mjs calls main(). The CLI makes no
// network call and writes into the workspace only where `init` is meant to (.chatmcp/acceptance.yml); its state is in the state folder.
import { CLI_FORMAT, CODES, CliStop, EXIT } from './codes.mjs';
import { languageOf, parseArgs } from './args.mjs';
import { messageOf } from './messages.mjs';
import { COMMAND_TABLE } from './commands.mjs';

export { CLI_FORMAT, CODES, COMMANDS, EXIT, SESSION_FORMAT } from './codes.mjs';
export { MESSAGES, usage } from './messages.mjs';
export { CLI_DATA_SCHEMAS, CLI_OUTPUT_SCHEMA } from './schema.mjs';
export { compileClaimMarker, joinCommand, parseArgs } from './args.mjs';

// What the modules the CLI calls throw, as answer codes (a code of the modules that is also an answer code keeps its name).
const MODULE_CODES = Object.freeze({
  no_shell: 'shell_unavailable',
  spawn_failed: 'shell_unavailable',
  bad_shell: 'bad_value',
  baseline_bad_id: 'session_broken',
  baseline_bad_anchor: 'session_broken',
  ledger_bad_task: 'session_broken',
  baseline_store_mismatch: 'baseline_objects_mismatch',
});
const MODULE_PASSTHROUGH = new Set(['baseline_missing', 'baseline_edited', 'baseline_mismatch', 'baseline_bad_record', 'baseline_wrong_workspace', 'baseline_busy',
  'workspace_too_large', 'workspace_changed', 'ledger_broken', 'git_missing']);
const FILE_SYSTEM = /^E[A-Z]+$/;

/** The answer for an error: a CliStop as it is; a module's own code mapped; a file system error io_error; anything else internal_error. */
function answerForError(error, ctx) {
  if (error instanceof CliStop) return { code: error.code, detail: error.detail };
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = String(error?.message ?? error).slice(0, 1000);
  const known = { taskId: ctx.taskId ?? null, baselineId: ctx.baselineId ?? null, message };
  if (MODULE_PASSTHROUGH.has(code)) return { code, detail: { ...known, ...(code === 'ledger_broken' ? { brokenAt: null, reason: 'append_refused' } : {}) } };
  if (Object.hasOwn(MODULE_CODES, code)) {
    const mapped = MODULE_CODES[code];
    return { code: mapped, detail: mapped === 'session_broken' ? { ...known, why: code } : mapped === 'bad_value' ? { option: '--shell', value: null, expected: 'bash, sh, powershell' } : known };
  }
  if (FILE_SYSTEM.test(code)) return { code: 'io_error', detail: { message } };
  return { code: 'internal_error', detail: { message } };
}

const write = (stream, text) => new Promise((resolve) => { if (!text) resolve(); else stream.write(text, () => resolve()); });
const line = (text) => (text.endsWith('\n') ? text : `${text}\n`);

/**
 * Runs one command line and writes its answer: with --json exactly one JSON object on one line on stdout (nothing on stderr), else text
 * (a pass or a "no" on stdout, a refusal on stderr; exec also passes the agent's output on as it comes). `signals` is where exec listens
 * for Ctrl-C (SIGINT), SIGTERM and Ctrl-Break: the process, or an emitter a test fires. Resolves with the exit code.
 */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), now = () => new Date(), signals = process } = {}) {
  const head = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  const ctx = { env, cwd, now, args: null, root: null, lang: languageOf(argv), json: head.includes('--json'), stdout, stderr, signals };
  let answer;
  try {
    ctx.args = parseArgs(argv);
    Object.assign(ctx, { lang: ctx.args.lang, json: ctx.args.json });
    answer = await COMMAND_TABLE[ctx.args.command](ctx);
  } catch (error) {
    answer = answerForError(error, ctx);
  }
  const outcome = CODES[answer.code];
  const exitCode = EXIT[outcome];
  const detail = answer.detail && Object.keys(answer.detail).length ? answer.detail : null;
  const message = messageOf(answer.code, ctx.lang, { ...(answer.params ?? {}), ...(detail ?? {}) });
  if (ctx.json) {
    const envelope = {
      format: CLI_FORMAT, command: ctx.args?.command ?? null, exitCode, outcome, code: answer.code, message, lang: ctx.lang, workspace: ctx.root,
      data: exitCode <= EXIT.unverified ? (answer.data ?? null) : null, detail,
    };
    await write(stdout, `${JSON.stringify(envelope)}\n`);
    return exitCode;
  }
  await write(stdout, answer.stdout ?? '');
  await write(stderr, answer.stderr ? line(answer.stderr) : '');
  if (!answer.quiet) {
    const text = [message, ...(answer.lines ?? [])].join('\n');
    await write(exitCode <= EXIT.unverified ? stdout : stderr, line(text));
  }
  return exitCode;
}
