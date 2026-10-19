// Starts e2e/port-squatter.mjs (a separate process that listens on a port, answers like a Hub and records every byte it receives)
// and writes the stale session files a crash leaves behind. Shared by verify-hub-listener.mjs (the Node launcher) and
// verify-hub-listener-powershell.mjs (the PowerShell helper scripts), so both attack with the same squatter.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSession } from '../../lib/hub-session.mjs';
import { sleep } from './hub-process.mjs';

const SQUATTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'port-squatter.mjs');

/**
 * The helpers for one test run; every file goes under `scratch`. `children` is every process started through `squat`
 * (a test may push its own), and `stopAll` ends them.
 */
export function createSquatterHarness(scratch) {
  const children = [];
  const sandbox = (name) => { const directory = path.join(scratch, name); fs.mkdirSync(directory, { recursive: true }); return directory; };
  const stopChild = async (child) => {
    if (child.exitCode !== null) return;
    child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
  };

  /** A separate process that listens on `port` (on `host`, else the dual-stack wildcard) and answers like a Hub; see e2e/port-squatter.mjs. */
  async function squat({ name, port, host, healthText }) {
    const directory = sandbox(`squatter-${name}`);
    const files = { health: path.join(directory, 'health.json'), requests: path.join(directory, 'requests.jsonl'), raw: path.join(directory, 'raw.bin') };
    fs.writeFileSync(files.health, healthText);
    for (const file of [files.requests, files.raw]) fs.writeFileSync(file, '');
    const child = spawn(process.execPath, [SQUATTER, '--port', String(port), ...(host ? ['--host', host] : []), '--health', files.health, '--requests', files.requests, '--raw', files.raw], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    children.push(child);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the squatter did not start')), 15_000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the squatter exited early (${code})`)); });
    });
    return {
      port, pid: child.pid, origin: `http://127.0.0.1:${port}`,
      requests: () => fs.readFileSync(files.requests, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
      raw: () => fs.readFileSync(files.raw, 'latin1'),
      stop: () => stopChild(child),
    };
  }

  /** The id of a process that has exited (a stale session file names a Hub that is gone). */
  const deadPid = async () => { const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true }); await new Promise((resolve) => child.once('exit', resolve)); return child.pid; };

  /** The session file as the Hub's own writer makes it, naming `pid` (a process that is not the one listening, unless a test says so). */
  async function staleSession(stateDir, { port, pid, secret = randomBytes(32).toString('hex') }) { await writeSession(stateDir, { port, secret, pid }); return { stateDir, secret, pid, port }; }

  return { children, sandbox, stopChild, squat, deadPid, staleSession, stopAll: async () => { for (const child of children) await stopChild(child); } };
}
