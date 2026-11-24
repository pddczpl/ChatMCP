// One CI run per push, proved from the workflow files without GitHub.
//
// ci.yml used to run on `push` for main and for the branches dev/**, fix/**, feat/**, refactor/** AND on `pull_request`, so every push to a
// pull request branch started it twice; browser-companion-regression.yml and browser-companion-package.yml each pinned a feature branch
// in `push` for the same effect; phase1-component-tests.yml was pinned to a branch that no longer exists.
//
// This suite reads the REAL workflow files with a small model of GitHub's trigger rules (tests/fixtures/workflow-triggers.mjs) and replays
// events: a push to a branch that has an open pull request (the push event and the pull_request "synchronize" event GitHub sends for it),
// a docs-only change, a merge to main, a push to a branch without a pull request, a tag. For every workflow in .github/workflows it asserts
// that the push of one commit starts it at most once, and for ci.yml and docs-gates.yml exactly which one starts for which change.
// The same replay runs on the OLD trigger block (embedded below, as it was in v3.9.0) and must see two runs there: that is the negative
// control that shows the model can see the defect. Further defects are put into in-memory copies of the current files and must be found.
//
// What this does NOT show: that GitHub agrees with the model. The first pull requests after the change do (scripts/ci-health.mjs reports
// the runs per merged PR and the (workflow, commit) pairs that ran more than once).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { concurrencyOf, matchesFilter, parseWorkflow, triggers } from './fixtures/workflow-triggers.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');
const FOLDER = path.join(REPO, '.github', 'workflows');
if (!existsSync(FOLDER)) {
  console.log('CHATMCP_TEST_SKIP: .github/workflows was not found next to DATGOLD-HUB (the trigger check needs the whole repository)');
  process.exit(0);
}

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const files = readdirSync(FOLDER).filter((name) => /\.ya?ml$/.test(name)).sort();
const source = Object.fromEntries(files.map((name) => [name, readFileSync(path.join(FOLDER, name), 'utf8').replace(/\r\n/g, '\n')])); // a Windows checkout has CRLF
const workflows = Object.fromEntries(files.map((name) => [name, parseWorkflow(source[name])]));

/** The v3.9.0 header of ci.yml, byte for byte as far as it matters to triggers. */
const OLD_CI = parseWorkflow(`name: CI

on:
  push:
    branches: [main, 'dev/**', 'fix/**', 'feat/**', 'refactor/**']
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  hub-tests:
    runs-on: ubuntu-latest
`);

const CODE = ['DATGOLD-HUB/lib/agent.mjs', 'DATGOLD-HUB/tests/verify-docs.mjs'];
const DOCS = ['README.md', 'docs/THREAT-MODEL.md', 'docs/CLAIMS.json'];
const prEvents = (branch, files, number = 7) => [
  { name: 'push', branch, files },
  { name: 'pull_request', action: 'synchronize', base: 'main', head: branch, files, number },
];
const runs = (workflow, events) => events.filter((event) => triggers(workflow, event)).length;

// ---- 1. the model itself, against rules that GitHub documents -----------------------------------------------------------------------
{
  assert.equal(matchesFilter(['*.md'], 'README.md'), true);
  assert.equal(matchesFilter(['*.md'], 'docs/a.md'), false, '"*" does not cross a slash');
  assert.equal(matchesFilter(['docs/**'], 'docs/a/b.md'), true);
  assert.equal(matchesFilter(['**/*.md', '!docs/**'], 'docs/a.md'), false, 'a later "!" pattern excludes again');
  assert.equal(matchesFilter(['**/*.md', '!docs/**'], 'src/a.md'), true);
  assert.equal(matchesFilter(['feat/**'], 'feat/x/y'), true);
  assert.throws(() => matchesFilter(['feat/+'], 'feat/x'), /does not implement/, 'an unsupported pattern is an error, not a guess');
  const demo = parseWorkflow("on:\n  push:\n    branches: [main]\n    paths-ignore:\n      - '*.md'\n  pull_request:\n");
  assert.equal(triggers(demo, { name: 'push', branch: 'main', files: ['README.md'] }), false, 'paths-ignore: only ignored files => no run');
  assert.equal(triggers(demo, { name: 'push', branch: 'main', files: ['README.md', 'a.js'] }), true, 'paths-ignore: one other file => run');
  assert.equal(triggers(demo, { name: 'pull_request', action: 'opened', base: 'main', files: ['a.js'] }), true);
  assert.equal(triggers(demo, { name: 'pull_request', action: 'closed', base: 'main', files: ['a.js'] }), false, 'default activity types');
  assert.equal(triggers(demo, { name: 'push', tag: 'v1', files: [] }), false, 'a tag does not match a branches-only filter');
  ok('the trigger model follows the documented filter rules (globs, negation, paths-ignore, default types, tags) and refuses patterns it does not implement');
}

// ---- 2. the defect, replayed on the v3.9.0 header --------------------------------------------------------------------------------------
{
  for (const branch of ['feat/p0-claims', 'fix/ci', 'dev/x', 'refactor/y']) {
    assert.equal(runs(OLD_CI, prEvents(branch, CODE)), 2, `v3.9.0 ci.yml starts twice for a push to ${branch}`);
  }
  assert.equal(runs(OLD_CI, prEvents('p0/integration', CODE)), 1, 'a branch name outside the globs got one run (pull_request only)');
  assert.equal(runs(OLD_CI, [{ name: 'push', branch: 'feat/x', files: CODE }]), 1, 'and one for a push without a pull request');
  ok('negative control: replaying the v3.9.0 trigger block shows two runs per push to feat/**, fix/**, dev/** and refactor/**');
}

// ---- 3. every workflow: one commit pushed to a pull request branch starts it at most once ---------------------------------------------
{
  const BRANCHES = ['feat/p0-claims', 'fix/ci', 'dev/x', 'refactor/y', 'p0/integration', 'pddczpl/loving-sutherland', 'fix/native-workspace-picker-chatgpt-web-mode', 'fix/publish-browser-companion-archive', 'feat/phase1-complete-autonomous-coding'];
  const problems = [];
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const branch of BRANCHES) {
      for (const [label, changed] of [['code', CODE], ['docs', DOCS], ['mixed', [...CODE, ...DOCS]]]) {
        const count = runs(workflow, prEvents(branch, changed));
        if (count > 1) problems.push(`${name}: ${count} runs for one ${label} push to ${branch}`);
      }
    }
    const branches = workflow.on.push?.branches;
    if (branches !== undefined && !(branches.length === 1 && branches[0] === 'main')) problems.push(`${name}: on.push.branches is ${JSON.stringify(branches)}, it may only be [main]`);
  }
  assert.deepEqual(problems, [], `duplicate triggers:\n  - ${problems.join('\n  - ')}`);
  ok(`${files.length} workflows: one push of one commit to a pull request branch starts each of them at most once; push is limited to main`);
}

// ---- 4. ci.yml and docs-gates.yml, change by change ---------------------------------------------------------------------------------
{
  const ci = workflows['ci.yml'];
  const gates = workflows['docs-gates.yml'];
  assert.ok(ci && gates, 'ci.yml and docs-gates.yml must exist');
  const both = (events) => [runs(ci, events), runs(gates, events)];
  assert.deepEqual(both(prEvents('feat/p0-claims', CODE)), [1, 0], 'code change on a PR branch: ci once, docs-gates never');
  assert.deepEqual(both(prEvents('feat/p0-claims', DOCS)), [0, 1], 'docs-only change on a PR branch: ci skipped, docs-gates once');
  assert.deepEqual(both(prEvents('feat/p0-claims', [...CODE, ...DOCS])), [1, 1], 'mixed change: each once');
  assert.deepEqual(both([{ name: 'push', branch: 'main', files: CODE }]), [1, 0], 'merge to main with code');
  assert.deepEqual(both([{ name: 'push', branch: 'main', files: DOCS }]), [0, 1], 'merge to main, docs only');
  assert.deepEqual(both([{ name: 'push', branch: 'feat/no-pr-yet', files: CODE }]), [0, 0], 'a branch without a pull request is not built (workflow_dispatch below)');
  assert.deepEqual(both([{ name: 'workflow_dispatch' }]), [1, 1], 'a manual start runs both');
  assert.deepEqual(both([{ name: 'push', tag: 'v3.9.1', files: [] }]), [0, 0], 'a tag starts neither');
  for (const file of ['DATGOLD-HUB/tests/requirements-e2e.txt', 'DATGOLD-HUB/README.md', 'scripts/InstallerPayload.ps1', '.github/workflows/ci.yml', 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', 'DATGOLD-HUB/web/dist/index.html']) {
    assert.equal(runs(ci, prEvents('feat/x', [file])), 1, `${file} is not documentation: ci.yml runs`);
  }
  for (const file of ['README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'RELEASE-NOTES-v3.9.0.md', 'docs/CLAIMS.json', 'docs/claims-ratchet.json', 'docs/agent-handoffs/x.md', 'LICENSE', 'NOTICE']) {
    assert.deepEqual(both(prEvents('feat/x', [file])), [0, 1], `${file} is only read by the documentation gates`);
  }
  // the two lists are one list
  for (const event of ['push', 'pull_request']) {
    assert.deepEqual([...ci.on[event]['paths-ignore']].sort(), [...gates.on[event].paths].sort(), `ci.yml ${event}.paths-ignore must equal docs-gates.yml ${event}.paths`);
  }
  assert.deepEqual([...ci.on.push['paths-ignore']].sort(), [...ci.on.pull_request['paths-ignore']].sort(), 'ci.yml ignores the same paths on push and pull_request');
  ok('ci.yml: code => once; docs-only => skipped while docs-gates.yml runs once; mixed => both; main push, manual start, tag and a branch without a PR behave as documented');
  ok('the paths-ignore list of ci.yml equals the paths list of docs-gates.yml, for push and for pull_request');

  // concurrency: same group for every push of one PR, cancelled; main is never cancelled
  const key = (workflow, event) => concurrencyOf(workflow, event);
  const first = key(ci, { name: 'pull_request', action: 'synchronize', base: 'main', number: 7 });
  const second = key(ci, { name: 'pull_request', action: 'opened', base: 'main', number: 7 });
  const other = key(ci, { name: 'pull_request', action: 'synchronize', base: 'main', number: 8 });
  const main = key(ci, { name: 'push', branch: 'main' });
  assert.equal(first.group, 'ci-7');
  assert.equal(first.group, second.group, 'all runs of one pull request share a group');
  assert.notEqual(first.group, other.group, 'two pull requests do not cancel each other');
  assert.equal(first.cancelInProgress, true, 'a newer push replaces the run of a pull request');
  assert.equal(main.group, 'ci-refs/heads/main');
  assert.equal(main.cancelInProgress, false, 'a run on main is never cancelled by a newer commit');
  assert.equal(key(gates, { name: 'pull_request', action: 'synchronize', base: 'main', number: 7 }).group, 'docs-gates-7');
  ok('concurrency: the group is the pull request number (or the ref on main); only pull request runs are cancelled');
}

// ---- 5. stale triggers are gone --------------------------------------------------------------------------------------------------------
{
  assert.ok(!files.includes('phase1-component-tests.yml'), 'phase1-component-tests.yml (pinned to feat/phase1-complete-autonomous-coding) must stay deleted; its suites run in ci.yml through tests/run-all.mjs');
  for (const name of files) {
    for (const pinned of ['fix/native-workspace-picker-chatgpt-web-mode', 'fix/publish-browser-companion-archive', 'feat/phase1-complete-autonomous-coding']) {
      assert.ok(!source[name].includes(`'${pinned}'`), `${name} still pins the branch ${pinned}`);
    }
  }
  assert.ok(workflows['browser-companion-regression.yml'].on.pull_request.paths.length >= 5 && workflows['browser-companion-regression.yml'].on.push.paths.length >= 5, 'the browser companion regression keeps its path filters');
  ok('phase1-component-tests.yml is gone; no workflow pins a feature branch; the Companion workflows keep their path filters on push and pull_request');
}

// ---- 6. defects put into in-memory copies of the current files must be found --------------------------------------------------------------
{
  const duplicates = (name, text) => {
    const workflow = parseWorkflow(text);
    return ['feat/p0-claims', 'fix/ci'].some((branch) => runs(workflow, prEvents(branch, CODE)) > 1);
  };
  assert.equal(duplicates('ci.yml', source['ci.yml']), false, 'the current ci.yml has no duplicate');
  const mutations = [
    ['feat/** added back to push.branches', 'ci.yml', (text) => text.replace('    branches: [main]\n    paths-ignore:', "    branches: [main, 'feat/**']\n    paths-ignore:"), (text) => duplicates('ci.yml', text)],
    ['push without a branch filter', 'ci.yml', (text) => text.replace('    branches: [main]\n    paths-ignore:', '    paths-ignore:'), (text) => duplicates('ci.yml', text)],
    ['a pinned feature branch in browser-companion-regression.yml', 'browser-companion-regression.yml', (text) => text.replace('branches: [main]', "branches: [main, 'fix/native-workspace-picker-chatgpt-web-mode']").replace(/(on:\n  push:\n    branches: \[[^\]]*\]\n)(    paths:)/, '$1$2'), (text) => {
      const workflow = parseWorkflow(text);
      return runs(workflow, prEvents('fix/native-workspace-picker-chatgpt-web-mode', ['DATGOLD-HUB/lib/manager.mjs'])) > 1;
    }],
    ['docs-gates.yml loses a path', 'docs-gates.yml', (text) => text.replaceAll("      - 'docs/**'\n", ''), (text) => {
      const gates = parseWorkflow(text);
      return runs(gates, prEvents('feat/x', ['docs/CLAIMS.json'])) === 0;
    }],
    ['the concurrency group back to the ref', 'ci.yml', (text) => text.replace('ci-${{ github.event.pull_request.number || github.ref }}', 'ci-${{ github.ref }}'), (text) => {
      const ci = parseWorkflow(text);
      return concurrencyOf(ci, { name: 'pull_request', action: 'synchronize', base: 'main', number: 7 }).group !== 'ci-7';
    }],
    ['main runs cancelled by a newer commit', 'ci.yml', (text) => text.replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true'), (text) => {
      const ci = parseWorkflow(text);
      return concurrencyOf(ci, { name: 'push', branch: 'main' }).cancelInProgress === true;
    }],
    ['docs no longer ignored by ci.yml', 'ci.yml', (text) => text.replaceAll("      - 'docs/**'\n", ''), (text) => {
      const ci = parseWorkflow(text);
      return runs(ci, prEvents('feat/x', ['docs/CLAIMS.json'])) === 1;
    }],
  ];
  for (const [label, name, change, detect] of mutations) {
    const before = source[name];
    const after = change(before);
    assert.notEqual(after, before, `the mutation "${label}" changed nothing`);
    assert.equal(detect(after), true, `the defect "${label}" was not detected`);
  }
  ok(`${mutations.length} defects put into in-memory copies of the workflows (an old glob back, no branch filter, a pinned branch, a lost docs path, the old concurrency group, cancelled main runs, docs no longer ignored) are each detected`);
}

// ---- 7. one release workflow, started by hand only, a dry run unless the owner unticks it ---------------------------------------------------
// Up to v3.11.2 every release had its own publish-vX.Y.Z.yml (24 files: 18 started on every push to main, 6 on every completion of CI on
// main) that ended "skipped" unless the commit message began with "release: ChatMCP vX.Y.Z". release.yml replaces them (docs/RELEASING.md); scripts/Resolve-ReleaseInputs.ps1
// derives every value, so the file names no version at all.
const releaseRules = (text) => {
  const problems = [];
  const workflow = parseWorkflow(text);
  const events = Object.keys(workflow.on);
  if (events.length !== 1 || events[0] !== 'workflow_dispatch') problems.push(`release.yml starts on ${JSON.stringify(events)}, it may start on workflow_dispatch only`);
  for (const event of [
    { name: 'push', branch: 'main', files: ['DATGOLD-HUB/package.json'] },
    { name: 'push', tag: 'v3.12.0', files: [] },
    { name: 'pull_request', action: 'synchronize', base: 'main', head: 'feat/x', files: ['.github/workflows/release.yml'] },
  ]) if (triggers(workflow, event)) problems.push(`release.yml is started by ${event.name}`);
  const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
  if (inputs.dry_run?.type !== 'boolean' || inputs.dry_run?.default !== true) problems.push('release.yml: the input dry_run must be a boolean that defaults to true');
  if (inputs.prerelease?.type !== 'boolean' || inputs.prerelease?.default !== false) problems.push('release.yml: the input prerelease must be a boolean that defaults to false');
  if (inputs.version?.default !== '') problems.push('release.yml: the input version must default to empty (the version of DATGOLD-HUB/package.json)');
  if (!/^name: Publish /m.test(text)) problems.push('release.yml: the name must start with "Publish" (InstallerPayload.ps1 and the updater e2e tools refuse test keys in a workflow named Publish*)');
  const publish = /^ {2}publish:\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  if (!/^ {4}if: \$\{\{ inputs\.dry_run == false \}\}$/m.test(publish)) problems.push('release.yml: the publish job must run only when dry_run is false');
  if (!/^ {4}needs: \[resolve, verify\]$/m.test(publish)) problems.push('release.yml: the publish job must wait for the verify job');
  const writers = [...text.matchAll(/^ +contents: write$/gm)].length;
  if (writers !== 1 || !/^ {6}contents: write$/m.test(publish)) problems.push(`release.yml: only the publish job may write (found ${writers} "contents: write")`);
  if (/gh release create|git push|git tag /.test(text.replace(publish, ''))) problems.push('release.yml: a tag or a release is made outside the publish job');
  const code = text.replace(/^\s*#.*$/gm, ''); // full-line comments may tell the history
  if (/head_commit\.message|release: ChatMCP/.test(code)) problems.push('release.yml still reads a release commit message');
  const versions = code.match(/\bv?\d+\.\d+\.\d+\b/g);
  if (versions) problems.push(`release.yml hard-codes the versions ${[...new Set(versions)].join(', ')}; scripts/Resolve-ReleaseInputs.ps1 derives them`);
  for (const [label, pattern] of [
    ['the exact-commit CI gate', /actions\/workflows\/ci\.yml\/runs\?head_sha=\$GITHUB_SHA/],
    ['the "main moved" guard', /git ls-remote origin refs\/heads\/main \| cut -f1\)" = "\$GITHUB_SHA"/],
    ['the guard that never moves a tag', /test "\$\(git rev-list -n1 "\$TAG"\)" = "\$GITHUB_SHA"/],
    ['a draft first', /gh release create [^\n]*--draft/],
    ['the resolver', /scripts\/Resolve-ReleaseInputs\.ps1/],
    ['the asset check before publication', /scripts\/verify-release-assets\.py/],
  ]) if (!pattern.test(publish + text)) problems.push(`release.yml lost ${label}`);
  return problems;
};
{
  assert.deepEqual(files.filter((name) => /^publish-v/.test(name)), [], 'the publish-vX.Y.Z.yml files are gone: release.yml is the one release workflow');
  const releasing = files.filter((name) => /gh release (create|edit|upload)|git push origin "?refs\/tags/.test(source[name]));
  assert.deepEqual(releasing, ['release.yml'], 'exactly one workflow creates tags or releases');
  assert.deepEqual(releaseRules(source['release.yml']), []);
  ok('one release workflow: release.yml starts on workflow_dispatch only, dry_run defaults to true, only its publish job writes and runs only when dry_run is false; no publish-v*.yml is left');
  const text = source['release.yml'];
  const mutations = [
    ['a push trigger added back', (t) => t.replace('on:\n  workflow_dispatch:\n', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n')],
    ['dry_run defaulting to false', (t) => t.replace(/(dry_run:\n(?: {8}.*\n)*? {8}default: )true/, '$1false')],
    ['dry_run as a string', (t) => t.replace(/(dry_run:\n(?: {8}.*\n)*? {8}type: )boolean/, '$1string')],
    ['the publish job without its condition', (t) => t.replace('    if: ${{ inputs.dry_run == false }}\n', '')],
    ['a hard-coded version', (t) => t.replace('TAG: ${{ needs.resolve.outputs.tag }}', 'TAG: v3.12.0')],
    ['the release commit message back', (t) => t.replace('  resolve:\n', "  resolve:\n    if: startsWith(github.event.head_commit.message, 'release: ChatMCP')\n")],
    ['the verify job writing', (t) => t.replace('    permissions:\n      contents: read\n      actions: read\n', '    permissions:\n      contents: write\n      actions: read\n')],
    ['the main-moved guard dropped', (t) => t.replace(/ +test "\$\(git ls-remote origin refs\/heads\/main[^\n]*\n/, '')],
    ['a name that no longer starts with Publish', (t) => t.replace('name: Publish DatGold release', 'name: DatGold release')],
  ];
  for (const [label, change] of mutations) {
    const after = change(text);
    assert.notEqual(after, text, `the mutation "${label}" changed nothing`);
    assert.notDeepEqual(releaseRules(after), [], `the defect "${label}" was not detected`);
  }
  ok(`${mutations.length} defects put into an in-memory copy of release.yml (push trigger, dry_run false or a string, no condition on publish, a version, the commit message, a second writer, no main-moved guard, another name) are each detected`);
}

// ---------------------------------------------------------------------------------------------------------------- model-catalog.yml: a weekly job that may write a branch, and nothing more
// It holds a token that can push and open a pull request, so it must never be started by what a pull request carries, and what it uses must be pinned. It rebuilds the snapshot of models.dev
// that new installs start from; a person merges what it offers.
{
  const name = 'model-catalog.yml';
  assert.ok(files.includes(name), `${name} exists`);
  const text = source[name];
  const workflow = workflows[name];
  for (const event of [
    { name: 'push', branch: 'main', files: ['DATGOLD-HUB/lib/model-catalog.data.json'] },
    { name: 'push', branch: 'feat/x', files: ['DATGOLD-HUB/lib/model-catalog.data.json'] },
    { name: 'pull_request', action: 'synchronize', base: 'main', head: 'feat/x', files: ['.github/workflows/model-catalog.yml'] },
    { name: 'pull_request', action: 'opened', base: 'main', head: 'feat/x', files: [] },
  ]) assert.equal(triggers(workflow, event), false, `${name} is not started by ${event.name}${event.action ? ` (${event.action})` : ''}`);
  assert.equal(triggers(workflow, { name: 'workflow_dispatch' }), true, `${name} can be started by hand`);
  assert.match(text, /^on:\n  schedule:\n    - cron: '\d+ \d+ \* \* \d'[^\n]*\n  workflow_dispatch:\n/m, `${name} runs once a week, on one day`);
  assert.match(text, /^permissions:\n  contents: read\n/m, `${name} reads by default`);
  const writes = [...text.matchAll(/^ {6}(contents|pull-requests|issues|actions|checks|packages|id-token|statuses): (read|write)$/gm)].map((match) => `${match[1]}: ${match[2]}`);
  assert.deepEqual(writes, ['contents: write', 'pull-requests: write'], `${name}: the one job may write a branch and a pull request, nothing else`);
  const uses = text.match(/^\s*- uses: \S+/gm) ?? [];
  assert.ok(uses.length >= 2, `${name} uses actions`);
  for (const use of uses) assert.match(use.trim(), /^- uses: actions\/[a-z-]+@[0-9a-f]{40}$/, `${name}: ${use.trim()} is an official action pinned to a commit`);
  assert.match(text, /gh pr create --draft /, `${name} offers a draft`);
  assert.doesNotMatch(text, /gh pr merge|--auto\b|--admin|enable-auto-merge|pull_request_target/, `${name} never merges, and never runs on a pull request's code`);
  assert.match(text, /old\.sha256 !== now\.sha256/, `${name} compares the hash of the content: the date alone is not a change`);
  ok(`${name}: schedule and hand only, one job that may write a branch and a draft pull request, official actions pinned to a commit, the hash of the content decides, no merge`);
}

// ---- 8. the Hub suites run in shards: every suite on every OS and Node version, each job within 30 minutes -----------------------------------
// The Windows jobs of hub-tests reached 30 minutes with about 218 suites, and two shards 27 with 240 (docs/CI-HEALTH.md, "Three shards"). The matrix has
// a shard axis and each job runs `tests/run-all.mjs --shard <i>/<n>`; verify-test-runner proves that the n shards of a list are the whole list.
// What is checked here is that the workflow uses that correctly: at least three shards, n in the command equals their number, every OS x Node
// cell runs every shard, each job uploads under a name of its own (two jobs uploading the same name fail the second upload), and the flaky gate
// downloads all of them and knows how many to expect.
const MIN_SHARDS = 3;
export function hubTestsProblems(text) {
  const problems = [];
  const block = (header) => {
    const start = text.indexOf(`\n  ${header}:\n`);
    if (start < 0) return null;
    const rest = text.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return end < 0 ? rest : rest.slice(0, end + 1);
  };
  const job = block('hub-tests');
  const gate = block('flaky-gate');
  if (!job || !gate) return ['the hub-tests or the flaky-gate job is missing'];
  const list = (key) => {
    const match = job.match(new RegExp(`^ {8}${key}: \\[([^\\]]*)\\]$`, 'm'));
    return match ? match[1].split(',').map((item) => item.trim().replace(/^'(.*)'$/, '$1')).filter(Boolean) : null;
  };
  const [os, node, shard] = [list('os'), list('node'), list('shard')];
  if (!os || !['ubuntu-latest', 'windows-latest'].every((name) => os.includes(name))) problems.push(`hub-tests: the os axis is ${JSON.stringify(os)}; it must keep ubuntu-latest and windows-latest`);
  if (!node || !['22', '24'].every((version) => node.includes(version))) problems.push(`hub-tests: the node axis is ${JSON.stringify(node)}; it must keep Node 22 and 24`);
  const count = shard?.length ?? 0;
  if (count < MIN_SHARDS) problems.push(`hub-tests: ${count} shards; with fewer than ${MIN_SHARDS} a Windows job nears its 30 minutes (docs/CI-HEALTH.md, "Three shards")`);
  if (!shard || shard.join(',') !== Array.from({ length: count }, (_, i) => String(i + 1)).join(',')) problems.push(`hub-tests: the shard axis is ${JSON.stringify(shard)}; it must be [1, 2, ...] up to the number of shards`);
  if (/^ {6,}(include|exclude):/m.test(job)) problems.push('hub-tests: an include or exclude in the matrix could drop a shard of one OS or Node version');
  if (!/^ {6}fail-fast: false$/m.test(job)) problems.push('hub-tests: fail-fast must stay false (a red shard must not cancel the others)');
  const name = job.match(/^ {4}name: Hub tests \(\$\{\{ matrix\.os \}\}, Node \$\{\{ matrix\.node \}\}, \$\{\{ matrix\.shard \}\}\/(\d+)\)$/m);
  if (!name || Number(name[1]) !== count) problems.push(`hub-tests: the job name must be "Hub tests (\${{ matrix.os }}, Node \${{ matrix.node }}, \${{ matrix.shard }}/${count})"`);
  const runs = [...job.matchAll(/^ +run: node tests\/run-all\.mjs ([^\n]*)$/gm)].map((match) => match[1]);
  if (runs.length !== 1) problems.push(`hub-tests: expected one run of tests/run-all.mjs, found ${runs.length}`);
  else {
    const command = runs[0];
    const shardArgument = command.match(/(?:^| )--shard \$\{\{ matrix\.shard \}\}\/(\d+)(?= |$)/);
    if (!shardArgument || Number(shardArgument[1]) !== count) problems.push(`hub-tests: run-all must get --shard \${{ matrix.shard }}/${count}, it got: ${command}`);
    if (!command.startsWith('--no-skip all ')) problems.push('hub-tests: run-all must start with --no-skip all (verify-release-workflow compares the installs before that command)');
    if (!/(?:^| )--retry-failed-once(?= |$)/.test(command)) problems.push('hub-tests: run-all must keep --retry-failed-once');
    if (/(?:^| )--filter(?= |$)/.test(command)) problems.push('hub-tests: a --filter would leave suites out of every shard');
  }
  if (!/^ {4}timeout-minutes: 30$/m.test(job)) problems.push('hub-tests: timeout-minutes must be 30 (split further instead of raising it: docs/CI-HEALTH.md)');
  const artifacts = [...job.matchAll(/uses: actions\/upload-artifact@\S+[^\n]*\n {8}with:\n {10}name: ([^\n]+)/g)].map((match) => match[1].trim());
  if (artifacts.length === 0) problems.push('hub-tests: no artifact upload was found');
  for (const artifact of artifacts) {
    for (const part of ['${{ matrix.os }}', '${{ matrix.node }}', '${{ matrix.shard }}']) if (!artifact.includes(part)) problems.push(`hub-tests: the artifact name ${artifact} lacks ${part}, so two jobs would upload the same name`);
  }
  if (!artifacts.some((artifact) => artifact.startsWith('hub-test-summary-'))) problems.push('hub-tests: the summary artifact must be named hub-test-summary-* (the flaky gate downloads that pattern)');
  if (!gate.includes("--pattern 'hub-test-summary-*'")) problems.push("flaky-gate: it must download --pattern 'hub-test-summary-*'");
  const expected = gate.match(/scripts\/ci-flaky-gate\.mjs [^\n]*--expect-summaries (\d+)(?= |$)/m);
  const jobs = (os?.length ?? 0) * (node?.length ?? 0) * count;
  if (!expected || Number(expected[1]) !== jobs) problems.push(`flaky-gate: ci-flaky-gate.mjs must get --expect-summaries ${jobs} (${os?.length} OS x ${node?.length} Node x ${count} shards)`);
  return problems;
}
{
  const text = source['ci.yml'];
  assert.deepEqual(hubTestsProblems(text), []);
  const count = Number(text.match(/ --shard \$\{\{ matrix\.shard \}\}\/(\d+)/)[1]);
  const axis = (n) => `        shard: [${Array.from({ length: n }, (_, i) => i + 1).join(', ')}]`;
  const argument = (n) => `--shard \${{ matrix.shard }}/${n}`;
  ok(`hub-tests: ${count} shards (at least ${MIN_SHARDS}) run on every OS and Node version, run-all gets ${argument(count)}, the job name and every artifact name carry the shard, the limit is 30 minutes, and the flaky gate expects one summary per job`);
  const mutations = [
    ['the shard axis dropped', (t) => t.replace(/\n {8}shard: \[[^\]]*\]/, '')],
    ['one more shard in the matrix only', (t) => t.replace(axis(count), axis(count + 1))],
    ['one shard fewer in the matrix only', (t) => t.replace(axis(count), axis(count - 1))],
    ['run-all told there is one more shard', (t) => t.replace(argument(count), () => argument(count + 1))],
    ['run-all told there is one shard fewer', (t) => t.replace(argument(count), () => argument(count - 1))],
    // Every place agrees on two and every suite still runs once: only the floor sees it.
    ['two shards again, in every place', (t) => t.replace(axis(count), axis(2)).replaceAll(`\${{ matrix.shard }}/${count}`, () => '${{ matrix.shard }}/2').replace(/--expect-summaries \d+/, '--expect-summaries 8')],
    ['run-all without --shard', (t) => t.replace(` ${argument(count)}`, '')],
    ['a shard excluded on Windows', (t) => t.replace(/( {8}shard: \[[^\]]*\]\n)/, '$1        exclude:\n          - os: windows-latest\n            shard: 2\n')],
    ['the summary artifact without the shard', (t) => t.replace(/(name: hub-test-summary-\$\{\{ matrix\.os \}\}-node\$\{\{ matrix\.node \}\})-shard\$\{\{ matrix\.shard \}\}/, '$1')],
    ['the summary artifact renamed away from the gate pattern', (t) => t.replace('name: hub-test-summary-', 'name: hub-summary-')],
    ['the time limit raised again', (t) => t.replace(/(\n {2}hub-tests:\n[\s\S]*? {4}timeout-minutes: )30/, '$145')],
    ['the gate expecting the four summaries of unsplit jobs', (t) => t.replace(/--expect-summaries \d+/, '--expect-summaries 4')],
    ['the gate expecting the eight summaries of two shards', (t) => t.replace(/--expect-summaries \d+/, '--expect-summaries 8')],
    ['the job name without the shard', (t) => t.replace(/(name: Hub tests \(\$\{\{ matrix\.os \}\}, Node \$\{\{ matrix\.node \}\}), \$\{\{ matrix\.shard \}\}\/\d+\)/, '$1)')],
    ['the job name with the number of shards of before', (t) => t.replace(/(name: Hub tests \([^\n]*\$\{\{ matrix\.shard \}\}\/)\d+\)/, '$12)')],
    ['a filter in the shard run', (t) => t.replace(argument(count), () => `${argument(count)} --filter e2e`)],
  ];
  for (const [label, change] of mutations) {
    const after = change(text);
    assert.notEqual(after, text, `the mutation "${label}" changed nothing`);
    assert.notDeepEqual(hubTestsProblems(after), [], `the defect "${label}" was not detected`);
  }
  ok(`${mutations.length} defects put into an in-memory copy of ci.yml (no shard axis, a matrix or a command that disagrees on the number of shards, two shards again in every place, no --shard, an excluded shard, an artifact name without the shard or outside the gate pattern, 45 minutes, an old expected count, a name without the shard or with the old number, a filter) are each detected`);
}

console.log(`PASS: ${checks} CI trigger checks over ${files.length} workflows (modelled GitHub rules; GitHub itself confirms on the first pull requests)`);
