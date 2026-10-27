// What the proof asks of Windows: where an installed DatGold lives, which programs run, the policy that opens a debugging port of WebView2 for the installed shell, and the few facts the proof reads from
// files and the registry. It is for a disposable hosted runner (assertHostedRunnerEnvironment and assertDisposableRunner refuse anything else), the way scripts/tests/Test-NativeLifecycle.ps1 is.
//
// The programs it starts are Windows' own, by their full path in System32 and never through PATH: reg.exe, tasklist.exe, taskkill.exe, netstat.exe and Windows PowerShell 5.1 (always with
// `env: powerShellChildEnvironment()`, tests/verify-source-lint.mjs holds every node file that names powershell.exe to that: a pwsh session hands its module path on, and Windows PowerShell then loses
// Get-FileHash).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { powerShellChildEnvironment, windowsPowerShellPath } from '../../../../CHATMCP-HUB/tests/support/powershell-environment.mjs';

const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
/** The full path of a program of Windows' own (cmd.exe, netstat.exe ...), so that nothing a PATH could put first is ever started. */
export const system32 = (name) => path.join(SYSTEM32, name);

/** Runs `script` in Windows PowerShell 5.1 and returns what it printed (trimmed). Throws, with what it said, when it fails. */
export function powershell(script, { timeoutMs = 90_000 } = {}) {
  const done = spawnSync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: powerShellChildEnvironment(), maxBuffer: 16 * 1024 * 1024,
  });
  if (done.status !== 0) throw new Error(`PowerShell failed (exit ${done.status}): ${String(done.stderr || done.stdout).trim().slice(0, 600)}`);
  return String(done.stdout).trim();
}

/** Where DatGold lives for the account that runs this (what installer/InstallerEngine.cs and the lifecycle script use). */
export function installedPaths(env = process.env) {
  const local = env.LOCALAPPDATA;
  if (!local) throw new Error('LOCALAPPDATA is not set.');
  const folders = JSON.parse(powershell("ConvertTo-Json -Compress ([ordered]@{ desktop = [Environment]::GetFolderPath('Desktop'); programs = [Environment]::GetFolderPath('Programs') })"));
  const installDirectory = path.join(local, 'Programs', 'ChatMCP');
  const dataDirectory = path.join(local, 'ChatMCP');
  return {
    installDirectory, dataDirectory,
    hubDirectory: path.join(dataDirectory, 'hub'),
    exe: path.join(installDirectory, 'ChatMCP.exe'),
    node: path.join(installDirectory, 'runtimes', 'node', 'node.exe'),
    hubPackage: path.join(installDirectory, 'CHATMCP-HUB', 'package.json'),
    uninstallKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ChatMCP',
    shortcuts: {
      desktop: path.join(folders.desktop, 'DatGold Studio.lnk'),
      start: path.join(folders.programs, 'DatGold', 'DatGold Studio.lnk'),
      uninstall: path.join(folders.programs, 'DatGold', 'Uninstall DatGold Studio.lnk'),
    },
  };
}

/** Whether something listens on 127.0.0.1:`port` (it is tried, not looked up: a listener of any user counts). */
export function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error?.code === 'EADDRINUSE'));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(false)));
  });
}

/**
 * The first thing the proof (run.mjs) and the policy of the rehearsal (rehearse-page.mjs --policy) ask: is this a GitHub-hosted Windows runner that is not running a publish workflow? They install, update and
 * force-close DatGold, and write a machine-wide WebView2 policy, so on any other machine, a developer's above all, they do nothing: this reads `env` and `platform` and nothing else (no file, no program),
 * and throws with every reason it found, in the words of a refusal. The variables are the ones GitHub Actions sets on its own runners; a self-hosted runner says RUNNER_ENVIRONMENT=self-hosted.
 */
export function assertHostedRunnerEnvironment({ env = process.env, platform = process.platform } = {}) {
  const problems = [];
  if (platform !== 'win32') problems.push('this is not Windows');
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted') problems.push(`this is not a GitHub-hosted runner (GITHUB_ACTIONS=${env.GITHUB_ACTIONS}, RUNNER_ENVIRONMENT=${env.RUNNER_ENVIRONMENT})`);
  if (/^Publish/i.test(env.GITHUB_WORKFLOW ?? '')) problems.push('this is a publish workflow: nothing here may run in one');
  if (problems.length) throw new Error(`Refusing to run: ${problems.join('; ')}. This test installs and updates DatGold for real and runs only on a disposable GitHub-hosted runner.`);
}

/**
 * The proof installs and updates DatGold for real, so it runs only where nothing of anyone's can be lost: a GitHub-hosted runner (assertHostedRunnerEnvironment, asked first), with no installation, no data
 * folder and nothing on the port of the Hub. Throws with every reason it found.
 */
export async function assertDisposableRunner({ env = process.env, platform = process.platform, paths = null, hubPort = 3007 } = {}) {
  assertHostedRunnerEnvironment({ env, platform });
  const where = paths ?? installedPaths(env);
  const problems = [];
  if (fs.existsSync(where.installDirectory)) problems.push(`${where.installDirectory} exists`);
  if (fs.existsSync(where.dataDirectory)) problems.push(`${where.dataDirectory} exists`);
  if (registryHas(where.uninstallKey)) problems.push(`${where.uninstallKey} exists`);
  if (await portInUse(hubPort)) problems.push(`port ${hubPort} is in use`);
  if (problems.length) throw new Error(`Refusing to run: ${problems.join('; ')}. This test installs and updates DatGold for real and runs only on a disposable GitHub-hosted runner.`);
}

// ------------------------------------------------------------------------------------------------------------------------------- the registry

function reg(args) {
  const done = spawnSync(path.join(SYSTEM32, 'reg.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { status: done.status, stdout: String(done.stdout ?? ''), stderr: String(done.stderr ?? '') };
}
export const registryHas = (key) => reg(['query', key]).status === 0;
/** The data of the value `name` of `key`, or null. */
export function registryValue(key, name) {
  const done = reg(['query', key, '/v', name]);
  if (done.status !== 0) return null;
  const line = done.stdout.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${name} `) || entry.trim().startsWith(name + '\t'));
  return line ? line.trim().split(/\s{2,}|\t/).slice(2).join(' ').trim() : null;
}

const POLICY_KEY = 'HKLM\\Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';

/**
 * The documented policy that gives the browser arguments to the WebView2 of ONE program, here a debugging port for ChatMCP.exe. A newer WebView2 ignores the environment variable for a host that runs
 * elevated (a hosted runner's account does), and honours this policy; scripts/tests/windows-installer/guest-lifecycle.ps1 does the same in its Windows Sandbox. It is a setting of the disposable runner,
 * removed again by clearDebugPolicy when the proof ends.
 */
export function setDebugPolicy(port, program = 'ChatMCP.exe') {
  const done = reg(['add', POLICY_KEY, '/v', program, '/t', 'REG_SZ', '/d', `--remote-debugging-port=${port}`, '/f']);
  if (done.status !== 0) throw new Error(`The WebView2 policy could not be written (${done.stderr.trim().slice(0, 200)}). Is this account an administrator?`);
}
export function clearDebugPolicy(program = 'ChatMCP.exe') {
  reg(['delete', POLICY_KEY, '/v', program, '/f']);
}
export const debugPolicyValue = (program = 'ChatMCP.exe') => registryValue(POLICY_KEY, program);

// ------------------------------------------------------------------------------------------------------------------------------- programs

/** The ids of the running programs with this image name (ChatMCP.exe, node.exe ...). */
export function processIds(imageName) {
  const done = spawnSync(path.join(SYSTEM32, 'tasklist.exe'), ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const ids = [];
  for (const line of String(done.stdout ?? '').split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)"/.exec(line);
    if (match && match[1].toLowerCase() === imageName.toLowerCase()) ids.push(Number(match[2]));
  }
  return ids;
}
/** Whether the program with this process id is running (any program: tasklist is asked for the id, not for a name). */
export function isRunning(pid) {
  const done = spawnSync(path.join(SYSTEM32, 'tasklist.exe'), ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return String(done.stdout ?? '').split(/\r?\n/).some((line) => new RegExp(`^"[^"]+","${Number(pid)}"`).test(line));
}

/** The path, the command line, the creation time and the parent of a process, as Windows says them, or null when there is none. */
export function processInfo(pid) {
  const text = powershell(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'; if ($null -eq $p) { 'null' } else { ConvertTo-Json -Compress ([ordered]@{ path = $p.ExecutablePath; commandLine = $p.CommandLine; created = $(if ($null -ne $p.CreationDate) { $p.CreationDate.ToString('o') } else { $null }); parentProcessId = [int]$p.ParentProcessId }) }`);
  return text === 'null' ? null : JSON.parse(text);
}

/**
 * Whether the very program that was seen with this id and this creation time (processInfo(...).created) is still running. A process id is given again to another program once the first has ended,
 * so "is something running under pid 4711" is not "is the Hub I started still running": the creation time tells them apart.
 */
export function isSameProcessRunning(pid, created) {
  const info = processInfo(pid);
  return info !== null && typeof created === 'string' && info.created === created;
}

/** Asks a program to close, as the close button of its window does (no /F: it may refuse, and nothing is lost if it does); true when Windows took the request. */
export function closeGracefully(pid) {
  return spawnSync(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(Number(pid))], { stdio: 'ignore', windowsHide: true, timeout: 30_000 }).status === 0;
}

/**
 * The words of a Windows command line, split the way a program's own start-up splits it (CommandLineToArgvW): a word ends at white space outside double quotes; 2n backslashes before a double quote are n
 * backslashes and the quote opens or closes a quoted run, 2n+1 are n backslashes and a quote that belongs to the word; other backslashes are plain. The first word, the program, is read the simple way
 * (up to the next double quote when it starts with one). It is what lets the proof compare the arguments the shell gave the setup with the vector of native-shared/UpdateContract.cs word by word.
 */
export function splitWindowsCommandLine(commandLine) {
  const text = String(commandLine ?? '');
  const words = [];
  const space = (character) => character === ' ' || character === '\t' || character === '\r' || character === '\n';
  let index = 0;
  while (index < text.length && space(text[index])) index += 1;
  if (index >= text.length) return words;
  if (text[index] === '"') {
    const end = text.indexOf('"', index + 1);
    words.push(text.slice(index + 1, end < 0 ? text.length : end));
    index = end < 0 ? text.length : end + 1;
  } else {
    let end = index;
    while (end < text.length && !space(text[end])) end += 1;
    words.push(text.slice(index, end));
    index = end;
  }
  for (;;) {
    while (index < text.length && space(text[index])) index += 1;
    if (index >= text.length) break;
    let word = '';
    let quoted = false;
    while (index < text.length) {
      let slashes = 0;
      while (text[index] === '\\') { slashes += 1; index += 1; }
      if (text[index] === '"') {
        word += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) word += '"'; else quoted = !quoted;
        index += 1;
      } else {
        word += '\\'.repeat(slashes);
        if (index >= text.length || (!quoted && space(text[index]))) break;
        word += text[index];
        index += 1;
      }
    }
    words.push(word);
  }
  return words;
}

/** The title of the main window of a program, which the shell sets to "DatGold Studio <version> - AI Coding Agent" (desktop-shell/MainWindow.cs): what a person sees on the title bar. Empty when there is no window. */
export function windowTitle(pid) {
  return powershell(`$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($null -eq $p) { '' } else { $p.MainWindowTitle }`);
}

/** Ends a program and the programs it started. */
export function killTree(pid) {
  spawnSync(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
}

/** Waits up to `timeoutMs` for the program with this process id to be gone; true when it is. */
export async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// ------------------------------------------------------------------------------------------------------------------------------- files

/** What a program says it is (its version resource): the fields the desktop shell reads from a setup. */
export function versionInfo(file) {
  return JSON.parse(powershell(`$v = (Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo; ConvertTo-Json -Compress ([ordered]@{ product = $v.ProductName; description = $v.FileDescription; productVersion = $v.ProductVersion })`));
}

/** SHA-256 of a file, streamed (a setup is 220 MB). */
export function sha256File(file) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let read; (read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

/** The names of the files and folders of `directory` that match `pattern` (a leftover of an update: a marker, a backup, a part of a download). */
export function leftovers(directory, pattern) {
  try { return fs.readdirSync(directory).filter((name) => pattern.test(name)); } catch { return []; }
}
