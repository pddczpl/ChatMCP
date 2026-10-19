// The DCO check (scripts/check-dco.mjs, run by .github/workflows/dco.yml on every pull request) against real temporary Git repositories.
//
// The check must fail a commit without a Signed-off-by trailer, accept what `git commit -s` writes, leave merge commits and the known
// automation identities alone, and must not be fooled by a sign-off that is not in the trailer block or is not "Name <email>".
// The workflow file is checked for the properties the script cannot enforce itself: a full-history checkout, SHA-pinned actions,
// least privilege, and the two revisions passed through env rather than interpolated into the shell.
//
// Needs the repository root next to CHATMCP-HUB (scripts/, .github/); without it the suite reports SKIP, never PASS.
// CLAIM: dco-signoff
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-dco.mjs');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'dco.yml');

if (!existsSync(SCRIPT) || !existsSync(WORKFLOW)) {
  console.log('CHATMCP_TEST_SKIP: scripts/check-dco.mjs and .github/workflows/dco.yml were not found next to CHATMCP-HUB (the DCO check needs the whole repository)');
  process.exit(0);
}

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

// A throwaway repository that ignores the developer's own Git configuration (signing, hooks, templates, identity).
const root = mkdtempSync(path.join(os.tmpdir(), 'chatmcp-dco-'));
const hooks = mkdtempSync(path.join(os.tmpdir(), 'chatmcp-dco-hooks-'));
// An empty file, not os.devNull: Windows Git cannot open \\.\nul as a configuration file.
const emptyConfig = path.join(hooks, 'empty-gitconfig');
writeFileSync(emptyConfig, '');
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0' };
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) delete gitEnv[key];

function git(args, { author = ['Ada Lovelace', 'ada@example.invalid'], input } = {}) {
  const result = spawnSync('git', ['-c', 'user.name=Committer', '-c', 'user.email=committer@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'merge.ff=false',
    '-c', `core.hooksPath=${hooks}`, '-c', 'init.defaultBranch=main', ...args], {
    cwd: root, encoding: 'utf8', input,
    env: { ...gitEnv, GIT_AUTHOR_NAME: author[0], GIT_AUTHOR_EMAIL: author[1], GIT_COMMITTER_NAME: 'Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}

let counter = 0;
/** Commits a new file with exactly this message (stdin, so no shell quoting) and returns the new HEAD. */
function commit(message, options = {}) {
  counter += 1;
  writeFileSync(path.join(root, `file-${counter}.txt`), `content ${counter}\n`);
  git(['add', '-A']);
  git(['commit', '-q', '-F', '-', ...(options.signoff ? ['--signoff'] : [])], { author: options.author, input: message });
  return git(['rev-parse', 'HEAD']);
}

function check(base, head) {
  const result = spawnSync(process.execPath, [SCRIPT, '--base', base, '--head', head], { cwd: root, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

try {
  git(['init', '-q']);
  const base = commit('chore: base commit that predates the DCO\n');

  // 1. what `git commit -s` writes is accepted
  git(['checkout', '-q', '-b', 'signed']);
  const signed = commit('feat: signed with git commit -s\n', { signoff: true });
  let result = check(base, signed);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1 commit\(s\).*1 signed off, 0 exempt.*0 without/);
  ok('a commit made with `git commit -s` passes');

  // 2. an unsigned commit fails and is named
  git(['checkout', '-q', '-b', 'unsigned', base]);
  const unsigned = commit('fix: forgot the sign-off\n');
  result = check(base, unsigned);
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(`FAIL ${unsigned.slice(0, 12)} fix: forgot the sign-off - no Signed-off-by trailer`), result.output);
  assert.match(result.output, /git commit --amend --signoff/);
  ok('an unsigned commit fails the check and is reported by short SHA and subject');

  // 3. one unsigned commit among signed ones fails, and only that one is named
  git(['checkout', '-q', '-b', 'mixed', base]);
  const first = commit('feat: first, signed\n', { signoff: true });
  const middle = commit('feat: second, not signed\n');
  const last = commit('feat: third, signed\n', { signoff: true });
  result = check(base, last);
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(middle.slice(0, 12)) && !result.output.includes(`FAIL ${first.slice(0, 12)}`) && !result.output.includes(`FAIL ${last.slice(0, 12)}`), result.output);
  assert.match(result.output, /3 commit\(s\).*2 signed off, 0 exempt.*1 without/);
  ok('only the unsigned commit of a three-commit range is reported');

  // 4. merge commits are exempt, and commits that are already on the base side are not examined
  git(['checkout', '-q', 'main']);
  git(['checkout', '-q', '-B', 'topic', base]);
  commit('feat: topic work, signed\n', { signoff: true });
  git(['checkout', '-q', 'main']);
  const baseAdvanced = commit('chore: unsigned work that landed on the base branch meanwhile\n');
  git(['checkout', '-q', 'topic']);
  git(['merge', '-q', '--no-ff', '-m', 'Merge branch main into topic', 'main']);
  const merged = git(['rev-parse', 'HEAD']);
  assert.equal(git(['rev-list', '--parents', '-n', '1', merged]).split(' ').length, 3, 'the fixture must contain a real two-parent merge');
  result = check(baseAdvanced, merged);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1 commit\(s\)/);
  ok('a merge commit without a sign-off is exempt and commits reachable from the base are not examined');

  // 5. known automation authors are exempt, look-alikes are not
  git(['checkout', '-q', '-b', 'bots', base]);
  const bots = [
    ['dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'],
    ['github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com'],
    ['semantic-release-bot', 'semantic-release-bot@martynus.net'],
  ];
  let botHead = base;
  for (const author of bots) botHead = commit(`chore: automated change by ${author[0]}\n`, { author });
  result = check(base, botHead);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /3 commit\(s\).*0 signed off, 3 exempt.*0 without/);
  ok('unsigned commits by dependabot[bot], github-actions[bot] and semantic-release-bot are exempt');

  git(['checkout', '-q', '-b', 'lookalike', base]);
  const lookalike = commit('chore: pretends to be a bot\n', { author: ['totally-a-bot[bot]', 'bot@example.invalid'] });
  result = check(base, lookalike);
  assert.equal(result.status, 1, result.output);
  const impostor = commit('chore: pretends to be dependabot\n', { author: ['dependabot', 'dependabot@example.invalid'] });
  result = check(base, impostor);
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(lookalike.slice(0, 12)) && result.output.includes(impostor.slice(0, 12)), result.output);
  ok('an arbitrary "[bot]" name or a look-alike of a known bot is not exempt');

  // 6. malformed sign-offs fail
  const malformed = [
    ['Signed-off-by: Ada Lovelace', 'no address'],
    ['Signed-off-by: <ada@example.invalid>', 'no name'],
    ['Signed-off-by: Ada Lovelace <not an address>', 'bad address'],
    ['Signed-off-by:', 'empty value'],
  ];
  for (const [trailer, label] of malformed) {
    git(['checkout', '-q', '-B', 'malformed', base]);
    const head = commit(`feat: malformed trailer (${label})\n\n${trailer}\n`);
    result = check(base, head);
    assert.equal(result.status, 1, `${label}: ${result.output}`);
    assert.ok(result.output.includes(head.slice(0, 12)), `${label}: ${result.output}`);
  }
  ok(`${malformed.length} malformed Signed-off-by lines (no address, no name, bad address, empty) fail`);

  // 7. a sign-off line inside the body is not a trailer
  git(['checkout', '-q', '-B', 'body', base]);
  const body = commit('feat: sign-off in the middle of the body\n\nSigned-off-by: Ada Lovelace <ada@example.invalid>\n\nThis paragraph comes after it, so the line above is not a trailer.\n');
  result = check(base, body);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /no Signed-off-by trailer/);
  ok('a Signed-off-by line that is not in the final trailer block does not count');

  // 8. a hand-written trailer block counts, case-insensitively, next to other trailers
  git(['checkout', '-q', '-B', 'trailers', base]);
  const trailers = commit('feat: agent assisted\n\nSome explanation.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nsigned-off-by: Ada Lovelace <ada@example.invalid>\n');
  result = check(base, trailers);
  assert.equal(result.status, 0, result.output);
  ok('a sign-off next to a Co-Authored-By trailer is accepted (AI-assisted commits keep both)');

  // 9. an empty range passes, an unknown revision is a usage error, a missing option too
  result = check(base, base);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /0 commit\(s\)/);
  result = check('0000000000000000000000000000000000000000', base);
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /could not run/);
  const bare = spawnSync(process.execPath, [SCRIPT, '--base', base], { cwd: root, encoding: 'utf8' });
  assert.equal(bare.status, 2);
  ok('an empty range passes; an unknown revision or a missing --head is a usage error (exit 2), not a pass');

  // 10. commit text cannot inject a workflow command or control characters into the log
  git(['checkout', '-q', '-B', 'inject', base]);
  const injected = commit('::error::forged\u001b[31m annotation\n');
  result = check(base, injected);
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.split('\n').every((line) => !line.startsWith('::') && !line.includes('\u001b')), result.output);
  ok('a hostile commit subject is printed on a "FAIL" line without control characters');

  // 11. separator characters inside the subject cannot smuggle a sign-off into the parsed fields
  const smuggled = commit('feat: fake\u001f\u001eSigned-off-by: Mallory <mallory@example.invalid>\u001f\n');
  result = check(base, smuggled);
  assert.equal(result.status, 1, result.output);
  ok('unit-separator characters in a subject cannot fake a Signed-off-by value');
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(hooks, { recursive: true, force: true });
}

{
  const text = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
  assert.match(text, /^on:\n  pull_request:/m, 'the workflow must run on pull_request');
  assert.ok(!/pull_request_target/.test(text), 'pull_request_target would run with write access on fork code');
  assert.match(text, /^permissions:\n  contents: read\n/m, 'the workflow must have read-only permissions');
  assert.match(text, /fetch-depth: 0/, 'the check needs the full history between base and head');
  assert.match(text, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(text, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(text, /run: node scripts\/check-dco\.mjs --base "\$BASE_SHA" --head "\$HEAD_SHA"/, 'the workflow must run the tested script with the SHAs taken from env');
  const runLines = text.split('\n').filter((line) => /^\s*run:/.test(line));
  assert.ok(runLines.every((line) => !line.includes('${{')), 'no expression may be interpolated into a run: line');
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 1 && uses.every((action) => /^actions\/[a-z-]+@[0-9a-f]{40}$/.test(action)), `only first-party actions pinned to a full commit SHA are allowed: ${uses.join(', ')}`);
  ok(`dco.yml: pull_request trigger, read-only token, full-history checkout, SHAs via env, ${uses.length} SHA-pinned first-party actions`);
}

console.log(`PASS: ${checks} DCO check scenarios (signed, unsigned, mixed, merge, bots, malformed, body-only, trailers, empty range, injection) and the workflow wiring`);
