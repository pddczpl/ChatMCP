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
  console.log('CHATMCP_TEST_SKIP: .github/workflows was not found next to CHATMCP-HUB (the trigger check needs the whole repository)');
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

const CODE = ['CHATMCP-HUB/lib/agent.mjs', 'CHATMCP-HUB/tests/verify-docs.mjs'];
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
  for (const file of ['CHATMCP-HUB/tests/requirements-e2e.txt', 'CHATMCP-HUB/README.md', 'scripts/InstallerPayload.ps1', '.github/workflows/ci.yml', 'CHATMCP-HUB/THIRD-PARTY-NOTICES.txt', 'CHATMCP-HUB/web/dist/index.html']) {
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
      return runs(workflow, prEvents('fix/native-workspace-picker-chatgpt-web-mode', ['CHATMCP-HUB/lib/manager.mjs'])) > 1;
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

console.log(`PASS: ${checks} CI trigger checks over ${files.length} workflows (modelled GitHub rules; GitHub itself confirms on the first pull requests)`);
