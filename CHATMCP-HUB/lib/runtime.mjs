import fs from 'node:fs/promises';
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

export function collectSecrets(value) {
  const secrets = new Set();
  function walk(v, key = '') {
    if (typeof v === 'string' && /authorization|token|secret|password|api.?key/i.test(key)) {
      if (v.length >= 4) secrets.add(v);
      const bare = v.replace(/^Bearer\s+/i, '');
      if (bare.length >= 4) secrets.add(bare);
    }
    if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        if (key.toLowerCase() === 'headers' && typeof item === 'string' && item.length >= 4) secrets.add(item);
        walk(item, k);
      }
    }
  }
  walk(value);
  return [...secrets].sort((a, b) => b.length - a.length);
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

export async function resolveProgram(name, extra = []) {
  const entries = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).map((p) => p.replace(/^"|"$/g, ''));
  const candidates = [...extra, ...entries.filter(Boolean).map((p) => path.join(p, name))];
  for (const file of candidates) if (await exists(file)) return path.resolve(file);
  return null;
}

export async function npmCli() {
  const besideNode = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmCmd = await resolveProgram(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const candidates = [
    besideNode,
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(npmCmd ? [path.join(path.dirname(npmCmd), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : []),
  ];
  if (npmCmd && process.platform !== 'win32') candidates.push(await fs.realpath(npmCmd));
  for (const file of candidates) if (await exists(file)) return path.resolve(file);
  throw new Error('Không tìm thấy npm-cli.js của Node.js. Hãy kiểm tra bản cài Node/npm.');
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

export function spawnLogged(command, args, { cwd, log = () => {}, timeout = 0, quiet = false } = {}) {
  const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

export async function stopOwned(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // This PID is a still-live ChildProcess created by this hub, never a PID
    // discovered from a port scan. Its stdio MCP children belong to this proxy.
    const taskkill = await resolveProgram('taskkill.exe');
    if (!taskkill) throw new Error('Không tìm thấy taskkill.exe để dừng tiến trình Hub đang quản lý.');
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
