// The claims-test rule: a claim the documents make is bound to a test that exercises it on the production path, or it is listed as unmapped.
//
// v3.9.0 shipped claims whose tests stayed green while the product was broken: installed skills never reached the model, LSP answers were
// thrown away, Tree-sitter adapters were dropped - each time because the test built a double of the object that carried the defect (a
// hand-written workspace with a bare `path`, a fake in front of the runner). This gate makes the binding explicit and checkable.
//
//   docs/CLAIMS.json         every headline claim of README.md and RELEASE-NOTES-v3.9.0.md (and a few from SECURITY.md and the user guide):
//                            id, claim, source file:line + verbatim quote, kind (claim | disclaimer), seam (real | unmapped), test, a note on
//                            what is real, optional forbiddenDoubles (regular expressions that must not match the test's code).
//   docs/claims-ratchet.json the number of unmapped claims may never grow.
//
// For every `real` entry this suite checks that: the quote is on the stated line of the stated document; the test file exists, is named
// verify-*.mjs and is listed by `tests/run-all.mjs --list` (the REAL runner, not a copy of its pattern); the file carries the marker
// line `// CLAIM: <id>`; no forbiddenDoubles pattern matches its code (comments removed). Every `// CLAIM:` marker in any suite must name
// an existing real entry that points at that suite. Every sentence of README.md and RELEASE-NOTES-v3.9.0.md that contains `verified`,
// `guarantee(d)`, `sandbox` or `secure` must be covered by an entry (mapped, unmapped or a disclaimer); the counts are printed. A
// disclaimer is a statement that ONLY denies something ("not ..."; a sentence that also affirms something, like "X does Y, not Z", is a claim) and
// must contain a negation: it promises nothing, so it needs no test and is not part of the ratchet; an unmapped claim is. The negation is
// checked by the suite; that the sentence has no positive clause is for a reviewer.
//
// Usage: node tests/verify-claims-map.mjs [--base <git ref>] [--update-lines]
//   --base          also compare the ratchet with the one on that ref (CI passes origin/<base branch>): it may not be raised.
//   --update-lines  after a document edit moved a quote, rewrite the line numbers in docs/CLAIMS.json (only when each quote is found once).
//
// The same checks run on temporary copies of the files into which defects are put (a marker deleted, a test renamed, a forbidden double
// added ...); each must be reported. Needs the repository root next to DATGOLD-HUB.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');

const TRIGGER = /\bverified\b|\bguarantee[sd]?\b|\bsandbox\w*|\bsecure[ds]?\b|\bsecurely\b/i;
const NEGATOR = /\b(?:not|no|nor|never|without|cannot|can't|isn't|aren't|doesn't|don't|neither)\b/i;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const MARKER = /^[ \t]*\/\/ CLAIM: ([a-z0-9][a-z0-9-]*)[ \t]*$/gm;
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
const read = (root, relative) => readFileSync(path.join(root, relative), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

/** The code of a test without full-line and block comments (a regex must not fire on a sentence that talks about a double). */
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

/** Sentences of a Markdown document that contain a trigger word, with their line (fenced code skipped). */
function triggerSentences(text) {
  const found = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z*`[(])/)) if (TRIGGER.test(sentence)) found.push({ line: index + 1, text: normalize(sentence) });
  });
  return found;
}

/** Names that tests/run-all.mjs would run, asked of the runner itself. */
function discoveredSuites(root) {
  const runner = path.join(root, 'DATGOLD-HUB', 'tests', 'run-all.mjs');
  const result = spawnSync(process.execPath, [runner, '--list', '--tests-dir', path.join(root, 'DATGOLD-HUB', 'tests')], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`tests/run-all.mjs --list failed: ${result.stderr || result.stdout}`);
  return new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

function baseRatchet(root, ref) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try { git('rev-parse', '--verify', `${ref}^{commit}`); } catch { return { error: `cannot resolve the base ref ${ref} (fetch it, or pass the right name)` }; }
  try { return { value: JSON.parse(git('show', `${ref}:docs/claims-ratchet.json`)).maxUnmapped }; } catch { return { value: null }; }
}

/**
 * @returns {{problems: string[], stats: object, notes: string[]}}
 */
export function checkClaims(root, { base = null } = {}) {
  const problems = [];
  const notes = [];
  const fail = (message) => problems.push(message);
  let map;
  let ratchet;
  try { map = JSON.parse(read(root, 'docs/CLAIMS.json')); } catch (error) { return { problems: [`docs/CLAIMS.json cannot be read: ${error.message}`], stats: {}, notes }; }
  try { ratchet = JSON.parse(read(root, 'docs/claims-ratchet.json')); } catch (error) { return { problems: [`docs/claims-ratchet.json cannot be read: ${error.message}`], stats: {}, notes }; }
  const entries = Array.isArray(map.claims) ? map.claims : [];
  const scanned = Array.isArray(map.scannedDocuments) ? map.scannedDocuments : [];
  if (map.version !== 1) fail('docs/CLAIMS.json: version must be 1');
  if (entries.length === 0) fail('docs/CLAIMS.json has no claims');
  if (scanned.length === 0) fail('docs/CLAIMS.json: scannedDocuments is empty');
  if (!Number.isInteger(ratchet.maxUnmapped) || ratchet.maxUnmapped < 0) fail('docs/claims-ratchet.json: maxUnmapped must be a non-negative integer');

  const suites = discoveredSuites(root);
  const testsFolder = path.join(root, 'DATGOLD-HUB', 'tests');
  const markers = new Map(); // suite -> ids
  for (const name of readdirSync(testsFolder).filter((file) => /^verify-.+\.mjs$/.test(file))) {
    const ids = [...read(root, `DATGOLD-HUB/tests/${name}`).matchAll(MARKER)].map((match) => match[1]);
    if (ids.length) markers.set(`DATGOLD-HUB/tests/${name}`, ids);
  }

  const seen = new Set();
  const documents = new Map();
  const documentLines = (file) => {
    if (!documents.has(file)) documents.set(file, existsSync(path.join(root, file)) ? read(root, file).split('\n') : null);
    return documents.get(file);
  };
  for (const entry of entries) {
    const where = `claim ${entry.id ?? '(no id)'}`;
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) { fail(`${where}: id must match ${ID}`); continue; }
    if (seen.has(entry.id)) fail(`${where}: duplicate id`);
    seen.add(entry.id);
    if (typeof entry.claim !== 'string' || entry.claim.trim().length < 8) fail(`${where}: claim text is missing`);
    if (!['claim', 'disclaimer'].includes(entry.kind)) fail(`${where}: kind must be "claim" or "disclaimer"`);
    if (!['real', 'unmapped'].includes(entry.seam)) fail(`${where}: seam must be "real" or "unmapped", not ${JSON.stringify(entry.seam)}`);

    const source = entry.source ?? {};
    const lines = typeof source.file === 'string' ? documentLines(source.file) : null;
    if (!lines) fail(`${where}: source file ${source.file} does not exist`);
    else if (typeof source.quote !== 'string' || source.quote.length < 12) fail(`${where}: source.quote must be a verbatim quote of at least 12 characters`);
    else if (!Number.isInteger(source.line) || !(lines[source.line - 1] ?? '').includes(source.quote)) {
      const found = lines.flatMap((line, index) => (line.includes(source.quote) ? [index + 1] : []));
      fail(`${where}: the quote is not on line ${source.line} of ${source.file}${found.length ? ` (it is on line ${found.join(', ')}; run with --update-lines)` : ' (it is not in the document any more)'}`);
    }

    if (entry.seam === 'real') {
      if (entry.kind !== 'claim') fail(`${where}: a disclaimer cannot be mapped to a test; list it as unmapped`);
      if (typeof entry.test !== 'string' || !/^DATGOLD-HUB\/tests\/verify-[\w-]+\.mjs$/.test(entry.test)) { fail(`${where}: a real claim needs test: DATGOLD-HUB/tests/verify-<name>.mjs`); continue; }
      if (typeof entry.seamNote !== 'string' || entry.seamNote.trim().length < 20) fail(`${where}: a real claim needs a seamNote that says what is real and what is scripted`);
      if (!existsSync(path.join(root, entry.test))) { fail(`${where}: the test ${entry.test} does not exist`); continue; }
      if (!suites.has(path.basename(entry.test))) fail(`${where}: ${entry.test} is not listed by tests/run-all.mjs --list, so no run would execute it`);
      const text = read(root, entry.test);
      if (!(markers.get(entry.test) ?? []).includes(entry.id)) fail(`${where}: ${entry.test} has no line "// CLAIM: ${entry.id}"`);
      const code = codeOf(text);
      for (const pattern of entry.forbiddenDoubles ?? []) {
        let expression;
        try { expression = new RegExp(pattern, 'm'); } catch (error) { fail(`${where}: forbiddenDoubles has an invalid pattern ${JSON.stringify(pattern)}: ${error.message}`); continue; }
        const match = expression.exec(code);
        if (match) fail(`${where}: ${entry.test} contains a forbidden double (${JSON.stringify(pattern)} matches "${match[0].slice(0, 60)}")`);
      }
    } else if (entry.seam === 'unmapped') {
      if (entry.test !== null) fail(`${where}: an unmapped claim has test: null (a candidate goes in candidateTest)`);
      if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) fail(`${where}: an unmapped claim needs a reason`);
      if (entry.phase !== null && !/^P\d+$/.test(String(entry.phase))) fail(`${where}: phase must be null or P<number>`);
      if (entry.candidateTest && !existsSync(path.join(root, entry.candidateTest))) fail(`${where}: candidateTest ${entry.candidateTest} does not exist`);
      if (entry.kind === 'disclaimer' && !NEGATOR.test(source.quote ?? '')) fail(`${where}: a disclaimer must deny something; its quote contains no negation (not, no, never, without, cannot ...)`);
    }
  }

  // markers must name a real entry that points at the same suite
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const [suite, ids] of markers) {
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) fail(`${suite}: the marker "// CLAIM: ${id}" names no claim in docs/CLAIMS.json (orphan marker)`);
      else if (entry.seam !== 'real') fail(`${suite}: the marker "// CLAIM: ${id}" is on a claim that is not mapped`);
      else if (entry.test !== suite) fail(`${suite}: the marker "// CLAIM: ${id}" belongs to ${entry.test}`);
    }
  }

  // every trigger sentence is covered
  const stats = { claims: 0, real: 0, unmappedClaims: 0, disclaimers: 0, triggerSentences: 0, byReal: 0, byUnmapped: 0, byDisclaimer: 0 };
  for (const entry of entries) {
    if (entry.seam === 'real') stats.real += 1;
    else if (entry.kind === 'disclaimer') stats.disclaimers += 1;
    else stats.unmappedClaims += 1;
  }
  stats.claims = entries.length;
  stats.unmappedEntries = stats.unmappedClaims + stats.disclaimers; // every entry whose seam is "unmapped"
  for (const file of scanned) {
    if (!existsSync(path.join(root, file))) { fail(`scanned document ${file} does not exist`); continue; }
    for (const sentence of triggerSentences(read(root, file))) {
      stats.triggerSentences += 1;
      const covering = entries.filter((entry) => entry.source?.file === file && typeof entry.source.quote === 'string'
        && (sentence.text.includes(normalize(entry.source.quote)) || normalize(entry.source.quote).includes(sentence.text)));
      if (covering.length === 0) { fail(`${file}:${sentence.line}: "${sentence.text.slice(0, 90)}" contains verified/guarantee/sandbox/secure and is not covered by any claim in docs/CLAIMS.json`); continue; }
      if (covering.some((entry) => entry.seam === 'real')) stats.byReal += 1;
      else if (covering.some((entry) => entry.kind === 'claim')) stats.byUnmapped += 1;
      else stats.byDisclaimer += 1;
    }
  }

  // ratchet
  if (stats.unmappedClaims > ratchet.maxUnmapped) fail(`${stats.unmappedClaims} unmapped claims, the ratchet in docs/claims-ratchet.json allows ${ratchet.maxUnmapped}: map the new claim to a test (the count may not grow)`);
  else if (stats.unmappedClaims < ratchet.maxUnmapped) fail(`${stats.unmappedClaims} unmapped claims but docs/claims-ratchet.json still allows ${ratchet.maxUnmapped}: lower maxUnmapped to ${stats.unmappedClaims} in the same change so the gain cannot be spent again`);
  if (base) {
    const previous = baseRatchet(root, base);
    if (previous.error) fail(previous.error);
    else if (previous.value === null) notes.push(`no ratchet on ${base}: the first change that introduces it`);
    else if (ratchet.maxUnmapped > previous.value) fail(`docs/claims-ratchet.json raises maxUnmapped from ${previous.value} (on ${base}) to ${ratchet.maxUnmapped}`);
    else if (stats.unmappedClaims > previous.value) fail(`${stats.unmappedClaims} unmapped claims against ${previous.value} allowed on ${base}`);
    else notes.push(`ratchet on ${base}: ${previous.value}, now ${ratchet.maxUnmapped}`);
  }
  return { problems, stats, notes };
}

/** Rewrites source.line in docs/CLAIMS.json for quotes that moved; refuses a quote that is missing or not unique. */
function updateLines(root) {
  const file = path.join(root, 'docs', 'CLAIMS.json');
  const map = JSON.parse(readFileSync(file, 'utf8'));
  let changed = 0;
  for (const entry of map.claims) {
    const lines = read(root, entry.source.file).split('\n');
    const found = lines.flatMap((line, index) => (line.includes(entry.source.quote) ? [index + 1] : []));
    if (found.length !== 1) throw new Error(`${entry.id}: the quote is on ${found.length} lines of ${entry.source.file}; fix it by hand`);
    if (entry.source.line !== found[0]) { entry.source.line = found[0]; changed += 1; }
  }
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
  return changed;
}

// =============================================================================================================================================
const args = process.argv.slice(2);
if (!existsSync(path.join(REPO, 'README.md')) || !existsSync(path.join(REPO, 'docs', 'CLAIMS.json'))) {
  console.log('CHATMCP_TEST_SKIP: README.md and docs/CLAIMS.json were not found next to DATGOLD-HUB (the claims map needs the whole repository)');
  process.exit(0);
}
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
if (baseIndex >= 0 && !base) { console.error('--base needs a git ref'); process.exit(2); }
if (args.includes('--update-lines')) { console.log(`updated ${updateLines(REPO)} line number(s) in docs/CLAIMS.json`); }

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const real = checkClaims(REPO, { base });
const { stats } = real;
console.log(`  claims map: ${stats.claims} entries - ${stats.real} mapped to a test (seam real), ${stats.unmappedClaims} UNMAPPED claims, ${stats.disclaimers} disclaimers (statements that deny something and promise nothing)`);
console.log(`  entries with seam "unmapped": ${stats.unmappedEntries} = ${stats.unmappedClaims} unmapped claims (these are ratcheted) + ${stats.disclaimers} disclaimers (not ratcheted: entirely negative statements, judged by a reviewer)`);
console.log(`  trigger sentences (verified / guarantee / sandbox / secure) in ${JSON.parse(readFileSync(path.join(REPO, 'docs', 'CLAIMS.json'), 'utf8')).scannedDocuments.join(', ')}: ${stats.triggerSentences} - covered by a mapped claim ${stats.byReal}, by an unmapped claim ${stats.byUnmapped}, by a disclaimer ${stats.byDisclaimer}, uncovered ${stats.triggerSentences - stats.byReal - stats.byUnmapped - stats.byDisclaimer}`);
console.log(`  UNMAPPED COUNT: ${stats.unmappedClaims} (ratchet ${JSON.parse(readFileSync(path.join(REPO, 'docs', 'claims-ratchet.json'), 'utf8')).maxUnmapped})`);
for (const note of real.notes) console.log(`  note - ${note}`);
assert.deepEqual(real.problems, [], `claims map problems:\n  - ${real.problems.join('\n  - ')}`);
ok(`docs/CLAIMS.json: ${stats.real} mapped tests exist, are discovered by tests/run-all.mjs, carry their marker and match no forbidden double; every marker names its claim; every trigger sentence is covered; the unmapped count equals the ratchet`);

// ---- negative controls --------------------------------------------------------------------------------------------------------------------
const scratch = mkdtempSync(path.join(os.tmpdir(), 'chatmcp-claims-'));
try {
  const copy = (relative) => { mkdirSync(path.dirname(path.join(scratch, relative)), { recursive: true }); cpSync(path.join(REPO, relative), path.join(scratch, relative), { recursive: true }); };
  const claimSources = JSON.parse(readFileSync(path.join(REPO, 'docs', 'CLAIMS.json'), 'utf8')).claims.map((entry) => entry.source.file);
  for (const relative of new Set(['docs/CLAIMS.json', 'docs/claims-ratchet.json', 'DATGOLD-HUB/tests/run-all.mjs', ...JSON.parse(readFileSync(path.join(REPO, 'docs', 'CLAIMS.json'), 'utf8')).scannedDocuments, ...claimSources])) copy(relative);
  for (const name of readdirSync(path.join(REPO, 'DATGOLD-HUB', 'tests')).filter((file) => /^verify-.+\.mjs$/.test(file))) copy(`DATGOLD-HUB/tests/${name}`);
  assert.deepEqual(checkClaims(scratch).problems, [], 'the temporary copy must be clean before a defect is put in');

  const file = (relative) => path.join(scratch, relative);
  const edit = (relative, change) => {
    const before = readFileSync(file(relative), 'utf8');
    const after = change(before);
    assert.notEqual(after, before, `the mutation of ${relative} changed nothing`);
    writeFileSync(file(relative), after);
    return () => writeFileSync(file(relative), before);
  };
  const editMap = (change) => edit('docs/CLAIMS.json', (text) => { const map = JSON.parse(text); change(map); return `${JSON.stringify(map, null, 2)}\n`; });
  let defects = 0;
  const expectProblem = (label, expected, options) => {
    defects += 1;
    const found = checkClaims(scratch, options).problems;
    assert.ok(found.some((problem) => expected.test(problem)), `defect "${label}" was not reported; problems: ${JSON.stringify(found)}`);
  };
  const skills = 'DATGOLD-HUB/tests/verify-skill-delivery.mjs';
  const lsp = 'DATGOLD-HUB/tests/verify-lsp-tier.mjs';

  // 1. delete a marker
  let restore = edit(skills, (text) => text.replace(/^\/\/ CLAIM: skills-reach-model\r?\n/m, ''));
  expectProblem('a marker deleted', /has no line "\/\/ CLAIM: skills-reach-model"/); restore();
  // 2. rename a test
  renameSync(file(skills), file('DATGOLD-HUB/tests/verify-skill-delivery-renamed.mjs'));
  expectProblem('a test renamed', /verify-skill-delivery\.mjs does not exist/);
  // 2b. renamed so that the runner no longer lists it (and the map follows the rename): the file exists but nothing would run it
  renameSync(file('DATGOLD-HUB/tests/verify-skill-delivery-renamed.mjs'), file('DATGOLD-HUB/tests/skill-delivery.mjs'));
  restore = editMap((map) => { map.claims.find((entry) => entry.id === 'skills-reach-model').test = 'DATGOLD-HUB/tests/skill-delivery.mjs'; });
  expectProblem('a test renamed out of the verify-*.mjs pattern', /needs test: DATGOLD-HUB\/tests\/verify-/);
  restore();
  renameSync(file('DATGOLD-HUB/tests/skill-delivery.mjs'), file(skills));
  // 2c. the runner itself no longer lists it: a copy of run-all that only lists other suites
  const runner = 'DATGOLD-HUB/tests/run-all.mjs';
  restore = edit(runner, (text) => text.replace("/^verify-.+\\.mjs$/.test(name)", "/^verify-(?!skill-delivery).+\\.mjs$/.test(name)"));
  expectProblem('the runner no longer lists the suite', /is not listed by tests\/run-all\.mjs --list/); restore();
  // 3. a forbidden double
  restore = edit(lsp, (text) => `${text}\nconst workspace = { path: '/project' };\nnew LocalTools({ workspace });\n`);
  expectProblem('a forbidden double added', /forbidden double/); restore();
  restore = edit(lsp, (text) => `${text}\n// the old test used workspace = { path: '/project' } here\n`);
  assert.deepEqual(checkClaims(scratch).problems, [], 'a comment that talks about a double is not a double'); restore();
  // 4. the unmapped count grows
  restore = editMap((map) => map.claims.push({ id: 'new-unmapped', claim: 'A new claim without a test.', source: { file: 'README.md', line: map.claims[0].source.line, quote: map.claims[0].source.quote }, kind: 'claim', seam: 'unmapped', test: null, reason: 'no test yet, on purpose', phase: null }));
  expectProblem('the unmapped count grows', /unmapped claims, the ratchet .* allows/); restore();
  // 5. a gain that is not locked in
  restore = edit('docs/claims-ratchet.json', (text) => text.replace(/"maxUnmapped": \d+/, '"maxUnmapped": 99'));
  expectProblem('a ratchet that was not lowered', /lower maxUnmapped/); restore();
  // 6. a sentence with a trigger word that no claim covers
  restore = edit('README.md', (text) => `${text}\nThe installer is verified by an independent party.\n`);
  expectProblem('an uncovered sentence', /not covered by any claim/); restore();
  // 7. a document edit moves a quote
  restore = edit('README.md', (text) => `Moved down by one line.\n${text}`);
  expectProblem('a quote that moved', /the quote is not on line \d+ of README\.md \(it is on line \d+/); restore();
  // 8. a quote that is gone
  restore = edit('README.md', (text) => text.replace('install reviewed skills', 'install skills'));
  expectProblem('a quote that was reworded', /not in the document any more/); restore();
  // 9. bad data
  restore = editMap((map) => { map.claims[0].seam = 'mostly'; });
  expectProblem('an invalid seam', /seam must be "real" or "unmapped"/); restore();
  restore = editMap((map) => { delete map.claims[0].seamNote; });
  expectProblem('a real claim without a note', /needs a seamNote/); restore();
  restore = editMap((map) => { map.claims.find((entry) => entry.id === 'owner-acceptance').kind = 'disclaimer'; });
  expectProblem('a claim dressed as a disclaimer', /disclaimer must deny something/); restore();
  restore = editMap((map) => { map.claims[1].id = map.claims[0].id; });
  expectProblem('a duplicate id', /duplicate id/); restore();
  // 10. an orphan marker
  restore = edit('DATGOLD-HUB/tests/verify-docs.mjs', (text) => `// CLAIM: not-in-the-map\n${text}`);
  expectProblem('an orphan marker', /orphan marker/); restore();
  restore = edit('DATGOLD-HUB/tests/verify-docs.mjs', (text) => `// CLAIM: lsp-tier\n${text}`);
  expectProblem('a marker in the wrong suite', /belongs to DATGOLD-HUB\/tests\/verify-lsp-tier\.mjs/); restore();
  assert.deepEqual(checkClaims(scratch).problems, [], 'the copy is clean again once the defects are removed');
  ok(`${defects} seeded defects (marker deleted, test renamed, renamed out of the pattern, suite no longer listed by the runner, forbidden double added, unmapped count grown, ratchet not lowered, uncovered sentence, quote moved, quote reworded, bad seam / note / disclaimer / duplicate id, orphan marker, marker in the wrong suite) are each reported; a comment about a double is not one`);

  // 11. the ratchet against a base ref (a real Git repository)
  const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'ci'); git('config', 'commit.gpgsign', 'false');
  const current = JSON.parse(readFileSync(file('docs/claims-ratchet.json'), 'utf8'));
  writeFileSync(file('docs/claims-ratchet.json'), `${JSON.stringify({ ...current, maxUnmapped: current.maxUnmapped - 1 })}\n`);
  git('add', 'docs/claims-ratchet.json'); git('commit', '-q', '-m', 'base ratchet one lower');
  writeFileSync(file('docs/claims-ratchet.json'), `${JSON.stringify(current)}\n`);
  expectProblem('a ratchet raised against its base', /raises maxUnmapped from \d+ \(on main\)/, { base: 'main' });
  expectProblem('a base ref that does not exist', /cannot resolve the base ref nope/, { base: 'nope' });
  git('rm', '-q', '--cached', 'docs/claims-ratchet.json'); git('commit', '-q', '-m', 'no ratchet yet');
  assert.ok(checkClaims(scratch, { base: 'main' }).notes.some((note) => /no ratchet on main/.test(note)), 'a base without a ratchet is the first introduction');
  assert.deepEqual(checkClaims(scratch, { base: 'main' }).problems, [], 'and passes');
  git('add', 'docs/claims-ratchet.json'); git('commit', '-q', '-m', 'ratchet introduced');
  assert.deepEqual(checkClaims(scratch, { base: 'main' }).problems, [], 'the same ratchet as its base passes');
  ok('--base: a raised ratchet is reported, an unknown ref is reported, a base without a ratchet is the first introduction, an unchanged ratchet passes');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`PASS: ${checks} claims map checks (${stats.real} mapped, ${stats.unmappedClaims} unmapped, ${stats.disclaimers} disclaimers; ${stats.triggerSentences} trigger sentences covered)`);
