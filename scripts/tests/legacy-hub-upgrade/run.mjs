// The upgrade path from a Hub that has no per-launch secret (v3.9.0 and older), with the installer's REAL preflight code.
//
//   node scripts/tests/legacy-hub-upgrade/run.mjs --baseline-ref <git commit or tag of the release being upgraded from>
//
// Scenarios, each against a real Hub process installed under a throwaway "application root":
//   a. the baseline Hub from git (secretless: /api/state hands its CSRF token to anyone) is stopped by
//      HubLifecycle.StopInstalledHub (the installer/uninstaller preflight) through the legacy session-token flow;
//   b. the same Hub is stopped by the current Stop-ChatMcpHub.ps1;
//   c. the current Hub is stopped through the secret in its session file, which the Hub then removes;
//   d. a current Hub whose session file is missing, or names another process, is NOT stopped and the preflight says why;
//   e. the same preflight, started from a PowerShell 7 session whose CimCmdlets Windows PowerShell cannot load (a stand-in module folder
//      first in PSModulePath), still stops the current Hub: its Hub ownership query is a Windows PowerShell child;
//   f. the real uninstaller (the installer exe under the name Uninstall.exe, in a throwaway "installed" folder), started from a PowerShell 7
//      session that has taken Get-FileHash from Windows PowerShell, still deletes its own Uninstall.exe: that is done by a Windows PowerShell child too.
// Windows only. It needs port 3007 (the product's fixed port) free and never touches a process it did not start. The Hub data
// folder is redirected with CHATMCP_STATE_DIR so the owner's real data is untouched.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { powerShell7ModuleStandIn, powerShellChildEnvironment, windowsPowerShellPath } from '../../../DATGOLD-HUB/tests/support/powershell-environment.mjs';

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
// The tree of a ref stands for an INSTALLATION, whose Hub folder is CHATMCP-HUB. A ref from before the rename of the repository folder has that folder; a later one (HEAD) has DATGOLD-HUB, which is
// renamed when it is unpacked, the way the installer's payload maps it (scripts/InstallerPayload.ps1).
function hubFolderOf(ref) {
  const listed = spawnSync('git', ['-C', repo, 'ls-tree', '--name-only', ref, 'DATGOLD-HUB'], { encoding: 'utf8' });
  assert.equal(listed.status, 0, `git ls-tree ${ref}: ${listed.stderr}`);
  return listed.stdout.trim() === 'DATGOLD-HUB' ? 'DATGOLD-HUB' : 'CHATMCP-HUB';
}
function prepare(name, ref) {
  const root = path.join(scratch, name, 'root');
  fs.mkdirSync(path.join(root, 'runtimes', 'node'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(root, 'runtimes', 'node', 'node.exe'));
  const folder = hubFolderOf(ref);
  const archive = spawnSync('git', ['-C', repo, 'archive', ref, folder], { maxBuffer: 1 << 30 });
  assert.equal(archive.status, 0, `git archive ${ref}: ${archive.stderr}`);
  // Windows' own bsdtar by full path (Git for Windows ships a GNU tar that treats C: as a host); -f - reads the archive from stdin.
  const tar = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');
  const unpack = spawnSync(tar, ['-xf', '-'], { cwd: root, input: archive.stdout });
  assert.equal(unpack.status, 0, String(unpack.stderr));
  if (folder !== 'CHATMCP-HUB') fs.renameSync(path.join(root, folder), path.join(root, 'CHATMCP-HUB'));
  return { root, state: path.join(scratch, name, 'state') };
}
async function startHub({ root, state }) {
  fs.mkdirSync(state, { recursive: true });
  const log = fs.openSync(path.join(state, 'hub-out.log'), 'a');
  // Exactly how the desktop shell starts it: the bundled Node, the installed hub.mjs, port 3007, no --state-dir.
  const child = spawn(path.join(root, 'runtimes', 'node', 'node.exe'), [path.join(root, 'CHATMCP-HUB', 'hub.mjs'), '--port', '3007', '--no-open'], {
    cwd: path.join(root, 'CHATMCP-HUB'), env: { ...process.env, CHATMCP_STATE_DIR: state, CHATMCP_NO_OPEN: '1', CHATMCP_UPDATE_FEED_URL: 'http://127.0.0.1:9/RELEASE-MANIFEST.json' }, stdio: ['ignore', log, log], windowsHide: true,
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

// A process started from PowerShell 7 hands PSModulePath on with PowerShell 7's module folders first, and Windows PowerShell then loses what its own modules define.
// There is no PowerShell 7 on every machine that runs this, so the folder is a stand-in: Microsoft.PowerShell.Utility 7.0.0.0 for the Core edition comes from the
// support file (it reproduces what windows-latest does under pwsh: Get-FileHash is gone); CimCmdlets 7.0.0.0 is written here. Windows PowerShell on windows-latest
// does load the real CimCmdlets of PowerShell 7 and the Hub ownership query works there (run 40168200866), so that one models a PowerShell 7 whose CimCmdlets it cannot.
const behind = (modules) => {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) if (name.toLowerCase() !== 'psmodulepath') environment[name] = value;
  environment.PSModulePath = `${modules};${process.env.PSModulePath ?? ''}`;
  return environment;
};
function cimCmdletsStandIn(directory) {
  const listed = spawnSync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command -Module CimCmdlets).Name'], { encoding: 'utf8', windowsHide: true, env: powerShellChildEnvironment(), timeout: 60_000 });
  const names = String(listed.stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[A-Za-z]+-[A-Za-z]+$/.test(line));
  assert.ok(listed.status === 0 && names.includes('Get-CimInstance'), `Windows PowerShell did not list the commands of CimCmdlets: ${listed.stdout}${listed.stderr}`);
  const folder = path.join(directory, 'Modules', 'CimCmdlets', '7.0.0.0');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'CimCmdlets.psd1'), ['@{', "  GUID = '6c3f5d7e-2b1a-4c58-9e0d-7a41b8c2d9f3'", "  ModuleVersion = '7.0.0.0'", "  CompatiblePSEditions = @('Core')", "  PowerShellVersion = '3.0'",
    `  CmdletsToExport = @(${names.map((name) => `'${name}'`).join(', ')})`, '}', ''].join('\r\n'));
  return path.join(directory, 'Modules');
}
// What a Windows PowerShell started with `environment` finds under `name`: the premise of a check that it still works with the fix.
const found = (name, environment) => spawnSync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Command ${name} -ErrorAction SilentlyContinue) { 'FOUND' } else { 'MISSING' }`],
  { env: environment, encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout.trim();

try {
  const probeOutput = path.join(scratch, 'probe');
  const build = spawnSync('dotnet', ['build', path.join(repo, 'scripts', 'tests', 'legacy-hub-upgrade', 'StopProbe.csproj'), '-c', 'Release', '--nologo', '-v', 'q', '-o', probeOutput], { encoding: 'utf8' });
  assert.equal(build.status, 0, `probe build failed:\n${build.stdout}${build.stderr}`);
  const preflight = ({ root, state }, environment = process.env) => {
    const run = spawnSync('dotnet', [path.join(probeOutput, 'StopProbe.dll'), root], { env: { ...environment, CHATMCP_STATE_DIR: state }, encoding: 'utf8', timeout: 180_000 });
    return { code: run.status, out: `${run.stdout}${run.stderr}`.trim() };
  };

  const old = prepare('baseline', baselineRef);
  const legacy = await startHub(old);
  const legacyState = await (await fetch('http://127.0.0.1:3007/api/state')).json();
  check(`${baselineRef} Hub is secretless: /api/state gives its CSRF token to any local caller`, typeof legacyState.csrfToken === 'string' && legacy.health.auth === undefined, `version ${legacy.health.version}`);
  const first = preflight(old);
  check('the installer preflight stops it through the legacy flow, and the Hub exits', first.code === 0 && /STOPPED/.test(first.out) && await gone(legacy), first.out);

  const legacyAgain = await startHub(old);
  const stop = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'DATGOLD-HUB', 'Stop-ChatMcpHub.ps1'), '-Port', '3007'], { env: powerShellChildEnvironment({ CHATMCP_STATE_DIR: old.state }), encoding: 'utf8', timeout: 180_000 });
  check('Stop-ChatMcpHub.ps1 stops it too', stop.status === 0 && await gone(legacyAgain), `${stop.stdout}${stop.stderr}`.trim().split(/\r?\n/).slice(-1)[0]);

  const current = prepare('current', 'HEAD');
  const hub = await startHub(current);
  const session = JSON.parse(fs.readFileSync(path.join(current.state, 'run', 'hub-session.json'), 'utf8'));
  check('the current Hub requires the secret and published a session for its process', hub.health.auth === 'bearer' && session.pid === hub.child.pid && session.port === 3007 && (await fetch('http://127.0.0.1:3007/api/state')).status === 401);
  const second = preflight(current);
  check('the preflight stops the current Hub with the secret', second.code === 0 && /STOPPED/.test(second.out) && await gone(hub), second.out);
  check('and the Hub removed its session file', !fs.existsSync(path.join(current.state, 'run', 'hub-session.json')));

  // e. started from a PowerShell 7 session whose CimCmdlets Windows PowerShell cannot load
  const cimFolder = cimCmdletsStandIn(path.join(scratch, 'powershell7-cim'));
  check('premise: behind the CimCmdlets stand-in Windows PowerShell has lost Get-CimInstance, which the Hub ownership query runs', found('Get-CimInstance', behind(cimFolder)) === 'MISSING');
  const behindCim = await startHub(current);
  const third = preflight(current, behind(cimFolder));
  check('started from a PowerShell 7 session that hides Get-CimInstance, the preflight still stops the current Hub', third.code === 0 && /STOPPED/.test(third.out) && await gone(behindCim), third.out);
  if (!behindCim.exited) { behindCim.child.kill(); await gone(behindCim); }

  const unreadable = await startHub(current);
  fs.rmSync(path.join(current.state, 'run', 'hub-session.json'));
  const missing = preflight(current);
  check('a current Hub without a readable session is refused, and nothing is stopped', missing.code === 2 && /requires its session file/.test(missing.out) && !unreadable.exited, missing.out);
  fs.writeFileSync(path.join(current.state, 'run', 'hub-session.json'), JSON.stringify({ version: 1, app: 'chatmcp-local-hub', pid: 4, port: 3007, secret: 'a'.repeat(64), nonce: 'x', startedAt: 'x' }));
  const stale = preflight(current);
  check('a session file that names another process is never presented', stale.code === 2 && !unreadable.exited, stale.out);
  unreadable.child.kill();
  await gone(unreadable);

  // f. the uninstaller, from a PowerShell 7 session. Every Hub is gone now (an uninstaller refuses a listener it does not own). The installed folder is a throwaway one with the
  // installer exe under the name the installer gives it and a manifest that owns it; the uninstall touches nothing else (its shortcuts and registry entry are
  // removed only when they name this folder). Nothing is installed, so nothing is left for the next suite.
  const setup = path.join(scratch, 'setup');
  const buildSetup = spawnSync('dotnet', ['build', path.join(repo, 'installer', 'ChatMCP.Installer.csproj'), '-c', 'Release', '--nologo', '-v', 'q', '-o', setup], { encoding: 'utf8' });
  assert.equal(buildSetup.status, 0, `installer build failed:\n${buildSetup.stdout}${buildSetup.stderr}`);
  const installed = path.join(scratch, 'installed app');
  fs.mkdirSync(installed, { recursive: true });
  for (const name of ['DatGoldSetup.dll', 'DatGoldSetup.runtimeconfig.json', 'DatGoldSetup.deps.json']) fs.copyFileSync(path.join(setup, name), path.join(installed, name));
  fs.copyFileSync(path.join(setup, 'DatGoldSetup.exe'), path.join(installed, 'Uninstall.exe'));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(installed, 'Uninstall.exe'))).digest('hex').toUpperCase();
  fs.writeFileSync(path.join(installed, '.chatmcp-installed-files.json'), JSON.stringify({ 'Uninstall.exe': digest }));
  const utilityFolder = await powerShell7ModuleStandIn(path.join(scratch, 'powershell7-utility'));
  check('premise: behind the Utility stand-in Windows PowerShell has lost Get-FileHash, as it does under pwsh on windows-latest', found('Get-FileHash', behind(utilityFolder)) === 'MISSING');
  const uninstall = spawnSync(path.join(installed, 'Uninstall.exe'), ['--quiet', '--uninstall'], { env: behind(utilityFolder), encoding: 'utf8', timeout: 120_000 });
  check('the real uninstaller started from that PowerShell 7 session completes', uninstall.status === 0, `exit ${uninstall.status} ${uninstall.stdout}${uninstall.stderr}`.trim());
  // The helper that deletes the running uninstaller works on for a moment after the uninstaller has ended.
  for (let i = 0; i < 120 && fs.existsSync(path.join(installed, 'Uninstall.exe')); i++) await wait(250);
  check('and it still deletes its own Uninstall.exe', !fs.existsSync(path.join(installed, 'Uninstall.exe')));
} catch (error) {
  console.error(error.stack ?? error);
  results.push(false);
} finally {
  for (const child of started) { try { child.kill(); } catch { /* already gone */ } }
  await wait(500);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(results.every(Boolean) ? `PASS: ${results.length} checks - legacy and current Hub upgrade preflight, and the preflight and the uninstaller behind PowerShell 7` : 'FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
