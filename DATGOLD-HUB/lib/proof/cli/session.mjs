// Where `chatmcp verify` keeps its state and how it reads a proof session back (docs/PROOF-CLI.md, "State"). Everything lives in the state
// folder (lib/manager.mjs defaultDataDirectory: CHATMCP_STATE_DIR, else the Hub's per-user data folder), never in the workspace:
//   <state>/proof/baselines/<key>/        the baselines (lib/proof/baseline.mjs)
//   <state>/proof/<taskId>.jsonl          the ledger of a session (lib/proof/ledger.mjs), its first record the session's task_start
//   <state>/proof/trusted-acceptance.json the trust store (lib/proof/trust-store.mjs)
//   <state>/proof/cli/<key>/              session.json (which session is current), the raw bytes of the acceptance file at the snapshot,
//                                         the last statement of each session, the snapshot and shell scratch folders
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultDataDirectory } from '../../manager.mjs';
import { StudioWorkspace } from '../../studio-workspace.mjs';
import { ACCEPTANCE_FILE } from '../acceptance.mjs';
import { workspaceKey } from '../baseline.mjs';
import { ledgerPath, sha256Hex, verifyChain } from '../ledger.mjs';
import { SESSION_FORMAT, stop } from './codes.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const TASK_ID = /^cli-(\d{8}T\d{9}Z-[0-9a-f]{8})$/;

/** The workspace folder: `--workspace` (or the current folder) as the file system names it, or bad_workspace. */
export async function resolveWorkspace(option, cwd) {
  const asked = path.resolve(cwd, option ?? '.');
  let root;
  try { root = await fs.realpath(asked); } catch { throw stop('bad_workspace', { path: asked }); }
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw stop('bad_workspace', { path: asked });
  return root;
}

/** The real path of `target`: the real path of its longest existing part, the rest as written (nothing is created to find it). */
async function realOrPlanned(target) {
  let existing = path.resolve(target);
  const rest = [];
  for (;;) {
    try { return path.join(await fs.realpath(existing), ...rest); } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

const caseFold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
const within = (outer, inner) => {
  const relative = path.relative(caseFold(outer), caseFold(inner));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/**
 * The state folder of the CLI for `root`. Refuses (state_inside_workspace) a state folder inside the workspace or a workspace inside the
 * state folder: the snapshot would then hold the state itself, and the CLI would write into the workspace.
 */
export async function stateOf(root, env) {
  const hubDir = await realOrPlanned(defaultDataDirectory(env));
  if (within(root, hubDir) || within(hubDir, root)) throw stop('state_inside_workspace', { stateFolder: hubDir, workspace: root });
  const key = workspaceKey(root);
  const folder = path.join(hubDir, 'proof', 'cli', key);
  return {
    hubDir, key, folder,
    session: path.join(folder, 'session.json'),
    treeState: path.join(folder, 'tree-state'),
    shellState: path.join(folder, 'shell'),
    studio: path.join(folder, 'studio'),
    acceptanceCopy: (taskId) => path.join(folder, `${taskId}.acceptance.yml`),
    statement: (taskId) => path.join(folder, `${taskId}.statement.json`),
  };
}

/**
 * The StudioWorkspace shim: the Hub's workspace class over a manager that is only {workspace, secrets}. The CLI uses its resolve() (the
 * workspace containment and symlink rules of the Hub) and hands it to ShellRunner. Its folder is in the state folder; nothing is written
 * there unless a Studio feature that writes is called, and the CLI calls none.
 */
export function workspaceShim(root, state) {
  return new StudioWorkspace({ manager: { workspace: root, secrets: [] }, directory: state.studio });
}

/**
 * The raw bytes of `.chatmcp/acceptance.yml` as they are on disk (the bytes the trust store hashes, docs/PROOF-ACCEPTANCE.md):
 * {state: 'present', bytes} for a regular file, {state: 'missing'} when there is none or it is not a regular file (a link, a folder),
 * {state: 'outside'} when the path leads out of the workspace.
 */
export async function readAcceptance(shim) {
  let target;
  try { target = await shim.resolve(ACCEPTANCE_FILE); } catch (error) {
    if (['outside_workspace', 'symlink_escape', 'alternate_stream', 'bad_path'].includes(error?.code)) return { state: 'outside' };
    throw error;
  }
  const stat = await fs.lstat(target.absolute).catch((error) => { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null; throw error; });
  if (!stat) return { state: 'missing', exists: false };
  if (!stat.isFile()) return { state: 'missing', exists: true };
  return { state: 'present', exists: true, bytes: await fs.readFile(target.absolute), absolute: target.absolute };
}

/** Writes `bytes` to `file` through a temporary file and a rename (the folder is created). */
export async function writeAtomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx' });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** The session pointer: which proof session of this workspace is current. */
export async function writeSession(state, { taskId, baselineId, root, startedAt }) {
  const record = { format: SESSION_FORMAT, taskId, baselineId, workspace: root, startedAt };
  await writeAtomic(state.session, `${JSON.stringify(record)}\n`);
}

/** The verified prefix of a ledger: its entries, parsed from the lines verifyChain accepted. */
function entriesOf(bytes, report) {
  return bytes.subarray(0, report.verifiedBytes).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * The current session of the workspace, checked: session.json names a task whose ledger verifies (a torn last line only when
 * `allowTorn`: the next append repairs it and records `uncertain`), whose first record is this session's task_start, and whose copy of the
 * acceptance file still has the sha256 that record names. Throws no_session (2), session_broken, ledger_broken or session_edited (3).
 */
export async function loadSession(state, { allowTorn = false } = {}) {
  let text;
  try { text = await fs.readFile(state.session, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') throw stop('no_session');
    throw error;
  }
  let session;
  try { session = JSON.parse(text); } catch { throw stop('session_broken', { why: 'session_file_not_json' }); }
  const id = TASK_ID.exec(String(session?.taskId ?? ''));
  if (session?.format !== SESSION_FORMAT || !id || session.baselineId !== id[1]) throw stop('session_broken', { why: 'session_file_not_a_session' });
  const { taskId, baselineId } = session;
  const file = ledgerPath(state.hubDir, taskId);
  const bytes = await fs.readFile(file).catch((error) => { if (error?.code === 'ENOENT') return Buffer.alloc(0); throw error; });
  const report = verifyChain(bytes);
  if (!report.ok && !(allowTorn && report.reason === 'torn_tail')) {
    throw stop('ledger_broken', { taskId, brokenAt: report.brokenAt, reason: report.reason });
  }
  const entries = entriesOf(bytes, report);
  const start = entries[0];
  const record = start?.type === 'task_start' ? start.record : null;
  if (!record || record.format !== SESSION_FORMAT || record.baselineId !== baselineId || typeof record.baselineSha256 !== 'string' || !HEX64.test(record.baselineSha256)) {
    throw stop('session_broken', { taskId, why: entries.length ? 'ledger_does_not_start_this_session' : 'ledger_missing' });
  }
  let acceptanceBytes = null;
  if (record.acceptance?.present === true) {
    acceptanceBytes = await fs.readFile(state.acceptanceCopy(taskId)).catch(() => null);
    if (!acceptanceBytes || sha256Hex(acceptanceBytes) !== record.acceptance.sha256) throw stop('session_edited', { taskId });
  }
  return { taskId, baselineId, anchor: record.baselineSha256, start: record, ledgerFile: file, ledgerBytes: bytes, report, entries, acceptanceBytes };
}
