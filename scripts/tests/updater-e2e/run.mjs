#!/usr/bin/env node
// The end-to-end proof of the in-app updater, on a GitHub-hosted Windows runner (the CI job "Windows in-app updater, end to end"). It installs a real OLD setup, starts the real desktop shell and Hub, and drives the
// page inside the shell's WebView2 with REAL mouse presses to Download and to Install and restart; the shell checks the update with its own C#, starts the real NEW setup in update mode, the setup replaces the
// files under the running app and opens the NEW app. Then the facts that nobody has seen so far are checked, and the refusals (a tampered setup, a manifest signed by another key, work that is running, a
// second request) are made to happen to the OLD app, which must stay installed and working.
//
//     node scripts/tests/updater-e2e/run.mjs --work <folder of Build-TestPair.ps1> --keys <folder of make-keys.mjs> --evidence <folder> [--until <phase>]
//
// Phases, in order: prepare, install, attach, download, negatives, apply, after. Everything is a test of THIS commit's code: the setups are built from it (scripts/tests/updater-e2e/Build-TestPair.ps1, with a
// throwaway key list, versions given at build time, nothing published); GitHub is a stand-in on a loopback port (tests/e2e/update-feed-server.mjs) that the installed Hub reads through the one variable that
// exists for it (CHATMCP_UPDATE_FEED_URL, loopback addresses only: lib/update-check.mjs, docs/THREAT-MODEL.md Surface 8); the page of the installed shell is reached through a debugging port that a WebView2 policy
// of this disposable runner opens for ChatMCP.exe, as scripts/tests/windows-installer/guest-lifecycle.ps1 does in its sandbox.
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
  assertDisposableRunner, clearDebugPolicy, debugPolicyValue, installedPaths, isRunning, killTree, leftovers, powershell, processIds, processInfo, registryValue, setDebugPolicy,
  sha256File, versionInfo, waitForExit, windowTitle,
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
const ev = new Evidence(path.resolve(options.evidence));
const paths = installedPaths();
const hub = new HubClient({ origin: HUB_ORIGIN, stateDirectory: paths.hubDirectory });
const cleanups = [];
// the state of the run, which a failure reads to say what it can
const run = { feed: null, cdpPort: 0, cdp: null, driver: null, shellPid: 0, hubPid: 0, appEnvironment: null };

const readUpdate = async () => (await hub.state()).update;

async function waitForHub(version, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  for (;;) {
    try {
      const health = await hub.health();
      last = `version ${health.version}, initialized ${health.initialized}`;
      if (health.version === version && health.initialized === true) return health;
    } catch (error) { last = error?.cause?.code ?? error?.message ?? String(error); }
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label} (last: ${last})`);
    await sleep(500);
  }
}

function startApp(label) {
  const child = spawn(paths.exe, [], { env: run.appEnvironment, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
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
  safe(`ports ${run.cdpPort} and ${HUB_PORT}`, () => spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter((line) => line.includes(`:${run.cdpPort} `) || line.includes(`:${HUB_PORT} `)).join(' | '));
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

async function main() {
  const report = JSON.parse(fs.readFileSync(path.join(options.work, 'build-report.json'), 'utf8'));
  const keys = JSON.parse(fs.readFileSync(path.join(options.keys, 'keys.json'), 'utf8'));
  const OLD = report.old.version;
  const NEW = report.new.version;
  const staged = path.join(paths.hubDirectory, 'updates', NEW);
  const installerFile = path.join(staged, 'DatGoldSetup.exe');
  const signatureFile = path.join(staged, 'RELEASE-MANIFEST.json.sig');
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
    ev.check(isRunning(run.shellPid), `${label}: the OLD desktop shell is still running (pid ${run.shellPid})`);
    const health = await hub.health();
    ev.check(health.version === OLD && health.initialized === true && (await hub.session()).pid === run.hubPid, `${label}: the OLD Hub still answers, the same process (pid ${run.hubPid})`);
    ev.check(run.cdp.open && (await run.driver.evaluate('1 + 1')) === 2, `${label}: the page in the OLD window is still there and answers`);
    ev.check((await readUpdate()).download?.state === 'ready', `${label}: and the Hub still says the download is ready`);
    ev.check(leftovers(paths.installDirectory, /^\.chatmcp-update-pending\.json$|^\.ChatMCP-update-/).length === 0, `${label}: no marker and no backup of an update in the installation`);
    ev.check(!fs.existsSync(path.join(paths.hubDirectory, 'update-result.json')), `${label}: no result file of an update`);
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
  await assertDisposableRunner({ paths, hubPort: HUB_PORT });
  ev.check(true, 'this is a disposable GitHub-hosted runner: nothing of DatGold is installed, nothing listens on port 3007');
  ev.note('node', process.version);
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
  ev.check(!signature.bytes.equals(otherSignature.bytes), `the manifest of ${NEW} is signed by scripts/sign-release.mjs with key ${keys.run.kid} (and, for the refusal, with another key ${keys.other.kid})`);
  run.feed = await startUpdateFeed({ manifest: feedManifest({ version: NEW }) });
  cleanups.push(() => run.feed.close());
  run.feed.publish(feedManifest({ version: NEW }), { raw: manifestBytes });
  run.feed.signature.set(signature.bytes);
  run.feed.signature.mode('chain');
  run.feed.installer.set({ name: 'DatGoldSetup.exe', bytes: newBytes });
  ev.check(run.feed.url.startsWith('http://127.0.0.1:'), `the stand-in for GitHub is on ${run.feed.origin} (loopback)`);
  run.cdpPort = await freePort();
  setDebugPolicy(run.cdpPort);
  cleanups.push(() => clearDebugPolicy());
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
    const install = spawn(report.old.path, ['--quiet', '--install-dir', paths.installDirectory], { stdio: 'ignore', windowsHide: true });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { killTree(install.pid); resolve('timeout'); }, 600_000);
      install.once('close', (status) => { clearTimeout(timer); resolve(status); });
    });
    ev.note('old install seconds', Number(((Date.now() - began) / 1000).toFixed(1)));
    ev.check(code === 0, 'the OLD setup installed (exit code 0)', `exit ${code}`);
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
  run.shellPid = startApp('the OLD app');
  const health = await waitForHub(OLD, 120_000, `the Hub ${OLD} that the shell starts`);
  ev.check(health.auth === 'bearer', `the Hub ${OLD} is up on port ${HUB_PORT} and requires its session secret`);
  run.hubPid = (await hub.session()).pid;
  const hubProcess = processInfo(run.hubPid);
  ev.check(hubProcess?.path?.toLowerCase() === paths.node.toLowerCase() && String(hubProcess.commandLine).toLowerCase().includes(path.join(paths.installDirectory, 'CHATMCP-HUB', 'hub.mjs').toLowerCase()), 'the Hub is the installed one (the installed node.exe runs the installed hub.mjs)', JSON.stringify(hubProcess));
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
  await run.driver.openSettings('Updates');
  await run.driver.waitForVisible('updates-check');
  await run.driver.screenshot(ev.file('attach-settings.png'));
  ev.check(true, 'a real mouse press opened Settings and its Updates section in the installed shell (trusted clicks)');
  await run.driver.closeSettings();
  const first = await readUpdate();
  ev.check(first.current === OLD && first.autoCheck?.needsChoice === true && run.feed.requests.length === 0, `the OLD Hub knows it is ${OLD}, has not been asked whether to check by itself, and has made no request`, JSON.stringify(first.autoCheck));
  if (lastPhase('attach')) return;

  // ---------------------------------------------------------------------------------------------------------------------------- download
  ev.phase('download', 'answer No, Check now, Download: all with real presses');
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
  ev.check(!(await run.driver.isDisabled('update-download')), 'Download is offered');
  const downloadBegan = Date.now();
  await run.driver.pressTestId('update-download');
  await run.driver.waitForVisible('update-download-ready', { timeoutMs: 300_000 });
  ev.note('download seconds', Number(((Date.now() - downloadBegan) / 1000).toFixed(1)));
  const ready = (await readUpdate()).download;
  ev.check(ready?.state === 'ready' && ready.version === NEW, `the Hub says the download of ${NEW} is ready`, JSON.stringify(ready));
  stagedIsGood('the download');
  ev.check(fs.existsSync(path.join(staged, 'state.json')), 'with the Hub\'s state file beside them');
  await run.driver.waitForVisible('update-apply');
  ev.check(!(await run.driver.isDisabled('update-apply')), 'Install and restart is offered, inside the desktop shell');
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
  cleanups.push(() => mock.close());
  const workspace = path.join(options.work, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# the workspace of the update proof\n');
  const work = await startRunningWork({ hub, mock, workspace });
  await run.driver.waitForVisible('update-apply-blocked', { timeoutMs: 30_000 });
  ev.check(await run.driver.isDisabled('update-apply'), 'a task is running: the page disables Install and restart and says why');
  const before = (await run.driver.shellMessages()).length;
  await run.driver.pressDisabled('update-apply');
  await sleep(500);
  ev.check((await run.driver.shellMessages()).length === before && !(await run.driver.isVisible('update-apply-confirm')), 'a real press on the disabled button asks nothing and sends nothing');
  const [blocked] = await run.driver.postApplyRequests(1);
  const blockedAnswer = await run.driver.shellAnswer(blocked, { timeoutMs: 60_000 });
  ev.check(blockedAnswer.ok === false && blockedAnswer.code === 'tasks_running', 'a message POSTED BY SCRIPT while the task runs: the shell refuses it with tasks_running', JSON.stringify(blockedAnswer));
  await assertOldIntact('work running');
  await work.release();
  await run.driver.waitForGone('update-apply-blocked', { timeoutMs: 30_000 });
  ev.check(!(await run.driver.isDisabled('update-apply')), 'the task is cancelled and the button is back');
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
  ev.phase('apply', `Install and restart: the real click, the real setup, ${OLD} -> ${NEW} under the running app`);
  // what must survive: the person's data, and the choices the person made about shortcuts
  const profilesFile = path.join(paths.installDirectory, 'CHATMCP-HUB', 'ai-profiles.json');
  const profilesHash = fs.existsSync(profilesFile) ? sha256File(profilesFile) : null;
  fs.rmSync(paths.shortcuts.desktop, { force: true });
  ev.check(!fs.existsSync(paths.shortcuts.desktop), 'the person deletes the Desktop shortcut (the update must not bring it back)');
  const workspaceBefore = (await hub.state()).workspace?.path;
  ev.check(typeof workspaceBefore === 'string' && workspaceBefore.length > 0, 'the Hub has a workspace the person chose', workspaceBefore);
  const updateBegan = Date.now();
  const oldShellPid = run.shellPid;
  await run.driver.pressTestId('update-apply');
  await run.driver.waitForVisible('update-apply-confirm');
  await run.driver.screenshot(ev.file('apply-confirm.png'));
  await run.driver.pressTestId('update-apply-yes');
  ev.log('Install and restart was confirmed; the shell checks the update, starts the setup and closes');

  // the timeline: the shell goes, the setup is seen (with the arguments the shell gave it), the NEW Hub answers
  let installerSeen = null;
  let shellGoneAt = null;
  let newHealth = null;
  const deadline = Date.now() + 900_000;
  for (;;) {
    if (installerSeen === null) {
      const ids = processIds('DatGoldSetup.exe');
      if (ids.length) {
        const info = processInfo(ids[0]);
        installerSeen = { pid: ids[0], at: Number(((Date.now() - updateBegan) / 1000).toFixed(1)), info };
        ev.log(`the setup is running: pid ${ids[0]} ${info?.commandLine ?? '(command line not readable)'}`);
      }
    }
    if (shellGoneAt === null && !isRunning(oldShellPid)) { shellGoneAt = Number(((Date.now() - updateBegan) / 1000).toFixed(1)); ev.log(`the OLD shell has closed (${shellGoneAt} s after the click)`); }
    try {
      const current = await hub.health();
      if (current.version === NEW && current.initialized === true) { newHealth = current; break; }
    } catch { /* the Hub is being replaced */ }
    if (Date.now() >= deadline) throw new Error('The NEW Hub did not answer within 15 minutes of the click.');
    await sleep(1000);
  }
  ev.note('update seconds (click to NEW Hub)', Number(((Date.now() - updateBegan) / 1000).toFixed(1)));
  ev.check(shellGoneAt !== null, 'the OLD shell closed itself for the setup (it was not killed by this run)');
  ev.check(installerSeen !== null, 'the setup ran');
  if (installerSeen?.info) {
    const command = String(installerSeen.info.commandLine);
    // compared as Windows spells them (a profile path can be written with 8.3 names in one and in full in the other)
    ev.check(String(installerSeen.info.path).toLowerCase() === fs.realpathSync.native(installerFile).toLowerCase(), 'and it was started from the staged file that the shell had hashed', `${installerSeen.info.path} vs ${installerFile}`);
    ev.check(command.includes('--quiet') && command.includes('--update') && command.includes('--install-dir') && command.includes(`--wait-pid ${oldShellPid}`) && command.includes('--relaunch') && command.includes('--result') && command.includes('update-result.json'),
      'with the arguments of the contract (--quiet --update --install-dir --wait-pid <the shell> --relaunch --result <the Hub\'s folder>\\update-result.json)', command);
  }
  ev.check(newHealth.auth === 'bearer', `the Hub that answers is ${NEW}, and it requires its session secret`);

  // the NEW app: another program than the OLD one, started after the click, from the installed file
  let newShell = null;
  for (let attempt = 0; attempt < 60 && newShell === null; attempt += 1) {
    for (const id of processIds('ChatMCP.exe')) {
      if (id === oldShellPid) continue;
      const info = processInfo(id);
      if (info?.path?.toLowerCase() === paths.exe.toLowerCase()) { newShell = { pid: id, info }; break; }
    }
    if (newShell === null) await sleep(1000);
  }
  ev.check(newShell !== null, 'the setup opened the NEW app (a new ChatMCP.exe of the installation)');
  run.shellPid = newShell.pid;
  ev.check(!isRunning(oldShellPid), 'the OLD shell is gone');
  ev.check(Date.parse(newShell.info.created) > updateBegan - 5000, 'and the NEW one was started after the click', newShell.info.created);
  const newSession = await hub.session();
  const newHubProcess = processInfo(newSession.pid);
  ev.check(newSession.pid !== run.hubPid && newHubProcess?.path?.toLowerCase() === paths.node.toLowerCase(), `the Hub is a new process (${run.hubPid} -> ${newSession.pid}) of the installed node.exe`);
  run.hubPid = newSession.pid;
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
  const words = (await run.driver.text('update-applied-text')) ?? '';
  ev.check(words.includes(NEW), 'and the strip names the version', words);
  await run.driver.screenshot(ev.file('after-applied.png'));
  ev.check(!fs.existsSync(path.join(paths.hubDirectory, 'update-result.json')), 'the result file was consumed when the Hub started');
  await run.driver.pressTestId('update-applied-dismiss');
  await run.driver.waitForGone('update-applied');
  ev.check(((await readUpdate()).applied ?? null) === null, 'the person read it and dismissed it: the Hub forgets it');

  // nothing is left behind
  ev.check(leftovers(paths.installDirectory, /^\.chatmcp-update-pending\.json$/).length === 0, 'no marker of an unfinished update');
  ev.check(leftovers(paths.installDirectory, /^\.ChatMCP-update-/).length === 0, 'no backup folder of the update in the installation');
  ev.check(leftovers(path.join(paths.hubDirectory, 'updates'), /\.part$/).length === 0 && processIds('DatGoldSetup.exe').length === 0, 'no part of a download and no setup still running');

  // the shortcuts, as the person left them
  ev.check(fs.existsSync(paths.shortcuts.start) && fs.existsSync(paths.shortcuts.uninstall), 'the Start menu shortcuts (DatGold Studio, Uninstall DatGold Studio) are there');
  ev.check(!fs.existsSync(paths.shortcuts.desktop), 'the Desktop shortcut that the person deleted is not brought back');

  // the person's data
  ev.check(fs.readFileSync(path.join(paths.dataDirectory, 'unrelated-user-state.txt'), 'utf8') === 'PRESERVE-STATE' && fs.readFileSync(path.join(paths.hubDirectory, 'canary-before-update.txt'), 'utf8') === 'PRESERVE-HUB-DATA', 'the files that the person (this run) left in the data folder are as they were');
  const stateAfter = await hub.state();
  ev.check(stateAfter.workspace?.path === workspaceBefore, 'the workspace the person chose is still chosen', `${stateAfter.workspace?.path} vs ${workspaceBefore}`);
  ev.check(stateAfter.agent.tasks.some((task) => task.id === run.taskIdOfTheProof), 'and the task of the person is still in the Hub\'s history');
  ev.check(profilesHash === null || (fs.existsSync(profilesFile) && sha256File(profilesFile) === profilesHash), 'the model settings the Hub wrote in the installation are byte for byte what they were');
  ev.check(await run.driver.evaluate("localStorage.getItem('chatmcp:onboarding-completed') === '1' && localStorage.getItem('chatmcp:language') === 'en'"), 'the page\'s own settings (in the WebView2 profile) survived');
  ev.check(fs.existsSync(path.join(paths.dataDirectory, 'webview2-data')), 'and so did the WebView2 profile');

  // "once": a Hub that starts again finds no note
  ev.log('--- once: the app is closed, the Hub is stopped, the app is started again');
  spawnSync('taskkill', ['/PID', String(run.shellPid)], { stdio: 'ignore', timeout: 30_000 });
  ev.check(await waitForExit(run.shellPid, 30_000), 'the NEW app closed when asked');
  const stop = spawnSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/c', path.join(paths.installDirectory, 'CHATMCP-HUB', 'STOP-CHATMCP-HUB.cmd'), '-Port', String(HUB_PORT)], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  ev.check(stop.status === 0, 'the NEW Hub stopped through its own stop script', `${stop.status} ${stop.stdout} ${stop.stderr}`.slice(0, 300));
  run.shellPid = startApp('the NEW app again');
  await waitForHub(NEW, 120_000, `the Hub ${NEW} again`);
  ev.check(((await readUpdate()).applied ?? null) === null, 'a Hub that starts again does not announce the update again');
  run.cdp.close();
  await attach('the page of the NEW app, started again');
  await run.driver.waitFor("document.querySelector('#root header')", { timeoutMs: 120_000, label: 'the Studio again' });
  ev.check(!(await run.driver.isVisible('update-applied')), 'and the page shows no "Updated to" strip');
  ev.check(run.feed.requests.every((request) => request.url.startsWith('/pddczpl/ChatMCP/releases/') || request.url.startsWith('/github-production-release-asset/')), 'every request the Hubs made went to the stand-in, at the paths of the release files', run.feed.requests.map((request) => request.url.split('?')[0]).join(' '));
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  console.error(`\n[${ev.elapsed()}s] RUN FAILED: ${error?.stack ?? error}`);
  try { await diagnostics(String(error?.message ?? error)); } catch (diagnosticError) { console.error(`diagnostics failed: ${diagnosticError.message}`); }
} finally {
  try { run.cdp?.close(); } catch { /* none */ }
  for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { console.error(`cleanup: ${error.message}`); } }
  try {
    for (const id of processIds('ChatMCP.exe')) killTree(id);
    const stopScript = path.join(paths.installDirectory, 'CHATMCP-HUB', 'STOP-CHATMCP-HUB.cmd');
    if (fs.existsSync(stopScript)) spawnSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/c', stopScript, '-Port', String(HUB_PORT)], { stdio: 'ignore', timeout: 120_000, windowsHide: true });
  } catch { /* best effort */ }
  const report = ev.finish(failure ? 'failed' : 'passed', failure);
  console.log(`\n[${ev.elapsed()}s] ${failure ? 'FAILED' : 'PASSED'}: ${report.checks.filter((check) => check.ok).length} checks passed${failure ? `, then: ${failure.message}` : ''}`);
  process.exitCode = failure ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 1000).unref();
}
