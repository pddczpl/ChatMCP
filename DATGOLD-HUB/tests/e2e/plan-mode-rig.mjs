// What the hostile plan-mode suites (tests/verify-plan-mode-*.mjs, P9 ac-12) share: a workspace whose every file is hashed before and after, programs that
// leave a mark when anybody starts them, a scripted model that answers step by step and can be held, an audit of the processes a suite started, and the
// calls the suites make on a real Hub (tests/e2e/hub-process.mjs). Nothing here decides what is allowed: a suite asserts it, next to the thing it attacks.
//
// The evidence of a suite is never the model's text: it is the bytes of the workspace (every file, .git included), Git's own status, HEAD, refs and
// index, the gate's permission history and pending requests as the Hub reports them, the marks of started programs and the process table.
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanEnvironment, settledTask, waitFor } from './hub-process.mjs';
import { say } from './scenarios.mjs';
import { powerShellChildEnvironment, windowsPowerShellPath } from '../support/powershell-environment.mjs';

const WIN = process.platform === 'win32';
export const PLAN_TEXT = '1. Read src/app.js.\n2. Add a test for answer.\n3. Rename answer to theAnswer.';

// ---------------------------------------------------------------------------------------------------------------- workspaces and what they hold

export function git(cwd, scratch, ...args) {
  const result = spawnSync('git', args, { cwd, env: cleanEnvironment(scratch, { GIT_OPTIONAL_LOCKS: '0' }), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

export function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** A repository with one commit, a second branch and a feature commit to merge, so that every Git tool has something it could really change. */
export function makeRepo(scratch, name, files = {}) {
  const root = path.join(scratch, name);
  writeFiles(root, { 'README.md': '# fixture\n', 'src/app.js': 'export const answer = 42;\n', 'package.json': '{"name":"fixture","private":true}\n', ...files });
  const run = (...args) => git(root, scratch, ...args);
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'E2E Tester');
  run('config', 'user.email', 'e2e@example.invalid');
  run('config', 'core.autocrlf', 'false');
  run('add', '-A');
  run('commit', '-q', '-m', 'fixture');
  run('checkout', '-q', '-b', 'feature');
  writeFiles(root, { 'feature.txt': 'feature\n' });
  run('add', '-A');
  run('commit', '-q', '-m', 'feature');
  run('checkout', '-q', 'main');
  return root;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every entry under `root` (.git included): its kind, its mode on POSIX, and the hash of its bytes. */
export function hashEveryFile(root) {
  const out = new Map();
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { out.set(relative, `link ${fs.readlinkSync(full)}`); continue; }
      const stat = fs.lstatSync(full);
      const mode = WIN ? '' : ` ${(stat.mode & 0o7777).toString(8)}`;
      if (entry.isDirectory()) { out.set(`${relative}/`, `dir${mode}`); walk(full, relative); } else if (entry.isFile()) out.set(relative, `file${mode} ${stat.size} ${sha(fs.readFileSync(full))}`);
      else out.set(relative, 'other');
    }
  };
  walk(root, '');
  return out;
}

/** The whole workspace: every file, and what Git says of it. `ignore` drops paths by prefix (a second chat's worktree is made under .git by the Hub). */
export function fingerprint(root, scratch, { ignore = [], refs = null } = {}) {
  const files = hashEveryFile(root);
  for (const key of [...files.keys()]) if (ignore.some((prefix) => key === prefix || key.startsWith(prefix))) files.delete(key);
  const keepRef = refs ?? (() => true);
  return {
    files,
    status: git(root, scratch, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
    head: `${git(root, scratch, 'rev-parse', 'HEAD').trim()} ${git(root, scratch, 'symbolic-ref', '-q', 'HEAD').trim()}`,
    refs: git(root, scratch, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter((line) => line && keepRef(line)).join('\n'),
    index: git(root, scratch, 'ls-files', '--stage'),
  };
}

/** What differs between two fingerprints, as sentences ([] when nothing does). */
export function differences(before, after) {
  const out = [];
  for (const [name, value] of before.files) { if (!after.files.has(name)) out.push(`deleted ${name}`); else if (after.files.get(name) !== value) out.push(`changed ${name}`); }
  for (const name of after.files.keys()) if (!before.files.has(name)) out.push(`created ${name}`);
  for (const key of ['status', 'head', 'refs', 'index']) if (before[key] !== after[key]) out.push(`git ${key}: ${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- programs that leave a mark

/**
 * A folder outside the workspace where a program that was started leaves one file per start. `command(label)` is the text of a shell command that would leave
 * one; `seen()` are the labels that were left, so "no process of a refused call ever started" is `seen()` being empty.
 */
export function markers(scratch, name = 'marks') {
  const directory = path.join(scratch, name);
  const script = path.join(scratch, `${name}-program.mjs`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(script, `import fs from 'node:fs';\nimport path from 'node:path';\nimport { randomUUID } from 'node:crypto';\nfs.writeFileSync(path.join(${JSON.stringify(directory)}, process.argv[2] + '.' + randomUUID()), process.execPath);\n`);
  const slash = (value) => value.replaceAll('\\', '/');
  return {
    directory, script,
    command: (label) => `node "${slash(script)}" ${label}`,
    /** JavaScript (CommonJS) that leaves the mark `label` when it is run. */
    source: (label) => `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(directory)}, ${JSON.stringify(`${label}.`)} + require('node:crypto').randomUUID()), process.execPath);\n`,
    seen: () => fs.readdirSync(directory).map((file) => file.slice(0, file.lastIndexOf('.'))).sort(),
    clear: () => { for (const file of fs.readdirSync(directory)) fs.rmSync(path.join(directory, file)); },
  };
}

/**
 * A stand-in for a command line tool: it leaves a mark named after itself whatever its arguments are, and prints nothing. On Windows it is compiled with the C#
 * compiler every Windows has (.NET Framework); elsewhere it is a shell script.
 */
export async function makeMarkingProgram(scratch, directory, target) {
  if (!WIN) { fs.writeFileSync(target, `#!/bin/sh\nn=$(basename "$0")\nprintf '%s' "$0" > "${directory}/$n.$$-$(date +%s%N)"\n`, { mode: 0o755 }); return target; }
  const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const source = path.join(scratch, 'marking-program.cs');
  fs.writeFileSync(source, `\ufeffusing System; using System.IO; class P { static int Main() { string me = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName; File.WriteAllText(Path.Combine(@"${directory}", Path.GetFileNameWithoutExtension(me) + "." + Guid.NewGuid().ToString()), me); return 0; } }\n`);
  await run(compiler, ['/nologo', '/target:exe', `/out:${target}`, source], {});
  return target;
}

// ---------------------------------------------------------------------------------------------------------------- the process table

function run(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/**
 * The running processes whose command line holds `needle` (the random name of a scratch folder: no other process has it), each with the time it was created.
 * A process is told by {pid, created}: a pid alone may be somebody else's a moment later (Windows uses them again at once).
 */
export async function processesNaming(needle) {
  const own = process.pid;
  if (WIN) {
    const script = '$n=$env:RIG_NEEDLE; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine,Name | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($n) } | ForEach-Object { "{0}|{1}|{2}|{3}|{4}" -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().Ticks,$_.Name,$_.CommandLine }';
    const text = await run(windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...powerShellChildEnvironment(process.env), RIG_NEEDLE: needle } });
    return text.split(/\r?\n/).filter(Boolean).map((line) => { const [pid, ppid, created, name, ...rest] = line.split('|'); return { pid: Number(pid), ppid: Number(ppid), created, name, command: rest.join('|') }; }).filter((row) => row.pid !== own);
  }
  const text = await run('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { env: { ...process.env, LC_ALL: 'C' } });
  return text.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)).filter((row) => row && row[4].includes(needle))
    .map((row) => ({ pid: Number(row[1]), ppid: Number(row[2]), created: row[3], name: path.basename(row[4].split(' ')[0]), command: row[4] })).filter((row) => row.pid !== own && !/^ps\b/.test(row.command));
}

export const sameProcess = (a, b) => a.pid === b.pid && a.created === b.created;

// ---------------------------------------------------------------------------------------------------------------- the scripted model

/** A promise that the test settles: `hold.promise`, `hold.release(value)`. */
export function hold() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

/**
 * A model that obeys a script per conversation. The owner's message names the script, `[[name]]`; each model request of a conversation whose latest named message is
 * `name` takes the next step of `steps[name]` (a step, or a function of the context that may wait), then `say('Done.')`. `asked(name)` are the contexts of those
 * requests, in order, so that a suite sees what the model was given. A request the Hub repeats after an error would take a step; these Hubs have no reason to.
 */
export function scriptedModel() {
  const scripts = new Map();
  const taken = new Map();
  const contexts = new Map();
  const nameOf = (users) => {
    for (const text of [...users].reverse()) {
      const found = [...text.matchAll(/\[\[([\w-]+)\]\]/g)].at(-1);
      if (found) return found[1];
    }
    return null;
  };
  const scenario = async (ctx) => {
    const name = nameOf(ctx.users);
    const steps = scripts.get(name);
    if (!steps) return say('No script.');
    const at = taken.get(name) ?? 0;
    taken.set(name, at + 1);
    contexts.get(name).push(ctx);
    const step = steps[at];
    if (step === undefined) return say('Done.');
    return typeof step === 'function' ? step(ctx) : step;
  };
  return {
    scenario,
    script(name, steps) { scripts.set(name, steps); taken.set(name, 0); contexts.set(name, []); },
    asked: (name) => contexts.get(name) ?? [],
    requests: (name) => (contexts.get(name) ?? []).length,
  };
}

/** A model call whose arguments are sent exactly as `text` (they need not be JSON, or an object). */
export const rawCall = (name, text) => ({ calls: [{ name, argumentsText: text }] });

// ---------------------------------------------------------------------------------------------------------------- a Hub, the way the page calls it

export const start = async (hub, prompt, body = {}) => {
  const response = await hub.request('POST', '/api/tasks/start', { prompt, ...body });
  if (response.status !== 200) throw new Error(`start -> ${response.status}: ${response.text.slice(0, 300)}`);
  return response.json.task;
};
export const tryStart = (hub, prompt, body = {}) => hub.request('POST', '/api/tasks/start', { prompt, ...body });
export const tryContinue = (hub, id, prompt, body = {}) => hub.request('POST', '/api/tasks/continue', { id, prompt, ...body });
export const resume = async (hub, id, prompt, body = {}) => {
  const response = await tryContinue(hub, id, prompt, body);
  if (response.status !== 200) throw new Error(`continue -> ${response.status}: ${response.text.slice(0, 300)}`);
  return response.json.task;
};
export const permissions = async (hub) => (await hub.state()).studio.permissions;
export const pendingOf = async (hub, taskId) => (await permissions(hub)).pending.filter((item) => item.taskId === taskId);
/** The rows of the gate's history about one task, as {toolName, decision, category} in order. */
export const historyOf = async (hub, taskId) => (await permissions(hub)).recent.filter((row) => row.taskId === taskId).map(({ toolName, decision, category }) => ({ toolName, decision, category }));
export const decide = (hub, body) => hub.request('POST', '/api/studio/plan/decide', body);
export const answer = (hub, body) => hub.request('POST', '/api/studio/permissions/decide', body);
export const planOf = async (hub, taskId) => (await hub.get(`/api/studio/plan?taskId=${taskId}`)).json;
export const tryMode = (hub, body) => hub.request('POST', '/api/studio/permissions/config', body);

/** The plan request the task waits with. */
export const waitPlan = (hub, taskId, { not = null, timeoutMs = 30_000 } = {}) => waitFor(async () => (await pendingOf(hub, taskId)).find((item) => item.category === 'plan' && item.id !== not),
  { timeoutMs, intervalMs: 40, label: `the plan request of ${taskId.slice(0, 8)}` });
/** Any request of the task that is not a plan request. */
export const waitAsk = (hub, taskId, test = () => true, { timeoutMs = 30_000 } = {}) => waitFor(async () => (await pendingOf(hub, taskId)).find((item) => item.category !== 'plan' && test(item)),
  { timeoutMs, intervalMs: 40, label: `a question of ${taskId.slice(0, 8)}` });
/** The task at rest (and the Hub no longer holding it). */
export const waitRest = (hub, taskId, { timeoutMs = 40_000 } = {}) => waitFor(async () => settledTask(await hub.state(), taskId), { timeoutMs, intervalMs: 40, label: `task ${taskId.slice(0, 8)} to rest` });

/** The plan file of a task, wherever the studio that runs it keeps it (a chat beside another has a state folder of its own). */
export function planFile(hub, taskId) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'worktree' && entry.name !== 'checkpoints') walk(full); } else if (entry.name.toLowerCase() === `${taskId.toLowerCase()}.json` && path.basename(directory) === 'plans') found.push(full);
    }
  };
  walk(hub.stateDir);
  if (found.length !== 1) throw new Error(`${found.length} plan files of ${taskId}`);
  return found[0];
}
/** The files of one task in the Hub's data folder. */
export function taskFiles(hub, taskId) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(directory, entry.name);
      if (entry.name === taskId && fs.existsSync(path.join(full, 'task.json'))) found.push(full);
      else if (entry.name !== 'worktree' && entry.name !== 'checkpoints') walk(full);
    }
  };
  walk(hub.stateDir);
  if (found.length !== 1) throw new Error(`${found.length} task folders of ${taskId}`);
  return { folder: found[0], json: path.join(found[0], 'task.json'), transcript: path.join(found[0], 'transcript.jsonl'), read: () => JSON.parse(fs.readFileSync(path.join(found[0], 'task.json'), 'utf8')) };
}

/** The same task id in the other case, as a careless or hostile client may spell it (an id of digits only has no other case). */
export const otherCase = (id) => (id === id.toUpperCase() ? id.toLowerCase() : id.toUpperCase());

export const freshName = () => `x-${randomUUID().slice(0, 8)}`;
