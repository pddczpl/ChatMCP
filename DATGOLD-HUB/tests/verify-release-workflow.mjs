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
//   - the Hub suites of the windows job moved to a job of their own, hub-tests, which runs them in shards (SPLIT below): the same runner, time
//     limit and set-up steps, the same lines except that run-all.mjs gets --shard; section 7 holds the rest of that job to its purpose;
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
// The version of the frozen file is read from its own name line, not typed: it is history, not the running version (which
// verify-updater-e2e-tools forbids a test to write by hand), and the two are the same number only until the next version bump.
const FROZEN_VERSION = /^name: Publish ChatMCP v(\d+\.\d+\.\d+)$/m.exec(frozenText)?.[1];
assert.equal(FROZEN_VERSION?.split('.').length, 3, 'the frozen workflow names its version on its name line');
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
  [`v${FROZEN_VERSION}`, '{TAG}'],
  [FROZEN_VERSION, '{VERSION}'],
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
// A job of 3.11.2 from which a job of release.yml was split off, and the steps that moved there: same runner, same time limit, and the same
// unnamed set-up steps as the job they came from, so that the suites see the same machine. One Windows job ran all of it until 2026-11-24; its
// suites alone took 27.7 of its 44 minutes with 218 suites, and the list grows with every wave (docs/RELEASING.md, "Why the Hub suites run in shards").
const SPLIT = { windows: { job: 'hub-tests', steps: ['Complete no-skip Hub regression'] } };
// A line of 3.11.2 that release.yml must hold in this form instead.
const CHANGED = {
  'Complete no-skip Hub regression': [
    [/^node DATGOLD-HUB\/tests\/run-all\.mjs --no-skip all --json /, (line, shards) => line.replace('--no-skip all ', '--no-skip all --shard ${{ matrix.shard }}/' + shards + ' '), 'the list runs in shards, one job each (section 7)'],
  ],
};
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
  // the test tools of the suites that came after 3.11.2 (ACP, MCP), installed as ci.yml installs them (check 6)
  'Install the ACP test tools',
  'Install the MCP client SDK and the MCP reference servers',
  // the sharded Hub run: what the windows job did for its suites (exact commit, source left clean, evidence kept) each shard does itself
  'Guard the exact commit of this shard',
  'The suites of this shard left the source as it was committed',
  'Preserve the Hub evidence of this shard even on failure',
  'Set up Node for the evidence check',
  'Check that the shards ran every Hub suite exactly once and that all passed',
]);

/** The lines of one job of a workflow, its header included; null when there is none. */
function jobBlock(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end + 2);
}

/** The shard axis of hub-tests as it is written, [] when there is none. */
function shardAxis(text) {
  const axis = /^ {8}shard: \[([^\]]*)\]$/m.exec(jobBlock(text, 'hub-tests') ?? '');
  return axis ? axis[1].split(',').map((item) => item.trim()).filter(Boolean) : [];
}

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
    const split = SPLIT[oldName];
    const splitJob = split ? after.get(split.job) : null;
    if (split && !splitJob) { problems.push(`release.yml lacks the job ${split.job}, which runs "${split.steps.join('", "')}" of ${oldName}`); continue; }
    if (split) {
      if (splitJob.runsOn !== old.runsOn) problems.push(`${split.job}: runs on ${splitJob.runsOn}, 3.11.2 ran ${oldName} on ${old.runsOn}`);
      if (splitJob.timeout !== old.timeout) problems.push(`${split.job}: timeout-minutes ${splitJob.timeout}, 3.11.2 had ${old.timeout} for ${oldName}`);
      const setUp = (job) => job.steps.filter((step) => !step.name);
      const text = (job) => JSON.stringify(setUp(job).map((step) => step.lines));
      if (text(splitJob) !== text(old)) problems.push(`${split.job}: its set-up steps are not those of ${oldName} in 3.11.2`);
      for (const step of setUp(splitJob)) mapped.add(step);
    }
    let cursor = 0;
    for (const step of old.steps) {
      const key = RENAMED[step.key] ?? step.key;
      const moved = split?.steps.includes(step.key) ?? false;
      const index = moved ? -1 : pool.findIndex((candidate, position) => position >= cursor && candidate.key === key);
      const found = moved ? splitJob.steps.find((candidate) => candidate.key === key) : pool[index];
      if (!found) { problems.push(`${oldName}: the step "${step.key}" of 3.11.2 is missing from ${moved ? `${split.job} of release.yml` : 'release.yml or out of order'}`); continue; }
      if (!moved) cursor = index + 1;
      mapped.add(found);
      const allowed = REMOVED[step.key] ?? [];
      const changed = CHANGED[step.key] ?? [];
      for (const [pattern] of [...allowed, ...changed]) if (!step.lines.some((line) => pattern.test(line))) problems.push(`the allowed change ${pattern} matches no line of "${step.key}" in 3.11.2`);
      const kept = new Set(found.lines);
      for (const line of step.lines) {
        const change = changed.find(([pattern]) => pattern.test(line));
        const wanted = change ? change[1](line, shardAxis(release).length) : line;
        if (kept.has(wanted) || allowed.some(([pattern]) => pattern.test(line))) continue;
        problems.push(`${oldName} / "${step.key}": the line "${line}" of 3.11.2 is not in release.yml${change ? ` as "${wanted}"` : ''}`);
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
  const listed = [...Object.values(REMOVED), ...Object.values(CHANGED)].reduce((sum, list) => sum + list.length, 0);
  ok(`every job, step and line of publish-v3.11.2.yml (${counted} lines) is in release.yml in the same order, with the same runners, time limits and pinned actions, except ${listed} listed changes (the Hub suites in the job ${SPLIT.windows.job})`);
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
    ['the no-skip flag dropped from the Hub run', (t) => t.replace('run-all.mjs --no-skip all ', 'run-all.mjs ')],
    ['the Hub run without --shard (every shard would run the whole list)', (t) => t.replace(/ --shard "\$\{\{ matrix\.shard \}\}\/\d+"/, '')],
    ['the exit code of the Hub run not looked at', (t) => t.replace(/ +if \(\$LASTEXITCODE -ne 0\) \{ throw 'Hub regression failed' \}\n/, '')],
    ['another Node version for the shards', (t) => t.replace(/(\n {2}hub-tests:\n[\s\S]*?node-version: ')24'/, "$122'")],
    ['another machine for the shards', (t) => t.replace(/(\n {2}hub-tests:\n[\s\S]*? {4}runs-on: )windows-latest/, '$1ubuntu-latest')],
    ['a higher time limit for the shards', (t) => t.replace(/(\n {2}hub-tests:\n[\s\S]*? {4}timeout-minutes: )75/, '$190')],
    ['the Hub run in the windows job again', (t) => t.replace('      - name: Build fresh versioned Windows installer\n', '      - name: Complete no-skip Hub regression\n        run: node DATGOLD-HUB/tests/run-all.mjs --no-skip all\n      - name: Build fresh versioned Windows installer\n')],
    ['the shards in no job', (t) => t.replace('\n  hub-tests:\n', '\n  hub-suites:\n')],
    ['another checkout pin',(t) => t.replace('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683', 'actions/checkout@v4')],
    ['a shorter Windows time limit', (t) => t.replace(/(\n {2}windows:\n[\s\S]*? {4}timeout-minutes: )75/, '$160')],
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
  ok(`${mutations.length} defects put into an in-memory copy of release.yml (a dropped flag, test, Hub run, shard, exit code, checksum or draft, another pin, Node, machine or time limit, two steps swapped, an unlisted or repeated step) are each detected`);
}

// ---- 6. the no-skip Hub run of a release installs what the no-skip Hub run of ci.yml installs -------------------------------------------
// The dry run of 2026-11-21 (run 44816344277) failed here: release.yml was built from publish-v3.11.2.yml, which predates the ACP and MCP
// suites, so 11 suites were skipped for their missing test tools and --no-skip made each skip a failure. Every `npm ci --prefix <folder>` that
// the hub-tests job of ci.yml runs before its run-all must also run in the hub-tests job of release.yml before its run-all.
export function missingInstalls(ciText, releaseYml) {
  const prefixes = (text, jobHeader, baseDir) => {
    const start = text.indexOf(jobHeader);
    if (start < 0) return null;
    const rest = text.slice(start);
    const end = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const job = end > 0 ? rest.slice(0, end) : rest;
    const runAll = job.indexOf('tests/run-all.mjs --no-skip all');
    const before = runAll < 0 ? job : job.slice(0, runAll);
    return [...before.matchAll(/npm ci [^\n]*--prefix (\S+)/g)].map((m) => path.posix.normalize(path.posix.join(baseDir, m[1])));
  };
  const ci = prefixes(ciText, '\n  hub-tests:\n', 'DATGOLD-HUB');
  const release = prefixes(releaseYml, '\n  hub-tests:\n', '.');
  if (!ci || !release) return ['a job was not found'];
  return ci.filter((folder) => !release.includes(folder));
}
{
  const ciText = lf(readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8'));
  const missing = missingInstalls(ciText, releaseText);
  assert.deepEqual(missing, [], `release.yml runs the no-skip Hub regression without installing what ci.yml installs for it: ${missing.join(', ')}`);
  assert.ok(missingInstalls(ciText, releaseText.replace(/^ +npm ci [^\n]*--prefix DATGOLD-HUB\/tests\/acp-tools[^\n]*\n/m, '')).includes('DATGOLD-HUB/tests/acp-tools'), 'a dropped ACP install is detected');
  ok('the no-skip Hub run of release.yml installs every test tool folder that the no-skip Hub run of ci.yml installs (ACP tools, MCP runtime, MCP reference servers)');
}

// ---- 7. the shards: each suite in exactly one of them, every shard waited for, its evidence kept and checked before anything is published ----
// `run-all.mjs --shard i/n` splits the list (verify-test-runner proves that the n parts are the whole list), and scripts/verify-release-evidence.mjs
// refuses a run whose evidence does not show every suite PASS exactly once (verify-release-evidence tests it). What is checked here is that
// release.yml uses the two so that nothing slips past: one shard axis 1..n and the same n wherever it is named, a run that can neither leave a
// suite out nor retry one, no condition that could skip a job or a step and no failure that is ignored, an evidence artifact per shard that the
// verify job downloads and checks, and a verify job that waits for all of them (publish waits for verify: verify-ci-triggers pins that).
const SHARD_STEPS = { // in this order
  guard: 'Guard the exact commit of this shard',
  acp: 'Install the ACP test tools',
  mcp: 'Install the MCP client SDK and the MCP reference servers',
  run: 'Complete no-skip Hub regression',
  clean: 'The suites of this shard left the source as it was committed',
  keep: 'Preserve the Hub evidence of this shard even on failure',
};
const EVIDENCE_CHECK = 'Check that the shards ran every Hub suite exactly once and that all passed';
const SHARD = '${{ matrix.shard }}'; // what the workflow writes, not a template of this file

function stepBlock(job, name) {
  const start = job.indexOf(`      - name: ${name}\n`);
  if (start < 0) return '';
  const rest = job.slice(start);
  const end = rest.slice(1).search(/\n {6}- /);
  return end < 0 ? rest : rest.slice(0, end + 2);
}

export function shardProblems(text) {
  const problems = [];
  const code = text.replace(/^\s*#.*$/gm, '').replace(/\n{2,}/g, '\n'); // without the full-line comments
  const [job, verify, windows, browser] = ['hub-tests', 'verify', 'windows', 'browser'].map((name) => jobBlock(code, name));
  if (!job || !verify || !windows || !browser) return ['release.yml lacks the hub-tests, the verify, the windows or the browser job'];
  const need = (condition, problem) => { if (!condition) problems.push(problem); };

  // one number of shards
  const axis = shardAxis(code);
  const count = axis.length;
  need(count >= 2 && axis.join(',') === Array.from({ length: count }, (_, i) => String(i + 1)).join(','), `hub-tests: the shard axis is [${axis.join(', ')}]; it must be [1, 2, ...] up to the number of shards`);
  need(job.includes(`    strategy:\n      fail-fast: false\n      matrix:\n        shard: [${axis.join(', ')}]\n    defaults:\n      run:\n        shell: pwsh\n    steps:\n`), 'hub-tests: the strategy must be fail-fast: false (a red shard must not cancel the evidence of the others) and a matrix of the shard axis alone (an include or exclude could drop a shard), and the steps must run in PowerShell 7 (the Tee-Object of Windows PowerShell writes UTF-16)');
  need(job.includes(`    name: Complete no-skip Hub regression (${SHARD}/${count})\n`), `hub-tests: the job name must be "Complete no-skip Hub regression (${SHARD}/${count})"`);
  need(/^ {4}needs: resolve$/m.test(job), 'hub-tests: it must wait for the resolve job');

  // the run
  const runs = [...code.matchAll(/run-all\.mjs([^\n]*)/g)].map((match) => match[1]);
  need(runs.length === 1 && job.includes('run-all.mjs'), `release.yml names run-all.mjs ${runs.length} times; it must run it once, in hub-tests`);
  const folder = '$env:RUNNER_TEMP/native-release-evidence';
  const wanted = ` --no-skip all --shard "${SHARD}/${count}" --json "${folder}/node-summary.json" 2>&1 | Tee-Object "${folder}/node-all.log"`;
  need(runs[0] === wanted, `hub-tests: run-all.mjs must be called with exactly${wanted} (no --filter, --bail, --retry-failed-once, --timeout or --tests-dir)`);

  // nothing skipped, nothing forgiven
  for (const [name, block] of Object.entries({ 'hub-tests': job, windows, browser, verify })) {
    need(!/^ {4}if:/m.test(block), `${name}: a condition on the job could skip it`);
    need(!/continue-on-error/.test(block), `${name}: continue-on-error would let a failure pass`);
  }
  const steps = Object.fromEntries(Object.entries(SHARD_STEPS).map(([key, name]) => [key, stepBlock(job, name)]));
  const at = Object.values(SHARD_STEPS).map((name) => job.indexOf(`      - name: ${name}\n`));
  need(at.every((position, index) => position >= 0 && (index === 0 || position > at[index - 1])), `hub-tests: its steps must be, in this order: ${Object.values(SHARD_STEPS).join('; ')}`);
  for (const key of ['guard', 'acp', 'mcp', 'run', 'clean']) need(!/^ {8}if:/m.test(steps[key]), `hub-tests: the step "${SHARD_STEPS[key]}" has a condition`);

  // what a shard vouches for and keeps
  need(steps.guard.includes("          if ((git rev-parse HEAD).Trim() -ne $env:GITHUB_SHA) { throw 'Wrong checkout' }\n") && steps.guard.includes(`          $env:GITHUB_SHA | Set-Content "${folder}/commit.txt" -Encoding utf8\n`), 'hub-tests: each shard must check the commit it runs on and write it into its evidence');
  need(/\n {10}git diff HEAD --stat --exit-code\n {10}if \(\$LASTEXITCODE -ne 0\) \{ throw '[^'\n]+' \}\n/.test(steps.clean), 'hub-tests: each shard must refuse a checkout that its suites changed (the source gate of the windows job no longer sees them run)');
  const artifact = '${{ needs.resolve.outputs.artifact_prefix }}-hub-evidence-shard' + SHARD;
  need(steps.keep.includes(`          name: ${artifact}\n`), `hub-tests: the evidence must be uploaded as ${artifact} (two shards must not upload one name)`);
  need(steps.keep.includes('        if: always()\n') && steps.keep.includes('          path: ${{ runner.temp }}/native-release-evidence\n') && steps.keep.includes('          if-no-files-found: error\n'), 'hub-tests: the evidence folder must be uploaded always, and an empty one must fail');

  // the verify job waits for every shard and checks what they kept
  need(/^ {4}needs: \[resolve, browser, hub-tests, windows\]$/m.test(verify), 'verify: it must wait for resolve, browser, hub-tests (every shard) and windows');
  const check = stepBlock(verify, EVIDENCE_CHECK);
  need(!/^ {8}if:/m.test(check), 'verify: the evidence check has a condition');
  need(check.includes('        shell: bash\n        run: |\n          set -euo pipefail\n'), 'verify: the evidence check must stop at its first failing command (bash, set -euo pipefail: tee would hide an exit code)');
  need(check.includes('          gh run download "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" --pattern "$ARTIFACT_PREFIX-hub-evidence-shard*" --dir "$RUNNER_TEMP/hub-evidence"\n'), 'verify: it must download the evidence of every shard of this run');
  need(check.includes(`          node scripts/verify-release-evidence.mjs --evidence "$RUNNER_TEMP/hub-evidence" --shards ${count} --commit "$GITHUB_SHA" | tee -a "$GITHUB_STEP_SUMMARY"\n`), `verify: scripts/verify-release-evidence.mjs must check the evidence of ${count} shards at $GITHUB_SHA`);
  return problems;
}
{
  assert.deepEqual(shardProblems(releaseText), []);
  const count = shardAxis(releaseText).length;
  ok(`hub-tests runs the no-skip list in ${count} shards (the axis, the job name, the command and the evidence check agree), each shard guards its commit and its source and keeps its evidence, and verify waits for all of them and checks that every suite passed exactly once`);
  const inJob = (name, change) => (t) => { const block = jobBlock(t, name); return t.replace(block, () => change(block)); };
  const inStep = (name, change) => (t) => { const block = stepBlock(t, name); return t.replace(block, () => change(block)); };
  const first = (block, line) => block.replace(/\n/, () => `\n${line}\n`); // a line right below the "- name:" line
  const mutations = [
    ['the shard axis dropped', (t) => t.replace(/\n {8}shard: \[[^\]]*\]/, '')],
    ['a shard dropped from the axis only', (t) => t.replace(/( {8}shard: \[[^\]]*), \d+\]/, '$1]')],
    ['a shard more in the axis only', (t) => t.replace(/( {8}shard: \[[^\]]*)\]/, `$1, ${count + 1}]`)],
    ['a shard twice, another never', (t) => t.replace(/ {8}shard: \[[^\]]*\]/, '        shard: [1, 1, 3]')],
    ['a single shard, consistently', (t) => t.replace(/ {8}shard: \[[^\]]*\]/, '        shard: [1]').replaceAll(`${SHARD}/${count}`, `${SHARD}/1`).replace(`--shards ${count}`, '--shards 1')],
    ['a shard excluded', (t) => t.replace(/( {8}shard: \[[^\]]*\]\n)/, '$1        exclude:\n          - shard: 2\n')],
    ['another number in the command', (t) => t.replace(`"${SHARD}/${count}"`, `"${SHARD}/${count + 1}"`)],
    ['another number in the job name', (t) => t.replace(`regression (${SHARD}/${count})`, `regression (${SHARD}/${count + 1})`)],
    ['another number in the evidence check', (t) => t.replace(`--shards ${count}`, `--shards ${count - 1}`)],
    ['every job running shard 1', (t) => t.replace(`--shard "${SHARD}/`, '--shard "1/')],
    ['Windows PowerShell for the shards', inJob('hub-tests', (b) => b.replace('shell: pwsh', 'shell: powershell'))],
    ['fail-fast back',(t) => t.replace('fail-fast: false', 'fail-fast: true')],
    ['the shards before the inputs are resolved', inJob('hub-tests', (b) => b.replace('    needs: resolve\n', ''))],
    ['a filter', (t) => t.replace('--no-skip all --shard', '--no-skip all --filter e2e --shard')],
    ['a retry', (t) => t.replace('--no-skip all --shard', '--no-skip all --retry-failed-once --shard')],
    ['--bail', (t) => t.replace('--no-skip all --shard', '--no-skip all --bail --shard')],
    ['--no-skip for one suite only', (t) => t.replace('--no-skip all --shard', '--no-skip verify-docs --shard')],
    ['a second run of the runner', inJob('windows', (b) => b.replace('      - name: Build fresh', () => '      - name: More\n        run: node DATGOLD-HUB/tests/run-all.mjs\n      - name: Build fresh'))],
    ['the Hub step with a condition', inStep(SHARD_STEPS.run, (b) => first(b, '        if: ${{ inputs.dry_run }}'))],
    ['the Hub step allowed to fail', inStep(SHARD_STEPS.run, (b) => first(b, '        continue-on-error: true'))],
    ['the shards only in a dry run', inJob('hub-tests', (b) => b.replace('    needs: resolve\n', () => '    needs: resolve\n    if: ${{ inputs.dry_run }}\n'))],
    ['the shards allowed to fail', inJob('hub-tests', (b) => b.replace('    needs: resolve\n', '    needs: resolve\n    continue-on-error: true\n'))],
    ['no commit guard', inStep(SHARD_STEPS.guard, (b) => b.replace(/ +if \(\(git rev-parse[^\n]*\n/, ''))],
    ['no commit in the evidence', inStep(SHARD_STEPS.guard, (b) => b.replace(/ +\$env:GITHUB_SHA \| Set-Content[^\n]*\n/, ''))],
    ['the commit guard with a condition', inStep(SHARD_STEPS.guard, (b) => first(b, '        if: ${{ inputs.dry_run }}'))],
    ['the source check that looks at no exit code', inStep(SHARD_STEPS.clean, (b) => b.replace(/ +if \(\$LASTEXITCODE[^\n]*\n/, ''))],
    ['the source check that misses staged changes', inStep(SHARD_STEPS.clean, (b) => b.replace('git diff HEAD', 'git diff'))],
    ['the source check with a condition', inStep(SHARD_STEPS.clean, (b) => first(b, '        if: ${{ inputs.dry_run }}'))],
    ['two shards uploading one name', (t) => t.replace(`-hub-evidence-shard${SHARD}`, '-hub-evidence-shard')],
    ['the evidence kept on success only', inStep(SHARD_STEPS.keep, (b) => b.replace('        if: always()\n', ''))],
    ['an empty evidence folder allowed', inStep(SHARD_STEPS.keep, (b) => b.replace('if-no-files-found: error', 'if-no-files-found: ignore'))],
    ['the evidence kept before the suites run', inJob('hub-tests', (b) => { const keep = stepBlock(b, SHARD_STEPS.keep); return b.replace(keep, '').replace(`      - name: ${SHARD_STEPS.run}\n`, (line) => keep + line); })],
    ['verify not waiting for the shards', (t) => t.replace('needs: [resolve, browser, hub-tests, windows]', 'needs: [resolve, browser, windows]')],
    ['verify not waiting for the windows job', (t) => t.replace('needs: [resolve, browser, hub-tests, windows]', 'needs: [resolve, browser, hub-tests]')],
    ['verify running whatever the shards did', inJob('verify', (b) => b.replace('    runs-on:', () => '    if: ${{ always() }}\n    runs-on:'))],
    ['verify allowed to fail', inJob('verify', (b) => b.replace('    runs-on:', '    continue-on-error: true\n    runs-on:'))],
    ['the evidence check dropped', inStep(EVIDENCE_CHECK, () => '')],
    ['the evidence check in a dry run only', inStep(EVIDENCE_CHECK, (b) => first(b, '        if: ${{ inputs.dry_run }}'))],
    ['the evidence check without pipefail', inStep(EVIDENCE_CHECK, (b) => b.replace('set -euo pipefail', 'set -eu'))],
    ['the evidence of one shard only', (t) => t.replace('-hub-evidence-shard*"', '-hub-evidence-shard1"')],
    ['the evidence held against another commit', (t) => t.replace(/(verify-release-evidence\.mjs [^\n]*--commit )"\$GITHUB_SHA"/, (_, head) => `${head}"$(git rev-parse HEAD~1)"`)],
  ];
  for (const [label, change] of mutations) {
    const after = change(releaseText);
    assert.notEqual(after, releaseText, `the mutation "${label}" changed nothing`);
    assert.notDeepEqual(shardProblems(after), [], `the defect "${label}" was not detected`);
  }
  ok(`${mutations.length} defects put into an in-memory copy of release.yml (a shard dropped, repeated, added or excluded; numbers that disagree; a filter, retry, bail or narrower no-skip; a second run; a condition or a tolerated failure; no commit or source guard; evidence that is shared, dropped, partial, empty or of another commit; a verify job that does not wait or does not check) are each detected`);
}

console.log(`PASS: ${checks} release workflow checks (release.yml against the frozen publish-v3.11.2.yml)`);
