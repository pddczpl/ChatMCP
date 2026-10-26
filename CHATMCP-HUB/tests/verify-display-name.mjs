// The product is called DatGold (it was called ChatMCP until version 3.9.0). Everything a person reads while using it, and the documents they read about it, say DatGold;
// the old name stays only where something else depends on it: the repository and the release files (URLs, ChatMCPSetup.exe, ChatMCP.exe), the folders the installer
// makes (%LOCALAPPDATA%\ChatMCP), the request headers of the Hub, an author name an older Hub saved, and the older helper extension "ChatMCP Button Fix".
// docs/NAMING.md lists them with the reason each one stays and the step that changes it.
//
// This suite reads those places and fails for any "ChatMCP" that is not one of the exceptions, so that a new string, a new screen or a new document cannot bring the old
// name back unnoticed. The places are: the sources of the React UI, the Browser Companion, the desktop application's texts, the setup and uninstall wizard (its texts,
// the names of the shortcuts it makes, the entry in Apps & features), the hooks schema and the living documents.
// The Hub's own sentences (the verification notice, the withheld notice ...) are pinned by the suites that test them; the release workflows, the
// historical documents (RELEASE-NOTES-*, CHANGELOG.md, docs/PHASE*) and the developer tools keep the old name for now and are not read here.
//
// Negative controls: the same scan runs on copies of the real files with one defect put in at a time (the old name in a dictionary value, in a heading, in the
// extension's manifest ...); each must be reported, and each exception must pass.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');

if (!existsSync(path.join(REPO, 'README.md')) || !existsSync(path.join(REPO, 'desktop-shell', 'MainWindow.cs'))) {
  console.log('CHATMCP_TEST_SKIP: README.md and desktop-shell/ were not found next to CHATMCP-HUB (the naming checks need the whole repository)');
  process.exit(0);
}

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const readText = (file) => readFileSync(path.join(REPO, file), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const walk = (dir, pattern) => readdirSync(path.join(REPO, dir), { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && pattern.test(entry.name))
  .map((entry) => path.posix.join(path.relative(REPO, entry.parentPath ?? entry.path).split(path.sep).join('/'), entry.name));

// What may keep the old name, wherever it stands in a line. Each pattern is removed from the line before the line is checked.
const TECHNICAL = [
  /github\.com\/pddczpl\/ChatMCP(?:\.git)?/g, /pddczpl\/ChatMCP/g,                       // the repository
  /ChatMCP-Browser-Companion\b/g,                                                       // the release file of the Browser Companion (and the folder it is extracted to)
  /ChatMCP(?:Setup(?:-win-x64)?(?:\.exe)?|\.exe|\.csproj|\.Installer\.csproj)/g,        // the installer, the application and their projects
  /\\ChatMCP(?![A-Za-z0-9_-])/g,                                                        // %LOCALAPPDATA%\ChatMCP, Programs\ChatMCP
  /ChatMCP has NOT/g,                                                                   // the sentence an older Hub wrote, which a saved task still ends with
  /X-ChatMCP-[A-Za-z-]+/g,                                                              // the request headers of the Hub
  /\bcd ChatMCP\b/g,                                                                    // the folder `git clone` makes
  /thư mục ChatMCP đã cài/g, /installed ChatMCP folder/g, /folder where ChatMCP is installed/g, // the folder the installer makes
  /ChatMCP Button Fix/g,                                                                // the older helper extension, a different thing
  /'ChatMCP Team'/g,                                                                    // an author name that an older Hub saved
  /\bformerly ChatMCP\b/g, /\btrước đây là ChatMCP\b/g,                                 // the naming note
  /\bChatMCP\.(?:Native|Desktop|Installer|Sandbox)\b/g, /"ChatMCP", "(?:hub|webview2-data)"/g, // namespaces and data folders of the desktop code
  /Local\\+ChatMCP\.Update\./g,                                                         // the name of the lock that keeps two installers apart
  /\b(?:LegacyAppName|LegacyStartMenuFolder) = "ChatMCP(?: Studio)?";/g,                // the names versions up to 3.10.1 gave the shortcuts, which setup finds and removes
  /"Programs", "ChatMCP"|"ChatMCP", "logs"|GetProcessesByName\("ChatMCP"\)|Contains\("ChatMCP"|\.ChatMCP-update-/g, // the folders, the process and the update folder the installer works with
];
const isComment = (line) => /^\s*(?:\/\/|\/\*|\*|\{\/\*|<!--|#)/.test(line);

/** `files` is {path: text}. Returns "path:line: text" for every line that still names the product ChatMCP. `comments` lets a comment line pass (code comments are not read by a person using the product). */
function scan(files, { comments = false } = {}) {
  const found = [];
  for (const [file, text] of Object.entries(files)) {
    text.split('\n').forEach((line, index) => {
      if (!line.includes('ChatMCP')) return;
      if (comments && isComment(line) && !/\.(md|txt)$/.test(file) && file !== 'NOTICE') return;
      const rest = TECHNICAL.reduce((left, pattern) => left.replace(pattern, ''), line);
      if (rest.includes('ChatMCP')) found.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return found;
}
const load = (names) => Object.fromEntries(names.map((name) => [name, readText(name)]));

const UI = [...walk('CHATMCP-HUB/ui/src', /\.(?:tsx?|css)$/), 'CHATMCP-HUB/ui/index.html'];
const COMPANION = ['manifest.json', 'popup.html', 'popup.js', 'bridge.js', 'INSTALL-EXTENSION.txt', 'HUONG-DAN.txt'].map((name) => `CHATMCP-HUB/extension/${name}`);
const DESKTOP = ['desktop-shell/MainWindow.cs', 'native-shared/HubLifecycle.cs', 'native-shared/HubSession.cs'];
const INSTALLER = ['InstallerEngine.cs', 'InstallTransaction.cs', 'Program.cs', 'SetupForm.cs', 'UninstallForm.cs', 'ChatMCP.Installer.csproj'].map((name) => `installer/${name}`);
const LIVING_DOCUMENTS = [
  'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'NOTICE', 'HUONG-DAN.txt', 'THIRD-PARTY-NOTICES.md', 'CHATMCP-HUB/README.md', 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt',
  ...['AGENT-TOOL-CAPABILITIES', 'ARCHITECTURE', 'COMPANION-PRIVACY', 'DEPLOYMENT', 'DESKTOP-APP', 'DEVELOPMENT', 'EVALUATION', 'HOOKS', 'HUB-AUTH', 'INDEX', 'LICENSE-SCAN',
    'TESTING-WITH-REAL-MODELS', 'THREAT-MODEL', 'USER-GUIDE', 'WINDOWS-SETUP', 'TROUBLESHOOTING', 'CI-HEALTH'].map((name) => `docs/${name}.md`),
  'design/DESIGN-DIRECTION.md', 'design/ADR-001-frontend-stack.md',
];
const SCHEMA = ['CHATMCP-HUB/schemas/hooks.schema.json'];

// ------------------------------------------------------------------------------------------------------------------------------- 1. the real files
const real = {
  'the UI': load(UI), 'the Browser Companion': load(COMPANION), 'the desktop application': load(DESKTOP), 'the setup and uninstall wizard': load(INSTALLER), 'the hooks schema': load(SCHEMA),
  'the living documents': load(LIVING_DOCUMENTS),
};
assert.ok(Object.keys(real['the UI']).length > 40, `(premise) the UI sources were found: ${Object.keys(real['the UI']).length} files`);
for (const [surface, files] of Object.entries(real)) {
  const left = scan(files, { comments: surface !== 'the living documents' });
  assert.deepEqual(left, [], `${surface} still names the product ChatMCP; say DatGold (or, if something else depends on the old name, add it to docs/NAMING.md and to TECHNICAL in this suite):\n${left.join('\n')}`);
  ok(`${surface}: ${Object.keys(files).length} files say DatGold wherever a person reads the name`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 2. the name itself, where it must stand
{
  assert.match(readText('README.md'), /^# DatGold \(formerly ChatMCP\)\n/, 'the README is headed DatGold and says what the product used to be called');
  assert.match(readText('README.md'), /\]\(docs\/NAMING\.md\)/, 'and links the naming note');
  assert.match(readText('NOTICE'), /^DatGold \(formerly ChatMCP\)\n/, 'the NOTICE is headed the same way');
  assert.match(readText('NOTICE'), /Copyright 2026 Phan Danh Dat/, 'and the legal name of the copyright holder is unchanged');
  assert.match(readText('CHATMCP-HUB/ui/index.html'), /<title>DatGold Studio<\/title>/, 'the page title');
  assert.equal(JSON.parse(readText('CHATMCP-HUB/extension/manifest.json')).name, 'DatGold Hub Companion', 'the extension\'s name');
  assert.equal(JSON.parse(readText('CHATMCP-HUB/extension/manifest.json')).action.default_title, 'DatGold Hub Companion', 'and the title of its button');
  const window = readText('desktop-shell/MainWindow.cs');
  assert.match(window, /Text = "DatGold Studio " \+ HubLifecycle\.Version/, 'the title of the desktop window');
  const project = readText('desktop-shell/ChatMCP.csproj');
  for (const element of ['Company', 'Product', 'Description']) assert.match(project, new RegExp(`<${element}>DatGold\\b`), `the ${element} of the application file`);
  assert.match(project, /<AssemblyName>ChatMCP<\/AssemblyName>/, 'while the file name of the application is still ChatMCP.exe (the installer, the shortcuts and the upgrade depend on it)');
  // the setup and uninstall wizard: what the window says, what the shortcuts and the entry in Apps & features are called
  const engine = readText('installer/InstallerEngine.cs');
  assert.match(engine, /public const string AppName = "DatGold Studio";/, 'the name of the shortcuts and of the entry in Apps & features');
  assert.match(engine, /internal const string StartMenuFolder = "DatGold";/, 'the Start menu folder');
  assert.match(engine, /RegistryKeyPath = @"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ChatMCP";/, 'while the registry key is still ChatMCP (an upgrade finds the earlier installation by it)');
  assert.match(readText('installer/SetupForm.cs'), /Text = "DatGold Studio Setup - Version "/, 'the title of the setup wizard');
  assert.match(readText('installer/UninstallForm.cs'), /Text = "DatGold Studio - Uninstaller"/, 'the title of the uninstaller');
  const setupProject = readText('installer/ChatMCP.Installer.csproj');
  for (const element of ['Company', 'Product', 'Description', 'AssemblyTitle']) assert.match(setupProject, new RegExp(`<${element}>DatGold\\b`), `the ${element} of the setup file (AssemblyTitle is the "File description" that Windows shows)`);
  assert.match(setupProject, /<AssemblyName>DatGoldSetup<\/AssemblyName>/, 'and the file name of the setup is DatGoldSetup.exe (section 4 reads the rest of the downloads)');
  const plugins = readText('CHATMCP-HUB/lib/plugins.mjs');
  assert.equal(/author: 'ChatMCP/.test(plugins), false, 'no built-in skill is by "ChatMCP Team" any more');
  assert.match(plugins, /author: 'DatGold Team'/);
  // the names of the files a person saves (the audit export, a transcript, the workspace instructions) are not the old name's either
  assert.equal(/filename="CHATMCP-/.test(readText('CHATMCP-HUB/hub.mjs')), false, 'the files the Hub offers for download are named DATGOLD-...');
  assert.match(readText('CHATMCP-HUB/hub.mjs'), /filename="DATGOLD-WORKSPACE-INSTRUCTIONS\.txt"/);
  assert.match(readText('CHATMCP-HUB/ui/src/components/settings/AboutSection.tsx'), /datgold-audit-/, 'and so is the audit export');
  assert.ok(existsSync(path.join(REPO, 'docs', 'NAMING.md')), 'docs/NAMING.md exists');
  assert.match(readText('docs/INDEX.md'), /\]\(NAMING\.md\)/, 'and the documentation index links it');
  ok('the name stands in the README, NOTICE, page title, extension, desktop window and application file; the legal name and the file name of the application are unchanged');
}

// ------------------------------------------------------------------------------------------------------------------------------- 3. the check can fail, and the exceptions pass
{
  const ui = real['the UI'];
  const dictionary = 'CHATMCP-HUB/ui/src/lib/i18n.ts';
  const defects = [
    ['the old name in a dictionary value', { ...ui, [dictionary]: `${ui[dictionary]}\n    welcome_title: 'ChatMCP Studio',` }, { comments: true }],
    ['the old name in a component', { ...ui, 'CHATMCP-HUB/ui/src/App.tsx': `${ui['CHATMCP-HUB/ui/src/App.tsx']}\nconst x = <h1>ChatMCP</h1>;` }, { comments: true }],
    ['the old name in the page title', { 'CHATMCP-HUB/ui/index.html': '<title>ChatMCP Studio</title>' }, { comments: true }],
    ['the old name in the extension manifest', { 'CHATMCP-HUB/extension/manifest.json': '{ "name": "ChatMCP Hub Companion" }' }, { comments: true }],
    ['the old name in a heading of a document', { 'README.md': '# ChatMCP\n' }, { comments: false }],
    ['the old name in a sentence of a document that starts with #', { 'docs/USER-GUIDE.md': '# Hướng dẫn sử dụng ChatMCP Studio' }, { comments: false }],
    ['the old name in the title of the desktop window', { 'desktop-shell/MainWindow.cs': 'Text = "ChatMCP Studio " + HubLifecycle.Version;' }, { comments: true }],
    ['the old name in the title of the setup wizard', { 'installer/SetupForm.cs': 'Text = "ChatMCP Studio Setup - Version " + InstallerEngine.AppVersion;' }, { comments: true }],
    ['the old name in a sentence of the uninstaller', { 'installer/UninstallForm.cs': 'Text = "Remove ChatMCP and all associated shortcuts from this computer",' }, { comments: true }],
    ['the old name as the name of the shortcuts', { 'installer/InstallerEngine.cs': 'public const string AppName = "ChatMCP Studio";' }, { comments: true }],
    ['the old name in the file properties of the setup', { 'installer/ChatMCP.Installer.csproj': '<Product>ChatMCP Studio Setup</Product>' }, { comments: true }],
  ];
  for (const [label, files, options] of defects) assert.equal(scan(files, options).length, 1, `reported: ${label}`);
  const allowed = [
    ['the repository', 'See https://github.com/pddczpl/ChatMCP/issues and git clone https://github.com/pddczpl/ChatMCP.git'],
    ['the release files', 'Download ChatMCPSetup.exe, ChatMCPSetup.exe.sha256 and ChatMCP-Browser-Companion.zip'],
    ['the data folder', 'Hub data is in %LOCALAPPDATA%\\ChatMCP\\hub and the program in "$env:LOCALAPPDATA\\Programs\\ChatMCP"'],
    ['the request header', "headers: { 'X-ChatMCP-Request': 'local-dashboard' }"],
    ['the folder the installer makes', 'trong thư mục ChatMCP đã cài. Trình duyệt'],
    ['the older helper', 'Turn off the old ChatMCP Button Fix helper'],
    ['the naming note', 'DatGold (formerly ChatMCP) is a local-first AI coding agent'],
    ['a code comment in a source file', '// the page was opened without ChatMCP'],
    ['the old names the installer finds and removes', 'internal const string LegacyAppName = "ChatMCP Studio"; internal const string LegacyStartMenuFolder = "ChatMCP";'],
    ['the folders, the process and the update folder of the installer', 'Path.Combine(local, "Programs", "ChatMCP"); Path.Combine(local, "ChatMCP", "logs"); Process.GetProcessesByName("ChatMCP"); name.Contains("ChatMCP", x); ".ChatMCP-update-"'],
  ];
  for (const [label, line] of allowed) assert.deepEqual(scan({ 'CHATMCP-HUB/ui/src/x.tsx': line }, { comments: true }), [], `allowed: ${label}`);
  assert.equal(scan({ 'docs/x.md': '# ChatMCP' }, { comments: false }).length, 1, 'a heading of a document is read as a sentence, not skipped as a comment');
  assert.equal(scan({ 'docs/x.md': '# ChatMCP' }, { comments: true }).length, 1, 'even when comments are skipped for code');
  ok(`${defects.length} defects are reported, ${allowed.length} exceptions pass, and a heading of a document is never mistaken for a comment`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 4. the names of the downloads
// What a person downloads from a release is called DatGold too: DatGoldSetup.exe with its .sha256, and DatGold-Browser-Companion.zip. Releases up to 3.10.2 published ChatMCPSetup.exe and
// ChatMCP-Browser-Companion.zip, and two things still depend on those names: every installed version links to
// https://github.com/pddczpl/ChatMCP/releases/latest/download/ChatMCP-Browser-Companion.zip, so every release keeps publishing that file as a COPY of the new one; and the upgrade test
// downloads the published 3.9.0 by its file name. The names inside the installed program (ChatMCP.exe, the folders, the registry key) are the identifier step of docs/NAMING.md.
{
  /** A script or a workflow without its comments (PowerShell `<# ... #>` blocks and whole comment lines): a comment may say what a file used to be called. */
  const code = (text) => text.replace(/<#[\s\S]*?#>/g, '').split('\n').filter((line) => !/^\s*(?:#|\/\/)/.test(line)).join('\n');
  const DOWNLOAD_FILES = {
    project: 'installer/ChatMCP.Installer.csproj', usage: 'installer/Program.cs', build: 'scripts/Build-Installer.ps1', companion: 'scripts/Build-BrowserCompanion.ps1',
    ci: '.github/workflows/ci.yml', package: '.github/workflows/browser-companion-package.yml', gate: 'scripts/verify-release-source.py',
    upgrade: 'scripts/tests/legacy-hub-upgrade/run.mjs', link: 'CHATMCP-HUB/ui/src/components/settings/AgentChannelSection.tsx',
  };
  const TELL_A_PERSON = ['README.md', 'HUONG-DAN.txt', 'docs/WINDOWS-SETUP.md', 'docs/DESKTOP-APP.md'];
  /** `files` maps a path to its text. Returns what is wrong with the names of the downloads, one sentence each. */
  function downloadProblems(files) {
    const found = [];
    const need = (condition, sentence) => { if (!condition) found.push(sentence); };
    const at = (key) => files[DOWNLOAD_FILES[key]] ?? '';
    need(/<AssemblyName>DatGoldSetup<\/AssemblyName>/.test(at('project')), `${DOWNLOAD_FILES.project}: the setup is not built as DatGoldSetup.exe`);
    need(/DatGoldSetup\.exe --quiet --install-dir/.test(at('usage')), `${DOWNLOAD_FILES.usage}: the usage text does not name DatGoldSetup.exe`);
    const build = code(at('build'));
    need(/Join-Path \$installerPublish 'DatGoldSetup\.exe'/.test(build) && /Join-Path \$distDir 'DatGoldSetup\.exe'/.test(build) && /"\$checksum {2}DatGoldSetup\.exe"/.test(build), `${DOWNLOAD_FILES.build}: does not publish dist/DatGoldSetup.exe with a checksum line that names it`);
    need(!/ChatMCPSetup/.test(build), `${DOWNLOAD_FILES.build}: still names ChatMCPSetup outside a comment`);
    const companion = code(at('companion'));
    need(/\$filename = 'DatGold-Browser-Companion\.zip'/.test(companion), `${DOWNLOAD_FILES.companion}: the Browser Companion is not built as DatGold-Browser-Companion.zip`);
    need(/\$legacyFilename = 'ChatMCP-Browser-Companion\.zip'/.test(companion) && /Copy-Item/.test(companion), `${DOWNLOAD_FILES.companion}: the old name is not published as a copy (installed versions link to it)`);
    for (const key of ['ci', 'package']) {
      const text = at(key);
      const listed = (name) => new RegExp(`^\\s+dist/${name.replace(/[.]/g, '\\.')}$`, 'm').test(text);
      for (const name of ['DatGold-Browser-Companion.zip', 'DatGold-Browser-Companion.zip.sha256', 'ChatMCP-Browser-Companion.zip', 'ChatMCP-Browser-Companion.zip.sha256'])
        need(listed(name), `${DOWNLOAD_FILES[key]}: the uploaded artifact does not list dist/${name}`);
    }
    need(/^\s+dist\/DatGoldSetup\.exe$/m.test(at('ci')) && /^\s+dist\/DatGoldSetup\.exe\.sha256$/m.test(at('ci')) && /name: DatGoldSetup-win-x64/.test(at('ci')), `${DOWNLOAD_FILES.ci}: the installer artifact is not DatGoldSetup-win-x64 with dist/DatGoldSetup.exe`);
    const oldNameLines = at('ci').split('\n').filter((line) => /ChatMCPSetup/.test(line) && !/^\s*#/.test(line));
    need(oldNameLines.length > 0 && oldNameLines.every((line) => /native-baseline/.test(line)), `${DOWNLOAD_FILES.ci}: ChatMCPSetup is named outside the download of the published 3.9.0 (its file name cannot change): ${oldNameLines.filter((line) => !/native-baseline/.test(line)).map((line) => line.trim().slice(0, 80)).join(' | ')}`);
    need(/'dist\/DatGoldSetup\.exe'/.test(at('gate')) && !/ChatMCPSetup/.test(at('gate')), `${DOWNLOAD_FILES.gate}: the provenance gate does not read dist/DatGoldSetup.exe`);
    need(/'DatGoldSetup\.dll'/.test(at('upgrade')) && /'DatGoldSetup\.exe'/.test(at('upgrade')), `${DOWNLOAD_FILES.upgrade}: the upgrade test does not copy the files of DatGoldSetup`);
    for (const name of TELL_A_PERSON) need(/DatGoldSetup\.exe/.test(files[name] ?? ''), `${name}: does not tell a person to get DatGoldSetup.exe`);
    // The link inside the app must name a file that every release publishes: the new name, or the old one that is kept as a copy.
    const linked = /releases\/latest\/download\/([A-Za-z0-9._-]+)/.exec(at('link'))?.[1];
    const published = [/\$filename = '([^']+)'/.exec(companion)?.[1], /\$legacyFilename = '([^']+)'/.exec(companion)?.[1]];
    need(linked !== undefined && published.includes(linked), `${DOWNLOAD_FILES.link}: the app links ${linked ?? 'nothing'}, which the Companion build does not publish (${published.join(', ')})`);
    return found;
  }
  const names = Object.fromEntries([...Object.values(DOWNLOAD_FILES), ...TELL_A_PERSON].map((name) => [name, readText(name)]));
  const wrong = downloadProblems(names);
  assert.deepEqual(wrong, [], `the names of the downloads are not DatGold's (docs/NAMING.md, section "What still says ChatMCP"):\n${wrong.join('\n')}`);
  const mutate = (name, from, to) => { assert.ok(names[name].includes(from), `(premise) ${name} holds the text the defect replaces`); return { ...names, [name]: names[name].replace(from, to) }; };
  const downloadDefects = [
    ['the setup built under the old file name', mutate(DOWNLOAD_FILES.project, '<AssemblyName>DatGoldSetup</AssemblyName>', '<AssemblyName>ChatMCPSetup</AssemblyName>')],
    ['the old installer name in the build script', mutate(DOWNLOAD_FILES.build, "$setupExe = Join-Path $distDir 'DatGoldSetup.exe'", "$setupExe = Join-Path $distDir 'ChatMCPSetup.exe'")],
    ['the checksum line naming the old file', mutate(DOWNLOAD_FILES.build, '"$checksum  DatGoldSetup.exe"', '"$checksum  ChatMCPSetup.exe"')],
    ['the Companion without its old-named copy', mutate(DOWNLOAD_FILES.companion, "$legacyFilename = 'ChatMCP-Browser-Companion.zip'", "$legacyFilename = 'DatGold-Browser-Companion.zip'")],
    ['the artifact without the old-named Companion', mutate(DOWNLOAD_FILES.ci, '            dist/ChatMCP-Browser-Companion.zip\n', '')],
    ['the old installer name beside the checks of the new build', mutate(DOWNLOAD_FILES.ci, 'if (-not (Test-Path .\\dist\\DatGoldSetup.exe))', 'if (-not (Test-Path .\\dist\\ChatMCPSetup.exe))')],
    ['the provenance gate reading the old file', mutate(DOWNLOAD_FILES.gate, "'dist/DatGoldSetup.exe'", "'dist/ChatMCPSetup.exe'")],
    ['the README without the new file name', mutate('README.md', 'DatGoldSetup.exe', 'the installer')],
    ['the app linking a file no release publishes', mutate(DOWNLOAD_FILES.link, 'ChatMCP-Browser-Companion.zip', 'Companion.zip')],
  ];
  for (const [label, files] of downloadDefects) assert.ok(downloadProblems(files).length >= 1, `reported: ${label}`);
  ok(`the downloads are DatGoldSetup.exe and DatGold-Browser-Companion.zip, the old-named Companion is published as a copy, and ${downloadDefects.length} defects are reported`);
}

console.log(`\nPASS: ${checks} display-name checks`);
