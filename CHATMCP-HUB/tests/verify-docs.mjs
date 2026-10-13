// The documents must agree with the code and with each other.
//
// Documentation that has drifted from the product is worse than none: this suite fails when a link or an anchor points nowhere, when a
// number the documents quote (suites, tools, presets, task states) differs from what the code has, when the version differs between
// package.json, the code, the UI bundle and the changelog, or when something a script depends on is broken (a non-ASCII byte in a
// PowerShell file that Windows PowerShell 5.1 would read as ANSI, an unpinned CI action, an unpinned test requirement).
//
// Part 1 only needs the CHATMCP-HUB folder. Part 2 needs the repository root next to it (README.md, docs/, .github/); without it the
// suite reports SKIP with the part-1 result in the note, never PASS.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalTools } from '../lib/local-tools.mjs';
import { PRESETS } from '../lib/provider-presets.mjs';
import { TASK_STATES, TRANSITIONS } from '../lib/task-state.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const read = (file) => readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const expectNone = (problems, what) => assert.equal(problems.length, 0, `${what}:\n  - ${problems.join('\n  - ')}`);

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');
const TESTS = path.join(HUB, 'tests');

// ================================================================================================================================
// Part 1 - inside CHATMCP-HUB
// ================================================================================================================================
const pkg = JSON.parse(read(path.join(HUB, 'package.json')));
const version = pkg.version;
assert.match(version, /^\d+\.\d+\.\d+$/, 'package.json: version is not x.y.z');

{
  const managerVersion = read(path.join(HUB, 'lib', 'manager.mjs')).match(/export const VERSION = '([^']+)'/)?.[1];
  assert.equal(managerVersion, version, `lib/manager.mjs VERSION (${managerVersion}) differs from package.json (${version})`);
  const uiBuild = read(path.join(HUB, 'hub.mjs')).match(/export const UI_BUILD = '([^']+)'/)?.[1];
  const bundleBuild = read(path.join(HUB, 'web', 'react-app.js')).match(/const BUILD = '([^']+)'/)?.[1];
  assert.ok(uiBuild, 'hub.mjs: UI_BUILD not found');
  const uiApiBuild = read(path.join(HUB, 'ui', 'src', 'lib', 'api.ts')).match(/const UI_BUILD = '([^']+)';/)?.[1];
  assert.equal(bundleBuild, uiBuild, `web/react-app.js BUILD (${bundleBuild}) differs from hub.mjs UI_BUILD (${uiBuild}); the dashboard would refuse to talk to the Hub`);
  assert.equal(uiApiBuild, uiBuild, `ui/src/lib/api.ts UI_BUILD (${uiApiBuild}) differs from hub.mjs UI_BUILD (${uiBuild}); modern UI requests would be rejected with 409`);
  assert.ok(uiBuild.startsWith(`${version}-`), `UI_BUILD ${uiBuild} does not start with the version ${version}-`);
  ok(`one version everywhere in the code: package.json = lib/manager.mjs = ${version}; hub.mjs UI_BUILD = web/react-app.js BUILD = ui/src/lib/api.ts UI_BUILD = ${uiBuild}`);
}

function walk(folder, { skip = new Set(['node_modules', '.git', 'test-results', 'vendor', '.generated', '__pycache__']) } = {}) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, { skip }));
    else found.push(full);
  }
  return found;
}

{
  // Windows PowerShell 5.1 and cmd.exe read a script that has no byte-order mark in the ANSI code page: one Vietnamese letter or one
  // typographic dash in a message is enough to turn a string literal into garbage or a parse error. The scripts are plain ASCII.
  const roots = [HUB, path.join(REPO, 'scripts')].filter((folder) => existsSync(folder));
  const scripts = roots.flatMap((folder) => walk(folder)).filter((file) => /\.(ps1|cmd|bat)$/i.test(file));
  if (scripts.length === 0 && !existsSync(path.join(HUB, 'windows'))) {
    ok('0 PowerShell/cmd scripts found (omitted in Linux image by .dockerignore)');
  } else {
    assert.ok(scripts.length >= 8, `expected the launcher and the Windows scripts, found ${scripts.length}`);
    const problems = [];
    for (const file of scripts) {
      const bytes = readFileSync(file);
      if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) continue; // with a BOM any UTF-8 is fine
      const offset = bytes.findIndex((byte) => byte > 0x7F);
      if (offset >= 0) problems.push(`${path.relative(REPO, file)}: non-ASCII byte at offset ${offset} and no UTF-8 BOM`);
    }
    expectNone(problems, 'PowerShell/cmd scripts must be ASCII (or carry a BOM)');
    ok(`${scripts.length} PowerShell/cmd scripts are ASCII-only, so Windows PowerShell 5.1 reads them as written`);
  }
}

{
  const files = readdirSync(TESTS).filter((name) => /^requirements-.+\.txt$/.test(name));
  assert.ok(files.length >= 2, 'tests/requirements-*.txt are missing');
  const problems = [];
  for (const name of files) {
    for (const [index, line] of read(path.join(TESTS, name)).split('\n').entries()) {
      const text = line.trim();
      if (!text || text.startsWith('#')) continue;
      if (!/^[A-Za-z0-9_.-]+(\[[A-Za-z0-9_,.-]+\])?==\d[A-Za-z0-9.+!-]*$/.test(text)) problems.push(`tests/${name}:${index + 1}: "${text}" is not pinned with ==`);
    }
  }
  expectNone(problems, 'test requirements must be pinned');
  ok(`test requirements are pinned (${files.join(', ')})`);
}

{
  // A mutation list whose patterns no longer match the code tests nothing, silently. Every pattern must still occur exactly once.
  const folder = path.join(TESTS, 'mutation');
  const lists = readdirSync(folder).filter((name) => name.endsWith('.json'));
  assert.ok(lists.length >= 4, `expected the mutation lists in tests/mutation, found ${lists.length}`);
  const problems = [];
  let mutations = 0;
  for (const name of lists) {
    const list = JSON.parse(read(path.join(folder, name)));
    if (!existsSync(path.join(TESTS, list.suite ?? ''))) problems.push(`${name}: the suite ${list.suite} does not exist`);
    for (const mutation of list.mutations) {
      mutations += 1;
      for (const patch of mutation.patches) {
        const file = path.join(HUB, patch.file);
        if (!existsSync(file)) { problems.push(`${name} / ${mutation.name}: ${patch.file} does not exist`); continue; }
        const occurrences = read(file).split(patch.old).length - 1;
        if (occurrences !== 1) problems.push(`${name} / ${mutation.name}: the pattern occurs ${occurrences} times in ${patch.file}, it must occur exactly once`);
      }
    }
  }
  expectNone(problems, 'stale mutation lists');
  ok(`${mutations} mutations in ${lists.length} lists (tests/mutation) still apply to the code: every pattern occurs exactly once`);
}

// ================================================================================================================================
// Part 2 - the repository root
// ================================================================================================================================
if (!existsSync(path.join(REPO, 'docs', 'ARCHITECTURE.md')) || !existsSync(path.join(REPO, 'README.md'))) {
  console.log(`CHATMCP_TEST_SKIP: README.md and docs/ were not found next to CHATMCP-HUB (the ${checks} in-folder checks passed; the document checks need the whole repository)`);
  process.exit(0);
}

const DOC_FILES = ['README.md', 'SECURITY.md', 'CHANGELOG.md', 'THIRD-PARTY-NOTICES.md']
  .filter((name) => existsSync(path.join(REPO, name)))
  .concat(readdirSync(path.join(REPO, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`));
const docs = Object.fromEntries(DOC_FILES.map((name) => [name, read(path.join(REPO, name)).normalize('NFC')]));

/** GitHub's heading anchors: lower case, letters/digits/underscore/hyphen kept (any script), spaces to hyphens, the rest dropped. */
function slugOf(heading) {
  const text = heading.trim().replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase();
  let out = '';
  for (const char of text) {
    if (/[\p{L}\p{N}\p{M}_-]/u.test(char)) out += char;
    else if (char === ' ') out += '-';
  }
  return out;
}

/**
 * The lines of a Markdown file without fenced code blocks (their lines come back empty, so line numbers stay right). Links are looked
 * for with `stripInlineCode` (a link-shaped string inside backticks is not a link); headings are read with the code spans kept,
 * because the anchor of "## `checkpoint_failed`" is made from the code's text.
 */
function proseOf(markdown, { stripInlineCode = false } = {}) {
  const lines = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; lines.push(''); continue; }
    lines.push(fenced ? '' : stripInlineCode ? line.replace(/`[^`\n]*`/g, '``') : line);
  }
  return lines;
}

function anchorsOf(markdown) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of proseOf(markdown)) {
    const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!match) continue;
    const base = slugOf(match[2]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

{
  const anchors = Object.fromEntries(Object.entries(docs).map(([name, text]) => [name, anchorsOf(text)]));
  const problems = [];
  let links = 0;
  for (const [name, text] of Object.entries(docs)) {
    proseOf(text, { stripInlineCode: true }).forEach((line, index) => {
      for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:)/i.test(target)) continue;
        links += 1;
        const [rawPath, rawFragment] = target.split('#');
        const fragment = rawFragment === undefined ? '' : decodeURIComponent(rawFragment);
        const file = rawPath ? path.resolve(REPO, path.dirname(name), decodeURIComponent(rawPath)) : path.join(REPO, name);
        const where = `${name}:${index + 1}`;
        if (!existsSync(file)) { problems.push(`${where}: "${target}" - no such file or folder`); continue; }
        if (!fragment) continue;
        const relative = path.relative(REPO, file).split(path.sep).join('/');
        if (!(relative in anchors)) { if (/^L\d+(-L\d+)?$/.test(fragment) || statSync(file).isDirectory()) continue; problems.push(`${where}: "${target}" - fragment on a file that is not a checked document`); continue; }
        if (!anchors[relative].has(fragment)) problems.push(`${where}: "${target}" - no heading with that anchor in ${relative}`);
      }
    });
  }
  expectNone(problems, 'broken links or anchors');
  assert.ok(links > 100, `only ${links} relative links found; the link extraction is probably broken`);
  ok(`${links} relative links in ${DOC_FILES.length} documents resolve, anchors included`);
}

{
  const linked = new Set();
  for (const match of docs['README.md'].matchAll(/\]\((?:https:\/\/github\.com\/pddczpl\/ChatMCP\/blob\/main\/)?(docs\/[^)#\s]+\.md)/g)) linked.add(match[1]);
  const orphans = DOC_FILES.filter((name) => name.startsWith('docs/') && !linked.has(name));
  expectNone(orphans, 'documents in docs/ that README.md does not link to');
  ok(`README.md links to all ${linked.size} documents in docs/`);
}

{
  const bad = DOC_FILES.filter((name) => docs[name].includes('�'));
  expectNone(bad.map((name) => `${name} contains U+FFFD (a broken encoding)`), 'replacement characters');
  ok('no document contains U+FFFD (mojibake)');
}

{
  const top = docs['CHANGELOG.md'].match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  assert.equal(top, version, `CHANGELOG.md: the newest release is ${top}, package.json says ${version}`);
  ok(`CHANGELOG.md's newest release is ${version}, the version in package.json`);
}

{
  const nodeSuites = readdirSync(TESTS).filter((name) => /^verify-.+\.mjs$/.test(name)).length;
  const uiSuites = readdirSync(TESTS).filter((name) => /^verify-.+\.py$/.test(name)).length;
  const problems = [];
  for (const [name, text] of Object.entries(docs)) {
    // Phase reports preserve their original historical test counts.
    // Only currently maintained documentation claims the present suite count.
    if (/^docs\/PHASE[0-9]+-(?:DESIGN|REPORT)\.md$/.test(name)) continue;
    for (const match of text.matchAll(/(\d+) bộ Node/g)) if (Number(match[1]) !== nodeSuites) problems.push(`${name}: says ${match[1]} Node suites, tests/ has ${nodeSuites}`);
    for (const match of text.matchAll(/(\d+) bộ giao diện/g)) if (Number(match[1]) !== uiSuites) problems.push(`${name}: says ${match[1]} UI suites, tests/ has ${uiSuites}`);
  }
  expectNone(problems, 'suite counts that differ from tests/');
  assert.ok(docs['docs/DEVELOPMENT.md'].includes(`**${nodeSuites} bộ Node**`), `docs/DEVELOPMENT.md must state "**${nodeSuites} bộ Node**" (the count is checked here)`);
  assert.ok(docs['docs/DEVELOPMENT.md'].includes(`**${uiSuites} bộ giao diện**`), `docs/DEVELOPMENT.md must state "**${uiSuites} bộ giao diện**" (the count is checked here)`);
  ok(`the documents quote the real number of suites: ${nodeSuites} Node, ${uiSuites} UI`);
}

{
  const tools = new LocalTools({ workspace: { resolve() { throw new Error('not used'); } }, shell: {}, git: {} }).definitions().length;
  const problems = [];
  let claims = 0;
  for (const [name, text] of Object.entries(docs)) {
    for (const match of text.matchAll(/(?:LocalTools \(|local-tools\.mjs`[,\s—-]+)(\d+) công cụ/g)) {
      claims += 1;
      if (Number(match[1]) !== tools) problems.push(`${name}: says ${match[1]} local tools, LocalTools defines ${tools}`);
    }
  }
  expectNone(problems, 'local tool counts');
  assert.ok(claims >= 2, `expected the documents to quote the number of local tools at least twice, found ${claims}`);

  const presets = PRESETS.length;
  const presetProblems = [];
  let presetClaims = 0;
  for (const [name, text] of Object.entries(docs)) {
    for (const match of text.matchAll(/(\d+) preset\b/g)) {
      presetClaims += 1;
      if (Number(match[1]) !== presets) presetProblems.push(`${name}: says ${match[1]} presets, lib/provider-presets.mjs has ${presets}`);
    }
  }
  expectNone(presetProblems, 'preset counts');
  assert.ok(presetClaims >= 1, 'no document quotes the number of presets');

  const stateProblems = [];
  for (const [name, text] of Object.entries(docs)) {
    for (const match of text.matchAll(/(\d+) trạng thái/g)) if (Number(match[1]) !== TASK_STATES.length) stateProblems.push(`${name}: says ${match[1]} states, task-state.mjs has ${TASK_STATES.length}`);
  }
  expectNone(stateProblems, 'task states');
  ok(`quoted numbers match the code: ${tools} local tools, ${presets} presets, ${TASK_STATES.length} task states`);
}

{
  // The diagram in ARCHITECTURE.md shows the main path only, so it may omit edges - but it must not draw an edge the code forbids,
  // and every state of the machine must appear in it.
  const diagram = docs['docs/ARCHITECTURE.md'].match(/```mermaid\s*\n\s*stateDiagram-v2\n([\s\S]*?)```/)?.[1];
  assert.ok(diagram, 'docs/ARCHITECTURE.md: the stateDiagram-v2 block is missing');
  const nodes = new Set();
  const problems = [];
  let edges = 0;
  for (const [, from, to] of diagram.matchAll(/^\s*(\[\*\]|\w+)\s+-->\s+(\w+)/gm)) {
    edges += 1;
    nodes.add(to);
    if (from === '[*]') { if (to !== 'created') problems.push(`the diagram starts in ${to}, the code starts in created`); continue; }
    nodes.add(from);
    if (!TRANSITIONS[from]?.includes(to)) problems.push(`the diagram draws ${from} --> ${to}, which TRANSITIONS does not allow`);
  }
  for (const state of TASK_STATES) if (!nodes.has(state)) problems.push(`the task state ${state} is missing from the diagram`);
  for (const node of nodes) if (!TASK_STATES.includes(node)) problems.push(`the diagram has a state (${node}) that the code does not`);
  expectNone(problems, 'state diagram');
  ok(`the state diagram in ARCHITECTURE.md (${edges} edges) draws only transitions the code allows and names all ${TASK_STATES.length} states`);
}

{
  const folder = path.join(REPO, '.github', 'workflows');
  const files = existsSync(folder) ? readdirSync(folder).filter((name) => /\.ya?ml$/.test(name)) : [];
  assert.ok(files.length >= 1, '.github/workflows has no workflow');
  const problems = [];
  let uses = 0;
  for (const name of files) {
    read(path.join(folder, name)).split('\n').forEach((line, index) => {
      const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
      if (!match || match[1].startsWith('./')) return;
      uses += 1;
      if (!/@[0-9a-f]{40}$/.test(match[1])) problems.push(`.github/workflows/${name}:${index + 1}: ${match[1]} is not pinned to a commit SHA`);
    });
  }
  expectNone(problems, 'CI actions must be pinned to a commit SHA');
  assert.ok(uses >= 5, `only ${uses} "uses:" lines found`);
  ok(`all ${uses} GitHub Actions in the workflows are pinned to a full commit SHA`);
}

console.log(`PASS: ${checks} documentation and metadata checks (versions, links and anchors, quoted numbers, script encoding, pinned dependencies)`);
