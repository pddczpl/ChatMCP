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

async function openBrowser(url) {
  if (process.platform !== 'win32') { console.log(`[CHATMCP-HUB] ${url}`); return; }
  const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(command, ['url.dll,FileProtocolHandler', url], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function launch(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const url = `http://127.0.0.1:${options.port}`;
  const running = await health(url);
  if (running?.app === 'chatmcp-local-hub') {
    const deadline = Date.now() + 30000;
    while (!(await health(url))?.initialized) {
      if (Date.now() >= deadline) throw new Error('Hub chưa nạp xong cấu hình. Xem hub.log rồi mở lại launcher.');
      await delay(250);
    }
    if (options.project) {
      const state = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000), redirect: 'error' }).then((r) => r.json());
      if (state.workspace?.path !== options.project) {
        const response = await fetch(`${url}/api/workspace/select`, {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', Origin: url, 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': state.csrfToken },
          body: JSON.stringify({ path: options.project }),
        });
        if (!response.ok) console.log(`[CHATMCP-HUB] ${(await response.json()).error ?? 'Chưa đổi workspace.'}`);
      }
    }
    await openBrowser(url);
    console.log('[CHATMCP-HUB] Hub da chay nen. Da mo lai trang localhost.');
    return;
  }
  if (await portOpen(options.port)) throw new Error(`Cong ${options.port} dang do ung dung khac su dung. Khong tu dung ung dung do.`);
  const directory = path.join(path.resolve(options.repoRoot), 'deploy', '.generated', 'chatmcp-hub');
  await fs.mkdir(directory, { recursive: true });
  const logFile = path.join(directory, 'hub.log');
  // Rotate only this app's own log; never touch project files or other logs.
  try { if ((await fs.stat(logFile)).size > 4_000_000) await fs.rename(logFile, path.join(directory, 'hub.previous.log')); }
  catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  const out = await fs.open(logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [path.join(bundle, 'hub.mjs'), ...args], {
      cwd: bundle, shell: false, detached: true, windowsHide: true,
      stdio: ['ignore', out.fd, out.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await out.close(); }
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const ready = await health(url);
    if (ready?.app === 'chatmcp-local-hub' && ready.initialized) {
      console.log(`[CHATMCP-HUB] Dang chay nen: ${url}`);
      console.log('[CHATMCP-HUB] Co the dong terminal. Trang localhost se hien tien trinh khoi dong MCP.');
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(250);
  }
  const recent = await fs.readFile(logFile, 'utf8').catch(() => '');
  for (const line of recent.split(/\r?\n/).slice(-8)) if (line) console.error(redact(line));
  throw new Error(`Hub chua mo duoc. Xem nhat ky ${logFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  launch().catch((error) => { console.error(`[CHATMCP-HUB] ${error.message}`); process.exitCode = 1; });
}
