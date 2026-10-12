import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArguments } from '../hub.mjs';
import { delay, portOpen, redact } from './runtime.mjs';

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function health(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function openBrowser(url, log) {
  if (process.platform !== 'win32') { log(`[CHATMCP-HUB] ${url}`); return; }
  const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(command, ['url.dll,FileProtocolHandler', url], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// Quote one argument the way CreateProcess expects (backslashes only matter in front of a quote).
export function quoteWindowsArgument(value) {
  const text = String(value);
  if (text !== '' && !/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/**
 * Start the Hub so that it outlives this launcher AND holds none of the launcher's handles.
 *
 * On Windows a child created with CreateProcess inherits every inheritable handle of its parent, including the pipe
 * a caller (CI step, IDE task, `$out = & START-CHATMCP-HUB.cmd`, a test) uses to capture the launcher's output. That
 * pipe then stays open until the Hub exits and the caller waits for it. Starting the Hub through PowerShell's
 * Start-Process (ShellExecute) does not pass those handles. The Hub writes its own log (--log-file) because it has no
 * pipe left to write to.
 *
 * @returns {Promise<{pid: number|null, exited: () => boolean}>}
 */
async function startHubDetached(args, logFile) {
  const hub = path.join(bundle, 'hub.mjs');
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = '$p = Start-Process -FilePath $env:CHATMCP_SPAWN_FILE -ArgumentList $env:CHATMCP_SPAWN_ARGS -WorkingDirectory $env:CHATMCP_SPAWN_CWD -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)';
    const launched = await new Promise((resolve) => {
      let output = '';
      let child;
      try {
        child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
          shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, CHATMCP_SPAWN_FILE: process.execPath, CHATMCP_SPAWN_ARGS: [hub, ...args, '--log-file', logFile].map(quoteWindowsArgument).join(' '), CHATMCP_SPAWN_CWD: bundle },
        });
      } catch { resolve(null); return; }
      const timer = setTimeout(() => { child.kill(); resolve(null); }, 30000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.once('error', () => { clearTimeout(timer); resolve(null); });
      child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 && /^\d+$/.test(output.trim()) ? Number(output.trim()) : null); });
    });
    if (launched) return { pid: launched, exited: () => !processAlive(launched) };
    // PowerShell could not start it. Fall back to a direct start, which works but lets the Hub keep inherited pipes.
  }
  const out = await fs.open(logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [hub, ...args], { cwd: bundle, shell: false, detached: true, windowsHide: true, stdio: ['ignore', out.fd, out.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await out.close(); }
  return { pid: child.pid ?? null, exited: () => child.exitCode !== null || child.signalCode !== null };
}

/** Per-user local Hub state directory. */
export function hubDirectoryFor(options) {
  if(options.stateDir)return options.stateDir;
  throw new Error('Không xác định được state directory. Specify --state-dir.');
}

/**
 * Start the Hub in the background (or reuse the one that already owns the
 * port) and return once it answers its health check.
 *
 * @returns {Promise<{url: string, reused: boolean, backend: string, logFile: string|null, pid: number|null}>}
 */
export async function launch(args = process.argv.slice(2), { log = console.log, warn = console.error } = {}) {
  const options = parseArguments(args);
  const backend = 'local';
  const url = `http://127.0.0.1:${options.port}`;
  const running = await health(url);
  if (running?.app === 'chatmcp-local-hub') {
    const deadline = Date.now() + 30000;
    while (!(await health(url))?.initialized) {
      if (Date.now() >= deadline) throw new Error('Hub chưa nạp xong cấu hình. Xem hub.log rồi mở lại launcher.');
      await delay(250);
    }
    if(running.backend&&running.backend!=='local')
      throw new Error('A legacy MCP Hub is using this port. Stop it explicitly; do not reuse it.');
    if (options.project) {
      const state = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000), redirect: 'error' }).then((r) => r.json());
      if (state.workspace?.path !== options.project) {
        const response = await fetch(`${url}/api/workspace/select`, {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', Origin: url, 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': state.csrfToken },
          body: JSON.stringify({ path: options.project }),
        });
        if (!response.ok) log(`[CHATMCP-HUB] ${(await response.json()).error ?? 'Chưa đổi workspace.'}`);
      }
    }
    if (options.open) {
      await openBrowser(url, log);
      log('[CHATMCP-HUB] Hub da chay nen. Da mo lai trang localhost.');
    } else {
      log(`[CHATMCP-HUB] Hub da chay nen: ${url}`);
    }
    return { url, reused: true, backend: running.backend ?? backend, logFile: null, pid: null };
  }
  if (await portOpen(options.port)) throw new Error(`Cong ${options.port} dang do ung dung khac su dung. Khong tu dung ung dung do.`);
  const directory = hubDirectoryFor(options);
  await fs.mkdir(directory, { recursive: true });
  const logFile = path.join(directory, 'hub.log');
  // Rotate only this app's own log; never touch project files or other logs.
  try { if ((await fs.stat(logFile)).size > 4_000_000) await fs.rename(logFile, path.join(directory, 'hub.previous.log')); }
  catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  const started = await startHubDetached(args, logFile);
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const ready = await health(url);
    if (ready?.app === 'chatmcp-local-hub' && ready.initialized) {
      log(`[CHATMCP-HUB] Dang chay nen: ${url}`);
      log('[CHATMCP-HUB] Local Node.js Hub. Configure your AI model and choose a workspace in the dashboard.');
      return { url, reused: false, backend, logFile, pid: started.pid };
    }
    if (started.exited()) break;
    await delay(250);
  }
  const recent = await fs.readFile(logFile, 'utf8').catch(() => '');
  for (const line of recent.split(/\r?\n/).slice(-8)) if (line) warn(redact(line));
  throw new Error(`Hub chua mo duoc. Xem nhat ky ${logFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  launch().catch((error) => { console.error(`[CHATMCP-HUB] ${error.message}`); process.exitCode = 1; });
}
