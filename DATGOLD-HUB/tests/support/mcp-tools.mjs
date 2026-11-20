// What the MCP client suites need besides the Hub: the client SDK (scripts/mcp-runtime, the same closure the installer stages), the real
// reference servers (tests/fixtures/mcp-reference), the process table (to prove that no server process is left), and an MCP client of
// their own, written here as plain JSON-RPC, that counts tools without the SDK under test.
//
// Both npm folders are installed by CI (.github/workflows/ci.yml) and by a developer with the two commands below. A suite that cannot find
// them prints CHATMCP_TEST_SKIP, which `run-all --no-skip all` turns into a failure. The mutation runner works on a copy of the Hub without
// node_modules (and without the scripts/ folder beside it); CHATMCP_MUTATION_SOURCE says where the original is, and both are looked for there.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { powerShellChildEnvironment, windowsPowerShellPath } from './powershell-environment.mjs';

export const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_SERVER = path.join(HUB, 'tests', 'fixtures', 'mcp-fixture-server.mjs');
export const RAW_SERVER = path.join(HUB, 'tests', 'fixtures', 'mcp-raw-server.mjs');
export const RUNTIME_INSTALL = 'npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/mcp-runtime';
export const REFERENCE_INSTALL = 'npm ci --ignore-scripts --no-audit --no-fund --prefix DATGOLD-HUB/tests/fixtures/mcp-reference';

const sources = () => [HUB, ...(process.env.CHATMCP_MUTATION_SOURCE ? [path.resolve(process.env.CHATMCP_MUTATION_SOURCE)] : [])];

/** The folder whose node_modules holds @modelcontextprotocol/client (scripts/mcp-runtime of this checkout), or null. */
export function runtimeRoot() {
  return sources().map((hub) => path.join(hub, '..', 'scripts', 'mcp-runtime'))
    .find((folder) => existsSync(path.join(folder, 'node_modules', '@modelcontextprotocol', 'client', 'package.json'))) ?? null;
}

/** tests/fixtures/mcp-reference with its node_modules, or null. */
export function referenceFolder() {
  return sources().map((hub) => path.join(hub, 'tests', 'fixtures', 'mcp-reference'))
    .find((folder) => existsSync(path.join(folder, 'node_modules', '@modelcontextprotocol', 'server-everything', 'package.json'))) ?? null;
}

export function missingReason() {
  const missing = [];
  if (!runtimeRoot()) missing.push(`the MCP client SDK (run: ${RUNTIME_INSTALL})`);
  if (!referenceFolder()) missing.push(`the MCP reference servers (run: ${REFERENCE_INSTALL})`);
  return missing.length ? `not installed: ${missing.join('; ')}` : null;
}

/** The entry file and the pinned version of one reference server. */
export function referenceServer(name) {
  const folder = path.join(referenceFolder(), 'node_modules', '@modelcontextprotocol', name);
  const manifest = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
  return { entry: path.join(folder, Object.values(manifest.bin)[0]), version: manifest.version };
}

/** The pinned versions of tests/fixtures/mcp-reference/package.json (what the lock file must hold too). */
export function referencePins() {
  return JSON.parse(readFileSync(path.join(HUB, 'tests', 'fixtures', 'mcp-reference', 'package.json'), 'utf8')).devDependencies;
}

/**
 * pid -> parent pid of every process of the machine (Windows: Win32_Process; Linux: /proc). `reader` is the pid of the PowerShell that read
 * the table on Windows: it (and the console host it may have) is a child of this process while it runs, and is not one of the processes
 * a suite asks about.
 */
export async function processTable() {
  const table = new Map();
  if (process.platform === 'win32') {
    let reader = null;
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { env: powerShellChildEnvironment(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, out) => (error ? reject(error) : resolve(out)));
      reader = child.pid;
    });
    for (const line of stdout.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid);
    }
    table.reader = reader;
    return table;
  }
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') continue; // a zombie has exited; only its entry is left until it is reaped
      table.set(Number(name), Number(fields[1]));
    } catch { /* gone meanwhile */ }
  }
  return table;
}

/**
 * Every process below `root` (by parent pid, never by name), and every process of `known` (pids the servers reported: an orphan of a dead
 * wrapper has no living parent to be found by) with what is below it. A known entry is {pid, ppid}. On Windows it counts only while that
 * pid still has that parent pid: Windows soon gives the pid of a process that has exited to another one, maybe of another program, and it
 * never changes the parent pid of an orphan. Linux gives an orphan a new parent instead and reuses pids only after the whole range, so
 * there the pid alone is the test.
 */
export async function descendants(root = process.pid, known = []) {
  const table = await processTable();
  const children = new Map();
  for (const [pid, ppid] of table) { if (!children.has(ppid)) children.set(ppid, []); children.get(ppid).push(pid); }
  const sameParent = (pid, ppid) => ppid === undefined || process.platform !== 'win32' || table.get(pid) === ppid;
  const alive = known.map((entry) => (typeof entry === 'number' ? { pid: entry } : entry))
    .filter(({ pid, ppid }) => table.has(pid) && sameParent(pid, ppid)).map(({ pid }) => pid);
  const found = new Set(alive);
  const queue = [root, ...alive];
  while (queue.length) {
    const next = queue.shift();
    for (const child of children.get(next) ?? []) if (child !== process.pid && child !== table.reader && !found.has(child)) { found.add(child); queue.push(child); }
  }
  return [...found].filter((pid) => table.has(pid));
}

/** The processes below this one that were not there in `baseline` (a list of pids taken before the servers started), known ones included. */
export async function newDescendants(baseline, known = []) {
  const before = new Set(baseline);
  const knownPids = new Set(known.map((entry) => (typeof entry === 'number' ? entry : entry.pid)));
  return (await descendants(process.pid, known)).filter((pid) => !before.has(pid) || knownPids.has(pid));
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(test, label, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await delay(50);
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** Lines of a counter file written by the fixtures ("call echo" ...). */
export function counterLines(file) {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

/** The JSON-RPC message of an HTTP answer, whether it came as JSON or as an SSE stream. */
async function rpcAnswer(response, id) {
  const body = await response.text();
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) return JSON.parse(body);
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data) continue;
    const message = JSON.parse(data);
    if (message.id === id) return message;
  }
  throw new Error('the stream carried no answer');
}

/**
 * An independent count of a Streamable HTTP server's tools, with fetch only. 2026-07-28: each request carries the _meta envelope and the
 * MCP-Protocol-Version and Mcp-Method headers, no session. 2025: initialize, then the session id on every request.
 */
export async function rawHttpToolsList({ url, protocolVersion, headers = {} }) {
  const modern = protocolVersion === '2026-07-28';
  const envelope = { 'io.modelcontextprotocol/protocolVersion': protocolVersion, 'io.modelcontextprotocol/clientInfo': { name: 'raw-count', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  let session = null;
  let next = 1;
  const post = async (method, params, { notification = false } = {}) => {
    const id = notification ? undefined : next++;
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(modern ? { 'mcp-protocol-version': protocolVersion, 'mcp-method': method } : {}), ...(!modern && session ? { 'mcp-session-id': session, 'mcp-protocol-version': protocolVersion } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params: modern ? { ...params, _meta: envelope } : params }),
    });
    session ??= response.headers.get('mcp-session-id');
    if (notification) { await response.arrayBuffer(); return null; }
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${await response.text()}`);
    const message = await rpcAnswer(response, id);
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  };
  if (!modern) {
    await post('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-count', version: '0' } });
    await post('notifications/initialized', {}, { notification: true });
  }
  const names = [];
  let cursor;
  do {
    const page = await post('tools/list', cursor === undefined ? {} : { cursor });
    names.push(...page.tools.map((tool) => tool.name));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  if (session) await fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session } }).catch(() => {});
  return names;
}

/** Starts a process that prints `listening <port>` (the fixture) or a line with ":<port>" (server-everything), and returns it with its port. */
export async function startHttpServer(command, args, { env = process.env, ready = /listening (\d+)|:(\d+)\b/ } = {}) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not start: ${output.slice(-500)}`)), 20_000);
    const look = (chunk) => {
      output += chunk;
      const match = ready.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1] ?? match[2])); }
    };
    child.stdout.setEncoding('utf8').on('data', look);
    child.stderr.setEncoding('utf8').on('data', look);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the server exited (${code}): ${output.slice(-500)}`)); });
  });
  return {
    child, port, url: `http://127.0.0.1:${port}/mcp`,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.race([exited, delay(5000)]);
    },
  };
}

/**
 * An independent count of a stdio server's tools: plain JSON-RPC, following nextCursor, in the era the client under test negotiated
 * (2026-07-28: requests carry the _meta envelope and no initialize; 2025: initialize, initialized, tools/list).
 */
export async function rawToolsList({ command, args = [], env = undefined, protocolVersion }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  lines.on('line', (line) => { try { const message = JSON.parse(line); waiting.get(message.id)?.(message); } catch { /* not ours */ } });
  let next = 1;
  const modern = protocolVersion === '2026-07-28';
  const envelope = { 'io.modelcontextprotocol/protocolVersion': protocolVersion, 'io.modelcontextprotocol/clientInfo': { name: 'raw-count', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 20_000);
    waiting.set(id, (message) => { clearTimeout(timer); waiting.delete(id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: modern ? { ...params, _meta: envelope } : params })}\n`);
  });
  try {
    if (!modern) {
      await request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-count', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    }
    const names = [];
    let cursor;
    do {
      const page = await request('tools/list', cursor === undefined ? {} : { cursor });
      names.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return names;
  } finally {
    child.stdin.end();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null) child.kill();
  }
}
