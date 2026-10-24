// Licence statements and third-party notices must match what the product redistributes, and a missing notice must fail the build.
//
// docs/LICENSE-SCAN.md listed notices that were missing or wrong: Node.js shipped without its LICENSE, the Tree-sitter grammars without the
// MIT notices of their upstream projects, CPython / the Microsoft Visual C++ runtime without their terms, no assertion that CPython's
// LICENSE.txt was present, and a README that still said the project had no license. This suite checks, on the real files:
//
//   1. README "License" section: the Apache-2.0 statement with links to LICENSE, NOTICE, CONTRIBUTING.md and THIRD-PARTY-NOTICES.md,
//      and no trace of the old "no adopted license" wording. LICENSE and NOTICE are the Apache text and notice.
//   2. Inventory: every redistributed component (read from the two lockfiles, stage-python.ps1, the csproj and the staging code) has an
//      entry with its version, license id and the place of its license text in THIRD-PARTY-NOTICES.md AND CHATMCP-HUB/THIRD-PARTY-NOTICES.txt.
//   3. The generated list of UI production packages in THIRD-PARTY-NOTICES.md equals the lockfile (scripts/generate-licenses.mjs --check).
//   4. Staging code: stage-python.ps1 asserts LICENSE.txt, stage.mjs stages the grammar notices, verify.mjs requires them, Build-Installer.ps1
//      copies Node's LICENSE (its behaviour is tested in scripts/tests/Test-InstallerPayload.ps1), the payload ships THIRD-PARTY-NOTICES.md,
//      and no release workflow sets CHATMCP_ALLOW_PENDING_NOTICES.
//   5. Behaviour of the REAL staging modules on fixtures: readGrammarNotices throws for a missing / empty / non-MIT notice and passes with
//      the right ones; verifyRuntime rejects a runtime without CPython's LICENSE.txt, tree-sitter-wasms' LICENSE or a grammar notice.
//   6. Negative controls: the same checks run on a temporary copy of the files into which defects are put one at a time (the Node.js entry
//      deleted, a grammar entry removed from the text file, the old README wording back, the LICENSE.txt assertion removed, one UI
//      package dropped from the generated list, a release workflow setting the pending-notices variable ...); each must be reported.
//
// The notices whose upstream text is not in the repository yet (the Tree-sitter grammar licenses) are PENDING: the suite prints them and does
// not fail, because the staging code refuses a release build without them (step 5).
// CLAIM: license-apache-2
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');

if (!existsSync(path.join(REPO, 'README.md')) || !existsSync(path.join(REPO, 'scripts', 'intelligence-runtime', 'notices.mjs'))) {
  console.log('CHATMCP_TEST_SKIP: README.md and scripts/ were not found next to CHATMCP-HUB (the notice checks need the whole repository)');
  process.exit(0);
}

const { GRAMMAR_NOTICES, PENDING_ALLOWED_ENV, noticeSource, noticeStaged, readGrammarNotices, requiredLicenseFiles } = await import(pathToFileURL(path.join(REPO, 'scripts', 'intelligence-runtime', 'notices.mjs')).href);
const { REQUIRED_COMPONENTS, verifyRuntime } = await import(pathToFileURL(path.join(REPO, 'scripts', 'intelligence-runtime', 'verify.mjs')).href);
const { expectedDocument } = await import(pathToFileURL(path.join(REPO, 'scripts', 'generate-licenses.mjs')).href);

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const read = (root, ...segments) => readFileSync(path.join(root, ...segments), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A package name as a whole word: "typescript" must not match "typescript-language-server". */
const word = (name) => new RegExp(`(?<![\\w@/-])${escape(name)}(?![\\w-])`);

/** True when a line matching `name` carries every needle itself or within the `span` lines after it. */
function entryHas(text, name, needles, span = 0) {
  const lines = text.split('\n');
  return lines.some((line, index) => {
    if (!name.test(line)) return false;
    const window = lines.slice(index, index + 1 + span).join('\n');
    return needles.every((needle) => (needle instanceof RegExp ? needle.test(window) : window.includes(needle)));
  });
}

/** The components the installer redistributes, with the facts a notice for each must state (taken from the sources, not typed here). */
function requiredEntries(repo) {
  const entries = [];
  const intelligence = JSON.parse(read(repo, 'scripts', 'intelligence-runtime', 'package-lock.json'));
  for (const [key, entry] of Object.entries(intelligence.packages)) {
    if (!key) continue;
    if (entry.optional && Array.isArray(entry.os) && !entry.os.includes('win32')) continue; // fsevents (macOS only) is not staged
    const name = key.slice('node_modules/'.length);
    entries.push({ label: `${name} ${entry.version}`, name: word(name), needles: [entry.version, entry.license], span: 2 });
  }
  const ui = JSON.parse(read(repo, 'CHATMCP-HUB', 'ui', 'package-lock.json'));
  for (const name of ['playwright', 'playwright-core']) {
    const entry = ui.packages[`node_modules/${name}`];
    entries.push({ label: `${name} ${entry.version}`, name: word(name), needles: [entry.version, entry.license], span: 2 });
  }
  for (const [key, entry] of Object.entries(ui.packages)) {
    if (!key || entry.dev || entry.license !== 'OFL-1.1') continue;
    entries.push({ label: `${key.slice('node_modules/'.length)} (OFL-1.1 font)`, name: word(key.slice('node_modules/'.length)), needles: [entry.version, /Open Font License|OFL/], span: 2 });
  }
  const pythonVersion = read(repo, 'scripts', 'intelligence-runtime', 'stage-python.ps1').match(/python-(\d+\.\d+\.\d+)-embeddable-amd64\.zip/)?.[1];
  assert.ok(pythonVersion, 'stage-python.ps1: the pinned CPython version was not found');
  entries.push({ label: `CPython ${pythonVersion}`, name: /CPython embeddable/, needles: [pythonVersion, 'PSF-2.0', 'runtimes/python/LICENSE.txt'], span: 3 });
  const ripgrepVersion = read(repo, 'scripts', 'intelligence-runtime', 'stage-ripgrep.ps1').match(/ripgrep-(\d+\.\d+\.\d+)-x86_64-pc-windows-msvc\.zip/)?.[1];
  assert.ok(ripgrepVersion, 'stage-ripgrep.ps1: the pinned ripgrep version was not found');
  entries.push({ label: `ripgrep ${ripgrepVersion}`, name: /ripgrep[^\n]*runtimes\/ripgrep/, needles: [ripgrepVersion, 'MIT OR Unlicense', 'runtimes/ripgrep/LICENSE-MIT'], span: 3 });
  entries.push({ label: 'Node.js', name: /Node\.js[^\n]*runtimes\/node/, needles: ['MIT', 'runtimes/node/LICENSE'], span: 3 });
  entries.push({ label: 'Microsoft Visual C++ runtime', name: /Visual C\+\+ runtime/, needles: [/Microsoft/, /redistribut/i], span: 3 });
  const webview2 = read(repo, 'desktop-shell', 'ChatMCP.csproj').match(/Include="Microsoft\.Web\.WebView2" Version="([^"]+)"/)?.[1];
  assert.ok(webview2, 'desktop-shell/ChatMCP.csproj: the WebView2 package version was not found');
  entries.push({ label: `Microsoft.Web.WebView2 ${webview2}`, name: /Microsoft\.Web\.WebView2/, needles: [webview2, 'BSD-3-Clause'], span: 2 });
  entries.push({ label: '.NET runtime', name: /\.NET 10 runtime/, needles: ['MIT'], span: 2 });
  entries.push({ label: 'React 16 UMD', name: /React 16\.0\.0/, needles: ['MIT'], span: 2 });
  entries.push({ label: 'UI libraries', name: /UI libraries compiled into/, needles: [/MIT/], span: 2 });
  for (const grammar of GRAMMAR_NOTICES) {
    entries.push({ label: `${grammar.id} grammar notice`, name: word(grammar.id), needles: [grammar.range, 'MIT', noticeStaged(grammar)], span: 4 });
  }
  entries.push({ label: 'tree-sitter-wasms license location', name: word('tree-sitter-wasms'), needles: ['Unlicense', 'licenses/tree-sitter-wasms/LICENSE'], span: 2 });
  return entries;
}

const SHIPPING_FILES = {
  'README.md': 'README.md',
  LICENSE: 'LICENSE',
  NOTICE: 'NOTICE',
  'THIRD-PARTY-NOTICES.md': 'THIRD-PARTY-NOTICES.md',
};

/**
 * All static checks. Returns the list of problems (empty = fine) and the grammar notices whose text is not in the repository.
 * `repo` is a repository root, the real one or a temporary copy that carries a defect.
 */
export async function checkNotices(repo) {
  const problems = [];
  const fail = (message) => problems.push(message);

  // 1. README licence section, LICENSE, NOTICE ---------------------------------------------------------------------------------------
  const readme = read(repo, 'README.md');
  const section = readme.match(/^## License\s*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
  if (!section) fail('README.md has no "## License" section');
  if (!/Apache License, Version 2\.0/.test(section)) fail('README.md License section does not state the Apache License, Version 2.0');
  for (const link of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'THIRD-PARTY-NOTICES.md']) {
    if (!section.includes(`](${link})`)) fail(`README.md License section does not link ${link}`);
  }
  if (!/Developer Certificate of Origin/.test(section) || !/no Contributor License Agreement/i.test(section)) fail('README.md License section must mention the DCO sign-off and that there is no CLA');
  if (/does \*\*not\*\* currently have|adopted top-level|Do not assume that the project code is licensed/i.test(readme)) fail('README.md still says that no project license has been adopted');
  if (!/^\s*Apache License\s*\n\s*Version 2\.0, January 2004/.test(read(repo, 'LICENSE'))) fail('LICENSE is not the Apache License, Version 2.0');
  if (!/Apache License, Version 2\.0/.test(read(repo, 'NOTICE'))) fail('NOTICE does not name the Apache License, Version 2.0');

  // 2. inventory in both notice files ------------------------------------------------------------------------------------------------
  const markdown = read(repo, 'THIRD-PARTY-NOTICES.md');
  const text = read(repo, 'CHATMCP-HUB', 'THIRD-PARTY-NOTICES.txt');
  if (/has not yet adopted a top-level/i.test(markdown)) fail('THIRD-PARTY-NOTICES.md still says that no top-level license exists');
  if (/ARCHIVED|NOT CURRENT/.test(text.split('\n').slice(0, 3).join('\n'))) fail('CHATMCP-HUB/THIRD-PARTY-NOTICES.txt is still the archived 1.x text');
  if (!/Permission is hereby granted, free of charge/.test(text)) fail('CHATMCP-HUB/THIRD-PARTY-NOTICES.txt lost the MIT permission text of the React 16 files it ships');
  if (existsSync(path.join(repo, 'THIRD_PARTY_NOTICES.md'))) fail('THIRD_PARTY_NOTICES.md is back: there is one canonical THIRD-PARTY-NOTICES.md (the list of UI packages is generated into it)');
  for (const entry of requiredEntries(repo)) {
    if (!entryHas(markdown, entry.name, entry.needles, entry.span)) fail(`THIRD-PARTY-NOTICES.md has no entry for ${entry.label} (needs ${entry.needles.map(String).join(', ')})`);
    if (entry.label === 'UI libraries' || entry.label.endsWith('license location')) continue;
    if (!entryHas(text, entry.name, entry.needles.filter((needle) => !(needle instanceof RegExp && needle.source === 'MIT')), entry.span + 1)) {
      fail(`CHATMCP-HUB/THIRD-PARTY-NOTICES.txt has no entry for ${entry.label}`);
    }
  }

  // 3. generated list equals the lockfile ----------------------------------------------------------------------------------------------
  try {
    const { current, expected } = await expectedDocument({ notices: path.join(repo, 'THIRD-PARTY-NOTICES.md'), lockfile: path.join(repo, 'CHATMCP-HUB', 'ui', 'package-lock.json') });
    if (current !== expected) fail('the generated list of UI packages in THIRD-PARTY-NOTICES.md differs from CHATMCP-HUB/ui/package-lock.json (run: node scripts/generate-licenses.mjs)');
  } catch (error) {
    fail(`the generated list of UI packages cannot be checked: ${error.message}`);
  }

  // 4. staging code and workflows -----------------------------------------------------------------------------------------------------
  const stagePython = read(repo, 'scripts', 'intelligence-runtime', 'stage-python.ps1');
  if (!/foreach \(\$required in @\([^)]*'LICENSE\.txt'/.test(stagePython)) fail('stage-python.ps1 does not require LICENSE.txt among the files of the CPython archive');
  if (!stagePython.includes('PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2')) fail('stage-python.ps1 does not check that LICENSE.txt is the PSF license text');
  const stage = read(repo, 'scripts', 'intelligence-runtime', 'stage.mjs');
  if (!stage.includes('readGrammarNotices') || !stage.includes('noticeStaged(entry)')) fail('stage.mjs does not stage the Tree-sitter grammar notices');
  if (!stage.includes("'runtimes/python/LICENSE.txt'")) fail('stage.mjs does not assert that the staged CPython carries LICENSE.txt');
  if (!stage.includes("noticeFiles.includes('LICENSE')")) fail('stage.mjs does not require the LICENSE of tree-sitter-wasms');
  if (!read(repo, 'scripts', 'intelligence-runtime', 'verify.mjs').includes('requiredLicenseFiles(pendingNotices)')) fail('verify.mjs does not require the license files of the staged runtime');
  const stageRipgrep = read(repo, 'scripts', 'intelligence-runtime', 'stage-ripgrep.ps1');
  if (!/\$required = @\([^)]*'LICENSE-MIT'[^)]*'UNLICENSE'/.test(stageRipgrep)) fail('stage-ripgrep.ps1 does not require both LICENSE-MIT and UNLICENSE among the files of the ripgrep archive');
  if (!stageRipgrep.includes('Permission is hereby granted, free of charge') || !stageRipgrep.includes('free and unencumbered software released into the public domain')) fail('stage-ripgrep.ps1 does not check that the two license files are the MIT and Unlicense texts');
  if (!stage.includes("['rg.exe', 'LICENSE-MIT', 'UNLICENSE']")) fail('stage.mjs does not assert that the staged ripgrep carries rg.exe and both of its license texts');
  const notices = read(repo, 'scripts', 'intelligence-runtime', 'notices.mjs');
  for (const required of ['licenses/tree-sitter-wasms/LICENSE', 'runtimes/python/LICENSE.txt', 'runtimes/ripgrep/LICENSE-MIT', 'runtimes/ripgrep/UNLICENSE']) {
    if (!notices.includes(`'${required}'`)) fail(`notices.mjs does not list ${required} as a required license file`);
  }
  if (!read(repo, 'scripts', 'Build-Installer.ps1').includes('Copy-InstallerNodeLicense -NodeExecutable $sysNode -Destination $stagingNode')) fail('Build-Installer.ps1 does not copy the Node.js LICENSE next to the bundled node.exe');
  const payloadScript = read(repo, 'scripts', 'InstallerPayload.ps1');
  if (!payloadScript.includes('function Copy-InstallerNodeLicense')) fail('InstallerPayload.ps1 lost Copy-InstallerNodeLicense');
  if (!/foreach \(\$required in @\([^)]*'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES\.md'\)/.test(payloadScript)) fail('the installer payload does not require LICENSE, NOTICE and THIRD-PARTY-NOTICES.md');
  const workflowFolder = path.join(repo, '.github', 'workflows');
  const pending = GRAMMAR_NOTICES.filter((entry) => !existsSync(path.join(repo, 'scripts', 'intelligence-runtime', noticeSource(entry))));
  const setIn = [];
  for (const name of readdirSync(workflowFolder).filter((file) => /\.ya?ml$/.test(file))) {
    if (read(repo, '.github', 'workflows', name).includes(PENDING_ALLOWED_ENV)) setIn.push(name);
  }
  const releaseWorkflows = setIn.filter((name) => name !== 'ci.yml');
  if (releaseWorkflows.length > 0) fail(`${releaseWorkflows.join(', ')} set ${PENDING_ALLOWED_ENV}: only ci.yml may build without every license notice`);
  if (pending.length > 0 && !setIn.includes('ci.yml')) fail(`ci.yml must set ${PENDING_ALLOWED_ENV} while grammar notices are pending, otherwise its installer build fails`);
  if (pending.length === 0 && setIn.length > 0) fail(`every grammar notice is vendored, so ${PENDING_ALLOWED_ENV} must be removed from ${setIn.join(', ')}`);
  return { problems, pending };
}

// =============================================================================================================================================
const real = await checkNotices(REPO);
assert.equal(real.problems.length, 0, `notice problems:\n  - ${real.problems.join('\n  - ')}`);
ok('README License section, LICENSE and NOTICE state Apache-2.0 and link the notices; no trace of the "no license" wording');
ok('every redistributed component has an entry with version, license id and license-text location in THIRD-PARTY-NOTICES.md and CHATMCP-HUB/THIRD-PARTY-NOTICES.txt');
ok('the UI package list in THIRD-PARTY-NOTICES.md equals the production closure of the UI lockfile; there is a single canonical notices file');
ok('stage-python.ps1, stage.mjs, verify.mjs, Build-Installer.ps1 and the payload script copy or assert the license files; no release workflow may build without them');
for (const entry of real.pending) console.log(`  PENDING (blocks a release build, not this suite) - ${noticeSource(entry)}: the upstream ${entry.license} text of ${entry.id} (${entry.upstream}) is not in the repository`);
console.log(`  ${real.pending.length} of ${GRAMMAR_NOTICES.length} grammar notices pending`);

// ---- 5. behaviour of the real staging modules on fixtures -----------------------------------------------------------------------------
const scratch = mkdtempSync(path.join(os.tmpdir(), 'chatmcp-notices-'));
try {
  const MIT = (holder) => `The MIT License (MIT)\n\nCopyright (c) 2014 ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction.\n`;
  const fixtureNotices = (directory, skip = []) => {
    mkdirSync(path.join(directory, 'licenses'), { recursive: true });
    for (const entry of GRAMMAR_NOTICES) if (!skip.includes(entry.id)) writeFileSync(path.join(directory, noticeSource(entry)), MIT(`${entry.id} authors`));
  };

  const complete = path.join(scratch, 'complete');
  fixtureNotices(complete);
  const all = await readGrammarNotices({ sourceDirectory: complete });
  assert.equal(all.found.length, GRAMMAR_NOTICES.length);
  assert.equal(all.pending.length, 0);
  ok(`readGrammarNotices accepts the ${GRAMMAR_NOTICES.length} upstream texts`);

  for (const entry of GRAMMAR_NOTICES) {
    const missing = path.join(scratch, `missing-${entry.id}`);
    fixtureNotices(missing, [entry.id]);
    await assert.rejects(readGrammarNotices({ sourceDirectory: missing }), (error) => error.message.includes(noticeSource(entry)) && /Missing licence notice/.test(error.message), `a missing ${entry.id} notice must stop staging`);
  }
  ok('a missing grammar notice stops staging, for each of the three upstream projects, and the message names the file');

  const [first] = GRAMMAR_NOTICES;
  for (const [label, body] of [['empty', ''], ['without a copyright year', 'Permission is hereby granted, free of charge, to any person'], ['without the MIT paragraph', 'Copyright (c) 2014 Someone\nAll rights reserved.\n']]) {
    const bad = path.join(scratch, `bad-${label.replaceAll(' ', '-')}`);
    fixtureNotices(bad);
    writeFileSync(path.join(bad, noticeSource(first)), body);
    await assert.rejects(readGrammarNotices({ sourceDirectory: bad }), /Missing licence notice/, `a ${label} notice must be refused`);
  }
  ok('an empty text, a text without a copyright year and a text without the MIT permission paragraph are refused');

  const partial = path.join(scratch, 'partial');
  fixtureNotices(partial, [first.id]);
  const allowed = await readGrammarNotices({ sourceDirectory: partial, allowPending: true });
  assert.deepEqual(allowed.pending.map((item) => item.entry.id), [first.id]);
  assert.equal(allowed.found.length, GRAMMAR_NOTICES.length - 1);
  ok('with allowPending (CI builds only) the missing notice is reported as pending instead of being dropped silently');

  // verifyRuntime on a fixture that has every required component
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  function makeRuntime(directory, { omit = [], pendingNotices = [] } = {}) {
    const paths = new Set([...REQUIRED_COMPONENTS, ...requiredLicenseFiles(pendingNotices)]);
    for (const skipped of omit) paths.delete(skipped);
    const files = [];
    for (const relative of [...paths].sort()) {
      const bytes = Buffer.from(`fixture ${relative}\n`);
      mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
      writeFileSync(path.join(directory, relative), bytes);
      files.push({ path: relative, size: bytes.length, sha256: sha(bytes) });
    }
    writeFileSync(path.join(directory, 'runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, target: 'win-x64', pendingNotices, files }));
    return directory;
  }
  const runtime = makeRuntime(path.join(scratch, 'runtime-ok'));
  const verified = await verifyRuntime(runtime);
  assert.deepEqual(verified.pendingNotices, []);
  ok(`verifyRuntime accepts a runtime with its ${requiredLicenseFiles([]).length} license files and ${REQUIRED_COMPONENTS.length} components`);

  for (const missing of requiredLicenseFiles([])) {
    const broken = makeRuntime(path.join(scratch, `runtime-without-${missing.replaceAll('/', '_')}`), { omit: [missing] });
    await assert.rejects(verifyRuntime(broken), (error) => error.message === `Missing required bundled component: ${missing}`, `verifyRuntime must reject a runtime without ${missing}`);
  }
  ok('verifyRuntime rejects a runtime without CPython LICENSE.txt, tree-sitter-wasms LICENSE or any grammar notice');

  const withPending = makeRuntime(path.join(scratch, 'runtime-pending'), { pendingNotices: GRAMMAR_NOTICES.map((entry) => entry.id) });
  assert.deepEqual((await verifyRuntime(withPending)).pendingNotices, GRAMMAR_NOTICES.map((entry) => entry.id));
  const unmarked = makeRuntime(path.join(scratch, 'runtime-pending-unmarked'), { pendingNotices: [first.id], omit: ['licenses/PENDING-NOTICES.txt'] });
  await assert.rejects(verifyRuntime(unmarked), /PENDING-NOTICES\.txt/, 'a runtime that names a pending notice must carry the marker file');
  ok('a runtime that stages without grammar notices must say so: pendingNotices in the manifest and licenses/PENDING-NOTICES.txt');

  // ---- 6. negative controls: defects in a temporary copy of the files ---------------------------------------------------------------
  const copyRoot = path.join(scratch, 'repo');
  const copy = (relative) => { mkdirSync(path.dirname(path.join(copyRoot, relative)), { recursive: true }); cpSync(path.join(REPO, relative), path.join(copyRoot, relative), { recursive: true }); };
  for (const relative of [...Object.values(SHIPPING_FILES), 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', 'CHATMCP-HUB/ui/package-lock.json', 'desktop-shell/ChatMCP.csproj',
    'scripts/Build-Installer.ps1', 'scripts/InstallerPayload.ps1', 'scripts/intelligence-runtime/package-lock.json', 'scripts/intelligence-runtime/stage.mjs',
    'scripts/intelligence-runtime/verify.mjs', 'scripts/intelligence-runtime/notices.mjs', 'scripts/intelligence-runtime/stage-python.ps1', 'scripts/intelligence-runtime/stage-ripgrep.ps1', '.github/workflows']) copy(relative);
  mkdirSync(path.join(copyRoot, 'scripts', 'intelligence-runtime', 'licenses'), { recursive: true });
  for (const entry of GRAMMAR_NOTICES) if (existsSync(path.join(REPO, 'scripts', 'intelligence-runtime', noticeSource(entry)))) copy(`scripts/intelligence-runtime/${noticeSource(entry)}`);
  const baseline = await checkNotices(copyRoot);
  assert.deepEqual(baseline.problems, [], 'the temporary copy must be clean before a defect is put in');

  const edit = (relative, change) => {
    const file = path.join(copyRoot, relative);
    const before = readFileSync(file, 'utf8');
    const after = change(before);
    assert.notEqual(after, before, `the mutation of ${relative} changed nothing`);
    writeFileSync(file, after);
    return () => writeFileSync(file, before);
  };
  const dropLines = (pattern) => (source) => source.split('\n').filter((line) => !pattern.test(line)).join('\n');
  const mutations = [
    ['the Node.js entry deleted from THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| Node\.js \(/), /no entry for Node\.js/],
    ['the CPython entry deleted from the plain-text notice', 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^ 2\. CPython embeddable[\s\S]*?(?=^ 3\.)/m, ''), /CHATMCP-HUB\/THIRD-PARTY-NOTICES\.txt has no entry for CPython/],
    ['the Tree-sitter python grammar removed from the plain-text notice', 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replaceAll('tree-sitter-python', 'tree-sitter-removed'), /tree-sitter-python grammar notice/],
    ['the Visual C++ runtime row deleted', 'THIRD-PARTY-NOTICES.md', dropLines(/Visual C\+\+ runtime/), /Visual C\+\+ runtime/],
    ['the old README wording back', 'README.md', (source) => source.replace(/^## License[\s\S]*?(?=^## Security)/m, '## License\n\nChatMCP does **not** currently have an adopted top-level project license in this repository.\n\n'), /License section|no project license/],
    ['LICENSE.txt dropped from the CPython staging assertion', 'scripts/intelligence-runtime/stage-python.ps1', (source) => source.replace(",'LICENSE.txt')", ')'), /does not require LICENSE\.txt/],
    ['the PSF text check dropped from the CPython staging', 'scripts/intelligence-runtime/stage-python.ps1', (source) => source.replace('PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2', 'x'), /PSF license text/],
    ['the ripgrep entry deleted from THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| ripgrep \(/), /THIRD-PARTY-NOTICES\.md has no entry for ripgrep/],
    ['the ripgrep entry deleted from the plain-text notice', 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^17\. ripgrep[\s\S]*?(?=^PENDING NOTICES)/m, ''), /CHATMCP-HUB\/THIRD-PARTY-NOTICES\.txt has no entry for ripgrep/],
    ['UNLICENSE dropped from the ripgrep staging assertion', 'scripts/intelligence-runtime/stage-ripgrep.ps1', (source) => source.replace("@('rg.exe', 'LICENSE-MIT', 'UNLICENSE')", "@('rg.exe', 'LICENSE-MIT')"), /does not require both LICENSE-MIT and UNLICENSE/],
    ['the ripgrep license text checks dropped from the staging', 'scripts/intelligence-runtime/stage-ripgrep.ps1', (source) => source.replace('free and unencumbered software released into the public domain', 'x'), /MIT and Unlicense texts/],
    ['stage.mjs no longer asserts the ripgrep license texts', 'scripts/intelligence-runtime/stage.mjs', (source) => source.replace("['rg.exe', 'LICENSE-MIT', 'UNLICENSE']", "['rg.exe']"), /staged ripgrep carries rg\.exe and both/],
    ['notices.mjs no longer lists the ripgrep license files', 'scripts/intelligence-runtime/notices.mjs', (source) => source.replace("'runtimes/ripgrep/UNLICENSE'", "'runtimes/ripgrep/x'"), /runtimes\/ripgrep\/UNLICENSE as a required license file/],
    ['the grammar notices no longer staged', 'scripts/intelligence-runtime/stage.mjs', (source) => source.replaceAll('readGrammarNotices', 'skipGrammarNotices'), /does not stage the Tree-sitter grammar notices/],
    ['verify.mjs no longer requires the license files', 'scripts/intelligence-runtime/verify.mjs', (source) => source.replace('requiredLicenseFiles(pendingNotices)', '[]'), /verify\.mjs does not require/],
    ['Build-Installer.ps1 no longer copies the Node.js LICENSE', 'scripts/Build-Installer.ps1', dropLines(/Copy-InstallerNodeLicense/), /Node\.js LICENSE next to/],
    ['the payload no longer requires THIRD-PARTY-NOTICES.md', 'scripts/InstallerPayload.ps1', (source) => source.replace(", 'THIRD-PARTY-NOTICES.md')) {", ')) {'), /does not require LICENSE, NOTICE and THIRD-PARTY-NOTICES\.md/],
    ['one UI package dropped from the generated list', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| `zustand` \|/), /generated list of UI packages/],
    ['a release workflow builds with pending notices allowed', '.github/workflows/publish-v3.9.0.yml', (source) => source.replace(/^jobs:/m, `env:\n  ${PENDING_ALLOWED_ENV}: '1'\njobs:`), /only ci\.yml may build/],
    ['the archived 1.x text back', 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', (source) => `ARCHIVED 1.x/2.x INTEGRATION NOTES - NOT CURRENT\n${source}`, /archived 1\.x text/],
  ];
  for (const [label, relative, change, expected] of mutations) {
    const restore = edit(relative, change);
    const result = await checkNotices(copyRoot);
    restore();
    assert.ok(result.problems.some((problem) => expected.test(problem)), `defect "${label}" was not reported; problems: ${JSON.stringify(result.problems)}`);
  }
  // a duplicate notices file and a vendored notice that makes the CI exception stale
  writeFileSync(path.join(copyRoot, 'THIRD_PARTY_NOTICES.md'), 'duplicate\n');
  assert.ok((await checkNotices(copyRoot)).problems.some((problem) => /THIRD_PARTY_NOTICES\.md is back/.test(problem)), 'a second notices file must be reported');
  rmSync(path.join(copyRoot, 'THIRD_PARTY_NOTICES.md'));
  ok(`${mutations.length + 1} seeded defects in a temporary copy are each reported by the check that owns them`);
  assert.deepEqual((await checkNotices(copyRoot)).problems, [], 'removing the defects must make the copy clean again');
  ok('the temporary copy is clean again once the defects are removed (the checks do not fail for unrelated reasons)');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`PASS: ${checks} license and third-party notice checks (${real.pending.length} grammar notice(s) pending, see above)`);
