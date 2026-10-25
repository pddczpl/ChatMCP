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
//   7. ripgrep: rg.exe is linked with PCRE2 and with Rust crates whose license texts are not in the ripgrep archive. They are vendored in
//      scripts/intelligence-runtime/licenses/ripgrep: MANIFEST.json is the inventory (derived from the Cargo.lock of the pinned release) with
//      the SHA-256 and the git blob id of every text. The inventory must belong to the archive that stage-ripgrep.ps1 pins, each text must be
//      what the manifest says and the kind of license that the crate's license expression names, no vendored file may be unlisted,
//      THIRD-PARTY-NOTICES.md and .txt must have a row for every component and no longer call ripgrep pending, stage.mjs must stage the
//      texts, verify.mjs must require them (with the vendored hashes), the payload and the installer build must check them, and
//      test-runtime.mjs must tie the notice to the shipped binary: the version string that the PCRE2 library carries ("10.46 2025-08-27") must be
//      in rg.exe, and `rg --pcre2-version` must print what the inventory records (10.45: it prints stale constants of the Rust bindings).
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

const noticesModule = await import(pathToFileURL(path.join(REPO, 'scripts', 'intelligence-runtime', 'notices.mjs')).href);
for (const name of ['readRipgrepNotices', 'judgeRipgrepText', 'requiredKindsOf', 'assertRipgrepPin', 'checkReportedPcre2', 'checkCompiledPcre2']) assert.equal(typeof noticesModule[name], 'function', `notices.mjs does not export ${name}`);
assert.ok(Array.isArray(noticesModule.RIPGREP_NOTICE_FILES) && noticesModule.RIPGREP_NOTICE_FILES.length > 1, 'notices.mjs does not export RIPGREP_NOTICE_FILES');
const { GRAMMAR_NOTICES, PENDING_ALLOWED_ENV, RIPGREP_NOTICE_FILES, assertRipgrepPin, checkCompiledPcre2, checkReportedPcre2, judgeRipgrepText, noticeSource, noticeStaged, readGrammarNotices, readRipgrepNotices, requiredKindsOf, requiredLicenseFiles } = noticesModule;
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

  // 7. ripgrep: PCRE2 and the Rust crates compiled into rg.exe ---------------------------------------------------------------------------
  const intelligence = path.join(repo, 'scripts', 'intelligence-runtime');
  let ripgrep = null;
  try { ripgrep = await readRipgrepNotices({ sourceDirectory: intelligence }); } catch (error) { fail(error.message); }
  if (ripgrep) {
    try { assertRipgrepPin(ripgrep.manifest, stageRipgrep); } catch (error) { fail(error.message); }
    const folder = path.join(intelligence, 'licenses', 'ripgrep');
    const listed = new Set(ripgrep.files.map((file) => file.path));
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (!listed.has(path.relative(folder, full).replaceAll('\\', '/'))) fail(`licenses/ripgrep/${path.relative(folder, full).replaceAll('\\', '/')} is not listed in MANIFEST.json (a text outside the inventory is neither checked nor staged)`);
      }
    };
    walk(folder);
    for (const component of ripgrep.manifest.components) {
      const label = component.type === 'crate' ? `\`${component.name}\`` : component.name;
      if (!markdown.includes(`| ${label} | ${component.version} | ${component.license} |`)) fail(`THIRD-PARTY-NOTICES.md has no row for ${component.name} ${component.version} (${component.license}) among the components compiled into rg.exe`);
      if (!text.includes(`${component.name} ${component.version} - ${component.license}`)) fail(`CHATMCP-HUB/THIRD-PARTY-NOTICES.txt has no line for ${component.name} ${component.version} (${component.license}) among the components compiled into rg.exe`);
    }
    // both PCRE2 numbers are in the prose: the compiled one (the notice is for it) and the one rg prints (stale)
    const pcre2 = ripgrep.manifest.components.find((component) => component.name === 'PCRE2');
    if (pcre2 && (!markdown.includes(pcre2.compiledVersionString) || !markdown.includes(`PCRE2 ${pcre2.rgReports}`))) fail(`THIRD-PARTY-NOTICES.md does not state both PCRE2 numbers: the version string compiled into rg.exe ("${pcre2.compiledVersionString}", which the notice is for) and the one rg --pcre2-version prints ("PCRE2 ${pcre2.rgReports}")`);
    if (pcre2 && !text.includes(pcre2.compiledVersionString)) fail(`CHATMCP-HUB/THIRD-PARTY-NOTICES.txt does not state the version string compiled into rg.exe ("${pcre2.compiledVersionString}")`);
    // the counts the prose gives are the inventory's
    const crates = ripgrep.manifest.components.length - 1;
    if (!markdown.includes(`${crates} Rust crates`) || !markdown.includes(`${ripgrep.manifest.notLinked.length} packages of the lock file that are not linked`)) fail(`THIRD-PARTY-NOTICES.md does not state the counts of the inventory (${crates} Rust crates, ${ripgrep.manifest.notLinked.length} packages of the lock file that are not linked)`);
    if (!text.includes(`${crates} Rust crates`)) fail(`CHATMCP-HUB/THIRD-PARTY-NOTICES.txt does not state the count of the inventory (${crates} Rust crates)`);
  }
  const ripgrepRow = markdown.split('\n').find((line) => /^\| ripgrep \(/.test(line)) ?? '';
  if (/pending/i.test(ripgrepRow)) fail('the ripgrep row of THIRD-PARTY-NOTICES.md still says Pending');
  if (!ripgrepRow.includes('licenses/ripgrep/')) fail('the ripgrep row of THIRD-PARTY-NOTICES.md does not say that the texts of PCRE2 and of the crates are in CHATMCP-HUB/licenses/ripgrep/');
  const pendingMarkdown = markdown.match(/^## Pending notices\s*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
  const pendingText = text.match(/^PENDING NOTICES\s*\n([\s\S]*?)(?=^NOT REDISTRIBUTED)/m)?.[1] ?? '';
  for (const [label, pendingList] of [['THIRD-PARTY-NOTICES.md', pendingMarkdown], ['CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', pendingText]]) {
    const flat = pendingList.replace(/\s+/g, ' ');
    if (!/Rust standard library/.test(flat)) fail(`${label} does not list the Rust standard library inside rg.exe among the pending notices (its toolchain is not pinned, so its texts are not vendored)`);
    if (!/static[^.]*C runtime|C runtime[^.]*static/i.test(flat)) fail(`${label} does not list the static Microsoft C runtime of rg.exe among the pending notices`);
  }
  const stageSource = read(repo, 'scripts', 'intelligence-runtime', 'stage.mjs');
  if (!stageSource.includes('readRipgrepNotices') || !stageSource.includes('assertRipgrepPin')) fail('stage.mjs does not stage the ripgrep notices (PCRE2 and the Rust crates) and check them against the pinned archive');
  if (!read(repo, 'scripts', 'intelligence-runtime', 'verify.mjs').includes('RIPGREP_NOTICE_FILES')) fail('verify.mjs does not compare the staged ripgrep notices with the vendored ones');
  const testRuntime = read(repo, 'scripts', 'intelligence-runtime', 'test-runtime.mjs');
  if (!testRuntime.includes('checkReportedPcre2')) fail('test-runtime.mjs does not compare the PCRE2 version that the bundled rg.exe prints with the notice');
  if (!testRuntime.includes('checkCompiledPcre2')) fail('test-runtime.mjs does not look for the version string of the PCRE2 compiled into the bundled rg.exe');
  if (!/^scripts\/intelligence-runtime\/licenses\/ripgrep\/\*\* -text$/m.test(read(repo, '.gitattributes'))) fail('.gitattributes does not keep the vendored ripgrep notices byte for byte: a Windows checkout would change their line ends and break their hashes');
  if (!payloadScript.includes('function Assert-InstallerRipgrepNotices')) fail('InstallerPayload.ps1 lost Assert-InstallerRipgrepNotices');
  const builder = read(repo, 'scripts', 'Build-Installer.ps1');
  const copiedLicenses = builder.indexOf("(Join-Path $intelligenceStage 'licenses') -Destination (Join-Path $hubPayload 'licenses')");
  if (copiedLicenses < 0 || builder.indexOf('Assert-InstallerRipgrepNotices -HubRoot $hubPayload') < copiedLicenses) fail('Build-Installer.ps1 does not check the ripgrep notices of the payload after copying the licenses folder');
  const lifecycle = read(repo, 'scripts', 'tests', 'windows-installer', 'guest-lifecycle.ps1');
  for (const staged of ripgrep ? ['licenses/ripgrep/MANIFEST.json', ripgrep.files.find((file) => file.kind === 'pcre2')?.staged] : []) {
    const installed = `CHATMCP-HUB\\${String(staged).replaceAll('/', '\\')}`;
    if (!lifecycle.includes(installed)) fail(`guest-lifecycle.ps1 does not list ${installed} among the installed files`);
  }
  return { problems, pending, ripgrep };
}

// =============================================================================================================================================
const real = await checkNotices(REPO);
assert.equal(real.problems.length, 0, `notice problems:\n  - ${real.problems.join('\n  - ')}`);
ok('README License section, LICENSE and NOTICE state Apache-2.0 and link the notices; no trace of the "no license" wording');
ok('every redistributed component has an entry with version, license id and license-text location in THIRD-PARTY-NOTICES.md and CHATMCP-HUB/THIRD-PARTY-NOTICES.txt');
ok('the UI package list in THIRD-PARTY-NOTICES.md equals the production closure of the UI lockfile; there is a single canonical notices file');
ok('stage-python.ps1, stage.mjs, verify.mjs, Build-Installer.ps1 and the payload script copy or assert the license files; no release workflow may build without them');
const noticePcre2 = real.ripgrep.manifest.components.find((component) => component.name === 'PCRE2');
ok(`PCRE2 ${noticePcre2.version} and ${real.ripgrep.manifest.components.length - 1} Rust crates compiled into rg.exe have their texts vendored, hashed and judged, a row in both notice files, and an inventory that belongs to the archive that stage-ripgrep.ps1 pins; no vendored file is unlisted`);
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
  // the ripgrep notices are the vendored bytes (verifyRuntime compares them with the vendored hashes); everything else is a stand-in
  const vendoredNotices = new Map(RIPGREP_NOTICE_FILES.map((file) => [file.staged, readFileSync(path.join(REPO, 'scripts', 'intelligence-runtime', ...file.staged.split('/')))]));
  function makeRuntime(directory, { omit = [], pendingNotices = [] } = {}) {
    const paths = new Set([...REQUIRED_COMPONENTS, ...requiredLicenseFiles(pendingNotices)]);
    for (const skipped of omit) paths.delete(skipped);
    const files = [];
    for (const relative of [...paths].sort()) {
      const bytes = vendoredNotices.get(relative) ?? Buffer.from(`fixture ${relative}\n`);
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

  for (const missing of requiredLicenseFiles([]).filter((relative) => !vendoredNotices.has(relative))) {
    const broken = makeRuntime(path.join(scratch, `runtime-without-${missing.replaceAll('/', '_')}`), { omit: [missing] });
    await assert.rejects(verifyRuntime(broken), (error) => error.message === `Missing required bundled component: ${missing}`, `verifyRuntime must reject a runtime without ${missing}`);
  }
  ok('verifyRuntime rejects a runtime without CPython LICENSE.txt, tree-sitter-wasms LICENSE or any grammar notice');

  const withPending = makeRuntime(path.join(scratch, 'runtime-pending'), { pendingNotices: GRAMMAR_NOTICES.map((entry) => entry.id) });
  assert.deepEqual((await verifyRuntime(withPending)).pendingNotices, GRAMMAR_NOTICES.map((entry) => entry.id));
  const unmarked = makeRuntime(path.join(scratch, 'runtime-pending-unmarked'), { pendingNotices: [first.id], omit: ['licenses/PENDING-NOTICES.txt'] });
  await assert.rejects(verifyRuntime(unmarked), /PENDING-NOTICES\.txt/, 'a runtime that names a pending notice must carry the marker file');
  ok('a runtime that stages without grammar notices must say so: pendingNotices in the manifest and licenses/PENDING-NOTICES.txt');

  // ---- 5b. the ripgrep notices: the real reader on the real texts, then one defect at a time -------------------------------------------
  const intelligence = path.join(REPO, 'scripts', 'intelligence-runtime');
  const folder = path.join(intelligence, 'licenses', 'ripgrep');
  const vendored = await readRipgrepNotices({ sourceDirectory: intelligence });
  const { components } = vendored.manifest;
  assert.equal(components[0].name, 'PCRE2', 'the inventory starts with the C library');
  assert.equal(vendored.files.length, components.reduce((sum, component) => sum + component.files.length, 0) + 1, 'every text and the inventory itself');
  assert.deepEqual(vendored.files.map((file) => file.staged).sort(), RIPGREP_NOTICE_FILES.map((file) => file.staged).sort(), 'notices.mjs requires exactly the files that the reader finds');
  ok(`readRipgrepNotices accepts the ${vendored.files.length - 1} vendored texts of ${components.length} components; notices.mjs requires exactly those files and the inventory`);

  /** The vendored folder in memory: `changes` maps a path below licenses/ripgrep to other bytes (null = the file is missing), `edit` changes the inventory. */
  const view = ({ changes = {}, edit = null } = {}) => async (file) => {
    const relative = path.relative(folder, file).replaceAll('\\', '/');
    if (relative === 'MANIFEST.json' && edit) { const inventory = structuredClone(vendored.manifest); edit(inventory); return Buffer.from(JSON.stringify(inventory)); }
    if (Object.hasOwn(changes, relative)) {
      if (changes[relative] === null) throw Object.assign(new Error(`ENOENT: ${relative}`), { code: 'ENOENT' });
      return changes[relative];
    }
    return readFileSync(file);
  };
  const refuses = (options, expected, message) => assert.rejects(readRipgrepNotices({ sourceDirectory: intelligence, readFile: view(options) }), (error) => /rg\.exe/.test(error.message) && expected.test(error.message), message);

  for (const component of components) {
    const first = component.files[0].path;
    await refuses({ changes: { [first]: null } }, new RegExp(`licenses/ripgrep/${escape(first)}[^;]*does not exist`), `a missing text of ${component.id} must stop staging`);
  }
  ok(`a missing text stops staging, for each of the ${components.length} components, and the message names the file`);

  const anyhow = components.find((component) => component.name === 'anyhow');
  const apache = anyhow.files.find((file) => file.kind === 'apache-2.0');
  const apacheBytes = readFileSync(path.join(folder, apache.path));
  await refuses({ changes: { [apache.path]: Buffer.concat([apacheBytes, Buffer.from(' ')]) } }, /SHA-256 differs/, 'one more byte');
  await refuses({ changes: { [apache.path]: Buffer.alloc(0) } }, /is empty/, 'no byte');
  await refuses({ edit: (inventory) => { inventory.components.find((component) => component.name === 'anyhow').files.find((file) => file.kind === 'apache-2.0').source.blob = '0'.repeat(40); } }, /git blob id/, 'another blob id');
  ok('a text with one more byte, with no byte, or with another git blob id than MANIFEST.json says is refused');

  const edits = [
    ['PCRE2 is missing from the inventory', (inventory) => { inventory.components = inventory.components.filter((component) => component.name !== 'PCRE2'); }, /no PCRE2/],
    ['the Apache text of a "MIT OR Apache-2.0" crate is not in the inventory', (inventory) => { const crate = inventory.components.find((component) => component.name === 'anyhow'); crate.files = crate.files.filter((file) => file.kind !== 'apache-2.0'); }, /anyhow[^;]*needs a text of kind apache-2\.0/],
    ['a license identifier is not one that notices.mjs knows', (inventory) => { inventory.components.find((component) => component.name === 'anyhow').license = 'MIT OR Frobnicate-1.0'; }, /Frobnicate-1\.0/],
    ['a text is declared as another kind', (inventory) => { inventory.components.find((component) => component.name === 'anyhow').files.find((file) => file.kind === 'mit').kind = 'apache-2.0'; }, /is not a text of kind apache-2\.0/],
    ['a path leaves the folder', (inventory) => { inventory.components[1].files[0].path = '../LICENSE'; }, /not a plain/],
    ['a text is listed twice', (inventory) => { inventory.components[1].files.push({ ...inventory.components[1].files[0] }); }, /listed twice/],
    ['a component has no text', (inventory) => { inventory.components[1].files = []; }, /lists no licence text/],
    ['there is no schema version', (inventory) => { delete inventory.schemaVersion; }, /schemaVersion/],
    ['the inventory is for another program', (inventory) => { inventory.subject.name = 'grep'; }, /subject/],
    ['the PCRE2 component names no compiled version string', (inventory) => { delete inventory.components.find((component) => component.name === 'PCRE2').compiledVersionString; }, /compiledVersionString/],
    ['the compiled version string is not one of the PCRE2 version', (inventory) => { inventory.components.find((component) => component.name === 'PCRE2').compiledVersionString = '10.45 2025-02-05'; }, /compiledVersionString/],
    ['the PCRE2 component does not say what rg prints', (inventory) => { delete inventory.components.find((component) => component.name === 'PCRE2').rgReports; }, /rgReports/],
  ];
  for (const [label, edit, expected] of edits) await refuses({ edit }, expected, `an inventory where ${label} must be refused`);
  ok(`an inventory is refused when ${edits.map(([label]) => label).join('; ')}`);

  // the judge reads words, not line breaks, and asks for no copyright line: the MIT texts of anyhow and serde have none
  const mitText = readFileSync(path.join(folder, anyhow.files.find((file) => file.kind === 'mit').path), 'utf8');
  assert.ok(!/copyright\s*\(c\)/i.test(mitText), 'the sample MIT text has no "Copyright (c) <year> <holder>" line, as upstream has none');
  assert.equal(judgeRipgrepText('mit', mitText), null);
  assert.equal(judgeRipgrepText('mit', mitText.replace(/\n/g, '\r\n')), null, 'CRLF does not matter');
  assert.equal(judgeRipgrepText('mit', mitText.replace(/\s+/g, ' ')), null, 'nor do line breaks');
  assert.match(judgeRipgrepText('apache-2.0', mitText) ?? '', /Apache License/);
  assert.match(judgeRipgrepText('mit', '') ?? '', /empty/);
  assert.match(judgeRipgrepText('gpl-3.0', mitText) ?? '', /unknown kind/);
  for (const kind of ['mit', 'apache-2.0', 'unlicense', 'bsd-3-clause', 'unicode', 'pcre2', 'pointer', 'notice']) assert.ok(judgeRipgrepText(kind, 'All rights reserved. '.repeat(30)), `a text that says nothing is not a ${kind} text`);
  ok('the judge reads words and not line breaks, wants no copyright line (the MIT texts of anyhow and serde have none), and refuses empty text, a text of another kind and an unknown kind');

  assert.deepEqual([...requiredKindsOf('MIT OR Apache-2.0')].sort(), ['apache-2.0', 'mit']);
  assert.deepEqual([...requiredKindsOf('Unlicense/MIT')].sort(), ['mit', 'unlicense']);
  assert.deepEqual([...requiredKindsOf('(Apache-2.0 OR MIT) AND BSD-3-Clause')].sort(), ['apache-2.0', 'bsd-3-clause', 'mit']);
  assert.deepEqual([...requiredKindsOf('BSD-3-Clause WITH PCRE2-exception')], ['pcre2']);
  assert.throws(() => requiredKindsOf('MIT OR Frobnicate-1.0'), /Frobnicate-1\.0/);
  ok('a license expression needs a text of each license it names; the PCRE2 exception needs the PCRE2 text; an unknown identifier is an error');

  // the inventory belongs to the archive that stage-ripgrep.ps1 pins
  const { subject } = vendored.manifest;
  const pinned = (version, hash) => `$source = 'https://example.invalid/ripgrep-${version}.zip'\n$expected = '${hash}'\n$expectedVersion = '${version}'\n`;
  assert.doesNotThrow(() => assertRipgrepPin(vendored.manifest, pinned(subject.version, subject.archiveSha256)));
  assert.doesNotThrow(() => assertRipgrepPin(vendored.manifest, pinned(subject.version, subject.archiveSha256).replace(/\n/g, '\r\n')), 'a script with CRLF line ends');
  assert.throws(() => assertRipgrepPin(vendored.manifest, pinned('15.2.1', subject.archiveSha256)), /stage-ripgrep\.ps1 pins ripgrep 15\.2\.1/);
  assert.throws(() => assertRipgrepPin(vendored.manifest, pinned(subject.version, 'a'.repeat(64))), /stage-ripgrep\.ps1 pins ripgrep/);
  assert.throws(() => assertRipgrepPin(vendored.manifest, '$expected = ""\n'), /pins no/);
  ok('the inventory is refused when stage-ripgrep.ps1 pins another version or another archive hash, or pins nothing');

  // What rg.exe says about its PCRE2. `rg --pcre2-version` prints the PCRE2_MAJOR/PCRE2_MINOR constants of the Rust bindings (pcre2-sys/src/bindings.rs), which were generated for
  // 10.45 and not regenerated when the bundled sources went to 10.46: the installer build found "PCRE2 10.45" in the real 15.2.0 binary while the notice is for 10.46. So the inventory
  // records both: what rg prints (rgReports) and the version string that the compiled library carries (compiledVersionString, the value of PCRE2_CONFIG_VERSION), and the check
  // that ties the notice to the shipped bytes is the second one.
  assert.match(noticePcre2.rgReports, /^\d+\.\d+$/);
  assert.notEqual(noticePcre2.rgReports, noticePcre2.version, 'the inventory records that rg prints another number than the compiled one');
  assert.match(noticePcre2.compiledVersionString, new RegExp(`^${escape(noticePcre2.version)} \\d{4}-\\d{2}-\\d{2}$`));
  assert.equal(checkReportedPcre2(vendored.manifest, `PCRE2 ${noticePcre2.rgReports} is available (JIT is available)\n`), null);
  assert.equal(checkReportedPcre2(vendored.manifest, `PCRE2 ${noticePcre2.rgReports} is available (JIT is unavailable)\n`), null);
  assert.match(checkReportedPcre2(vendored.manifest, 'PCRE2 10.99 is available (JIT is available)\n') ?? '', /10\.99/);
  assert.match(checkReportedPcre2(vendored.manifest, `PCRE2 ${noticePcre2.rgReports}0 is available\n`) ?? '', /differs/, 'a longer number is not the version');
  assert.match(checkReportedPcre2(vendored.manifest, 'PCRE2 is not available in this build of ripgrep.\n') ?? '', /without PCRE2/);
  assert.match(checkReportedPcre2(vendored.manifest, '') ?? '', /did not report/);
  ok(`rg --pcre2-version must print the ${noticePcre2.rgReports} that the inventory records (the stale constant of the bindings); no PCRE2 or no answer is refused`);

  const inFile = (text) => Buffer.concat([Buffer.alloc(64, 0x2a), Buffer.from(`${text}\0`, 'latin1'), Buffer.alloc(64, 0)]);
  assert.equal(checkCompiledPcre2(vendored.manifest, inFile(noticePcre2.compiledVersionString)), null);
  assert.match(checkCompiledPcre2(vendored.manifest, inFile('10.45 2025-02-05')) ?? '', /10\.45 2025-02-05/, 'it names the version string that it finds instead');
  assert.match(checkCompiledPcre2(vendored.manifest, inFile(`${noticePcre2.version} 2025-01-01`)) ?? '', /2025-01-01/, 'the date is part of the version string');
  assert.match(checkCompiledPcre2(vendored.manifest, Buffer.from('MZ without any version string')) ?? '', /no PCRE2 version string/);
  ok(`the version string "${noticePcre2.compiledVersionString}" that the PCRE2 library carries must be in rg.exe; another string, or none, is refused (and named)`);

  // verifyRuntime: every vendored text and the inventory are required, and each staged text must be the vendored one
  const fullRuntime = makeRuntime(path.join(scratch, 'runtime-with-ripgrep-notices'));
  await verifyRuntime(fullRuntime);
  const rewriteManifest = (directory, change) => {
    const file = path.join(directory, 'runtime-manifest.json');
    const original = readFileSync(file, 'utf8');
    const content = JSON.parse(original);
    change(content);
    writeFileSync(file, JSON.stringify(content));
    return () => writeFileSync(file, original);
  };
  for (const missing of [...components.map((component) => `licenses/ripgrep/${component.files[0].path}`), 'licenses/ripgrep/MANIFEST.json']) {
    const restore = rewriteManifest(fullRuntime, (content) => { content.files = content.files.filter((entry) => entry.path !== missing); });
    try {
      await assert.rejects(verifyRuntime(fullRuntime), (error) => error.message === `Missing required bundled component: ${missing}`, `verifyRuntime must reject a runtime without ${missing}`);
    } finally { restore(); }
  }
  ok(`verifyRuntime rejects a runtime that lacks the inventory or the first text of any of the ${components.length} ripgrep components`);

  const changed = makeRuntime(path.join(scratch, 'runtime-with-changed-notice'));
  const pcre2Staged = vendored.files.find((file) => file.kind === 'pcre2').staged;
  const forged = Buffer.from('This is not the PCRE2 licence.\n');
  writeFileSync(path.join(changed, ...pcre2Staged.split('/')), forged);
  rewriteManifest(changed, (content) => { const entry = content.files.find((item) => item.path === pcre2Staged); entry.size = forged.length; entry.sha256 = sha(forged); });
  await assert.rejects(verifyRuntime(changed), (error) => error.message === `Staged licence notice differs from the vendored one: ${pcre2Staged}`, 'a notice that is consistent with its manifest entry but is not the vendored text must be refused');
  ok('verifyRuntime compares every staged ripgrep notice with the vendored hash: a PCRE2 text replaced consistently (file and manifest entry) is refused');

  // ---- 6. negative controls: defects in a temporary copy of the files ---------------------------------------------------------------
  const copyRoot = path.join(scratch, 'repo');
  const copy = (relative) => { mkdirSync(path.dirname(path.join(copyRoot, relative)), { recursive: true }); cpSync(path.join(REPO, relative), path.join(copyRoot, relative), { recursive: true }); };
  for (const relative of [...Object.values(SHIPPING_FILES), 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', 'CHATMCP-HUB/ui/package-lock.json', 'desktop-shell/ChatMCP.csproj',
    'scripts/Build-Installer.ps1', 'scripts/InstallerPayload.ps1', 'scripts/intelligence-runtime/package-lock.json', 'scripts/intelligence-runtime/stage.mjs',
    'scripts/intelligence-runtime/verify.mjs', 'scripts/intelligence-runtime/notices.mjs', 'scripts/intelligence-runtime/stage-python.ps1', 'scripts/intelligence-runtime/stage-ripgrep.ps1',
    'scripts/intelligence-runtime/test-runtime.mjs', 'scripts/intelligence-runtime/licenses/ripgrep', 'scripts/tests/windows-installer/guest-lifecycle.ps1', '.gitattributes', '.github/workflows']) copy(relative);
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
    // ripgrep: PCRE2 and the Rust crates compiled into rg.exe
    ['a vendored ripgrep text is changed', `scripts/intelligence-runtime/licenses/ripgrep/${vendored.files.find((file) => file.kind === 'pcre2').path}`, (source) => `${source}\nAn extra line.\n`, /SHA-256 differs/],
    ['PCRE2 is no longer in the ripgrep inventory', 'scripts/intelligence-runtime/licenses/ripgrep/MANIFEST.json', (source) => source.replace('"name": "PCRE2"', '"name": "PCRE3"'), /no PCRE2/],
    ['the PCRE2 row deleted from THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| PCRE2 \|/), /THIRD-PARTY-NOTICES\.md has no row for PCRE2/],
    ['the zmij row deleted from THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| `zmij` \|/), /THIRD-PARTY-NOTICES\.md has no row for zmij/],
    ['the zmij line deleted from the plain-text notice', 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', dropLines(/\bzmij 1\.0\.23 - /), /THIRD-PARTY-NOTICES\.txt has no line for zmij/],
    ['the ripgrep row says Pending again', 'THIRD-PARTY-NOTICES.md', (source) => source.replace(/^(\| ripgrep \([^\n]*) \|$/m, '$1 Pending |'), /ripgrep row of THIRD-PARTY-NOTICES\.md still says Pending/],
    ['the Rust standard library no longer among the pending notices', 'THIRD-PARTY-NOTICES.md', (source) => source.replaceAll('Rust standard library', 'Rust library'), /does not list the Rust standard library/],
    ['the static C runtime no longer among the pending notices of the plain-text notice', 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replaceAll('C runtime', 'runtime'), /static Microsoft C runtime/],
    ['stage-ripgrep.ps1 pins another release', 'scripts/intelligence-runtime/stage-ripgrep.ps1', (source) => source.replace(`$expectedVersion = '${vendored.manifest.subject.version}'`, "$expectedVersion = '15.2.1'"), /stage-ripgrep\.ps1 pins ripgrep 15\.2\.1/],
    ['stage-ripgrep.ps1 pins another archive hash', 'scripts/intelligence-runtime/stage-ripgrep.ps1', (source) => source.replace(`$expected = '${vendored.manifest.subject.archiveSha256}'`, `$expected = '${'0'.repeat(64)}'`), /stage-ripgrep\.ps1 pins ripgrep/],
    ['stage.mjs no longer stages the ripgrep notices', 'scripts/intelligence-runtime/stage.mjs', (source) => source.replaceAll('readRipgrepNotices', 'skipRipgrepNotices'), /does not stage the ripgrep notices/],
    ['stage.mjs no longer checks the pinned archive against the notices', 'scripts/intelligence-runtime/stage.mjs', (source) => source.replaceAll('assertRipgrepPin', 'skipRipgrepPin'), /does not stage the ripgrep notices/],
    ['verify.mjs no longer compares the staged ripgrep notices with the vendored ones', 'scripts/intelligence-runtime/verify.mjs', (source) => source.replaceAll('RIPGREP_NOTICE_FILES', 'NO_NOTICE_FILES'), /does not compare the staged ripgrep notices/],
    ['test-runtime.mjs no longer compares the PCRE2 version that rg.exe prints', 'scripts/intelligence-runtime/test-runtime.mjs', (source) => source.replaceAll('checkReportedPcre2', 'skipPcre2Check'), /PCRE2 version that the bundled rg\.exe prints/],
    ['test-runtime.mjs no longer looks for the PCRE2 version string in rg.exe', 'scripts/intelligence-runtime/test-runtime.mjs', (source) => source.replaceAll('checkCompiledPcre2', 'skipCompiledCheck'), /version string of the PCRE2 compiled into the bundled rg\.exe/],
    ['the compiled PCRE2 version string is no longer in THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', (source) => source.replaceAll(vendored.manifest.components[0].compiledVersionString, 'x'), /does not state both PCRE2 numbers/],
    ['.gitattributes no longer keeps the ripgrep notices byte for byte', '.gitattributes', dropLines(/licenses\/ripgrep/), /byte for byte/],
    ['the payload script loses Assert-InstallerRipgrepNotices', 'scripts/InstallerPayload.ps1', (source) => source.replace('function Assert-InstallerRipgrepNotices', 'function Assert-SomethingElse'), /lost Assert-InstallerRipgrepNotices/],
    ['Build-Installer.ps1 no longer checks the ripgrep notices of the payload', 'scripts/Build-Installer.ps1', dropLines(/Assert-InstallerRipgrepNotices/), /does not check the ripgrep notices of the payload/],
    ['guest-lifecycle.ps1 no longer lists the ripgrep inventory among the installed files', 'scripts/tests/windows-installer/guest-lifecycle.ps1', (source) => source.replace('CHATMCP-HUB\\licenses\\ripgrep\\MANIFEST.json', 'CHATMCP-HUB\\licenses\\ripgrep\\x'), /guest-lifecycle\.ps1 does not list/],
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
  // a vendored file that the inventory does not list is neither hashed nor staged
  const stray = path.join(copyRoot, 'scripts', 'intelligence-runtime', 'licenses', 'ripgrep', path.dirname(vendored.files.find((file) => file.kind === 'pcre2').path), 'NOTES.txt');
  writeFileSync(stray, 'a text outside the inventory\n');
  assert.ok((await checkNotices(copyRoot)).problems.some((problem) => /NOTES\.txt is not listed in MANIFEST\.json/.test(problem)), 'a vendored file outside the inventory must be reported');
  rmSync(stray);
  ok(`${mutations.length + 2} seeded defects in a temporary copy are each reported by the check that owns them`);
  assert.deepEqual((await checkNotices(copyRoot)).problems, [], 'removing the defects must make the copy clean again');
  ok('the temporary copy is clean again once the defects are removed (the checks do not fail for unrelated reasons)');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`PASS: ${checks} license and third-party notice checks (${real.pending.length} grammar notice(s) pending, see above)`);
