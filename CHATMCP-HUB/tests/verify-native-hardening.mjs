// Static gate for the WebView2 desktop shell (pod-9) and how it handles the Hub secret. The behaviour itself is proved by the
// real WebView2 smoke (ui/e2e/webview2-smoke.mjs, Windows only); this suite keeps the source from drifting back, on every
// platform, in the ordinary Node run:
//   * an address from the page is never put into script text: the single-quote Replace pattern is gone and the shell calls
//     no ExecuteScriptAsync at all;
//   * window.open / target=_blank are handled in one place, which allows http/https only and posts a JSON web message;
//   * DevTools are enabled only in a DEBUG build;
//   * the Hub secret is never injected into pages by a document-created script (preview iframes would run it too).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(hubRoot, '..');
const shellFolders = ['desktop-shell', 'native-shared', 'installer'].map((name) => path.join(repo, name));
if (!shellFolders.every((folder) => fs.existsSync(folder))) {
  console.log('CHATMCP_TEST_SKIP: desktop-shell/, native-shared/ and installer/ were not found next to CHATMCP-HUB (they ship in the repository, not in the Hub bundle)');
  process.exit(0);
}

let checks = 0;
const check = (condition, label, detail = '') => { assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`); checks += 1; };
function sources(folder) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['bin', 'obj', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.cs')) found.push({ file: path.relative(repo, full).replaceAll('\\', '/'), text: fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') });
    }
  };
  walk(folder);
  return found;
}
const shell = shellFolders.flatMap(sources);
const smoke = sources(path.join(hubRoot, 'ui', 'e2e', 'windows-webview2'));
check(shell.length >= 6, `found the shell sources (${shell.length} files)`);
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments may mention the old pattern

// The installer quotes paths for PowerShell by doubling single quotes (installer/InstallerEngine.cs); that is not page text.
const pageFacing = shell.filter(({ file }) => !file.startsWith('installer/'));
for (const { file, text } of [...pageFacing, ...smoke]) {
  const code = strip(text);
  check(!/\.Replace\(\s*"'"/.test(code) && !/\.Replace\(\s*'\\''/.test(code), `${file}: the single-quote Replace pattern is gone`);
}
for (const { file, text } of pageFacing) {
  const code = strip(text);
  check(!/ExecuteScriptAsync\s*\(/.test(code), `${file}: the shell injects no script text into the page`);
  check(!/AddScriptToExecuteOnDocumentCreatedAsync\s*\(/.test(code), `${file}: nothing is injected into every document (the Hub secret never travels that way)`);
}

const window = shell.find((entry) => entry.file === 'desktop-shell/MainWindow.cs');
const bridge = shell.find((entry) => entry.file === 'native-shared/WebViewBridge.cs');
const link = shell.find((entry) => entry.file === 'native-shared/OpenLink.cs');
check(window && bridge && link, 'MainWindow.cs, WebViewBridge.cs and OpenLink.cs exist');
check(!/NewWindowRequested/.test(strip(window.text)) && /WebViewBridge\.AttachNewWindowHandler\(/.test(strip(window.text)), 'MainWindow handles new windows only through WebViewBridge');
check(/e\.Handled\s*=\s*true/.test(strip(bridge.text)) && /PostWebMessageAsJson\(\s*json\s*\)/.test(strip(bridge.text)), 'the handler always marks the request handled and posts a JSON web message');
check(/UriSchemeHttp\b/.test(strip(link.text)) && /UriSchemeHttps\b/.test(strip(link.text)) && !/UriSchemeFile|javascript:|"data:/.test(strip(link.text)), 'only http and https addresses are forwarded');
check(/JsonSerializer\.Serialize\(/.test(strip(link.text)), 'the address is serialised as a JSON string value');

// AreDevToolsEnabled = true only inside #if DEBUG ... (#else|#endif)
for (const { file, text } of shell) {
  const lines = text.split('\n');
  let inDebug = false;
  lines.forEach((line, index) => {
    const directive = /^\s*#\s*(if|else|elif|endif)\b(.*)$/.exec(line);
    if (directive) {
      if (directive[1] === 'if') inDebug = /^\s*DEBUG\s*$/.test(directive[2]);
      else inDebug = false;
    }
    if (/AreDevToolsEnabled\s*=\s*true/.test(line)) check(inDebug, `${file}:${index + 1}: AreDevToolsEnabled = true is inside #if DEBUG`);
  });
}
check(/AreDevToolsEnabled\s*=\s*false/.test(window.text), 'a release build turns DevTools off explicitly (WebView2 defaults to on)');

// Windows PowerShell as a child of the installer. A process started from PowerShell 7 inherits PSModulePath with PowerShell 7's module folders first, and the Windows
// PowerShell it starts then loses Get-FileHash and the other script functions of Microsoft.PowerShell.Utility: the helper that deletes Uninstall.exe left the file behind
// (tests tell the same story for node: tests/support/powershell-environment.mjs). The behaviour is proved on Windows by scripts/tests/legacy-hub-upgrade/run.mjs and
// scripts/tests/Test-NativeLifecycle.ps1; this keeps the source from drifting back, on every platform: the Windows PowerShell executable is named in ONE place, HubLifecycle.WindowsPowerShell,
// which never goes through the shell (ShellExecute ignores Environment) and takes PSModulePath out of the environment in any letter case; every start goes through it.
{
  const code = (entry) => strip(entry.text);
  const naming = shell.filter((entry) => /\b(?:powershell|pwsh)\.exe\b/i.test(code(entry))).map((entry) => entry.file);
  check(naming.length === 1 && naming[0] === 'native-shared/HubLifecycle.cs', 'the Windows PowerShell executable is named in exactly one C# file, native-shared/HubLifecycle.cs (a second start of it would not drop PSModulePath)', naming.join(', '));
  const lifecycle = shell.find((entry) => entry.file === 'native-shared/HubLifecycle.cs');
  const engine = shell.find((entry) => entry.file === 'installer/InstallerEngine.cs');
  check(lifecycle && engine, 'HubLifecycle.cs and InstallerEngine.cs exist');
  const helper = /internal static ProcessStartInfo WindowsPowerShell\(string command\)\s*\{[\s\S]*?\n    \}/.exec(code(lifecycle));
  check(helper, 'HubLifecycle.WindowsPowerShell(string command) exists');
  check(/\bpowershell\.exe\b/i.test(helper[0]) && /UseShellExecute\s*=\s*false/.test(helper[0]), 'and starts the machine\'s own Windows PowerShell without the shell');
  check(/Environment\.Remove\(/.test(helper[0]) && /"PSModulePath"/.test(helper[0]) && /StringComparison\.OrdinalIgnoreCase/.test(helper[0]), 'and removes PSModulePath, in any letter case, from the environment of the child');
  check(/\bHubLifecycle\.WindowsPowerShell\(/.test(code(engine)), 'the uninstaller starts the helper that deletes Uninstall.exe through it');
  check((code(lifecycle).match(/\bWindowsPowerShell\(/g) ?? []).length >= 2, 'and so does the Hub ownership query (the definition is the first of the occurrences)');
}

// A window that runs the engine reports what stopped it instead of letting the exception reach the .NET crash dialog ("Unhandled exception has occurred in your application").
// The uninstall window had no try/catch: with the Hub's state over 256 KiB (HubLifecycle's client refused it) it ended in that dialog on the owner's machine. The behaviour needs a
// window; this keeps the source from drifting back, on every platform. The refusal itself is pinned by the native unit tests (scripts/tests/native-lifecycle).
{
  const guarded = (text, call) => new RegExp(`try\\s*\\{[^]*?${call}\\([^]*?\\}\\s*catch\\s*\\(Exception\\b[^]*?MessageBox\\.Show\\(`).test(strip(text));
  const form = (name) => shell.find((entry) => entry.file === `installer/${name}`);
  check(form('UninstallForm.cs') && form('SetupForm.cs'), 'SetupForm.cs and UninstallForm.cs exist');
  check(guarded(form('UninstallForm.cs').text, 'InstallerEngine\\.Uninstall'), 'the uninstaller window runs the uninstall inside try/catch and shows what stopped it');
  check(guarded(form('SetupForm.cs').text, 'InstallerEngine\\.Install'), 'and so does the setup window');
  check(!guarded('await Task.Run(() => { InstallerEngine.Uninstall(dir, report); });\nMessageBox.Show("done");', 'InstallerEngine\\.Uninstall'), '(the pattern can fail: a window with no catch around the call is not accepted)');
}

console.log(`PASS: ${checks} checks - no script injection of page addresses, one http/https-only new-window handler, DevTools only in DEBUG, Windows PowerShell started in one place without PSModulePath, the setup and uninstall windows report errors`);
