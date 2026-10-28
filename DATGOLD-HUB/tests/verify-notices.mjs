// Licence statements and third-party notices must match what the product redistributes, and a missing notice must fail the build.
//
// docs/LICENSE-SCAN.md listed notices that were missing or wrong: Node.js shipped without its LICENSE, the Tree-sitter grammars without the
// MIT notices of their upstream projects, CPython / the Microsoft Visual C++ runtime without their terms, no assertion that CPython's
// LICENSE.txt was present, and a README that still said the project had no license. This suite checks, on the real files:
//
//   1. README "License" section: the Apache-2.0 statement with links to LICENSE, NOTICE, CONTRIBUTING.md and THIRD-PARTY-NOTICES.md,
//      and no trace of the old "no adopted license" wording. LICENSE and NOTICE are the Apache text and notice.
//   2. Inventory: every redistributed component (read from the two lockfiles, stage-python.ps1, the csproj and the staging code) has an
//      entry with its version, license id and the place of its license text in THIRD-PARTY-NOTICES.md AND DATGOLD-HUB/THIRD-PARTY-NOTICES.txt.
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
//   8. The Rust standard library inside rg.exe (the same inventory, `rustStd`): the toolchain that built it (the nightly of 2026-07-15, derived from the release record of
//      ripgrep and Rust's own nightly manifest), the texts of the library tree and of the crates it links for x86_64-pc-windows-msvc, and the packages of the library lock file it
//      does not link, each with the reason. test-runtime.mjs must look for the /rustc/<commit> source paths of that toolchain in rg.exe, and the static C runtime that the notices
//      claim must be real: the import table of rg.exe names no C runtime DLL (checkStaticCrt reads it from the PE file).
//   9. The Microsoft C/C++ runtime components (the static runtime inside rg.exe, the runtime DLLs inside the CPython archive): both notice files summarise the terms that
//      Microsoft publishes, with their conditions, the dates they were read and their links, and say that the text of those terms is not reproduced; none of it is pending any more.
//
// A notice whose upstream text is not in the repository yet is PENDING: the suite prints it and does not fail, because the staging code refuses a
// release build without it (step 5). The three Tree-sitter grammar texts are vendored, so none is pending today, and then nothing may call them so:
// no row or item of the two notice files, no list of pending notices, and no sentence of the scan, of the CI-health document or of the README of
// the vendored texts (grammarNoticeWording).
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
  console.log('CHATMCP_TEST_SKIP: README.md and scripts/ were not found next to DATGOLD-HUB (the notice checks need the whole repository)');
  process.exit(0);
}

const noticesModule = await import(pathToFileURL(path.join(REPO, 'scripts', 'intelligence-runtime', 'notices.mjs')).href);
for (const name of ['readRipgrepNotices', 'judgeRipgrepText', 'requiredKindsOf', 'assertRipgrepPin', 'checkReportedPcre2', 'checkCompiledPcre2', 'checkCompiledRust', 'checkStaticCrt', 'peImportedLibraries']) assert.equal(typeof noticesModule[name], 'function', `notices.mjs does not export ${name}`);
assert.ok(Array.isArray(noticesModule.RIPGREP_NOTICE_FILES) && noticesModule.RIPGREP_NOTICE_FILES.length > 1, 'notices.mjs does not export RIPGREP_NOTICE_FILES');
const { GRAMMAR_NOTICES, PENDING_ALLOWED_ENV, RIPGREP_NOTICE_FILES, assertRipgrepPin, checkCompiledPcre2, checkCompiledRust, checkReportedPcre2, checkStaticCrt, judgeRipgrepText, noticeSource, noticeStaged, peImportedLibraries, readGrammarNotices, readRipgrepNotices, requiredKindsOf, requiredLicenseFiles } = noticesModule;
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
  const ui = JSON.parse(read(repo, 'DATGOLD-HUB', 'ui', 'package-lock.json'));
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

/**
 * A grammar notice whose upstream text is in the repository is shipped, not pending. Returns the places that still say otherwise: the row of
 * THIRD-PARTY-NOTICES.md, the item of DATGOLD-HUB/THIRD-PARTY-NOTICES.txt, the lists of pending notices of both, the scan, the CI-health
 * document and the README of the vendored texts. `settingPending` are the workflows that set the variable which lets a build go without the texts.
 */
function grammarNoticeWording(repo, markdown, text, settingPending) {
  const problems = [];
  const fail = (message) => problems.push(message);
  for (const entry of GRAMMAR_NOTICES) {
    const row = markdown.split('\n').find((line) => line.startsWith('|') && word(entry.id).test(line)) ?? '';
    if (/pending/i.test(row)) fail(`the ${entry.id} row of THIRD-PARTY-NOTICES.md still says Pending: ${noticeSource(entry)} is in the repository`);
  }
  // the numbered item of the plain-text notice that names the grammars, from its number to the line before the next item
  // (a missing item is reported by the inventory check, not here)
  const lines = text.split('\n');
  const named = lines.findIndex((line) => word(GRAMMAR_NOTICES[0].id).test(line));
  let start = named;
  while (start > 0 && !/^\s*\d+\. /.test(lines[start])) start -= 1;
  let end = named + 1;
  while (end < lines.length && lines[end].trim() !== '' && !/^\s*\d+\. /.test(lines[end])) end += 1;
  const item = named < 0 ? NaN : Number(lines[start].match(/^\s*(\d+)\. /)?.[1]);
  if (!Number.isNaN(item) && /pending/i.test(lines.slice(start, end).join('\n'))) fail(`item ${item} (the Tree-sitter grammars) of DATGOLD-HUB/THIRD-PARTY-NOTICES.txt still says pending: their texts are in the repository`);
  const pendingMarkdown = markdown.match(/^## Pending notices\s*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
  const pendingText = text.match(/^PENDING NOTICES\s*\n([\s\S]*?)(?=^NOT REDISTRIBUTED)/m)?.[1] ?? '';
  if (/tree-?sitter/i.test(pendingMarkdown)) fail('THIRD-PARTY-NOTICES.md still lists the Tree-sitter grammar notices among the pending notices: their texts are in the repository');
  if (/tree-?sitter/i.test(pendingText)) fail('DATGOLD-HUB/THIRD-PARTY-NOTICES.txt still lists the Tree-sitter grammar notices among the pending notices: their texts are in the repository');
  // "Items 3, 9, 11, 12, 13 and 15 above." names the items by number
  const listed = [...pendingText.replace(/\s+/g, ' ').matchAll(/\bitems? (\d+(?:(?:, | and |, and )\d+)*) above\b/gi)].flatMap((match) => match[1].match(/\d+/g).map(Number));
  if (!Number.isNaN(item) && listed.includes(item)) fail(`DATGOLD-HUB/THIRD-PARTY-NOTICES.txt still lists item ${item} (the Tree-sitter grammars) among the pending notices`);

  const licenseScan = read(repo, 'docs', 'LICENSE-SCAN.md');
  const ciHealth = read(repo, 'docs', 'CI-HEALTH.md');
  const vendoredReadme = read(repo, 'scripts', 'intelligence-runtime', 'licenses', 'README.md');
  const finding5 = (licenseScan.match(/^## Status of the findings after the notice work\s*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '').split('\n').find((line) => /^\| 5 \|/.test(line)) ?? '';
  if (!finding5) fail('docs/LICENSE-SCAN.md has no row for finding 5 under "Status of the findings after the notice work"');
  if (/not in the repository|texts? missing|next step/i.test(finding5)) fail('docs/LICENSE-SCAN.md: the state of finding 5 still says that the grammar texts are missing or are the next step, but they are in the repository');
  const followUp = licenseScan.match(/^## Recommended follow-up\s*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
  const asked = GRAMMAR_NOTICES.map((entry) => path.basename(noticeSource(entry))).filter((file) => followUp.includes(file));
  if (asked.length > 0) fail(`docs/LICENSE-SCAN.md still recommends adding ${asked.join(', ')}, which ${asked.length === 1 ? 'is' : 'are'} in the repository`);
  if (settingPending.length === 0) {
    for (const [label, document] of [['THIRD-PARTY-NOTICES.md', markdown], ['DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', text], ['docs/LICENSE-SCAN.md', licenseScan], ['docs/CI-HEALTH.md', ciHealth]]) {
      if (document.includes(`${PENDING_ALLOWED_ENV}=1`)) fail(`${label} shows ${PENDING_ALLOWED_ENV}=1 as something that is set, but no workflow sets it`);
    }
    if (/\(CI does\)/.test(vendoredReadme)) fail(`scripts/intelligence-runtime/licenses/README.md still says that CI sets ${PENDING_ALLOWED_ENV}; no workflow does`);
  }
  if (/File to add here/.test(vendoredReadme)) fail('scripts/intelligence-runtime/licenses/README.md still calls the grammar files "File to add here": they are in the repository');
  return problems;
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
  const text = read(repo, 'DATGOLD-HUB', 'THIRD-PARTY-NOTICES.txt');
  if (/has not yet adopted a top-level/i.test(markdown)) fail('THIRD-PARTY-NOTICES.md still says that no top-level license exists');
  if (/ARCHIVED|NOT CURRENT/.test(text.split('\n').slice(0, 3).join('\n'))) fail('DATGOLD-HUB/THIRD-PARTY-NOTICES.txt is still the archived 1.x text');
  if (!/Permission is hereby granted, free of charge/.test(text)) fail('DATGOLD-HUB/THIRD-PARTY-NOTICES.txt lost the MIT permission text of the React 16 files it ships');
  if (existsSync(path.join(repo, 'THIRD_PARTY_NOTICES.md'))) fail('THIRD_PARTY_NOTICES.md is back: there is one canonical THIRD-PARTY-NOTICES.md (the list of UI packages is generated into it)');
  for (const entry of requiredEntries(repo)) {
    if (!entryHas(markdown, entry.name, entry.needles, entry.span)) fail(`THIRD-PARTY-NOTICES.md has no entry for ${entry.label} (needs ${entry.needles.map(String).join(', ')})`);
    if (entry.label === 'UI libraries' || entry.label.endsWith('license location')) continue;
    if (!entryHas(text, entry.name, entry.needles.filter((needle) => !(needle instanceof RegExp && needle.source === 'MIT')), entry.span + 1)) {
      fail(`DATGOLD-HUB/THIRD-PARTY-NOTICES.txt has no entry for ${entry.label}`);
    }
  }

  // 3. generated list equals the lockfile ----------------------------------------------------------------------------------------------
  try {
    const { current, expected } = await expectedDocument({ notices: path.join(repo, 'THIRD-PARTY-NOTICES.md'), lockfile: path.join(repo, 'DATGOLD-HUB', 'ui', 'package-lock.json') });
    if (current !== expected) fail('the generated list of UI packages in THIRD-PARTY-NOTICES.md differs from DATGOLD-HUB/ui/package-lock.json (run: node scripts/generate-licenses.mjs)');
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
  if (pending.length === 0) for (const problem of grammarNoticeWording(repo, markdown, text, setIn)) fail(problem);

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
      if (!text.includes(`${component.name} ${component.version} - ${component.license}`)) fail(`DATGOLD-HUB/THIRD-PARTY-NOTICES.txt has no line for ${component.name} ${component.version} (${component.license}) among the components compiled into rg.exe`);
    }
    // both PCRE2 numbers are in the prose: the compiled one (the notice is for it) and the one rg prints (stale)
    const pcre2 = ripgrep.manifest.components.find((component) => component.name === 'PCRE2');
    if (pcre2 && (!markdown.includes(pcre2.compiledVersionString) || !markdown.includes(`PCRE2 ${pcre2.rgReports}`))) fail(`THIRD-PARTY-NOTICES.md does not state both PCRE2 numbers: the version string compiled into rg.exe ("${pcre2.compiledVersionString}", which the notice is for) and the one rg --pcre2-version prints ("PCRE2 ${pcre2.rgReports}")`);
    if (pcre2 && !text.includes(pcre2.compiledVersionString)) fail(`DATGOLD-HUB/THIRD-PARTY-NOTICES.txt does not state the version string compiled into rg.exe ("${pcre2.compiledVersionString}")`);
    // the counts the prose gives are the inventory's: the crates of ripgrep's Cargo.lock, and the packages of the Rust library lock file that the standard library does not link
    const crates = ripgrep.manifest.components.filter((component) => component.type === 'crate' && component.origin !== 'rust-std').length;
    const rust = ripgrep.manifest.rustStd;
    const rustNotLinked = rust?.notLinked?.length ?? 0;
    if (!markdown.includes(`${crates} Rust crates`) || !markdown.includes(`${ripgrep.manifest.notLinked.length} packages of the lock file that are not linked`)) fail(`THIRD-PARTY-NOTICES.md does not state the counts of the inventory (${crates} Rust crates, ${ripgrep.manifest.notLinked.length} packages of the lock file that are not linked)`);
    if (!markdown.includes(`${rustNotLinked} packages of the Rust library lock file that are not linked`)) fail(`THIRD-PARTY-NOTICES.md does not state how many packages of the Rust library lock file the standard library does not link (${rustNotLinked})`);
    if (!text.includes(`${crates} Rust crates`)) fail(`DATGOLD-HUB/THIRD-PARTY-NOTICES.txt does not state the count of the inventory (${crates} Rust crates)`);
    // the toolchain that built rg.exe, and the check that ties the notice to the binary
    for (const [label, document] of [['THIRD-PARTY-NOTICES.md', markdown], ['DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', text]]) {
      if (!rust) { fail(`the inventory has no rustStd record, so ${label} cannot be checked against the toolchain`); break; }
      if (!document.includes(rust.toolchain.rustc)) fail(`${label} does not name the Rust toolchain that built rg.exe ("${rust.toolchain.rustc}")`);
      if (!document.includes('/rustc/')) fail(`${label} does not say that the installer build looks for the /rustc/<commit> source paths of the toolchain in rg.exe`);
    }
    if (rust && !markdown.includes(rust.toolchain.commit)) fail(`THIRD-PARTY-NOTICES.md does not name the commit of the Rust toolchain (${rust.toolchain.commit})`);
  }
  const ripgrepRow = markdown.split('\n').find((line) => /^\| ripgrep \(/.test(line)) ?? '';
  if (/pending/i.test(ripgrepRow)) fail('the ripgrep row of THIRD-PARTY-NOTICES.md still says Pending');
  if (!ripgrepRow.includes('licenses/ripgrep/')) fail('the ripgrep row of THIRD-PARTY-NOTICES.md does not say that the texts of PCRE2 and of the crates are in DATGOLD-HUB/licenses/ripgrep/');
  const pendingMarkdown = markdown.match(/^## Pending notices\s*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
  const pendingText = text.match(/^PENDING NOTICES\s*\n([\s\S]*?)(?=^NOT REDISTRIBUTED)/m)?.[1] ?? '';
  for (const [label, pendingList] of [['THIRD-PARTY-NOTICES.md', pendingMarkdown], ['DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', pendingText]]) {
    const flat = pendingList.replace(/\s+/g, ' ');
    if (/Rust standard library/.test(flat)) fail(`${label} still lists the Rust standard library inside rg.exe among the pending notices: its texts are vendored in licenses/ripgrep`);
    if (/static[^.]*C runtime|C runtime[^.]*static/i.test(flat)) fail(`${label} still lists the static Microsoft C runtime of rg.exe among the pending notices: its terms are summarised in the section "Microsoft C/C++ runtime components"`);
    if (/Visual C\+\+ runtime/i.test(flat)) fail(`${label} still lists the Microsoft Visual C++ runtime among the pending notices: its terms are summarised in the section "Microsoft C/C++ runtime components"`);
  }
  if (/\bItems? 3\b/.test(pendingText.replace(/\s+/g, ' '))) fail('DATGOLD-HUB/THIRD-PARTY-NOTICES.txt still lists item 3 (the Microsoft Visual C++ runtime) among the pending notices');
  // The Microsoft runtime components (the static C runtime inside rg.exe, the runtime DLLs inside the CPython archive): decided on 2026-10-25 to name them and summarise the terms
  // that Microsoft publishes, without reproducing any Microsoft text. The sections must carry the facts that make the summary honest.
  const microsoftRow = markdown.split('\n').find((line) => /^\| Microsoft Visual C\+\+ runtime/.test(line)) ?? '';
  if (/pending/i.test(microsoftRow)) fail('the Microsoft Visual C++ runtime row of THIRD-PARTY-NOTICES.md still says Pending');
  if (!microsoftRow.includes('Microsoft C/C++ runtime components')) fail('the Microsoft Visual C++ runtime row of THIRD-PARTY-NOTICES.md does not point to the section "Microsoft C/C++ runtime components"');
  const microsoftItem = text.match(/^ ?\d+\. Microsoft Visual C\+\+ runtime[\s\S]*?(?=^ ?\d+\. )/m)?.[0] ?? '';
  if (/pending/i.test(microsoftItem)) fail('the Microsoft Visual C++ runtime item of DATGOLD-HUB/THIRD-PARTY-NOTICES.txt still says pending');
  if (!microsoftItem.includes('Microsoft C/C++ runtime components')) fail('the Microsoft Visual C++ runtime item of DATGOLD-HUB/THIRD-PARTY-NOTICES.txt does not point to the section "Microsoft C/C++ runtime components"');
  const microsoftMarkdown = markdown.match(/^## Microsoft C\/C\+\+ runtime components\s*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
  const microsoftText = text.match(/^MICROSOFT C\/C\+\+ RUNTIME COMPONENTS\s*\n([\s\S]*?)(?=^PENDING NOTICES)/m)?.[1] ?? '';
  const microsoftFacts = [
    [/libucrt\.lib/, 'libucrt.lib (the static Universal C runtime, from the Windows SDK)'], [/libcmt\.lib/, 'libcmt.lib'], [/libvcruntime\.lib/, 'libvcruntime.lib'], [/vcruntime140\.dll/, 'vcruntime140.dll'],
    [/Static LIB files/, 'the "Static LIB files" section of the Windows SDK REDIST list'], [/end users/i, 'the condition about terms for end users'], [/indemnif/i, 'the indemnity condition'],
    [/not legal advice/i, 'that this is not legal advice'], [/2026-10-25/, 'the date on which the terms were read'],
  ];
  for (const [label, section] of [['THIRD-PARTY-NOTICES.md', microsoftMarkdown], ['DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', microsoftText]]) {
    if (!section) { fail(`${label} has no section "Microsoft C/C++ runtime components"`); continue; }
    for (const [pattern, what] of microsoftFacts) if (!pattern.test(section)) fail(`${label}: the section on the Microsoft C/C++ runtime components does not mention ${what}`);
  }
  for (const url of ['learn.microsoft.com/en-us/legal/windows-sdk/redist', 'visualstudio.microsoft.com/license-terms', 'learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files']) {
    if (microsoftMarkdown && !microsoftMarkdown.includes(url)) fail(`THIRD-PARTY-NOTICES.md: the section on the Microsoft C/C++ runtime components does not link ${url}`);
  }
  if (microsoftMarkdown && !/significant primary functionality/i.test(microsoftMarkdown)) fail('THIRD-PARTY-NOTICES.md: the section on the Microsoft C/C++ runtime components does not state the "significant primary functionality" condition');
  if (microsoftMarkdown && !/not reproduced/i.test(microsoftMarkdown)) fail('THIRD-PARTY-NOTICES.md: the section on the Microsoft C/C++ runtime components does not say that the text of the Microsoft terms is not reproduced');
  const licenseScan = read(repo, 'docs', 'LICENSE-SCAN.md');
  if (/Not covered: the Rust standard library/.test(licenseScan)) fail('docs/LICENSE-SCAN.md still says that the Rust standard library inside rg.exe is not covered');
  const licensesReadme = read(repo, 'scripts', 'intelligence-runtime', 'licenses', 'README.md');
  if (/named as open items/.test(licensesReadme)) fail('scripts/intelligence-runtime/licenses/README.md still names the Rust standard library and the C runtime of rg.exe as open items');
  if (ripgrep && !licensesReadme.includes(ripgrep.manifest.rustStd?.toolchain?.commit ?? 'no-toolchain')) fail('scripts/intelligence-runtime/licenses/README.md does not say how the Rust standard library notices were derived (it does not name the commit of the toolchain)');
  const stageSource = read(repo, 'scripts', 'intelligence-runtime', 'stage.mjs');
  if (!stageSource.includes('readRipgrepNotices') || !stageSource.includes('assertRipgrepPin')) fail('stage.mjs does not stage the ripgrep notices (PCRE2 and the Rust crates) and check them against the pinned archive');
  if (!read(repo, 'scripts', 'intelligence-runtime', 'verify.mjs').includes('RIPGREP_NOTICE_FILES')) fail('verify.mjs does not compare the staged ripgrep notices with the vendored ones');
  const testRuntime = read(repo, 'scripts', 'intelligence-runtime', 'test-runtime.mjs');
  if (!testRuntime.includes('checkReportedPcre2')) fail('test-runtime.mjs does not compare the PCRE2 version that the bundled rg.exe prints with the notice');
  if (!testRuntime.includes('checkCompiledPcre2')) fail('test-runtime.mjs does not look for the version string of the PCRE2 compiled into the bundled rg.exe');
  if (!testRuntime.includes('checkCompiledRust')) fail('test-runtime.mjs does not look for the /rustc/<commit> source paths of the Rust toolchain in the bundled rg.exe');
  if (!testRuntime.includes('checkStaticCrt')) fail('test-runtime.mjs does not check that the bundled rg.exe imports no C runtime DLL (the notices say that the runtime is linked statically)');
  if (!/^scripts\/intelligence-runtime\/licenses\/ripgrep\/\*\* -text$/m.test(read(repo, '.gitattributes'))) fail('.gitattributes does not keep the vendored ripgrep notices byte for byte: a Windows checkout would change their line ends and break their hashes');
  if (!payloadScript.includes('function Assert-InstallerRipgrepNotices')) fail('InstallerPayload.ps1 lost Assert-InstallerRipgrepNotices');
  const builder = read(repo, 'scripts', 'Build-Installer.ps1');
  const copiedLicenses = builder.indexOf("(Join-Path $intelligenceStage 'licenses') -Destination (Join-Path $hubPayload 'licenses')");
  if (copiedLicenses < 0 || builder.indexOf('Assert-InstallerRipgrepNotices -HubRoot $hubPayload') < copiedLicenses) fail('Build-Installer.ps1 does not check the ripgrep notices of the payload after copying the licenses folder');
  const lifecycle = read(repo, 'scripts', 'tests', 'windows-installer', 'guest-lifecycle.ps1');
  const rustRoot = ripgrep?.manifest.components.find((component) => component.type === 'rust-library')?.files[0].path;
  for (const staged of ripgrep ? ['licenses/ripgrep/MANIFEST.json', ripgrep.files.find((file) => file.kind === 'pcre2')?.staged, `licenses/ripgrep/${rustRoot}`] : []) {
    const installed = `CHATMCP-HUB\\${String(staged).replaceAll('/', '\\')}`;
    if (!lifecycle.includes(installed)) fail(`guest-lifecycle.ps1 does not list ${installed} among the installed files`);
  }
  return { problems, pending, ripgrep };
}

// =============================================================================================================================================
const real = await checkNotices(REPO);
assert.equal(real.problems.length, 0, `notice problems:\n  - ${real.problems.join('\n  - ')}`);
ok('README License section, LICENSE and NOTICE state Apache-2.0 and link the notices; no trace of the "no license" wording');
ok('every redistributed component has an entry with version, license id and license-text location in THIRD-PARTY-NOTICES.md and DATGOLD-HUB/THIRD-PARTY-NOTICES.txt');
ok('the UI package list in THIRD-PARTY-NOTICES.md equals the production closure of the UI lockfile; there is a single canonical notices file');
ok('the Tree-sitter grammar texts are vendored, so they are shipped and not pending: no row, item or list of pending notices in the two notice files, and no sentence of the scan, of the CI-health document or of the README of the vendored texts, says otherwise');
ok('stage-python.ps1, stage.mjs, verify.mjs, Build-Installer.ps1 and the payload script copy or assert the license files; no release workflow may build without them');
const noticePcre2 = real.ripgrep.manifest.components.find((component) => component.name === 'PCRE2');
const noticeRust = real.ripgrep.manifest.rustStd;
ok(`PCRE2 ${noticePcre2.version}, the Rust standard library (${noticeRust.toolchain.rustc}) with its in-tree parts and ${real.ripgrep.manifest.components.filter((component) => component.type === 'crate').length} Rust crates compiled into rg.exe have their texts vendored, hashed and judged, a row in both notice files, and an inventory that belongs to the archive that stage-ripgrep.ps1 pins; no vendored file is unlisted`);
ok('the pending lists no longer name the Rust standard library or the Microsoft runtimes; both notice files summarise the Microsoft terms (libucrt.lib, libcmt.lib, libvcruntime.lib, vcruntime140.dll) with their conditions, dates and links, and say that the text is not reproduced');
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
  // the Rust standard library: the toolchain that built rg.exe, the texts of its tree and of the crates it links, and what it does not link
  const rustStd = vendored.manifest.rustStd;
  assert.match(rustStd.toolchain.commit, /^[0-9a-f]{40}$/);
  assert.match(rustStd.toolchain.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(rustStd.toolchain.rustc.includes(rustStd.toolchain.commit.slice(0, 9)), 'the rustc version string names the commit');
  assert.equal(rustStd.toolchain.inspectedBinary, false, 'the toolchain is derived from the release record; the installer build checks it against the binary');
  assert.ok(rustStd.notLinked.length > 0 && rustStd.notLinked.every((item) => item.name && item.version && item.reason), 'every package of the library lock file that std does not link has a reason');
  const stdComponent = components.find((component) => component.type === 'rust-library');
  assert.equal(stdComponent.name, 'Rust standard library');
  assert.equal(stdComponent.version, rustStd.toolchain.rustc);
  assert.ok(stdComponent.files.every((file) => file.source.commit === rustStd.toolchain.commit), 'the root texts of the Rust standard library are those of the commit that the toolchain was built from');
  assert.deepEqual(stdComponent.files.map((file) => file.kind).sort(), ['apache-2.0', 'mit', 'notice']);
  const partNames = components.filter((component) => component.type === 'rust-library-part').map((component) => component.name);
  for (const part of ['Rust core::unicode tables', 'Rust std::sync::mpmc', 'Rust backtrace (backtrace-rs)', 'Rust compiler_builtins and libm', 'Rust stdarch (core::arch, std_detect)', 'Rust portable-simd (core::simd)']) assert.ok(partNames.includes(part), `the inventory has the in-tree part ${part}`);
  for (const crate of ['hashbrown', 'rustc-demangle', 'cfg-if']) assert.ok(components.some((component) => component.type === 'crate' && component.name === crate), `the inventory has the crate ${crate}, which the Rust standard library links`);
  assert.ok(components.filter((component) => component.origin === 'rust-std').every((component) => component.type === 'crate'), 'only crates carry the origin rust-std');
  for (const absent of ['libc', 'miniz_oxide', 'addr2line', 'object', 'gimli', 'memchr', 'foldhash', 'dlmalloc']) assert.ok(rustStd.notLinked.some((item) => item.name === absent), `${absent} is named among the packages that the Rust standard library does not link for x86_64-pc-windows-msvc`);
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
    // the Rust standard library
    ['there is no record of the Rust standard library', (inventory) => { delete inventory.rustStd; }, /rustStd/],
    ['the toolchain commit is not a commit', (inventory) => { inventory.rustStd.toolchain.commit = 'da80ed07'; }, /rustStd\.toolchain\.commit/],
    ['the toolchain date is not a date', (inventory) => { inventory.rustStd.toolchain.date = 'yesterday'; }, /rustStd\.toolchain\.date/],
    ['the rustc version string is not of the form that rustc prints', (inventory) => { inventory.rustStd.toolchain.rustc = '1.99.0-nightly (0000000 2026-07-14)'; }, /rustc version string/],
    ['the rustc version string names another commit', (inventory) => { inventory.rustStd.toolchain.rustc = '1.99.0-nightly (123456789 2026-07-14)'; }, /rustc version string/],
    ['the library lock file is of another commit than the toolchain', (inventory) => { inventory.rustStd.lockfile.commit = '0'.repeat(40); }, /lockfile/],
    ['the packages that the standard library does not link are not listed', (inventory) => { inventory.rustStd.notLinked = []; }, /rustStd\.notLinked/],
    ['a package that the standard library does not link has no reason', (inventory) => { delete inventory.rustStd.notLinked[0].reason; }, /rustStd\.notLinked/],
    ['the Rust standard library component is missing', (inventory) => { inventory.components = inventory.components.filter((component) => component.type !== 'rust-library'); }, /no component of type rust-library/],
    ['the Rust standard library component is for another version than the toolchain', (inventory) => { inventory.components.find((component) => component.type === 'rust-library').version = '1.98.0'; }, /Rust standard library[^;]*toolchain/],
    ['the Rust standard library texts are from another commit than the toolchain', (inventory) => { inventory.components.find((component) => component.type === 'rust-library').files[0].source.commit = '0'.repeat(40); }, /toolchain/],
    ['an in-tree part is for another version than the toolchain', (inventory) => { inventory.components.find((component) => component.type === 'rust-library-part').version = '1.98.0'; }, /in-tree part[^;]*toolchain/],
    ['the compiler_builtins component has no libm text', (inventory) => { const part = inventory.components.find((component) => component.name === 'Rust compiler_builtins and libm'); part.files = part.files.filter((file) => file.kind !== 'libm'); }, /needs a text of kind libm/],
    ['the compiler_builtins component has no composite text', (inventory) => { const part = inventory.components.find((component) => component.name === 'Rust compiler_builtins and libm'); part.files = part.files.filter((file) => file.kind !== 'compiler-builtins'); }, /needs a text of kind compiler-builtins/],
    ['the core::unicode tables have no Unicode text', (inventory) => { inventory.components.find((component) => component.name === 'Rust core::unicode tables').files = []; }, /lists no licence text/],
    ['an Unicode V3 text is declared as the older Unicode text', (inventory) => { inventory.components.find((component) => component.name === 'Rust core::unicode tables').files[0].kind = 'unicode'; }, /is not a text of kind unicode/],
    ['a Rust standard library crate is declared with a license that notices.mjs does not know', (inventory) => { inventory.components.find((component) => component.name === 'hashbrown').license = 'MIT OR Zlib'; }, /Zlib/],
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
  for (const kind of ['mit', 'apache-2.0', 'unlicense', 'bsd-3-clause', 'unicode', 'unicode-3.0', 'compiler-builtins', 'libm', 'pcre2', 'pointer', 'notice']) assert.ok(judgeRipgrepText(kind, 'All rights reserved. '.repeat(30)), `a text that says nothing is not a ${kind} text`);
  ok('the judge reads words and not line breaks, wants no copyright line (the MIT texts of anyhow and serde have none), and refuses empty text, a text of another kind and an unknown kind');

  // The kinds that the Rust standard library needs. Each real text is judged by its own kind, and no other kind takes it: the Unicode License V3 of core::unicode is not the older
  // "Unicode, Inc. License Agreement" of bstr, and the two composite files of compiler_builtins (MIT, Apache-2.0 and the LLVM exception in one file; libm with its musl copyrights)
  // are texts of their own.
  const textOf = (kind) => { const file = vendored.files.find((item) => item.kind === kind); assert.ok(file, `the inventory has a text of kind ${kind}`); return readFileSync(path.join(folder, file.path), 'utf8'); };
  for (const kind of ['unicode-3.0', 'compiler-builtins', 'libm']) {
    assert.equal(judgeRipgrepText(kind, textOf(kind)), null, `the vendored ${kind} text is a ${kind} text`);
    assert.equal(judgeRipgrepText(kind, textOf(kind).replace(/\n/g, '\r\n')), null, `CRLF does not matter for a ${kind} text`);
    for (const other of ['unlicense', 'bsd-3-clause', 'pcre2', 'pointer']) assert.ok(judgeRipgrepText(other, textOf(kind)), `a ${kind} text is not a ${other} text`);
  }
  assert.equal(judgeRipgrepText('unicode', textOf('unicode')), null);
  assert.match(judgeRipgrepText('unicode-3.0', textOf('unicode')) ?? '', /UNICODE LICENSE V3/, 'the older Unicode text is not the V3 text');
  assert.match(judgeRipgrepText('unicode', textOf('unicode-3.0')) ?? '', /heading/, 'the V3 text is not the older Unicode text');
  assert.match(judgeRipgrepText('compiler-builtins', textOf('libm')) ?? '', /compiler-builtins/, 'the libm file is not the compiler-builtins file');
  assert.match(judgeRipgrepText('libm', textOf('compiler-builtins')) ?? '', /libm/, 'the compiler-builtins file is not the libm file');
  assert.match(judgeRipgrepText('compiler-builtins', textOf('compiler-builtins').replace(/LLVM Exceptions to the Apache 2\.0 License/g, 'x')) ?? '', /LLVM exception/i, 'the compiler-builtins text must carry the LLVM exception');
  assert.match(judgeRipgrepText('libm', textOf('libm').replace(/Rich Felker/g, 'x')) ?? '', /musl/, 'the libm text must carry the musl copyright');
  ok('the kinds of the Rust standard library (unicode-3.0, compiler-builtins, libm) judge their own real text and nothing else; the Unicode V3 text and the older Unicode text are told apart; the LLVM exception and the musl copyright are required');

  assert.deepEqual([...requiredKindsOf('MIT OR Apache-2.0')].sort(), ['apache-2.0', 'mit']);
  assert.deepEqual([...requiredKindsOf('Unlicense/MIT')].sort(), ['mit', 'unlicense']);
  assert.deepEqual([...requiredKindsOf('(Apache-2.0 OR MIT) AND BSD-3-Clause')].sort(), ['apache-2.0', 'bsd-3-clause', 'mit']);
  assert.deepEqual([...requiredKindsOf('BSD-3-Clause WITH PCRE2-exception')], ['pcre2']);
  assert.throws(() => requiredKindsOf('MIT OR Frobnicate-1.0'), /Frobnicate-1\.0/);
  ok('a license expression needs a text of each license it names; the PCRE2 exception needs the PCRE2 text; an unknown identifier is an error');

  // The Rust standard library: Unicode-3.0 is the V3 text, and the one expression of compiler_builtins (MIT AND Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0)) is answered by
  // the two composite files that its repository carries, as the PCRE2 exception is answered by the PCRE2 file. The exception alone, or a part of that expression, is not known.
  assert.deepEqual([...requiredKindsOf('Unicode-3.0')], ['unicode-3.0']);
  assert.deepEqual([...requiredKindsOf('MIT AND Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0)')].sort(), ['compiler-builtins', 'libm']);
  assert.deepEqual([...requiredKindsOf('MIT AND  Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0)')].sort(), ['compiler-builtins', 'libm'], 'extra white space does not matter');
  assert.throws(() => requiredKindsOf('Apache-2.0 WITH LLVM-exception'), /LLVM-exception/);
  assert.throws(() => requiredKindsOf('MIT AND Apache-2.0 WITH LLVM-exception'), /LLVM-exception/);
  assert.throws(() => requiredKindsOf('MIT OR Apache-2.0 WITH LLVM-exception'), /LLVM-exception/);
  ok('Unicode-3.0 needs the V3 text and the one expression of compiler_builtins needs its two composite files; the LLVM exception alone or in another expression is an error');

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

  // The Rust toolchain: std and core carry the paths of their sources, /rustc/<commit hash>/library/..., into every binary that can panic in them (on Windows the part after the hash is
  // often written with backslashes). The commit that the inventory names must be among them; a binary built by another toolchain is refused and the commits that it carries are named.
  const toolchain = vendored.manifest.rustStd.toolchain;
  const rustPath = (separator, commit = toolchain.commit) => inFile(`/rustc/${commit}${separator}library${separator}core${separator}src${separator}panicking.rs`);
  assert.equal(checkCompiledRust(vendored.manifest, rustPath('/')), null);
  assert.equal(checkCompiledRust(vendored.manifest, rustPath('\\')), null, 'the part after the hash written with backslashes');
  assert.match(checkCompiledRust(vendored.manifest, rustPath('/', 'a'.repeat(40))) ?? '', new RegExp(`${'a'.repeat(40)}[^]*${toolchain.commit}`), 'it names the commit that it finds, and the one that the notice is for');
  assert.match(checkCompiledRust(vendored.manifest, Buffer.concat([rustPath('/', 'a'.repeat(40)), rustPath('\\', 'b'.repeat(40))])) ?? '', new RegExp(`${'a'.repeat(40)}[^]*${'b'.repeat(40)}`), 'it names every commit that it finds');
  assert.match(checkCompiledRust(vendored.manifest, rustPath('/', `${toolchain.commit.slice(0, 39)}${toolchain.commit.endsWith('0') ? '1' : '0'}`)) ?? '', /not of the commit/, 'one digit of the hash makes it another toolchain');
  assert.match(checkCompiledRust(vendored.manifest, inFile(`/rustc/${toolchain.commit}`)) ?? '', /no \/rustc\//, 'a hash that no path follows is not a source path');
  assert.match(checkCompiledRust(vendored.manifest, inFile(`rustc/${toolchain.commit}/library/core`)) ?? '', /no \/rustc\//, 'it must be the /rustc/ prefix');
  assert.match(checkCompiledRust(vendored.manifest, Buffer.from('MZ without any source path')) ?? '', /no \/rustc\//);
  assert.match(checkCompiledRust({ ...vendored.manifest, rustStd: undefined }, rustPath('/')) ?? '', /no Rust toolchain/);
  ok(`the source paths of the toolchain (/rustc/${toolchain.commit.slice(0, 9)}...) must be in rg.exe, with a slash or a backslash after the hash; another commit, a hash without a path, or none is refused (and the commits found are named)`);

  // The C runtime is linked statically: the import table of the PE file names no runtime DLL. The reader is tested on files built here (PE32+ with one section), on damaged ones,
  // and, on Windows, on a real executable.
  const makePe = (imports, { delay = [], pe32 = false } = {}) => {
    const SECTION_RVA = 0x1000;
    const SECTION_RAW = 0x200;
    const importBytes = (imports.length + 1) * 20;
    const delayBytes = delay.length > 0 ? (delay.length + 1) * 32 : 0;
    let cursor = importBytes + delayBytes;
    const names = [...imports, ...delay].map((name) => { const offset = cursor; cursor += name.length + 1; return { name, offset }; });
    const raw = Buffer.alloc(cursor);
    imports.forEach((_, index) => { raw.writeUInt32LE(SECTION_RVA + names[index].offset, index * 20 + 12); raw.writeUInt32LE(0x2000, index * 20 + 16); });
    delay.forEach((_, index) => { raw.writeUInt32LE(1, importBytes + index * 32); raw.writeUInt32LE(SECTION_RVA + names[imports.length + index].offset, importBytes + index * 32 + 4); });
    for (const { name, offset } of names) raw.write(`${name}\0`, offset, 'latin1');
    const file = Buffer.alloc(SECTION_RAW + raw.length);
    file.write('MZ', 0, 'latin1');
    file.writeUInt32LE(0x80, 0x3c);
    file.write('PE\0\0', 0x80, 'latin1');
    const coff = 0x84;
    const optionalSize = pe32 ? 224 : 240;
    file.writeUInt16LE(pe32 ? 0x14c : 0x8664, coff);
    file.writeUInt16LE(1, coff + 2);
    file.writeUInt16LE(optionalSize, coff + 16);
    const optional = coff + 20;
    const directories = optional + (pe32 ? 96 : 112);
    file.writeUInt16LE(pe32 ? 0x10b : 0x20b, optional);
    file.writeUInt32LE(16, directories - 4);
    file.writeUInt32LE(SECTION_RVA, directories + 8);
    file.writeUInt32LE(importBytes, directories + 12);
    if (delay.length > 0) { file.writeUInt32LE(SECTION_RVA + importBytes, directories + 13 * 8); file.writeUInt32LE(delayBytes, directories + 13 * 8 + 4); }
    const section = optional + optionalSize;
    file.write('.idata\0\0', section, 'latin1');
    file.writeUInt32LE(raw.length, section + 8);
    file.writeUInt32LE(SECTION_RVA, section + 12);
    file.writeUInt32LE(raw.length, section + 16);
    file.writeUInt32LE(SECTION_RAW, section + 20);
    raw.copy(file, SECTION_RAW);
    return file;
  };
  assert.deepEqual(peImportedLibraries(makePe(['KERNEL32.dll', 'ntdll.dll'])), ['kernel32.dll', 'ntdll.dll'], 'the imports of a PE32+ file, lower-cased');
  assert.deepEqual(peImportedLibraries(makePe(['KERNEL32.dll'], { pe32: true })), ['kernel32.dll'], 'and of a PE32 file');
  assert.deepEqual(peImportedLibraries(makePe(['KERNEL32.dll'], { delay: ['USER32.dll'] })), ['kernel32.dll', 'user32.dll'], 'delay-loaded libraries are imports too');
  assert.deepEqual(peImportedLibraries(makePe([])), [], 'a file without imports');
  assert.equal(checkStaticCrt(makePe(['KERNEL32.dll', 'ntdll.dll', 'api-ms-win-core-synch-l1-2-0.dll', 'bcryptprimitives.dll', 'WS2_32.dll'])), null, 'the Windows libraries that a Rust program imports are not the C runtime');
  for (const dynamic of ['VCRUNTIME140.dll', 'vcruntime140_1.dll', 'MSVCP140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'UCRTBASE.dll', 'msvcr120.dll', 'CONCRT140.dll']) {
    assert.match(checkStaticCrt(makePe(['KERNEL32.dll', dynamic])) ?? '', new RegExp(escape(dynamic.toLowerCase())), `${dynamic} is the C runtime in a DLL`);
  }
  assert.match(checkStaticCrt(makePe(['KERNEL32.dll'], { delay: ['UCRTBASE.dll'] })) ?? '', /ucrtbase\.dll/, 'a delay-loaded C runtime counts');
  assert.match(checkStaticCrt(makePe(['VCRUNTIME140.dll', 'MSVCP140.dll'])) ?? '', /vcruntime140\.dll[^]*msvcp140\.dll/, 'every runtime DLL is named');
  assert.match(checkStaticCrt(Buffer.from('not a PE file')) ?? '', /not a PE/);
  assert.match(checkStaticCrt(Buffer.alloc(0)) ?? '', /not a PE/);
  const damaged = makePe(['KERNEL32.dll']);
  assert.match(checkStaticCrt(damaged.subarray(0, 0x90)) ?? '', /truncated/, 'headers cut short');
  assert.match(checkStaticCrt(damaged.subarray(0, 0x210)) ?? '', /beyond the end/, 'an import table that lies beyond the end of the file');
  const badSignature = Buffer.from(damaged);
  badSignature.write('XX', 0x80, 'latin1');
  assert.match(checkStaticCrt(badSignature) ?? '', /not a PE/, 'no PE signature');
  const badMagic = Buffer.from(damaged);
  badMagic.writeUInt16LE(0x1234, 0x98);
  assert.match(checkStaticCrt(badMagic) ?? '', /not a PE/, 'an optional header that is neither PE32 nor PE32+');
  const endless = makePe(['KERNEL32.dll']);
  endless.fill(0x41, 0x200 + 20, endless.length); // no terminating descriptor: the names are garbage that must not make the reader run away
  assert.match(checkStaticCrt(endless) ?? '', /beyond the end|not a PE|truncated/, 'a table without its terminator ends the reader instead of looping');
  assert.match(checkStaticCrt(makePe(Array(4100).fill('a.dll'))) ?? '', /more than 4096/, 'thousands of valid entries before the terminator are refused, not read to the end');
  const outside = makePe(['KERNEL32.dll']);
  outside.writeUInt32LE(0x40, 0x200 + 12); // the name of the first import points into the DOS header, which no section covers
  assert.match(checkStaticCrt(outside) ?? '', /beyond the end|outside every section/, 'an address that no section covers is not read as a file offset');
  if (process.platform === 'win32') {
    const real = peImportedLibraries(readFileSync(process.execPath));
    assert.ok(real.includes('kernel32.dll'), `the reader finds KERNEL32.dll among the imports of ${process.execPath} (${real.join(', ')})`);
  }
  ok('checkStaticCrt reads the import table (and the delay-load table) of a PE32 or PE32+ file and refuses every C runtime DLL by name; damaged files, a missing terminator and non-PE files are errors, not a pass');

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
  for (const relative of [...Object.values(SHIPPING_FILES), 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', 'DATGOLD-HUB/ui/package-lock.json', 'desktop-shell/ChatMCP.csproj',
    'scripts/Build-Installer.ps1', 'scripts/InstallerPayload.ps1', 'scripts/intelligence-runtime/package-lock.json', 'scripts/intelligence-runtime/stage.mjs',
    'scripts/intelligence-runtime/verify.mjs', 'scripts/intelligence-runtime/notices.mjs', 'scripts/intelligence-runtime/stage-python.ps1', 'scripts/intelligence-runtime/stage-ripgrep.ps1',
    'scripts/intelligence-runtime/test-runtime.mjs', 'scripts/intelligence-runtime/licenses/ripgrep', 'scripts/intelligence-runtime/licenses/README.md', 'docs/LICENSE-SCAN.md', 'scripts/tests/windows-installer/guest-lifecycle.ps1', '.gitattributes', '.github/workflows']) copy(relative);
  mkdirSync(path.join(copyRoot, 'scripts', 'intelligence-runtime', 'licenses'), { recursive: true });
  for (const entry of GRAMMAR_NOTICES) if (existsSync(path.join(REPO, 'scripts', 'intelligence-runtime', noticeSource(entry)))) copy(`scripts/intelligence-runtime/${noticeSource(entry)}`);
  for (const relative of ['docs/LICENSE-SCAN.md', 'docs/CI-HEALTH.md', 'scripts/intelligence-runtime/licenses/README.md']) copy(relative);
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
    ['the CPython entry deleted from the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^ 2\. CPython embeddable[\s\S]*?(?=^ 3\.)/m, ''), /DATGOLD-HUB\/THIRD-PARTY-NOTICES\.txt has no entry for CPython/],
    ['the Tree-sitter python grammar removed from the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replaceAll('tree-sitter-python', 'tree-sitter-removed'), /tree-sitter-python grammar notice/],
    // a grammar notice whose text is vendored is shipped, not pending (grammarNoticeWording): one defect for each place that could say otherwise
    ...GRAMMAR_NOTICES.map((entry) => [`the ${entry.id} row says Pending again`, 'THIRD-PARTY-NOTICES.md', (source) => source.replace(new RegExp('^(\\| Tree-sitter grammar `' + entry.id + '`[^\\n]*) \\|$', 'm'), '$1 Pending |'), new RegExp(`${entry.id} row of THIRD-PARTY-NOTICES\\.md still says Pending`)]),
    ['the Tree-sitter item of the plain-text notice says pending again', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^( +tree-sitter-python \([^\n]*\n)/m, '$1    Status: pending.\n'), /item \d+ \(the Tree-sitter grammars\) of DATGOLD-HUB\/THIRD-PARTY-NOTICES\.txt still says pending/],
    ['the Tree-sitter notices back among the pending notices of THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', (source) => source.replace(/^## Pending notices\s*\n/m, (heading) => `${heading}\n0. **Tree-sitter grammar notices** are pending.\n`), /THIRD-PARTY-NOTICES\.md still lists the Tree-sitter grammar notices among the pending notices/],
    ['the Tree-sitter notices back among the pending notices of the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^PENDING NOTICES\s*\n/m, (heading) => `${heading}\n - The Tree-sitter grammar notices are pending.\n`), /THIRD-PARTY-NOTICES\.txt still lists the Tree-sitter grammar notices among the pending notices/],
    ['the number of the Tree-sitter item back in the "Items ... above" list of the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^PENDING NOTICES\s*\n/m, (heading) => `${heading}\n - Item ${source.match(/^ ?(\d+)\. Tree-sitter grammars/m)[1]} above.\n`), /still lists item \d+ \(the Tree-sitter grammars\) among the pending notices/],
    ['finding 5 of the scan says the grammar texts are not in the repository again', 'docs/LICENSE-SCAN.md', (source) => source.replace(/(^## Status of the findings after the notice work\s[\s\S]*?^\| 5 \|[^\n]*?) \|$/m, '$1 The three upstream MIT texts are not in the repository. |'), /state of finding 5 still says/],
    ['the scan recommends adding a grammar text again', 'docs/LICENSE-SCAN.md', (source) => source.replace(/^## Recommended follow-up\s*\n/m, (heading) => `${heading}\n1. Add \`${path.basename(noticeSource(GRAMMAR_NOTICES[0]))}\` to the folder of the vendored texts.\n`), /still recommends adding tree-sitter-javascript\.LICENSE/],
    ['the CI-health document says that the installer jobs set the pending variable again', 'docs/CI-HEALTH.md', (source) => `${source.trimEnd()}\n- The installer jobs of \`ci.yml\` set \`${PENDING_ALLOWED_ENV}=1\` while the grammar licenses are missing.\n`, /docs\/CI-HEALTH\.md shows CHATMCP_ALLOW_PENDING_NOTICES=1/],
    ['the README of the vendored texts says again that CI sets the pending variable', 'scripts/intelligence-runtime/licenses/README.md', (source) => source.replace('(no workflow does)', '(CI does)'), /licenses\/README\.md still says that CI sets/],
    ['the README of the vendored texts asks for the grammar files again', 'scripts/intelligence-runtime/licenses/README.md', (source) => source.replace('| Vendored file |', '| File to add here |'), /still calls the grammar files "File to add here"/],
    ['the Visual C++ runtime row deleted', 'THIRD-PARTY-NOTICES.md', dropLines(/Visual C\+\+ runtime/), /Visual C\+\+ runtime/],
    ['the old README wording back', 'README.md', (source) => source.replace(/^## License[\s\S]*?(?=^## Security)/m, '## License\n\nChatMCP does **not** currently have an adopted top-level project license in this repository.\n\n'), /License section|no project license/],
    ['LICENSE.txt dropped from the CPython staging assertion', 'scripts/intelligence-runtime/stage-python.ps1', (source) => source.replace(",'LICENSE.txt')", ')'), /does not require LICENSE\.txt/],
    ['the PSF text check dropped from the CPython staging', 'scripts/intelligence-runtime/stage-python.ps1', (source) => source.replace('PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2', 'x'), /PSF license text/],
    ['the ripgrep entry deleted from THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| ripgrep \(/), /THIRD-PARTY-NOTICES\.md has no entry for ripgrep/],
    ['the ripgrep entry deleted from the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^17\. ripgrep[\s\S]*?(?=^PENDING NOTICES)/m, ''), /DATGOLD-HUB\/THIRD-PARTY-NOTICES\.txt has no entry for ripgrep/],
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
    ['the archived 1.x text back', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => `ARCHIVED 1.x/2.x INTEGRATION NOTES - NOT CURRENT\n${source}`, /archived 1\.x text/],
    // ripgrep: PCRE2 and the Rust crates compiled into rg.exe
    ['a vendored ripgrep text is changed', `scripts/intelligence-runtime/licenses/ripgrep/${vendored.files.find((file) => file.kind === 'pcre2').path}`, (source) => `${source}\nAn extra line.\n`, /SHA-256 differs/],
    ['PCRE2 is no longer in the ripgrep inventory', 'scripts/intelligence-runtime/licenses/ripgrep/MANIFEST.json', (source) => source.replace('"name": "PCRE2"', '"name": "PCRE3"'), /no PCRE2/],
    ['the PCRE2 row deleted from THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| PCRE2 \|/), /THIRD-PARTY-NOTICES\.md has no row for PCRE2/],
    ['the zmij row deleted from THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| `zmij` \|/), /THIRD-PARTY-NOTICES\.md has no row for zmij/],
    ['the zmij line deleted from the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', dropLines(/\bzmij 1\.0\.23 - /), /THIRD-PARTY-NOTICES\.txt has no line for zmij/],
    ['the ripgrep row says Pending again', 'THIRD-PARTY-NOTICES.md', (source) => source.replace(/^(\| ripgrep \([^\n]*) \|$/m, '$1 Pending |'), /ripgrep row of THIRD-PARTY-NOTICES\.md still says Pending/],
    ['the Rust standard library back among the pending notices', 'THIRD-PARTY-NOTICES.md', (source) => source.replace(/^## Pending notices\s*\n/m, (heading) => `${heading}\n0. **The Rust standard library inside rg.exe** is pending.\n`), /still lists the Rust standard library/],
    ['the static C runtime back among the pending notices of the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^PENDING NOTICES\s*\n/m, (heading) => `${heading}\n - The static Microsoft C runtime of rg.exe is pending.\n`), /still lists the static Microsoft C runtime/],
    ['the Visual C++ runtime back among the pending notices of THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', (source) => source.replace(/^## Pending notices\s*\n/m, (heading) => `${heading}\n0. **Microsoft Visual C++ runtime terms** are pending.\n`), /still lists the Microsoft Visual C\+\+ runtime/],
    ['the Visual C++ runtime row says Pending again', 'THIRD-PARTY-NOTICES.md', (source) => source.replace(/^(\| Microsoft Visual C\+\+ runtime[^\n]*) \|$/m, '$1 Pending |'), /Visual C\+\+ runtime row of THIRD-PARTY-NOTICES\.md still says Pending/],
    ['the Visual C++ runtime row no longer points to the section', 'THIRD-PARTY-NOTICES.md', (source) => source.replace(/^\| Microsoft Visual C\+\+ runtime[^\n]*$/m, (row) => row.replaceAll('Microsoft C/C++ runtime components', 'elsewhere')), /row of THIRD-PARTY-NOTICES\.md does not point to the section/],
    ['item 3 of the plain-text notice says pending again', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^( ?\d+\. Microsoft Visual C\+\+ runtime[^\n]*)$/m, '$1 Status: pending.'), /item of DATGOLD-HUB\/THIRD-PARTY-NOTICES\.txt still says pending/],
    ['item 3 is back in the pending list of the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^( - Items )(\d)/m, (_match, head, rest) => `${head}3, ${rest}`), /still lists item 3/],
    ['the Microsoft section deleted from THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', (source) => source.replace(/^## Microsoft C\/C\+\+ runtime components\s*\n[\s\S]*?(?=^## )/m, ''), /THIRD-PARTY-NOTICES\.md has no section "Microsoft C\/C\+\+ runtime components"/],
    ['the Microsoft section deleted from the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replace(/^MICROSOFT C\/C\+\+ RUNTIME COMPONENTS\s*\n[\s\S]*?(?=^PENDING NOTICES)/m, ''), /THIRD-PARTY-NOTICES\.txt has no section "Microsoft C\/C\+\+ runtime components"/],
    ['the static libraries of the Windows SDK no longer named in the Microsoft section', 'THIRD-PARTY-NOTICES.md', (source) => source.replaceAll('Static LIB files', 'static libraries'), /"Static LIB files" section/],
    ['the condition about end users no longer in the Microsoft section', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replaceAll('end users', 'people'), /condition about terms for end users/],
    ['the indemnity condition no longer in the Microsoft section', 'THIRD-PARTY-NOTICES.md', (source) => source.replaceAll('indemnif', 'compensat'), /indemnity condition/],
    ['the statement that the Microsoft text is not reproduced removed', 'THIRD-PARTY-NOTICES.md', (source) => source.replaceAll('not reproduced', 'omitted'), /does not say that the text of the Microsoft terms is not reproduced/],
    ['the date on which the Microsoft terms were read removed', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replaceAll('2026-10-25', '2026-10-26'), /the date on which the terms were read/],
    ['a link to the Microsoft terms removed', 'THIRD-PARTY-NOTICES.md', (source) => source.replaceAll('learn.microsoft.com/en-us/legal/windows-sdk/redist', 'example.invalid/redist'), /does not link learn\.microsoft\.com\/en-us\/legal\/windows-sdk\/redist/],
    ['the Rust toolchain no longer named in THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', (source) => source.replaceAll(vendored.manifest.rustStd.toolchain.rustc, 'x'), /THIRD-PARTY-NOTICES\.md does not name the Rust toolchain/],
    ['the Rust toolchain no longer named in the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', (source) => source.replaceAll(vendored.manifest.rustStd.toolchain.rustc, 'x'), /THIRD-PARTY-NOTICES\.txt does not name the Rust toolchain/],
    ['the commit of the Rust toolchain no longer named in THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', (source) => source.replaceAll(vendored.manifest.rustStd.toolchain.commit, '0'.repeat(40)), /does not name the commit of the Rust toolchain/],
    ['the Rust standard library row deleted', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| Rust standard library \|/), /no row for Rust standard library/],
    ['the Rust standard library line deleted from the plain-text notice', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', dropLines(new RegExp(escape(`Rust standard library ${vendored.manifest.rustStd.toolchain.rustc} - `))), /no line for Rust standard library/],
    ['the hashbrown row deleted', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| `hashbrown` \|/), /no row for hashbrown/],
    ['the compiler_builtins row deleted', 'THIRD-PARTY-NOTICES.md', dropLines(/^\| Rust compiler_builtins and libm \|/), /no row for Rust compiler_builtins and libm/],
    ['the count of packages that the standard library does not link is wrong', 'THIRD-PARTY-NOTICES.md', (source) => source.replace(/\d+ packages of the Rust library lock file that are not linked/g, '1 packages of the Rust library lock file that are not linked'), /how many packages of the Rust library lock file/],
    ['the /rustc/ check no longer described in THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md', (source) => source.replaceAll('/rustc/', '/rust/'), /does not say that the installer build looks for the \/rustc\//],
    ['test-runtime.mjs no longer looks for the Rust source paths in rg.exe', 'scripts/intelligence-runtime/test-runtime.mjs', (source) => source.replaceAll('checkCompiledRust', 'skipRustCheck'), /source paths of the Rust toolchain/],
    ['test-runtime.mjs no longer checks the C runtime imports of rg.exe', 'scripts/intelligence-runtime/test-runtime.mjs', (source) => source.replaceAll('checkStaticCrt', 'skipCrtCheck'), /imports no C runtime DLL/],
    ['docs/LICENSE-SCAN.md says again that the Rust standard library is not covered', 'docs/LICENSE-SCAN.md', (source) => source.replace(/^(\| ripgrep \([^\n]*) \|$/m, '$1 Not covered: the Rust standard library and the static C runtime. |'), /LICENSE-SCAN\.md still says/],
    ['the licenses README names the open items again', 'scripts/intelligence-runtime/licenses/README.md', (source) => `${source}\n- They are named as open items in THIRD-PARTY-NOTICES.md.\n`, /still names the Rust standard library/],
    ['the licenses README does not name the commit of the toolchain', 'scripts/intelligence-runtime/licenses/README.md', (source) => source.replaceAll(vendored.manifest.rustStd.toolchain.commit, 'x'), /does not say how the Rust standard library notices were derived/],
    ['a vendored compiler_builtins text is changed', `scripts/intelligence-runtime/licenses/ripgrep/${vendored.files.find((file) => file.kind === 'compiler-builtins').path}`, (source) => `${source}\nAn extra line.\n`, /SHA-256 differs/],
    ['a vendored Unicode V3 text is changed', `scripts/intelligence-runtime/licenses/ripgrep/${vendored.files.find((file) => file.kind === 'unicode-3.0').path}`, (source) => `${source}\nAn extra line.\n`, /SHA-256 differs/],
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
    ['guest-lifecycle.ps1 no longer lists the Rust standard library text among the installed files', 'scripts/tests/windows-installer/guest-lifecycle.ps1', (source) => source.replace('\\ripgrep\\rust-std-', '\\ripgrep\\rust-gone-'), /guest-lifecycle\.ps1 does not list[^;]*rust-std-/],
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
