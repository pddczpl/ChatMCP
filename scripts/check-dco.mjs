#!/usr/bin/env node
// Developer Certificate of Origin check, shared by .github/workflows/dco.yml and DATGOLD-HUB/tests/verify-dco-check.mjs.
//
// Every commit in <base>..<head> must carry a Signed-off-by trailer ("Name <email>", what `git commit -s` writes), except
//   - merge commits (more than one parent), and
//   - commits whose AUTHOR is one of the known automation identities in BOT_IDENTITIES (exact match, never a blanket "[bot]").
//
// Trailers are read with git's own trailer parser (%(trailers:...)), so a "Signed-off-by:" line in the middle of the message body
// does not count. The check needs the full history between base and head (actions/checkout with fetch-depth: 0).
// The bot exemption trusts the author name/email in the commit, which anyone can write: this is an attestation check, not an
// authentication check, and a spoofed bot identity is visible to the reviewer.
//
// Usage: node scripts/check-dco.mjs --base <rev> --head <rev>     (run inside the repository to check)
// Exit:  0 every commit is signed off or exempt, 1 at least one commit is not, 2 usage or git error.

import { spawnSync } from 'node:child_process';

const BOT_IDENTITIES = {
  names: ['github-actions[bot]', 'dependabot[bot]', 'semantic-release-bot', 'semantic-release[bot]'],
  emails: [
    '41898282+github-actions[bot]@users.noreply.github.com',
    'github-actions[bot]@users.noreply.github.com',
    '49699333+dependabot[bot]@users.noreply.github.com',
    'dependabot[bot]@users.noreply.github.com',
    'semantic-release-bot@martynus.net',
  ],
};

// "Name <local@domain>": a non-empty name, one address in angle brackets, nothing after it.
const SIGNOFF = /^[^<>\r\n]*[^<>\s] <[^<>\s@]+@[^<>\s@]+>$/;

function isBotAuthor(name, email) {
  const lower = (text) => text.trim().toLowerCase();
  return BOT_IDENTITIES.names.some((bot) => lower(bot) === lower(name)) || BOT_IDENTITIES.emails.some((bot) => lower(bot) === lower(email));
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`cannot run git: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

/** Commits of base..head that are subject to the check, with the verdict for each. Throws when git cannot answer. */
function inspect({ cwd = process.cwd(), base, head }) {
  if (!base || !head) throw new Error('both a base and a head revision are required');
  // A shallow clone has no merge base, and base..head would then silently cover far too much (or too little).
  try { git(cwd, ['merge-base', base, head]); } catch (error) {
    throw new Error(`no merge base between ${base} and ${head} (is the checkout shallow? use fetch-depth: 0): ${error.message}`);
  }
  const shas = git(cwd, ['rev-list', '--no-merges', `${base}..${head}`]).split('\n').filter(Boolean);
  return shas.map((sha) => {
    // One call per commit and a purely line-based layout: a name, an e-mail address and a subject can never contain a newline, so
    // hostile commit text cannot shift the fields (a separator character inside a subject could). Everything after the third
    // line is the Signed-off-by trailers, one unfolded value per line.
    const lines = git(cwd, ['show', '-s', '--format=%an%n%ae%n%s%n%(trailers:key=Signed-off-by,valueonly,unfold)', sha]).split('\n');
    const [authorName = '', authorEmail = '', subject = '', ...trailers] = lines;
    const signoffs = trailers.map((line) => line.trim()).filter(Boolean);
    const exempt = isBotAuthor(authorName, authorEmail);
    const valid = signoffs.filter((line) => SIGNOFF.test(line));
    let verdict = 'ok';
    let reason = '';
    if (exempt) verdict = 'exempt';
    else if (signoffs.length === 0) { verdict = 'fail'; reason = 'no Signed-off-by trailer'; }
    else if (valid.length === 0) { verdict = 'fail'; reason = `Signed-off-by is not "Name <email>": ${printable(signoffs[0])}`; }
    return { sha, authorName, authorEmail, subject, verdict, reason };
  });
}

// Commit text is attacker-controlled: keep it on one line and free of control characters before it reaches a log.
function printable(text, limit = 100) {
  const clean = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean;
}

function run(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base' || arg === '--head') options[arg.slice(2)] = argv[++index];
    else { err(`unknown argument: ${arg}`); return 2; }
  }
  if (!options.base || !options.head) {
    err('usage: node scripts/check-dco.mjs --base <rev> --head <rev>');
    return 2;
  }
  let commits;
  try { commits = inspect({ cwd, base: options.base, head: options.head }); } catch (error) {
    err(`DCO check could not run: ${printable(error.message, 500)}`);
    return 2;
  }
  const failed = commits.filter((commit) => commit.verdict === 'fail');
  const exempt = commits.filter((commit) => commit.verdict === 'exempt');
  out(`DCO: ${commits.length} commit(s) in ${options.base}..${options.head}: ${commits.length - failed.length - exempt.length} signed off, ${exempt.length} exempt (bot author), ${failed.length} without a valid sign-off.`);
  if (failed.length === 0) return 0;
  for (const commit of failed) out(`FAIL ${commit.sha.slice(0, 12)} ${printable(commit.subject)} - ${commit.reason}`);
  out('');
  out('Every commit needs a "Signed-off-by: Your Name <you@example.com>" trailer (the Developer Certificate of Origin, see CONTRIBUTING.md).');
  out('  last commit only:   git commit --amend --signoff --no-edit');
  out('  all PR commits:     git rebase --signoff <base-branch>   then   git push --force-with-lease');
  return 1;
}

// A command-line tool, not a library: it always runs. (A "run only when executed directly" guard compares file paths, and a
// drive-letter or case mismatch on Windows would make it exit 0 without checking anything.)
process.exitCode = run(process.argv.slice(2));
