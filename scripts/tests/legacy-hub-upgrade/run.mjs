// The upgrade path from a Hub that has no per-launch secret (v3.9.0 and older), with the installer's REAL preflight code.
//
//   node scripts/tests/legacy-hub-upgrade/run.mjs --baseline-ref <git commit or tag of the release being upgraded from>
//
// Scenarios, each against a real Hub process installed under a throwaway "application root":
//   a. the baseline Hub from git (secretless: /api/state hands its CSRF token to anyone) is stopped by
//      HubLifecycle.StopInstalledHub (the installer/uninstaller preflight) through the legacy session-token flow;
//   b. the same Hub is stopped by the current Stop-ChatMcpHub.ps1;
//   c. the current Hub is stopped through the secret in its session file, which the Hub then removes;
//   d. a current Hub whose session file is missing, or names another process, is NOT stopped and the preflight says why.
// Windows only. It needs port 3007 (the product's fixed port) free and never touches a process it did not start. The Hub data
// folder is redirected with CHATMCP_STATE_DIR so the owner's real data is untouched.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') { console.log('SKIP: the installer preflight is Windows-only'); process.exit(0); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const refIndex = process.argv.indexOf('--baseline-ref');
const baselineRef = refIndex > 0 ? process.argv[refIndex + 1] : '';
if (!baselineRef) { console.error('usage: run.mjs --baseline-ref <commit|tag>'); process.exit(2); }

const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const busy = await new Promise((resolve) => { const socket = net.connect({ port: 3007, host: '127.0.0.1' }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
if (busy) { console.error('Port 3007 is already in use; nothing was started or stopped.'); process.exit(2); }

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-legacy-upgrade-')));
const started = [];
function prepare(name, ref) {
  const root = path.join(scratch, name, 'root');
  fs.mkdirSync(path.join(root, 'runtimes', 'node'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(root, 'runtimes', 'node', 'node.exe'));
  const archive = spawnSync('git', ['-C', repo, 'archive', ref, 'CHATMCP-HUB'], { maxBuffer: 1 << 30 });
  assert.equal(archive.status, 0, `git archive ${ref}: ${archive.stderr}`);
  const unpack = spawnSync('tar', ['-x'], { cwd: root, input: archive.stdout });
  assert.equal(unpack.status, 0, String(unpack.stderr));
  return { root, state: path.join(scratch, name, 'state') };
}
async function startHub({ root, state }) {
  fs.mkdirSync(state, { recursive: true });
  const log = fs.openSync(path.join(state, 'hub-out.log'), 'a');
  // Exactly how the desktop shell starts it: the bundled Node, the installed hub.mjs, port 3007, no --state-dir.
  const child = spawn(path.join(root, 'runtimes', 'node', 'node.exe'), [path.join(root, 'CHATMCP-HUB', 'hub.mjs'), '--port', '3007', '--no-open'], {
    cwd: path.join(root, 'CHATMCP-HUB'), env: { ...process.env, CHATMCP_STATE_DIR: state, CHATMCP_NO_OPEN: '1' }, stdio: ['ignore', log, log], windowsHide: true,
  });
  fs.closeSync(log);
  started.push(child);
  const hub = { child, exited: false };
  child.once('exit', () => { hub.exited = true; });
  for (let i = 0; i < 160; i++) {
    if (hub.exited) throw new Error('the Hub exited early: ' + fs.readFileSync(path.join(state, 'hub-out.log'), 'utf8').slice(-600));
    try { hub.health = await (await fetch('http://127.0.0.1:3007/api/health')).json(); if (hub.health.initialized) return hub; } catch { /* not listening yet */ }
    await wait(250);
  }
  throw new Error('the Hub did not become ready');
}
const gone = async (hub) => { for (let i = 0; i < 60 && !hub.exited; i++) await wait(250); return hub.exited; };

try {
  const probeOutput = path.join(scratch, 'probe');
  const build = spawnSync('dotnet', ['build', path.join(repo, 'scripts', 'tests', 'legacy-hub-upgrade', 'StopProbe.csproj'), '-c', 'Release', '--nologo', '-v', 'q', '-o', probeOutput], { encoding: 'utf8' });
  assert.equal(build.status, 0, `probe build failed:\n${build.stdout}${build.stderr}`);
  const preflight = ({ root, state }) => {
    const run = spawnSync('dotnet', [path.join(probeOutput, 'StopProbe.dll'), root], { env: { ...process.env, CHATMCP_STATE_DIR: state }, encoding: 'utf8', timeout: 180_000 });
    return { code: run.status, out: `${run.stdout}${run.stderr}`.trim() };
  };

  const old = prepare('baseline', baselineRef);
  const legacy = await startHub(old);
  const legacyState = await (await fetch('http://127.0.0.1:3007/api/state')).json();
  check(`${baselineRef} Hub is secretless: /api/state gives its CSRF token to any local caller`, typeof legacyState.csrfToken === 'string' && legacy.health.auth === undefined, `version ${legacy.health.version}`);
  const first = preflight(old);
  check('the installer preflight stops it through the legacy flow, and the Hub exits', first.code === 0 && /STOPPED/.test(first.out) && await gone(legacy), first.out);

  const legacyAgain = await startHub(old);
  const stop = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'CHATMCP-HUB', 'Stop-ChatMcpHub.ps1'), '-Port', '3007'], { env: { ...process.env, CHATMCP_STATE_DIR: old.state }, encoding: 'utf8', timeout: 180_000 });
  check('Stop-ChatMcpHub.ps1 stops it too', stop.status === 0 && await gone(legacyAgain), `${stop.stdout}${stop.stderr}`.trim().split(/\r?\n/).slice(-1)[0]);

  const current = prepare('current', 'HEAD');
  const hub = await startHub(current);
  const session = JSON.parse(fs.readFileSync(path.join(current.state, 'run', 'hub-session.json'), 'utf8'));
  check('the current Hub requires the secret and published a session for its process', hub.health.auth === 'bearer' && session.pid === hub.child.pid && session.port === 3007 && (await fetch('http://127.0.0.1:3007/api/state')).status === 401);
  const second = preflight(current);
  check('the preflight stops the current Hub with the secret', second.code === 0 && /STOPPED/.test(second.out) && await gone(hub), second.out);
  check('and the Hub removed its session file', !fs.existsSync(path.join(current.state, 'run', 'hub-session.json')));

  const unreadable = await startHub(current);
  fs.rmSync(path.join(current.state, 'run', 'hub-session.json'));
  const missing = preflight(current);
  check('a current Hub without a readable session is refused, and nothing is stopped', missing.code === 2 && /requires its session file/.test(missing.out) && !unreadable.exited, missing.out);
  fs.writeFileSync(path.join(current.state, 'run', 'hub-session.json'), JSON.stringify({ version: 1, app: 'chatmcp-local-hub', pid: 4, port: 3007, secret: 'a'.repeat(64), nonce: 'x', startedAt: 'x' }));
  const stale = preflight(current);
  check('a session file that names another process is never presented', stale.code === 2 && !unreadable.exited, stale.out);
  unreadable.child.kill();
  await gone(unreadable);
} catch (error) {
  console.error(error.stack ?? error);
  results.push(false);
} finally {
  for (const child of started) { try { child.kill(); } catch { /* already gone */ } }
  await wait(500);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(results.every(Boolean) ? `PASS: ${results.length} checks - legacy and current Hub upgrade preflight` : 'FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
