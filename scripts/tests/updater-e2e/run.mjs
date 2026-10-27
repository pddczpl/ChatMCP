#!/usr/bin/env node
// The end-to-end proof of the in-app updater, on a GitHub-hosted Windows runner (the CI job "Windows in-app updater, end to end"). It installs a real OLD setup, starts the real desktop shell and Hub, and drives the
// page inside the shell's WebView2 with mouse presses that the browser takes for a person's (trusted clicks, injected through the DevTools protocol: not the click() of a script, but not the operating
// system's mouse either) to Download and to Install and restart; the shell checks the update with its own C#, starts the real NEW setup in update mode, the setup waits for the shell to close, replaces the
// files and opens the NEW app. Then the facts that nobody has seen so far are checked, and the refusals (a tampered setup, a manifest signed by another key, work that is running, a second request) are made to
// happen to the OLD app, which must stay installed and working.
//
//     node scripts/tests/updater-e2e/run.mjs --work <folder of Build-TestPair.ps1> --keys <folder of make-keys.mjs> --evidence <folder> [--until <phase>]
//
// Phases, in order: prepare, install, attach, download, negatives, apply, after. Everything is a test of THIS commit's code: the setups are built from it (scripts/tests/updater-e2e/Build-TestPair.ps1, with a
// throwaway key list, versions given at build time, nothing published); GitHub is a stand-in on a loopback port (tests/e2e/update-feed-server.mjs) that the installed Hub reads through the one variable that
// exists for it (CHATMCP_UPDATE_FEED_URL, loopback addresses only: lib/update-check.mjs, docs/THREAT-MODEL.md Surface 8); the page of the installed shell is reached through a debugging port that a WebView2 policy
// of this disposable runner opens for ChatMCP.exe, as scripts/tests/windows-installer/guest-lifecycle.ps1 does in its sandbox.
//
// It installs, updates and force-closes DatGold, so it runs on a GitHub-hosted Windows runner and nowhere else: the guards below are the first thing it does, before it makes a folder, reads a file or starts a
// program, and a refusal ends the process with nothing put back or taken down (there is nothing of its own to put back).
//
// What it is NOT: a release, a signed release, GitHub, a download of 230 MB over the internet, or SmartScreen with an unsigned installer. The pull request says so.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startMockModel } from '../../../CHATMCP-HUB/tests/e2e/mock-model-server.mjs';
import { feedManifest, startUpdateFeed } from '../../../CHATMCP-HUB/tests/e2e/update-feed-server.mjs';
import { buildReleaseManifest, flipByte, signWithTool } from './release-files.mjs';
import { browserVersion, connectPage, sleep } from './lib/cdp.mjs';
import { Evidence } from './lib/evidence.mjs';
import { HubClient } from './lib/hub-client.mjs';
import { PageDriver } from './lib/page-driver.mjs';
import {
  assertDisposableRunner, assertHostedRunnerEnvironment, clearDebugPolicy, closeGracefully, debugPolicyValue, installedPaths, isRunning, isSameProcessRunning, killTree, leftovers, powershell, processIds,
  processInfo, registryValue, setDebugPolicy, sha256File, splitWindowsCommandLine, system32, versionInfo, waitForExit, windowTitle,
} from './lib/windows.mjs';
import { startRunningWork } from './lib/work.mjs';

const PHASES = ['prepare', 'install', 'attach', 'download', 'negatives', 'apply', 'after'];
const HUB_PORT = 3007;
const HUB_ORIGIN = `http://127.0.0.1:${HUB_PORT}`;
const WEBVIEW2_RUNTIME_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function parseArguments(argv) {
  const options = { until: 'after' };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--work', '--keys', '--evidence', '--until'].includes(name) || value === undefined) throw new Error(`usage: node scripts/tests/updater-e2e/run.mjs --work <folder> --keys <folder> --evidence <folder> [--until <${PHASES.join('|')}>] (got ${name})`);
    options[name.slice(2)] = value;
  }
  for (const required of ['work', 'keys', 'evidence']) if (!options[required]) throw new Error(`--${required} is required`);
  if (!PHASES.includes(options.until)) throw new Error(`--until must be one of ${PHASES.join(', ')}`);
  return options;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const options = parseArguments(process.argv.slice(2));

// ---- the guards: first, before anything is made, read or started ------------------------------------------------------------------------------------
// The environment (a GitHub-hosted Windows runner, no publish workflow), then the machine (nothing of DatGold installed, nothing on port 3007). A refusal is the end: the clean-up below kills the programs
// of an installation and runs its stop script, and that is only ever for the installation THIS run made.
try {
  assertHostedRunnerEnvironment();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const paths = installedPaths();
try {
  await assertDisposableRunner({ paths, hubPort: HUB_PORT });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const ev = new Evidence(path.resolve(options.evidence));
const hub = new HubClient({ origin: HUB_ORIGIN, stateDirectory: paths.hubDirectory });
const closers = [];
// the state of the run, which a failure reads to say what it can
const run = { feed: null, cdpPort: 0, cdp: null, driver: null, shell: null, shellPid: 0, shellCreated: null, hubPid: 0, hubCreated: null, appEnvironment: null, startError: null, taskIdOfTheProof: null };

const readUpdate = async () => (await hub.state()).update;
const seconds = (since) => Number(((Date.now() - since) / 1000).toFixed(1));
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const kidOfSignature = (bytes) => JSON.parse(stripBom(Buffer.from(bytes).toString('utf8'))).kid;
// a path as Windows spells it, compared the way Windows compares it: no \\?\ prefix, no trailing separator, no case
const samePath = (a, b) => {
  const normal = (value) => path.win32.normalize(String(value).replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '').toLowerCase();
  return normal(a) === normal(b);
};
// the creation time of a process, as milliseconds (Windows says 100-nanosecond ticks; a clock reads milliseconds)
const createdAt = (info) => Date.parse(String(info?.created ?? '').replace(/(\.\d{3})\d+/, '$1'));

async function waitForHub(version, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  for (;;) {
    if (run.startError) throw new Error(`The app could not be started: ${run.startError.message}`);
    try {
      const health = await hub.health();
      last = `version ${health.version}, initialized ${health.initialized}`;
      if (health.version === version && health.initialized === true) return health;
    } catch (error) { last = error?.cause?.code ?? error?.message ?? String(error); }
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label} (last: ${last})`);
    await sleep(500);
  }
}

/** Starts the installed app the way a shortcut does (its own process, with the environment of this run); `run.shell` follows it, and says when it exited and how. */
function startApp(label) {
  const child = spawn(paths.exe, [], { env: run.appEnvironment, detached: true, stdio: 'ignore', windowsHide: false });
  const shell = { pid: child.pid, exitedAt: null, exitCode: null };
  child.once('error', (error) => { run.startError = error; ev.log(`${label} did not start: ${error.message}`); });
  child.once('exit', (code) => { shell.exitedAt = Date.now(); shell.exitCode = code; });
  child.unref();
  run.shell = shell;
  run.shellPid = child.pid;
  ev.log(`started ${label}: ChatMCP.exe pid ${child.pid}`);
  return child.pid;
}

async function attach(label) {
  run.cdp = await connectPage({ port: run.cdpPort, match: (address) => address.startsWith(`${HUB_ORIGIN}/`), timeoutMs: 120_000, label });
  run.driver = new PageDriver(run.cdp, { log: (line) => ev.log(line) });
  return run.driver;
}

/** What a failure leaves for whoever reads it: the programs, the policy, the port, the folders, the logs, and a picture of the page. */
async function diagnostics(reason) {
  const lines = [`reason: ${reason}`, `time: ${new Date().toISOString()}`];
  const safe = (name, action) => { try { lines.push(`${name}: ${action()}`); } catch (error) { lines.push(`${name}: (failed: ${String(error.message).slice(0, 200)})`); } };
  for (const image of ['ChatMCP.exe', 'node.exe', 'msedgewebview2.exe', 'DatGoldSetup.exe']) safe(image, () => processIds(image).join(','));
  safe('WebView2 policy', () => debugPolicyValue());
  // the browser processes of WebView2 (not their renderers): whether the arguments of the policy reached them is in their command lines
  safe('WebView2 browser command lines', () => powershell("Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.CommandLine } | Select-Object -First 3 | Out-String"));
  safe('WebView2 runtime', () => registryValue(WEBVIEW2_RUNTIME_KEY, 'pv'));
  safe('integrity level', () => powershell("(whoami /groups | Select-String 'Mandatory Label').ToString().Trim()"));
  safe(`ports ${run.cdpPort} and ${HUB_PORT}`, () => spawnSync(system32('netstat.exe'), ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).filter((line) => line.includes(`:${run.cdpPort} `) || line.includes(`:${HUB_PORT} `)).join(' | '));
  safe('install directory', () => (fs.existsSync(paths.installDirectory) ? fs.readdirSync(paths.installDirectory).join(', ') : '(absent)'));
  safe('hub directory', () => (fs.existsSync(paths.hubDirectory) ? fs.readdirSync(paths.hubDirectory).join(', ') : '(absent)'));
  safe('updates', () => (fs.existsSync(path.join(paths.hubDirectory, 'updates')) ? fs.readdirSync(path.join(paths.hubDirectory, 'updates'), { recursive: true }).join(', ') : '(absent)'));
  ev.write('diagnostics.txt', `${lines.join('\n')}\n`);
  console.log(lines.map((line) => `  diag ${line}`).join('\n'));
  if (run.driver && run.cdp?.open) await run.driver.screenshot(ev.file('failure.png'));
  for (const [from, name] of [[path.join(paths.dataDirectory, 'logs'), 'data-logs'], [path.join(paths.hubDirectory, 'logs'), 'hub-logs']]) {
    try { if (fs.existsSync(from)) fs.cpSync(from, ev.file(name), { recursive: true }); } catch { /* best effort */ }
  }
  for (const name of ['update-check.json', 'update-settings.json', 'update-result.json']) {
    try { const file = path.join(paths.hubDirectory, name); if (fs.existsSync(file)) fs.copyFileSync(file, ev.file(`hub-${name}`)); } catch { /* best effort */ }
  }
}

/** The file that a path names, as the disk knows it: its identity (NTFS file id), size and time, so that a file that was replaced is told from a file that was only read. */
function fileIdentity(file) {
  try { const stat = fs.statSync(file, { bigint: true }); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch (error) { return `unreadable:${error.code ?? error.message}`; }
}

/** A fact that becomes true shortly after something else (what the Hub clears as it starts): looked at again for up to `timeoutMs`, kept as a check when it holds, and a failed check when it does not. */
async function eventually(label, read, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await read()) === true) { ev.check(true, label); return; }
    if (Date.now() >= deadline) ev.check(false, label, `still not so after ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

async function main() {
  const report = JSON.parse(fs.readFileSync(path.join(options.work, 'build-report.json'), 'utf8'));
  const keys = JSON.parse(fs.readFileSync(path.join(options.keys, 'keys.json'), 'utf8'));
  const OLD = report.old.version;
  const NEW = report.new.version;
  const updatesDirectory = path.join(paths.hubDirectory, 'updates');
  const staged = path.join(updatesDirectory, NEW);
  const installerFile = path.join(staged, 'DatGoldSetup.exe');
  const signatureFile = path.join(staged, 'RELEASE-MANIFEST.json.sig');
  const resultFile = path.join(paths.hubDirectory, 'update-result.json');
  const gatewayConfigFile = path.join(paths.hubDirectory, 'gateway', 'gateway-config.json');
  const lastPhase = (phase) => options.until === phase;
  let manifestBytes = null;
  let signature = null;
  let otherSignature = null;
  let oldExeHash = null;

  /** What is the same after a refusal as it was before it: the OLD app is installed, runs, and nothing of an update is left. */
  async function assertOldIntact(label) {
    ev.check(sha256File(paths.exe) === oldExeHash, `${label}: ChatMCP.exe is the OLD program, byte for byte`);
    ev.check(JSON.parse(fs.readFileSync(paths.hubPackage, 'utf8')).version === OLD, `${label}: the installed Hub package is still ${OLD}`);
    ev.check(String(registryValue(paths.uninstallKey, 'DisplayVersion')) === OLD, `${label}: Windows Installed Apps still says ${OLD}`);
    ev.check(run.shell.exitedAt === null && isRunning(run.shellPid), `${label}: the OLD desktop shell is still running (pid ${run.shellPid}, never exited)`);
    const health = await hub.health();
    ev.check(health.version === OLD && health.initialized === true && (await hub.session()).pid === run.hubPid, `${label}: the OLD Hub still answers, the same process (pid ${run.hubPid})`);
    ev.check(run.cdp.open && (await run.driver.evaluate('1 + 1')) === 2, `${label}: the page in the OLD window is still there and answers`);
    ev.check((await readUpdate()).download?.state === 'ready', `${label}: and the Hub still says the download is ready`);
    ev.check(leftovers(paths.installDirectory, /^\.chatmcp-update-pending\.json$|^\.ChatMCP-update-/).length === 0, `${label}: no marker and no backup of an update in the installation`);
    ev.check(!fs.existsSync(resultFile), `${label}: no result file of an update`);
    ev.check(processIds('DatGoldSetup.exe').length === 0, `${label}: no setup is running`);
  }

  /** The files of the staged update are the ones the Hub made: the signed manifest, its signature, the setup. */
  function stagedIsGood(label) {
    ev.check(fs.readFileSync(path.join(staged, 'RELEASE-MANIFEST.json')).equals(manifestBytes), `${label}: the staged manifest is the signed one, byte for byte`);
    ev.check(fs.readFileSync(signatureFile).equals(signature.bytes), `${label}: the staged signature is the one the owner's tool made`);
    ev.check(sha256File(installerFile) === report.new.sha256, `${label}: the staged setup is the NEW setup, byte for byte`);
  }

  /** The `n` answers of the shell that came after the first `count` messages the page had, waited for. */
  async function shellAnswersAfter(count, n, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const answers = (await run.driver.shellMessages()).slice(count).filter((message) => message && message.type === 'chatmcp.update-result');
      if (answers.length >= n) return answers;
      if (Date.now() >= deadline) throw new Error(`Only ${answers.length} of ${n} answers of the shell within ${timeoutMs} ms`);
      await sleep(300);
    }
  }

  /** "Download again" from the page, after a refusal: the Hub fetches the setup anew and says ready; the staged files are the good ones again. */
  async function downloadAgain(label) {
    const before = run.feed.installer.hits();
    await run.driver.waitForVisible('update-apply-again');
    await run.driver.pressTestId('update-apply-again');
    const deadline = Date.now() + 180_000;
    for (;;) {
      const download = (await readUpdate()).download;
      if (run.feed.installer.hits() > before && download?.state === 'ready' && download.version === NEW) break;
      if (Date.now() >= deadline) throw new Error(`The Hub did not say ready again within 180 s (download: ${JSON.stringify(download)})`);
      await sleep(500);
    }
    await run.driver.waitForVisible('update-apply', { timeoutMs: 60_000 });
    stagedIsGood(`${label} (after Download again)`);
  }

  /** A refusal that a person's clicks reach: Install and restart, the question, Yes; the shell says no with `code`; the OLD app is as it was; Download again puts the update right. */
  async function refusalByClick({ name, code, tamper }) {
    ev.log(`--- ${name}`);
    tamper();
    const count = (await run.driver.shellMessages()).length;
    await run.driver.pressTestId('update-apply');
    await run.driver.waitForVisible('update-apply-confirm');
    await run.driver.pressTestId('update-apply-yes');
    const [answer] = await shellAnswersAfter(count, 1);
    ev.check(answer.ok === false && answer.code === code, `${name}: the shell refused with ${code}`, JSON.stringify(answer));
    await run.driver.waitForVisible('update-apply-error', { timeoutMs: 30_000 });
    ev.check(((await run.driver.text('update-apply-error')) ?? '').trim().length > 0, `${name}: the page says so in words`);
    ev.check(await run.driver.isVisible('update-apply-again'), `${name}: and offers Download again`);
    await run.driver.screenshot(ev.file(`negative-${code}.png`));
    await assertOldIntact(name);
    await downloadAgain(name);
  }

  // ---------------------------------------------------------------------------------------------------------------------------- prepare
  ev.phase('prepare', 'the runner, the two setups, the key, the signed manifest, the stand-in for GitHub');
  ev.log('both guards passed before this program made anything: a GitHub-hosted Windows runner, no publish workflow, nothing of DatGold installed, nothing on port 3007');
  ev.note('node', process.version);
  ev.note('runner image', `${process.env.ImageOS ?? '?'} ${process.env.ImageVersion ?? '?'}`);
  ev.note('os', powershell('[Environment]::OSVersion.VersionString'));
  ev.note('elevated', powershell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'));
  ev.note('webview2 runtime', registryValue(WEBVIEW2_RUNTIME_KEY, 'pv'));
  for (const role of ['old', 'new']) {
    const entry = report[role];
    ev.check(fs.existsSync(entry.path) && fs.statSync(entry.path).size === entry.bytes, `the ${role} setup is there (${(entry.bytes / 1048576).toFixed(1)} MB)`);
    const info = versionInfo(entry.path);
    ev.check(info.product === 'DatGold Studio Setup' && info.description === 'DatGold Studio Setup' && info.productVersion.split('+')[0] === entry.version, `the ${role} setup says it is DatGold Studio Setup ${entry.version} (what the shell reads before it runs one)`, JSON.stringify(info));
  }
  ev.check(OLD !== NEW && report.old.sha256 !== report.new.sha256, `two different setups: ${OLD} and ${NEW}`);
  const newBytes = fs.readFileSync(report.new.path);
  ev.check(newBytes.length === report.new.bytes, 'the NEW setup is read for the stand-in');
  manifestBytes = buildReleaseManifest({
    version: NEW, commit: process.env.GITHUB_SHA ?? report.commit, workflowRun: process.env.GITHUB_RUN_ID ?? '0', installer: { name: 'DatGoldSetup.exe', bytes: newBytes.length, sha256: report.new.sha256 },
  });
  const manifestFile = path.join(options.work, 'RELEASE-MANIFEST.json');
  fs.writeFileSync(manifestFile, manifestBytes);
  signature = await signWithTool({ tag: `v${NEW}`, keyFile: keys.run.keyFile, keysFile: keys.run.listFile, manifestFile, installerFile: report.new.path, outDirectory: path.join(options.work, 'signature-run') });
  otherSignature = await signWithTool({ tag: `v${NEW}`, keyFile: keys.other.keyFile, keysFile: keys.other.listFile, manifestFile, installerFile: report.new.path, outDirectory: path.join(options.work, 'signature-other') });
  ev.check(kidOfSignature(signature.bytes) === keys.run.kid && kidOfSignature(otherSignature.bytes) === keys.other.kid && keys.run.kid !== keys.other.kid && !signature.bytes.equals(otherSignature.bytes),
    `scripts/sign-release.mjs signed the manifest of ${NEW} with key ${keys.run.kid} (the key list of the run), and, for the refusal, with another key ${keys.other.kid} (named inside the signature file itself)`);
  run.feed = await startUpdateFeed({ manifest: feedManifest({ version: NEW }) });
  closers.push(() => run.feed.close());
  run.feed.publish(feedManifest({ version: NEW }), { raw: manifestBytes });
  run.feed.signature.set(signature.bytes);
  run.feed.signature.mode('chain');
  run.feed.installer.set({ name: 'DatGoldSetup.exe', bytes: newBytes });
  ev.check(run.feed.url.startsWith('http://127.0.0.1:'), `the stand-in for GitHub is on ${run.feed.origin} (loopback)`);
  run.cdpPort = await freePort();
  setDebugPolicy(run.cdpPort);
  ev.check(debugPolicyValue() === `--remote-debugging-port=${run.cdpPort}`, `the WebView2 policy opens debugging port ${run.cdpPort} for ChatMCP.exe only`);
  run.appEnvironment = { ...process.env, CHATMCP_UPDATE_FEED_URL: run.feed.url, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${run.cdpPort}` };
  if (lastPhase('prepare')) return;

  // ---------------------------------------------------------------------------------------------------------------------------- install
  ev.phase('install', `the OLD setup ${OLD}, the real one, quietly`);
  {
    // A hosted runner's profile may lack the Desktop and the Start menu folders, which a person's profile always has (the setup ignores a shortcut it cannot save): they are made, so that the proof is about
    // what the setup and the update do with shortcuts and not about the profile (scripts/tests/Test-NativeLifecycle.ps1 does the same).
    for (const folder of [path.dirname(paths.shortcuts.desktop), path.dirname(path.dirname(paths.shortcuts.start))]) fs.mkdirSync(folder, { recursive: true });
    const began = Date.now();
    const install = spawn(report.old.path, ['--quiet', '--install-dir', paths.installDirectory], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let said = '';
    for (const stream of [install.stdout, install.stderr]) stream.on('data', (chunk) => { said = `${said}${chunk}`.slice(-2000); });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { killTree(install.pid); resolve('timeout'); }, 600_000);
      install.once('error', (error) => { clearTimeout(timer); resolve(`the setup could not be started: ${error.message}`); });
      install.once('close', (status) => { clearTimeout(timer); resolve(status); });
    });
    ev.note('old install seconds', seconds(began));
    ev.check(code === 0, 'the OLD setup installed (exit code 0)', `exit ${code}: ${said.trim().slice(-600)}`);
  }
  ev.check(fs.existsSync(paths.exe), `ChatMCP.exe is installed in ${paths.installDirectory}`);
  ev.check(versionInfo(paths.exe).productVersion.split('+')[0] === OLD, `the installed program says ${OLD}`);
  ev.check(JSON.parse(fs.readFileSync(paths.hubPackage, 'utf8')).version === OLD, `the installed Hub package says ${OLD}`);
  ev.check(String(registryValue(paths.uninstallKey, 'DisplayVersion')) === OLD, `Windows Installed Apps says ${OLD}`);
  ev.check(fs.readFileSync(path.join(paths.installDirectory, 'CHATMCP-HUB', 'lib', 'release-keys.json')).equals(fs.readFileSync(keys.run.listFile)), 'the installed Hub trusts exactly the key list of the run');
  for (const [name, file] of Object.entries(paths.shortcuts)) ev.check(fs.existsSync(file), `the ${name} shortcut was made`);
  oldExeHash = sha256File(paths.exe);
  ev.note('old ChatMCP.exe sha256', oldExeHash);
  if (lastPhase('install')) return;

  // ---------------------------------------------------------------------------------------------------------------------------- attach
  ev.phase('attach', 'start the OLD app, find its page through the debugging port, press with the mouse');
  startApp('the OLD app');
  const health = await waitForHub(OLD, 120_000, `the Hub ${OLD} that the shell starts`);
  ev.check(health.auth === 'bearer', `the Hub ${OLD} is up on port ${HUB_PORT} and requires its session secret`);
  const shellProcess = processInfo(run.shellPid);
  ev.check(shellProcess !== null && samePath(shellProcess.path, paths.exe), 'the OLD app is the installed ChatMCP.exe', JSON.stringify(shellProcess));
  run.shellCreated = shellProcess.created;
  run.hubPid = (await hub.session()).pid;
  const hubProcess = processInfo(run.hubPid);
  ev.check(hubProcess !== null && samePath(hubProcess.path, paths.node) && String(hubProcess.commandLine).toLowerCase().includes(path.join(paths.installDirectory, 'CHATMCP-HUB', 'hub.mjs').toLowerCase()), 'the Hub is the installed one (the installed node.exe runs the installed hub.mjs)', JSON.stringify(hubProcess));
  run.hubCreated = hubProcess.created;
  try {
    await attach('the page of the installed shell');
  } catch (error) {
    await diagnostics(`no debugging connection to the installed shell: ${error.message}`);
    throw error;
  }
  ev.note('webview2 browser', (await browserVersion(run.cdpPort)).Browser);
  ev.check(windowTitle(run.shellPid).includes(`DatGold Studio ${OLD}`), `the title bar of the OLD app says DatGold Studio ${OLD}`, windowTitle(run.shellPid));
  const prepared = await run.driver.prepare({ language: 'en' });
  ev.check(prepared.shell === true && prepared.address === HUB_ORIGIN && prepared.session === true, 'the page in the installed shell is signed in, and window.chrome.webview is there (it knows it is in the desktop app)');
  await run.driver.recordShellMessages();
  const opened = await run.driver.openSettings('Updates');
  await run.driver.waitForVisible('updates-check');
  await run.driver.screenshot(ev.file('attach-settings.png'));
  ev.check(opened.length >= 1 && opened.every((press) => press.trusted === true), `Settings and its Updates section were opened with ${opened.length} presses of the mouse, and the page took every one for a person's (trusted clicks)`);
  await run.driver.closeSettings();
  const first = await readUpdate();
  ev.check(first.current === OLD && first.autoCheck?.needsChoice === true && run.feed.requests.length === 0, `the OLD Hub knows it is ${OLD}, has not been asked whether to check by itself, and has made no request`, JSON.stringify(first.autoCheck));
  if (lastPhase('attach')) return;

  // ---------------------------------------------------------------------------------------------------------------------------- download
  ev.phase('download', 'answer No, Check now, Download: all with presses of the mouse');
  fs.writeFileSync(path.join(paths.dataDirectory, 'unrelated-user-state.txt'), 'PRESERVE-STATE');
  fs.writeFileSync(path.join(paths.hubDirectory, 'canary-before-update.txt'), 'PRESERVE-HUB-DATA');
  await run.driver.waitForVisible('update-question');
  await run.driver.pressTestId('update-no');
  await run.driver.waitForGone('update-question');
  ev.check(run.feed.requests.length === 0, 'No was answered: the Hub still has made no request');
  await run.driver.openSettings('Updates');
  await run.driver.pressTestId('updates-check');
  await run.driver.waitFor(`document.querySelector('[data-testid="updates-latest"]')?.innerText.includes(${JSON.stringify(NEW)})`, { label: `Settings to show ${NEW}`, timeoutMs: 60_000 });
  await run.driver.closeSettings();
  await run.driver.waitForVisible('update-notice');
  const found = await readUpdate();
  ev.check(found.available === true && found.latest === NEW && found.signature === 'valid' && found.kid === keys.run.kid && found.installerName === 'DatGoldSetup.exe', `Check now found ${NEW}, signed by key ${keys.run.kid}, with the setup DatGoldSetup.exe`, JSON.stringify(found));
  ev.check(run.feed.requests.every((request) => !/\.exe/i.test(request.url)) && run.feed.checks() === 1, 'one look at the stand-in, and nobody has asked for the setup yet');
  await run.driver.screenshot(ev.file('download-notice.png'));
  ev.check((await run.driver.isDisabled('update-download')) === false, 'Download is offered (the button is there and not disabled)');
  const downloadBegan = Date.now();
  await run.driver.pressTestId('update-download');
  await run.driver.waitForVisible('update-download-ready', { timeoutMs: 300_000 });
  ev.note('download seconds', seconds(downloadBegan));
  const ready = (await readUpdate()).download;
  ev.check(ready?.state === 'ready' && ready.version === NEW, `the Hub says the download of ${NEW} is ready`, JSON.stringify(ready));
  stagedIsGood('the download');
  ev.check(kidOfSignature(fs.readFileSync(signatureFile)) === keys.run.kid, `and the signature file the Hub staged says it was made by key ${keys.run.kid}`);
  ev.check(fs.existsSync(path.join(staged, 'state.json')), 'with the Hub\'s state file beside them');
  await run.driver.waitForVisible('update-apply');
  ev.check((await run.driver.isDisabled('update-apply')) === false, 'Install and restart is offered, inside the desktop shell (the button is there and not disabled)');
  await run.driver.screenshot(ev.file('download-ready.png'));
  if (lastPhase('download')) return;

  // ---------------------------------------------------------------------------------------------------------------------------- negatives
  ev.phase('negatives', 'four refusals; after each the OLD app is still installed and working');
  // 1. a setup of which one byte differs (what a program that runs as the person could do to the folder of updates): the Hub said ready, the shell hashes again
  await refusalByClick({ name: 'tampered setup', code: 'bad_installer', tamper: () => flipByte(installerFile, Math.floor(report.new.bytes / 2)) });
  // 2. a manifest signed by a key that the build does not trust
  await refusalByClick({ name: 'signature of another key', code: 'bad_signature', tamper: () => fs.writeFileSync(signatureFile, otherSignature.bytes) });

  // 3. work that is running: the page holds the button back (a real press on it does nothing), and the shell refuses a message that is posted anyway
  ev.log('--- work that is running');
  const mock = await startMockModel({ scenario: 'canned-answer' });
  closers.push(() => mock.close());
  const workspace = path.join(options.work, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# the workspace of the update proof\n');
  const work = await startRunningWork({ hub, mock, workspace });
  await run.driver.waitForVisible('update-apply-blocked', { timeoutMs: 30_000 });
  ev.check(await run.driver.isDisabled('update-apply'), 'a task is running: the page disables Install and restart and says why');
  const before = (await run.driver.shellMessages()).length;
  await run.driver.pressDisabled('update-apply');
  await sleep(500);
  ev.check((await run.driver.shellMessages()).length === before && !(await run.driver.isVisible('update-apply-confirm')), 'a press on the disabled button asks nothing and sends nothing');
  const [blocked] = await run.driver.postApplyRequests(1);
  const blockedAnswer = await run.driver.shellAnswer(blocked, { timeoutMs: 60_000 });
  ev.check(blockedAnswer.ok === false && blockedAnswer.code === 'tasks_running', 'a message POSTED BY SCRIPT while the task runs: the shell refuses it with tasks_running', JSON.stringify(blockedAnswer));
  await assertOldIntact('work running');
  await work.release();
  await run.driver.waitForGone('update-apply-blocked', { timeoutMs: 30_000 });
  ev.check((await run.driver.isDisabled('update-apply')) === false, 'the task is cancelled and the button is back');
  run.taskIdOfTheProof = work.taskId;

  // 4. a second request while the first is being looked at (the page never sends one: the messages are posted by script, together), against a setup that does not prove itself, so that the OLD app stays
  flipByte(installerFile, Math.floor(report.new.bytes / 2));
  const [one, two] = await run.driver.postApplyRequests(2);
  const answers = [await run.driver.shellAnswer(one, { timeoutMs: 180_000 }), await run.driver.shellAnswer(two, { timeoutMs: 180_000 })];
  ev.check(answers[1].ok === false && answers[1].code === 'busy', 'two messages POSTED BY SCRIPT together: the second gets busy', JSON.stringify(answers));
  ev.check(answers[0].ok === false && answers[0].code === 'bad_installer', 'and the first is looked at on its own and refused for the setup that does not prove itself (bad_installer)', JSON.stringify(answers));
  await assertOldIntact('busy');
  flipByte(installerFile, Math.floor(report.new.bytes / 2));
  stagedIsGood('before the update');
  ev.check((await readUpdate()).download?.state === 'ready', 'the Hub still says ready, and the staged files are the good ones again');
  if (lastPhase('negatives')) return;

  // ---------------------------------------------------------------------------------------------------------------------------- apply
  ev.phase('apply', `Install and restart: the click, the real setup, ${OLD} -> ${NEW} under the running app`);
  // what must survive: the person's data, and the choices the person made about shortcuts
  ev.check(fs.existsSync(gatewayConfigFile), 'the Hub saved the model settings of the person (the stand-in model, from the task that ran)', gatewayConfigFile);
  const gatewayHash = sha256File(gatewayConfigFile);
  fs.rmSync(paths.shortcuts.desktop, { force: true });
  ev.check(!fs.existsSync(paths.shortcuts.desktop), 'the person deletes the Desktop shortcut (the update must not bring it back)');
  const workspaceBefore = (await hub.state()).workspace?.path;
  ev.check(typeof workspaceBefore === 'string' && workspaceBefore.length > 0, 'the Hub has a workspace the person chose', workspaceBefore);
  // where the staged setup really is, written as Windows spells it, asked BEFORE the click: the Hub that starts after the update removes the folder of updates (its start-up cleanup), so the file is gone by the time
  // the run looks at what the setup was started from (the first hosted run failed on exactly that: ENOENT on the realpath of a file that had just done its job)
  const stagedRealPath = fs.realpathSync.native(installerFile);
  const exeBefore = fileIdentity(paths.exe);
  const updateBegan = Date.now();
  const oldShell = run.shell;
  const oldShellPid = run.shellPid;
  const oldShellCreated = run.shellCreated;
  const oldHubPid = run.hubPid;
  const oldHubCreated = run.hubCreated;
  await run.driver.pressTestId('update-apply');
  await run.driver.waitForVisible('update-apply-confirm');
  await run.driver.screenshot(ev.file('apply-confirm.png'));
  const messagesBefore = (await run.driver.shellMessages()).length;
  await run.driver.pressTestId('update-apply-yes');
  ev.log('Install and restart was confirmed; the shell checks the update, starts the setup and closes');

  // the timeline: the setup is seen (with the arguments the shell gave it), the OLD shell exits, the NEW Hub answers. Every look taken while the OLD shell still runs also looks at the installed program:
  // it must still be the OLD file, because the setup waits for the shell to exit before it replaces anything (--wait-pid).
  let installerSeen = null;
  let shellGoneAt = null;
  let newHealth = null;
  let answer = null;
  let looksWhileShellRan = 0;
  let replacedWhileShellRan = false;
  const deadline = Date.now() + 900_000;
  for (;;) {
    if (answer === null && run.cdp.open) {
      let message = null;
      try { message = (await run.driver.shellMessages()).slice(messagesBefore).find((entry) => entry && entry.type === 'chatmcp.update-result') ?? null; } catch { /* the page goes away with the OLD shell */ }
      if (message) {
        answer = message;
        ev.log(`the shell answered the page: ${JSON.stringify(message)}`);
        ev.check(message.ok === true, `the shell accepted the request and started the setup (${message.code})`, JSON.stringify(message));
      }
    }
    if (installerSeen === null) {
      for (const id of processIds('DatGoldSetup.exe')) {
        const info = processInfo(id);
        if (info && /(^|\s)--update(\s|$)/.test(String(info.commandLine))) {
          installerSeen = { pid: id, at: seconds(updateBegan), info };
          ev.log(`the setup is running: pid ${id} ${info.commandLine}`);
          break;
        }
      }
    }
    if (oldShell.exitedAt === null) {
      looksWhileShellRan += 1;
      if (fileIdentity(paths.exe) !== exeBefore) replacedWhileShellRan = true;
    } else if (shellGoneAt === null) {
      shellGoneAt = Number(((oldShell.exitedAt - updateBegan) / 1000).toFixed(1));
      ev.log(`the OLD shell has closed (${shellGoneAt} s after the click, exit code ${oldShell.exitCode})`);
    }
    try {
      const current = await hub.health();
      if (current.version === NEW && current.initialized === true) { newHealth = current; break; }
    } catch { /* the Hub is being replaced */ }
    if (Date.now() >= deadline) throw new Error('The NEW Hub did not answer within 15 minutes of the click.');
    await sleep(1000);
  }
  ev.note('update seconds (click to NEW Hub)', seconds(updateBegan));
  ev.check(oldShell.exitedAt !== null, 'the OLD shell closed itself for the setup (this run never killed it: its own process reported the exit)');
  if (looksWhileShellRan > 0) ev.check(!replacedWhileShellRan, `in each of the ${looksWhileShellRan} looks taken while the OLD shell still ran, the installed ChatMCP.exe was still the OLD file (the setup waits for the shell to exit)`);
  else ev.log('the OLD shell had closed before the first look: no look was taken while it ran');
  ev.check(installerSeen !== null, 'the setup ran, and its command line was read while it ran');
  // compared as Windows spells them (a profile path can be written with 8.3 names in one and in full in the other)
  ev.check(samePath(installerSeen.info.path, stagedRealPath), 'and it was started from the staged file that the shell had hashed', `${installerSeen.info.path} vs ${stagedRealPath}`);
  const words = splitWindowsCommandLine(installerSeen.info.commandLine);
  const expected = ['--quiet', '--update', '--install-dir', paths.installDirectory, '--wait-pid', String(oldShellPid), '--relaunch', '--result', resultFile];
  const given = words.slice(1);
  ev.check(given.length === expected.length && expected.every((word, index) => (index === 3 || index === 8 ? samePath(given[index], word) : given[index] === word)),
    'with exactly the arguments of the contract, word by word (--quiet --update --install-dir <the installation> --wait-pid <the OLD shell> --relaunch --result <the Hub\'s folder>\\update-result.json)', installerSeen.info.commandLine);
  ev.check(newHealth.auth === 'bearer', `the Hub that answers is ${NEW}, and it requires its session secret`);

  // the NEW app: another program than the OLD one, started after the click, from the installed file, by the setup and not by this run
  let newShell = null;
  for (let attempt = 0; attempt < 60 && newShell === null; attempt += 1) {
    for (const id of processIds('ChatMCP.exe')) {
      if (id === oldShellPid) continue;
      const info = processInfo(id);
      if (info && samePath(info.path, paths.exe)) { newShell = { pid: id, info }; break; }
    }
    if (newShell === null) await sleep(1000);
  }
  ev.check(newShell !== null, 'the setup opened the NEW app (a new ChatMCP.exe of the installation)');
  run.shellPid = newShell.pid;
  run.shellCreated = newShell.info.created;
  ev.check(!isSameProcessRunning(oldShellPid, oldShellCreated) && oldShell.exitedAt !== null && newShell.info.created !== oldShellCreated, 'the OLD shell is gone, and the NEW one is not the same process');
  ev.check(createdAt(newShell.info) > updateBegan - 5000, 'the NEW one was started after the click', newShell.info.created);
  ev.check(newShell.info.parentProcessId !== process.pid && newShell.info.parentProcessId !== oldShellPid, `and not by this run or by the OLD shell (its parent is process ${newShell.info.parentProcessId}, the setup is ${installerSeen.pid})`);
  ev.note('new shell parent / setup', `${newShell.info.parentProcessId} / ${installerSeen.pid}`);
  const newSession = await hub.session();
  const newHubProcess = processInfo(newSession.pid);
  ev.check(newHubProcess !== null && newHubProcess.created !== oldHubCreated && samePath(newHubProcess.path, paths.node) && String(newHubProcess.commandLine).toLowerCase().includes(path.join(paths.installDirectory, 'CHATMCP-HUB', 'hub.mjs').toLowerCase()),
    `the Hub is a new process (${oldHubPid} -> ${newSession.pid}, another start time) of the installed node.exe running the installed hub.mjs`, JSON.stringify(newHubProcess));
  ev.check(!isSameProcessRunning(oldHubPid, oldHubCreated), `and the OLD Hub (pid ${oldHubPid}) is gone: the setup stopped it`);
  run.hubPid = newSession.pid;
  run.hubCreated = newHubProcess.created;
  if (lastPhase('apply')) return;

  // ---------------------------------------------------------------------------------------------------------------------------- after
  ev.phase('after', 'what runs, what the person sees once, what is left');
  run.cdp.close();
  try {
    await attach('the page of the NEW shell');
  } catch (error) {
    await diagnostics(`no debugging connection to the NEW shell: ${error.message}`);
    throw error;
  }
  await run.driver.waitFor("document.querySelector('#root header')", { timeoutMs: 120_000, label: 'the Studio of the NEW app' });
  await run.driver.recordShellMessages();
  ev.check(windowTitle(run.shellPid).includes(`DatGold Studio ${NEW}`), `the title bar of the NEW app says DatGold Studio ${NEW}`, windowTitle(run.shellPid));
  ev.check(versionInfo(paths.exe).productVersion.split('+')[0] === NEW, `the program on disk is ${NEW}`);
  ev.check(JSON.parse(fs.readFileSync(paths.hubPackage, 'utf8')).version === NEW, `the Hub package on disk is ${NEW}`);
  ev.check(String(registryValue(paths.uninstallKey, 'DisplayVersion')) === NEW, `Windows Installed Apps says ${NEW}`);
  ev.check((await readUpdate()).current === NEW, `the Hub that runs says it is ${NEW}`);
  ev.check(fs.readFileSync(path.join(paths.installDirectory, 'CHATMCP-HUB', 'lib', 'release-keys.json')).equals(fs.readFileSync(keys.run.listFile)), 'the NEW installation still trusts exactly the key list of the run');

  // "Updated to ...": shown once, then consumed
  await run.driver.waitForVisible('update-applied', { timeoutMs: 60_000 });
  const applied = (await readUpdate()).applied;
  ev.check(applied?.ok === true && applied.version === NEW && applied.previous === OLD && applied.state === 'installed' && applied.reason === null && applied.rolledBack === false, `the Hub tells the page "updated to ${NEW}" (from ${OLD}, state installed)`, JSON.stringify(applied));
  const strip = (await run.driver.text('update-applied-text')) ?? '';
  ev.check(strip.includes(NEW), 'and the strip names the version', strip);
  await run.driver.screenshot(ev.file('after-applied.png'));
  ev.check(!fs.existsSync(resultFile), 'the result file was consumed when the Hub started');
  await run.driver.pressTestId('update-applied-dismiss');
  await run.driver.waitForGone('update-applied');
  ev.check(((await readUpdate()).applied ?? null) === null, 'the person read it and dismissed it: the Hub forgets it');

  // nothing is left behind
  ev.check(leftovers(paths.installDirectory, /^\.chatmcp-update-pending\.json$/).length === 0, 'no marker of an unfinished update');
  ev.check(leftovers(paths.installDirectory, /^\.ChatMCP-update-/).length === 0, 'no backup folder of the update in the installation');
  await eventually(`the Hub that started after the update cleared the staged files of ${NEW} (the version that runs now needs no setup)`, () => !fs.existsSync(staged) && leftovers(updatesDirectory, /^\d+\.\d+\.\d+/).length === 0);
  ev.check(leftovers(updatesDirectory, /\.part$/).length === 0 && processIds('DatGoldSetup.exe').length === 0, 'no part of a download and no setup still running');

  // the shortcuts, as the person left them
  ev.check(fs.existsSync(paths.shortcuts.start) && fs.existsSync(paths.shortcuts.uninstall), 'the Start menu shortcuts (DatGold Studio, Uninstall DatGold Studio) are there');
  ev.check(!fs.existsSync(paths.shortcuts.desktop), 'the Desktop shortcut that the person deleted is not brought back');

  // the person's data
  ev.check(fs.readFileSync(path.join(paths.dataDirectory, 'unrelated-user-state.txt'), 'utf8') === 'PRESERVE-STATE' && fs.readFileSync(path.join(paths.hubDirectory, 'canary-before-update.txt'), 'utf8') === 'PRESERVE-HUB-DATA', 'the files that the person (this run) left in the data folder are as they were');
  const stateAfter = await hub.state();
  ev.check(stateAfter.workspace?.path === workspaceBefore, 'the workspace the person chose is still chosen', `${stateAfter.workspace?.path} vs ${workspaceBefore}`);
  ev.check(stateAfter.agent.tasks.some((task) => task.id === run.taskIdOfTheProof), 'and the task of the person is still in the Hub\'s history');
  ev.check(fs.existsSync(gatewayConfigFile) && sha256File(gatewayConfigFile) === gatewayHash, 'the model settings the Hub saved (gateway\\gateway-config.json in the data folder) are byte for byte what they were');
  ev.check(await run.driver.evaluate("localStorage.getItem('chatmcp:onboarding-completed') === '1' && localStorage.getItem('chatmcp:language') === 'en'"), 'the settings the page keeps for itself (set in the OLD window, read in the NEW one: the WebView2 profile) survived');

  // "once": a Hub that starts again finds no note
  ev.log('--- once: the app is closed, the Hub is stopped, the app is started again');
  ev.log(`asked the NEW app to close (taskkill without /F): ${closeGracefully(run.shellPid) ? 'Windows took the request' : 'Windows did not take the request'}`);
  ev.check(await waitForExit(run.shellPid, 30_000), 'the NEW app closed when asked');
  const stop = spawnSync(system32('cmd.exe'), ['/c', path.join(paths.installDirectory, 'CHATMCP-HUB', 'STOP-CHATMCP-HUB.cmd'), '-Port', String(HUB_PORT)], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  ev.check(stop.status === 0, 'the NEW Hub stopped through its own stop script', `${stop.status} ${stop.stdout} ${stop.stderr}`.slice(0, 300));
  startApp('the NEW app again');
  await waitForHub(NEW, 120_000, `the Hub ${NEW} again`);
  ev.check(((await readUpdate()).applied ?? null) === null, 'a Hub that starts again does not announce the update again');
  run.cdp.close();
  await attach('the page of the NEW app, started again');
  await run.driver.waitFor("document.querySelector('#root header')", { timeoutMs: 120_000, label: 'the Studio again' });
  await sleep(3000);
  ev.check(!(await run.driver.isVisible('update-applied')), 'and the page, three seconds after it was drawn, shows no "Updated to" strip');
  ev.check(run.feed.requests.every((request) => request.url.startsWith('/pddczpl/ChatMCP/releases/') || request.url.startsWith('/github-production-release-asset/')), 'every request that reached the stand-in was for a release file, at a path GitHub would serve it from', run.feed.requests.map((request) => request.url.split('?')[0]).join(' '));
}

// ---- the end: what was started is stopped, what was set is cleared; the same for a signal and for a crash ---------------------------------------------------------
/** Puts the machine back: the programs of the installation closed, its Hub stopped by its own script, the WebView2 policy removed. Synchronous, so that a signal or a crash can run it as well. */
function tearDownMachine() {
  try { run.cdp?.close(); } catch { /* none */ }
  try { clearDebugPolicy(); } catch { /* none */ }
  try {
    for (const id of processIds('ChatMCP.exe')) killTree(id);
    const stopScript = path.join(paths.installDirectory, 'CHATMCP-HUB', 'STOP-CHATMCP-HUB.cmd');
    if (fs.existsSync(stopScript)) spawnSync(system32('cmd.exe'), ['/c', stopScript, '-Port', String(HUB_PORT)], { stdio: 'ignore', timeout: 120_000, windowsHide: true });
  } catch { /* best effort */ }
}

let finished = false;
function stopEverything(reason, exitCode) {
  if (finished) return;
  finished = true;
  console.error(`\n[${ev.elapsed()}s] ${reason}: putting the machine back`);
  tearDownMachine();
  try { ev.finish('interrupted', new Error(reason)); } catch { /* none */ }
  process.exit(exitCode);
}
for (const signal of ['SIGINT', 'SIGBREAK', 'SIGTERM']) process.on(signal, () => stopEverything(`stopped by ${signal}`, 1));
process.on('uncaughtException', (error) => stopEverything(`an error that nothing caught: ${error?.stack ?? error}`, 1));
process.on('unhandledRejection', (error) => stopEverything(`a rejection that nothing caught: ${error?.stack ?? error}`, 1));

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  console.error(`\n[${ev.elapsed()}s] RUN FAILED: ${error?.stack ?? error}`);
  try { await diagnostics(String(error?.message ?? error)); } catch (diagnosticError) { console.error(`diagnostics failed: ${diagnosticError.message}`); }
} finally {
  finished = true;
  for (const close of closers.reverse()) { try { await close(); } catch (error) { console.error(`clean-up: ${error.message}`); } }
  tearDownMachine();
  const report = ev.finish(failure ? 'failed' : 'passed', failure);
  console.log(`\n[${ev.elapsed()}s] ${failure ? 'FAILED' : 'PASSED'}: ${report.checks.filter((check) => check.ok).length} checks passed${failure ? `, then: ${failure.message}` : ''}`);
  process.exitCode = failure ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 1000).unref();
}
