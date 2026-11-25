import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

export async function readJson(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`File JSON không hợp lệ: ${file}. Hãy kiểm tra file trên máy.`); }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

export function redact(line, secrets = []) {
  let result = String(line).replace(/\u001b\[[0-9;]*m/g, '');
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  if (/authorization|\bbearer\b|_authToken/i.test(result)) return '[Đã ẩn thông tin xác thực]';
  // Proxy info/debug JSON packets can contain full file contents. Never forward
  // those packets to dashboard logs even if an upstream log level changes.
  if (/"jsonrpc"\s*:|getConfig result:|Current configuration:/.test(result)) return '[Đã ẩn nội dung gói MCP]';
  return result.slice(0, 1800);
}

/** Whether `target` is `folder` or lies below it. */
const isWithin = (folder, target) => {
  const relative = path.relative(folder, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
/** A program: a regular file (a link to one counts), which may be executed where a mode says so. */
async function isProgramFile(file) {
  try {
    if (!(await fs.stat(file)).isFile()) return false;
    if (process.platform !== 'win32') await fs.access(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * The absolute path of the program `name` (with its extension): the first of `extra` (absolute paths the caller knows) that is there, else the one on PATH; null when
 * there is none. Only the absolute entries of PATH are read: a relative one would mean another folder for every process. `outside` is the workspace, when there is
 * one: an entry or a program that is below it, or leads there, is not taken (a workspace that holds the person's own profile takes nothing away: their programs are in it).
 */
export async function resolveProgram(name, extra = [], { outside = null } = {}) {
  const entries = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).map((entry) => entry.trim().replace(/^"(.*)"$/, '$1')).filter((entry) => path.isAbsolute(entry));
  const real = async (target) => fs.realpath(target).catch(() => path.resolve(target));
  // The workspace as it was named and as it really is: an entry below it by either spelling is below it, wherever a link there leads.
  let workspaces = typeof outside === 'string' && outside ? [path.resolve(outside), await real(outside)] : [];
  const home = await real(os.homedir());
  if (workspaces.some((folder) => isWithin(folder, home) || isWithin(folder, os.homedir()))) workspaces = [];
  const below = (file) => workspaces.some((folder) => isWithin(folder, file));
  for (const file of extra) if (await isProgramFile(file)) return path.resolve(file);
  for (const entry of entries) {
    const file = path.resolve(entry, name);
    if (below(file) || !(await isProgramFile(file)) || below(await real(file))) continue;
    return file;
  }
  return null;
}

/**
 * A program on PATH by its plain name ("git": git.exe on Windows), as an absolute path, or null when it is not installed. A program is never started by its bare name:
 * which file that is would depend on the folder it is started in (tests/verify-program-paths.mjs; the lint in tests/verify-source-lint.mjs).
 */
export function programOnPath(name, { outside = null } = {}) {
  return resolveProgram(process.platform === 'win32' && !/\.exe$/i.test(name) ? `${name}.exe` : name, [], { outside });
}
/** The absolute path of a program of Windows itself (taskkill.exe, icacls.exe ...). */
export const systemProgram = (name) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);

// The variable that tells Windows not to look for a program in a working folder. The Hub and the command line set it for themselves, which covers what they start; a helper
// program that starts others by name (a language server, gh) gets it too (helperEnvironment). A shell gets it as the owner had it (shellSearch): what a command of
// the owner or of the agent finds in its folder is not the Hub's to change.
const SEARCH_VARIABLE = 'NoDefaultCurrentDirectoryInExePath';
const withoutSearchVariable = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== SEARCH_VARIABLE.toUpperCase()));
let ownersSearch = null;
/** From now on this process looks for the programs it starts on PATH only (Windows; elsewhere that is so anyway). */
export function searchProgramsOnPathOnly() {
  if (process.platform !== 'win32') return;
  ownersSearch ??= { value: process.env[SEARCH_VARIABLE] };
  process.env[SEARCH_VARIABLE] = '1';
}
/** The environment of a helper program: `env` with the search variable set (Windows). */
export const helperEnvironment = (env = process.env) => (process.platform === 'win32' ? { ...withoutSearchVariable(env), [SEARCH_VARIABLE]: '1' } : { ...env });
/** `env` with the search variable set, unless it already has a value for it. */
export const withSearchVariable = (env) => (Object.keys(env).some((key) => key.toUpperCase() === SEARCH_VARIABLE.toUpperCase()) ? env : { ...env, [SEARCH_VARIABLE]: '1' });
/** The environment of a shell: `env` with the search variable as the owner's environment had it when this process started. */
export function shellSearch(env) {
  if (ownersSearch === null) return env;
  const out = withoutSearchVariable(env);
  return ownersSearch.value === undefined ? out : { ...out, [SEARCH_VARIABLE]: ownersSearch.value };
}

export function portOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let done = false;
    function finish(value) { if (done) return; done = true; socket.destroy(); resolve(value); }
    socket.setTimeout(timeout, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
}

export function spawnLogged(command, args, { cwd, env, log = () => {}, timeout = 0, quiet = false, windowsHide = true } = {}) {
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let bytes = 0;
  let timer;
  function capture(stream) {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (data) => {
      if (bytes < 2_000_000) { chunks.push(data); bytes += Buffer.byteLength(data); }
      buffered += data;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop();
      if (!quiet) for (const line of lines) if (line.trim()) log(line);
    });
    stream.on('end', () => { if (!quiet && buffered.trim()) log(buffered); });
  }
  capture(child.stdout);
  capture(child.stderr);
  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: chunks.join('') });
    });
    if (timeout > 0) timer = setTimeout(() => { void stopOwned(child); }, timeout);
  });
  return { child, completion };
}

export async function run(command, args, options = {}) {
  const result = await spawnLogged(command, args, options).completion;
  if (result.code !== 0) {
    const error = new Error(`Tiến trình ${path.basename(command)} dừng với mã ${result.code ?? result.signal}. Xem nhật ký bên dưới.`);
    error.result = result;
    throw error;
  }
  return result.output;
}

/**
 * Stops a child this process started, and what it started. `group: true` is for a child spawned detached on POSIX, where it leads
 * a process group of its own: the whole group is killed at once, because a script that ignores SIGTERM would otherwise leave its
 * descendants behind. On Windows the tree below the child is always killed (taskkill /T).
 */
export async function stopOwned(child, { group = false } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' && group) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    return;
  }
  if (process.platform === 'win32') {
    // This PID is a still-live ChildProcess created by this hub, never a PID
    // discovered from a port scan. Its stdio MCP children belong to this proxy.
    const taskkill = systemProgram('taskkill.exe');
    if (!(await exists(taskkill))) throw new Error('Không tìm thấy taskkill.exe để dừng tiến trình Hub đang quản lý.');
    await new Promise((resolve, reject) => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('exit', () => resolve());
    });
  } else {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
