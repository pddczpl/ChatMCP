// The product is called DatGold (it was called ChatMCP until version 3.9.0). Everything a person reads while using it, and the documents they read about it, say DatGold;
// the old name stays only where something else depends on it: the repository and the release files (URLs, ChatMCPSetup.exe, ChatMCP.exe), the folders the installer
// makes (%LOCALAPPDATA%\ChatMCP), the request headers of the Hub, an author name an older Hub saved, and the older helper extension "ChatMCP Button Fix".
// docs/NAMING.md lists them with the reason each one stays and the step that changes it.
//
// This suite reads those places and fails for any "ChatMCP" that is not one of the exceptions, so that a new string, a new screen or a new document cannot bring the old
// name back unnoticed. The places are: the sources of the React UI, the Browser Companion, the desktop application's texts, the hooks schema and the living documents.
// The Hub's own sentences (the verification notice, the withheld notice ...) are pinned by the suites that test them; the installer, the release workflows, the
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
const LIVING_DOCUMENTS = [
  'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'NOTICE', 'HUONG-DAN.txt', 'THIRD-PARTY-NOTICES.md', 'CHATMCP-HUB/README.md', 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt',
  ...['AGENT-TOOL-CAPABILITIES', 'ARCHITECTURE', 'COMPANION-PRIVACY', 'DEPLOYMENT', 'DESKTOP-APP', 'DEVELOPMENT', 'EVALUATION', 'HOOKS', 'HUB-AUTH', 'INDEX', 'LICENSE-SCAN',
    'TESTING-WITH-REAL-MODELS', 'THREAT-MODEL', 'USER-GUIDE', 'WINDOWS-SETUP', 'TROUBLESHOOTING', 'CI-HEALTH'].map((name) => `docs/${name}.md`),
  'design/DESIGN-DIRECTION.md', 'design/ADR-001-frontend-stack.md',
];
const SCHEMA = ['CHATMCP-HUB/schemas/hooks.schema.json'];

// ------------------------------------------------------------------------------------------------------------------------------- 1. the real files
const real = {
  'the UI': load(UI), 'the Browser Companion': load(COMPANION), 'the desktop application': load(DESKTOP), 'the hooks schema': load(SCHEMA), 'the living documents': load(LIVING_DOCUMENTS),
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
  ];
  for (const [label, line] of allowed) assert.deepEqual(scan({ 'CHATMCP-HUB/ui/src/x.tsx': line }, { comments: true }), [], `allowed: ${label}`);
  assert.equal(scan({ 'docs/x.md': '# ChatMCP' }, { comments: false }).length, 1, 'a heading of a document is read as a sentence, not skipped as a comment');
  assert.equal(scan({ 'docs/x.md': '# ChatMCP' }, { comments: true }).length, 1, 'even when comments are skipped for code');
  ok(`${defects.length} defects are reported, ${allowed.length} exceptions pass, and a heading of a document is never mistaken for a comment`);
}

console.log(`\nPASS: ${checks} display-name checks`);
