// release.yml runs the same gates and the same commands as the last hand-written release workflow, publish-v3.11.2.yml; only the
// values it used to type in are derived (docs/RELEASING.md).
//
// The 24 publish-vX.Y.Z.yml files were removed when release.yml replaced them, so a frozen copy of the last one is kept as a fixture
// (tests/fixtures/release/publish-v3.11.2.yml; its git blob id below proves it is the file that published v3.11.2). This suite reads both
// files step by step and normalizes every line: the literal values of 3.11.2 (version, Companion version, title, notes file, asset names,
// artifact prefix, the v3.9.0 baseline and its SHA-256) and the references release.yml uses instead ($env:X, $X,
// ${{ needs.resolve.outputs.x }}) become the same placeholder, quotes are dropped and whitespace collapsed. Then:
//   - every job of 3.11.2 has a counterpart with the same runner and time limit (its publish job became verify + publish);
//   - every step of 3.11.2 is found in the same order, and every line of it is in the matching step of release.yml, except the lines
//     listed below with the reason they changed (each listed pattern must match a line of 3.11.2, so the list cannot rot);
//   - release.yml uses no action that 3.11.2 did not use, at the same pinned commit, and adds only the steps listed below;
//   - the files whose versions 3.11.2 checked inline are all read by scripts/Resolve-ReleaseInputs.ps1.
// Defects put into an in-memory copy of release.yml (a dropped flag, a dropped command, another pin, two steps swapped, another time
// limit, an unlisted step) must each be found.
//
// What this does NOT show: that GitHub runs release.yml as intended. Only a run on GitHub shows that; it can be started only after the
// file is on the default branch (docs/RELEASING.md).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');
const RELEASE = path.join(REPO, '.github', 'workflows', 'release.yml');
const RESOLVER = path.join(REPO, 'scripts', 'Resolve-ReleaseInputs.ps1');
const FROZEN = path.join(HUB, 'tests', 'fixtures', 'release', 'publish-v3.11.2.yml');
if (!existsSync(RELEASE) || !existsSync(RESOLVER)) {
  console.log('CHATMCP_TEST_SKIP: .github/workflows/release.yml or scripts/Resolve-ReleaseInputs.ps1 was not found next to DATGOLD-HUB (the comparison needs the whole repository)');
  process.exit(0);
}

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const lf = (text) => text.replace(/\r\n/g, '\n');
const frozenText = lf(readFileSync(FROZEN, 'utf8'));
const releaseText = lf(readFileSync(RELEASE, 'utf8'));

// ---- the values of 3.11.2 and what release.yml says instead -------------------------------------------------------------------------
const LITERALS = [ // longest first: the title and the file names contain the version
  ['DatGold v3.11.2 - more skills install, review receipts that hold and the Hub side of per-hunk review', '{TITLE}'],
  ['RELEASE-NOTES-v3.11.2.md', '{NOTES_FILE}'],
  ['ChatMCP-v3.11.2', '{ARTIFACT_PREFIX}'],
  ['DatGold-Browser-Companion.zip', '{COMPANION_ASSET}'],
  ['DatGoldSetup.exe', '{INSTALLER_ASSET}'],
  ['RELEASE-MANIFEST.json', '{MANIFEST_ASSET}'],
  ['ChatMCPSetup.exe', '{BASELINE_ASSET}'],
  ['ef75e9a3721c5ba94a510de1ff00c1449031a4ac797570cb0d901861b509786e', '{BASELINE_SHA256}'],
  ['v3.9.0', '{BASELINE_TAG}'],
  ['3.9.0', '{BASELINE_VERSION}'],
  ['v3.11.2', '{TAG}'],
  ['3.11.2', '{VERSION}'],
  ['1.5.2', '{COMPANION_VERSION}'],
];
const NAMES = ['BASELINE_SHA256', 'BASELINE_VERSION', 'BASELINE_ASSET', 'BASELINE_TAG', 'COMPANION_VERSION', 'COMPANION_ASSET', 'INSTALLER_ASSET', 'MANIFEST_ASSET', 'ARTIFACT_PREFIX', 'NOTES_FILE', 'VERSION', 'TITLE', 'TAG'];

export function normalize(line) {
  let text = line.replace(/["']/g, '').replace(/\s+/g, ' ').trim();
  for (const [literal, placeholder] of LITERALS) text = text.split(literal).join(placeholder);
  text = text.replace(/\$\{\{\s*needs\.resolve\.outputs\.(\w+)\s*\}\}/g, (_, name) => `{${name.toUpperCase()}}`);
  for (const name of NAMES) text = text.replace(new RegExp(`\\$(?:env:)?\\{?${name}\\}?(?![A-Za-z0-9_])`, 'g'), `{${name}}`);
  return text;
}

// ---- a reader for the shape both files share --------------------------------------------------------------------------------------------
/** @returns {Map<string, {runsOn: string, timeout: string, steps: {key: string, name: string|null, uses: string|null, lines: string[]}[]}>} */
export function readJobs(text) {
  const lines = lf(text).split('\n');
  const start = lines.indexOf('jobs:');
  assert.ok(start >= 0, 'the workflow has a jobs: block');
  const jobs = new Map();
  let job = null;
  let step = null;
  let inSteps = false;
  for (const raw of lines.slice(start + 1)) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break;
    if (indent === 2) {
      const match = /^ {2}([\w-]+):$/.exec(raw);
      assert.ok(match, `unexpected line at job level: ${raw}`);
      job = { runsOn: '', timeout: '', steps: [] };
      jobs.set(match[1], job);
      inSteps = false; step = null;
      continue;
    }
    if (indent === 4) {
      inSteps = raw === '    steps:';
      step = null;
      const key = /^ {4}(runs-on|timeout-minutes): (.+)$/.exec(raw);
      if (key) job[key[1] === 'runs-on' ? 'runsOn' : 'timeout'] = key[2].trim();
      continue;
    }
    if (!inSteps) continue;
    if (indent === 6) {
      assert.ok(raw.startsWith('      - '), `unexpected line in steps: ${raw}`);
      step = { key: '', name: null, uses: null, lines: [] };
      job.steps.push(step);
      add(step, raw.slice(8));
      continue;
    }
    assert.ok(step && indent >= 8, `a step line outside a step: ${raw}`);
    add(step, raw.slice(8));
  }
  for (const each of jobs.values()) for (const one of each.steps) one.key = one.name ?? one.uses;
  return jobs;
}

function add(step, line) {
  const name = /^name: (.+)$/.exec(line);
  if (name) { step.name = name[1].trim(); return; }
  const uses = /^uses: (\S+)$/.exec(line);
  if (uses) { step.uses = uses[1]; step.lines.push(normalize(line)); return; }
  if (/^run: [|>]-?$/.test(line)) return;
  const run = /^run: (.+)$/.exec(line);
  step.lines.push(normalize(run ? run[1] : line));
}

// ---- what changed on purpose ------------------------------------------------------------------------------------------------------------------
const JOBS = { browser: ['browser'], windows: ['windows'], publish: ['verify', 'publish'] };
const RENAMED = {}; // a step of 3.11.2 that release.yml calls otherwise: none
const REMOVED = {
  'Guard exact commit and all component versions': [
    [/^if \(\(git show -s --format=%s HEAD\)\.Trim\(\) -ne release: ChatMCP \{TAG\}\)/, 'there is no release commit any more: a person starts the run (workflow_dispatch)'],
    [/^foreach \(\$file in @\(/, 'the versions are cross-checked by scripts/Resolve-ReleaseInputs.ps1 (scripts/tests/test_release_inputs.py), here and in the resolve job'],
    [/ConvertFrom-Json -AsHashtable\)\[version\] -ne \{VERSION\}/, 'the same (package.json, ui/package.json, ui/package-lock.json)'],
    [/\.Contains\(<Version>\{VERSION\}<\/Version>\)/, 'the same (both csproj)'],
    [/^}$/, 'the closing braces of the two loops above'],
    [/manifest\.json -Raw \| ConvertFrom-Json\)\.version -ne \{COMPANION_VERSION\}/, 'the Companion version is checked by the resolver'],
    [/^if \(-not \(Test-Path \{NOTES_FILE\}\)\)/, 'the notes file is required by the resolver'],
  ],
  'Require regular CI success on this exact release commit': [
    [/^result=\$\(gh api repos\/\$GITHUB_REPOSITORY\/actions\/runs\?head_sha=\$GITHUB_SHA&event=push/, 'the gate reads the runs of ci.yml itself and accepts push or a run started by hand on main (and the pull request run in a dry run)'],
    [/^read -r status conclusion <<</, 'it also reads the event of the run it counts'],
    [/^test \$conclusion = success \|\| \{ echo CI ended/, 'the message names the event'],
    [/^exit 0$/, 'it prints which run passed before it exits'],
    [/^echo CI did not finish successfully before publication deadline/, 'the same message without "publication": a dry run publishes nothing'],
  ],
  'Retrieve only artifacts from this successful workflow run': [
    [/^(python - <<PY|import hashlib, json, os|from pathlib import Path|root = |manifest = |assert |for asset in |file = |digest = |print\(|PY)/, 'the inline check became scripts/verify-release-assets.py (tested by scripts/tests/test_release_inputs.py); it runs in the verify job and again in the publish job'],
  ],
};
const ADDED = new Set([ // steps of release.yml with no counterpart in 3.11.2
  'A real release runs only from main',
  'Derive every value of the release from the repository',
  'Verify the asset hashes against the manifest',
  'Say what a dry run did not do',
  'Retrieve only artifacts from this successful workflow run and verify them again',
]);

export function compare(frozen, release) {
  const problems = [];
  const before = readJobs(frozen);
  const after = readJobs(release);
  const mapped = new Set();
  for (const [oldName, newNames] of Object.entries(JOBS)) {
    const old = before.get(oldName);
    if (!old) { problems.push(`publish-v3.11.2.yml has no job ${oldName}`); continue; }
    const targets = newNames.map((name) => after.get(name));
    if (targets.some((job) => !job)) { problems.push(`release.yml lacks one of the jobs ${newNames.join(', ')}`); continue; }
    for (const job of targets) {
      if (job.runsOn !== old.runsOn) problems.push(`${newNames.join('+')}: runs on ${job.runsOn}, 3.11.2 ran ${oldName} on ${old.runsOn}`);
      if (job.timeout !== old.timeout) problems.push(`${newNames.join('+')}: timeout-minutes ${job.timeout}, 3.11.2 had ${old.timeout} for ${oldName}`);
    }
    const pool = targets.flatMap((job) => job.steps);
    let cursor = 0;
    for (const step of old.steps) {
      const key = RENAMED[step.key] ?? step.key;
      const index = pool.findIndex((candidate, position) => position >= cursor && candidate.key === key);
      if (index < 0) { problems.push(`${oldName}: the step "${step.key}" of 3.11.2 is missing from release.yml or out of order`); continue; }
      cursor = index + 1;
      mapped.add(pool[index]);
      const allowed = REMOVED[step.key] ?? [];
      for (const [pattern] of allowed) if (!step.lines.some((line) => pattern.test(line))) problems.push(`the allowed change ${pattern} matches no line of "${step.key}" in 3.11.2`);
      const kept = new Set(pool[index].lines);
      for (const line of step.lines) {
        if (kept.has(line) || allowed.some(([pattern]) => pattern.test(line))) continue;
        problems.push(`${oldName} / "${step.key}": the line "${line}" of 3.11.2 is not in release.yml`);
      }
    }
  }
  const oldUses = new Set([...before.values()].flatMap((job) => job.steps.map((step) => step.uses)).filter(Boolean));
  for (const [name, job] of after) {
    for (const step of job.steps) {
      if (step.uses && !oldUses.has(step.uses)) problems.push(`${name}: uses ${step.uses}, which 3.11.2 did not use (or not at that commit)`);
      const extraCheckout = !step.name && /^actions\/checkout@/.test(step.uses ?? '') && (name === 'resolve' || name === 'publish'); // the two new jobs check out the same commit
      if (!mapped.has(step) && !(step.name && ADDED.has(step.name)) && !extraCheckout) {
        problems.push(`${name}: the step "${step.key}" is neither from 3.11.2 nor in the list of added steps`);
      }
    }
  }
  return problems;
}

// ---- 1. the fixture is the file that published v3.11.2 ---------------------------------------------------------------------------------
{
  const bytes = Buffer.from(frozenText, 'utf8');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob, 'af92a2c2a0d79fe3500a1e7097729995ea9b6435', 'tests/fixtures/release/publish-v3.11.2.yml is byte for byte .github/workflows/publish-v3.11.2.yml as of ea49701a');
  ok('the fixture is .github/workflows/publish-v3.11.2.yml as it was on main at ea49701a (git blob af92a2c2)');
}

// ---- 2. the reader and the normalizer --------------------------------------------------------------------------------------------------------
{
  const jobs = readJobs(frozenText);
  assert.deepEqual([...jobs.keys()], ['browser', 'windows', 'publish']);
  assert.equal(jobs.get('windows').steps.length, 14, '3.11.2 had 14 Windows steps');
  assert.equal(normalize("gh release download v3.9.0 --pattern ChatMCPSetup.exe"), normalize('gh release download $env:BASELINE_TAG --pattern "$env:BASELINE_ASSET"'));
  assert.equal(normalize("name: ChatMCP-v3.11.2-browser-evidence"), normalize('name: ${{ needs.resolve.outputs.artifact_prefix }}-browser-evidence'));
  assert.equal(normalize('git tag -a "$TAG" -m \'DatGold v3.11.2 - more skills install, review receipts that hold and the Hub side of per-hunk review\' "$GITHUB_SHA"'), normalize('git tag -a "$TAG" -m "$TITLE" "$GITHUB_SHA"'));
  assert.notEqual(normalize('$env:VERSION'), normalize('$env:BASELINE_VERSION'));
  assert.notEqual(normalize('gh release create --draft'), normalize('gh release create'));
  ok('the reader finds the 3 jobs and 14 Windows steps of 3.11.2; the normalizer maps a 3.11.2 literal and its derived reference to one placeholder and keeps flags apart');
}

// ---- 3. release.yml against 3.11.2 ----------------------------------------------------------------------------------------------------------
{
  assert.deepEqual(compare(frozenText, releaseText), []);
  const counted = [...readJobs(frozenText).values()].reduce((sum, job) => sum + job.steps.reduce((inner, step) => inner + step.lines.length, 0), 0);
  const removed = Object.values(REMOVED).reduce((sum, list) => sum + list.length, 0);
  ok(`every job, step and line of publish-v3.11.2.yml (${counted} lines) is in release.yml in the same order, with the same runners, time limits and pinned actions, except ${removed} listed changes`);
}

// ---- 4. the inline version checks of 3.11.2 are all done by the resolver ---------------------------------------------------------------
{
  const resolver = readFileSync(RESOLVER, 'utf8');
  const named = [...frozenText.matchAll(/'((?:DATGOLD-HUB|desktop-shell|installer)\/[^']+)'/g)].map((match) => match[1]);
  named.push('DATGOLD-HUB/extension/manifest.json', 'RELEASE-NOTES-v');
  assert.ok(named.length >= 7);
  for (const file of named) assert.ok(resolver.includes(file), `scripts/Resolve-ReleaseInputs.ps1 does not read ${file}, which publish-v3.11.2.yml checked`);
  ok(`the ${named.length} files whose versions 3.11.2 checked inline are all read by scripts/Resolve-ReleaseInputs.ps1`);
}

// ---- 5. defects in an in-memory copy of release.yml must be found ---------------------------------------------------------------------------
{
  const mutations = [
    ['--verify-tag dropped from the release', (t) => t.replaceAll(' --verify-tag', '')],
    ['the Companion browser test dropped', (t) => t.replace(/ +npx playwright test e2e\/companion-ipc\.spec\.mjs[^\n]*\n/, '')],
    ['the no-skip Hub run dropped', (t) => t.replace(/ +node DATGOLD-HUB\/tests\/run-all\.mjs --no-skip all[^\n]*\n/, '')],
    ['another checkout pin', (t) => t.replace('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683', 'actions/checkout@v4')],
    ['a shorter Windows time limit', (t) => t.replace('    timeout-minutes: 75\n', '    timeout-minutes: 60\n')],
    ['the upgrade test before the build', (t) => {
      const build = /( {6}- name: Build fresh versioned Windows installer\n(?: {8}.*\n)+)/.exec(t)[1];
      const upgrade = /( {6}- name: Real setup upgrade, installed EXE lifecycle and uninstall\n(?: {8}.*\n)+)/.exec(t)[1];
      return t.replace(build, '@@BUILD@@').replace(upgrade, build).replace('@@BUILD@@', upgrade);
    }],
    ['the baseline checksum check dropped', (t) => t.replace(/ +if \(\(Get-FileHash "\$env:RUNNER_TEMP\/native-baseline[^\n]*\n/, '')],
    ['an unlisted step added', (t) => t.replace('      - name: Build fresh versioned Windows installer\n', '      - name: Something new\n        run: echo hi\n      - name: Build fresh versioned Windows installer\n')],
    ['the draft dropped from a normal release', (t) => t.replace(/(--verify-tag) --draft (--title "\$TITLE" --notes-file "\$NOTES_FILE"\n {12}gh release edit "\$TAG" --repo "\$GITHUB_REPOSITORY" --draft=false --latest\n)/, '$1 $2')],
  ];
  for (const [label, change] of mutations) {
    const after = change(releaseText);
    assert.notEqual(after, releaseText, `the mutation "${label}" changed nothing`);
    assert.notDeepEqual(compare(frozenText, after), [], `the defect "${label}" was not detected`);
  }
  ok(`${mutations.length} defects put into an in-memory copy of release.yml (a dropped flag, test, Hub run, checksum or draft, another pin, another time limit, two steps swapped, an unlisted step) are each detected`);
}

console.log(`PASS: ${checks} release workflow checks (release.yml against the frozen publish-v3.11.2.yml)`);
