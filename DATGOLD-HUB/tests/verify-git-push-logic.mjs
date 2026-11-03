// The pure part of git_push (lib/git-push.mjs): which names may be pushed, what is shown of a remote's address, how the log, the diffstat and the
// answer of `git push --porcelain` are read, what the scan of the range looks for, and what the approval card is told. No Git, no files, no network:
// the Git side (a real repository with a bare `origin`) is tests/verify-git-push.mjs.
//
// A secret in this file is built at run time, never written as a literal (the push protection of the host would refuse the commit).
import assert from 'node:assert/strict';
import {
  PUSH_LIMITS, isPlainBranchName, isPlainRemoteName, protectedBranchReason, pushArgumentProblems, redactRemoteUrl, redactPushOutput,
  parseCommitList, parseDiffStat, scanPushPatch, parsePushPorcelain, pushApprovalDetail,
} from '../lib/git-push.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const TOKEN = `ghp_${'Ab1Cd2Ef3G'.repeat(4)}`; // the shape of a GitHub personal access token
const SHA = (n) => String(n).padStart(40, '0');

// ------------------------------------------------------------------ the limits
assert.equal(PUSH_LIMITS.commits, 50, 'the approval lists at most 50 commits');
assert.equal(PUSH_LIMITS.timeoutMs, 90_000, 'a push gets 90 seconds');
assert.ok(Object.isFrozen(PUSH_LIMITS));
ok('limits: 50 commits listed, 90 s timeout, frozen');

// ------------------------------------------------------------------ branch names: plain names only
for (const name of ['feature/x', 'fix-123', 'a', 'release_2.0', 'user/dat/feature', 'tính-năng/mới', 'Feature/UPPER', 'v1.2.3-rc1', 'x'.repeat(200)]) {
  assert.equal(isPlainBranchName(name), true, `accepts ${JSON.stringify(name)}`);
}
const NOT_BRANCH = [
  '', ' ', '-f', '--force', '--force-with-lease', '--delete', '--mirror', '--all', '--tags', '-d', '-D', '-u', '+main', '+refs/heads/x:refs/heads/x', 'feature:main', 'HEAD:main', ':main',
  'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u007fb', 'a..b', 'a@{b', '@', 'a\\b', 'a~1', 'a^', 'a?', 'a*', 'a[b', '/a', 'a/', 'a//b', 'a.', '.a', 'a/.b', 'a.lock', 'a/b.lock', 'refs/heads/a', 'refs/tags/v1',
  'HEAD', 'head', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', '*', 'x'.repeat(201), 'a\u202eb',
];
// Characters that are not typed on a keyboard, built from their code points: a no-break space, an em space, a C1 control, a private-use character, an unassigned one, a lone surrogate.
for (const code of [0xa0, 0x2003, 0x2028, 0x85, 0xe000, 0x378, 0xd800]) NOT_BRANCH.push(`a${String.fromCharCode(code)}b`);
for (const name of NOT_BRANCH) assert.equal(isPlainBranchName(name), false, `refuses ${JSON.stringify(name)}`);
for (const value of [undefined, null, 5, true, {}, [], ['a']]) assert.equal(isPlainBranchName(value), false, `refuses a ${typeof value}`);
ok(`branch names: ${NOT_BRANCH.length} forms that are not a plain name are refused (options, +refspec, src:dst, delete, wildcards, full refs, pseudo refs), real names pass`);

// ------------------------------------------------------------------ remote names: a name, never an address
for (const name of ['origin', 'upstream', 'my-fork', 'fork.1', 'a_b', 'O']) assert.equal(isPlainRemoteName(name), true, `accepts ${name}`);
for (const name of ['', '-x', '--mirror', '--all', 'origin main', 'a/b', 'https://example.com/x.git', 'git@github.com:o/r.git', '/tmp/x', 'C:\\x', 'C:/x', '..', '.', 'a:b', 'a@b', '*', 'origin*', 'x'.repeat(65), 'a\nb', 'ori gin']) {
  assert.equal(isPlainRemoteName(name), false, `refuses ${JSON.stringify(name)}`);
}
assert.equal(isPlainRemoteName(undefined), false);
assert.equal(isPlainRemoteName(5), false);
ok('remote names: a configured NAME only; an address, a path, an option or a pattern is refused');

// ------------------------------------------------------------------ the arguments of a call
assert.deepEqual(pushArgumentProblems({}), [], 'no arguments is fine: origin, the current branch');
assert.deepEqual(pushArgumentProblems({ remote: 'origin', branch: 'feature/x', set_upstream: true }), []);
assert.deepEqual(pushArgumentProblems({ set_upstream: false }), []);
{
  const bad = pushArgumentProblems({ remote: '--mirror', branch: '+main' });
  assert.equal(bad.length, 2, 'both fields are reported');
  assert.match(bad.join('\n'), /remote/);
  assert.match(bad.join('\n'), /branch/);
  assert.match(pushArgumentProblems({ branch: '--force' })[0], /--force|branch/);
  assert.match(pushArgumentProblems({ branch: 'feature:main' })[0], /tên nhánh|branch/i);
  assert.match(pushArgumentProblems({ remote: 'https://x.example/r.git' })[0], /remote/);
}
ok('arguments: each bad field is reported by name, good ones are not');

// ------------------------------------------------------------------ which branches are not pushed
for (const name of ['main', 'master', 'Main', 'MASTER']) assert.notEqual(protectedBranchReason(name, null), null, `${name} is refused`);
assert.notEqual(protectedBranchReason('trunk', 'trunk'), null, 'the remote default is refused');
assert.notEqual(protectedBranchReason('Develop', 'develop'), null, 'compared without regard to case: the same file on a case-insensitive disk');
assert.notEqual(protectedBranchReason('develop', 'Develop'), null, 'whichever of the two is written with capitals');
for (const name of ['feature/main', 'main2', 'maintenance', 'mainline', 'my-master', 'develop', 'trunk']) assert.equal(protectedBranchReason(name, null), null, `${name} may be pushed`);
assert.equal(protectedBranchReason('feature/x', 'main'), null);
assert.match(protectedBranchReason('main', null), /pull request/i, 'the message says what to do instead');
assert.match(protectedBranchReason('main', null), /nhánh/i, 'and says it in Vietnamese');
assert.match(protectedBranchReason('trunk', 'trunk'), /trunk/, 'it names the default branch');
ok('protected branches: main, master and the remote default (any case) are refused with the way out; look-alikes pass');

// ------------------------------------------------------------------ what is shown of an address
assert.equal(redactRemoteUrl('https://user:hunter2@github.com/o/r.git'), 'https://[REDACTED]@github.com/o/r.git');
assert.equal(redactRemoteUrl(`https://${TOKEN}@github.com/o/r.git`), 'https://[REDACTED]@github.com/o/r.git', 'a token in the user part');
assert.equal(redactRemoteUrl('https://x-access-token:abc123@github.com/o/r.git'), 'https://[REDACTED]@github.com/o/r.git');
assert.equal(redactRemoteUrl('https://u:p@ss@host.example/x.git'), 'https://[REDACTED]@host.example/x.git', 'a password with an @ in it: the LAST @ ends the user part');
assert.equal(redactRemoteUrl('ssh://git@github.com/o/r.git'), 'ssh://git@github.com/o/r.git', 'the user name of an ssh address is not a secret');
assert.equal(redactRemoteUrl('ssh://deploy:s3cret@host.example/o/r.git'), 'ssh://deploy:[REDACTED]@host.example/o/r.git', 'an ssh password is');
assert.equal(redactRemoteUrl('git@github.com:o/r.git'), 'git@github.com:o/r.git');
for (const plain of ['/srv/git/r.git', 'C:/srv/git/r.git', 'file:///srv/git/r.git', '../r.git', 'https://github.com/o/r.git']) assert.equal(redactRemoteUrl(plain), plain, `${plain} is left alone`);
assert.match(redactRemoteUrl('https://host.example/r.git?access_token=abcdef0123456789'), /\[REDACTED/, 'a token in the query');
assert.ok(!redactRemoteUrl('https://host.example/r.git?access_token=abcdef0123456789').includes('abcdef0123456789'));
assert.equal(redactRemoteUrl(undefined), '');
assert.equal(redactRemoteUrl(null), '');
ok('remote address: the user part of an http(s) address and the password of any address are hidden, plain addresses are not touched');

// ------------------------------------------------------------------ what is shown of the output
{
  const raw = `To https://user:hunter2@github.com/o/r.git\n remote: using ${TOKEN} to authenticate\n * [new branch]      feat -> feat\nerror: failed to push some refs to 'https://x-access-token:abc123@github.com/o/r.git'`;
  const clean = redactPushOutput(raw, ['registered-secret-value']);
  for (const leak of ['hunter2', TOKEN, 'abc123', 'x-access-token']) assert.ok(!clean.includes(leak), `${leak} is gone`);
  assert.match(clean, /\[new branch\]\s+feat -> feat/, 'the rest of the output stays');
  assert.match(clean, /To https:\/\/\[REDACTED\]@github\.com\/o\/r\.git/);
  assert.ok(!redactPushOutput('x registered-secret-value y', ['registered-secret-value']).includes('registered-secret-value'), 'a secret the Hub knows is replaced wherever it is');
  assert.equal(redactPushOutput('', []), '');
  assert.equal(redactPushOutput(undefined, []), '');
  const long = redactPushOutput('x'.repeat(PUSH_LIMITS.outputChars * 3), []);
  assert.ok(long.length < PUSH_LIMITS.outputChars + 200, 'the output is bounded');
  assert.match(long, /đã cắt|cắt/, 'and says it was cut');
}
ok('output: credentials in addresses, token shapes and registered secrets are hidden, ordinary lines stay, the length is bounded');

// ------------------------------------------------------------------ the commit list
{
  const record = (n, subject = `commit ${n}`, author = 'Dev') => [SHA(n), author, `2026-11-0${n}T10:00:00+07:00`, subject].join('\u001f');
  const parsed = parseCommitList([record(1), record(2, 'fix: a | b\ttab'), record(3, 'Sửa lỗi tiếng Việt', 'Phạm Dạ')].join('\0'));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].sha, SHA(1));
  assert.equal(parsed[0].short, SHA(1).slice(0, 7));
  assert.equal(parsed[1].subject, 'fix: a | b\ttab');
  assert.equal(parsed[2].author, 'Phạm Dạ');
  assert.equal(parsed[2].date, '2026-11-03T10:00:00+07:00');
  assert.deepEqual(parseCommitList(''), []);
  assert.deepEqual(parseCommitList(undefined), []);
  assert.equal(parseCommitList(['garbage', record(4), 'a\u001fb'].join('\0')).length, 1, 'a record that is not a commit is skipped');
  assert.equal(parseCommitList(`${record(5, 'x'.repeat(500))}\0`)[0].subject.length <= 200, true, 'a long subject is cut');
  assert.equal(parseCommitList(`${record(5, 'subject', 'a'.repeat(300))}\0`)[0].author.length, 80, 'a long author name is cut');
  assert.deepEqual(parseCommitList(['not-a-hash', 'Dev', '2026-11-03T10:00:00+07:00', 'looks like a record'].join('\u001f')), [], 'four fields but no commit hash: not a commit');
  assert.equal(parseCommitList(`${record(7, 'a\u001fb')}\0`)[0].subject, 'a\u001fb', 'a subject that holds the field separator is kept whole');
  assert.equal(parseCommitList(record(6)).length, 1, 'no trailing separator needed');
  assert.deepEqual(parseCommitList(`${SHA(8)}\u001fDev`), [], 'a commit hash with no date and no subject is not a record');
}
ok('commit list: sha, author, date and subject read from the NUL-separated log; bad records skipped; subjects bounded');

// ------------------------------------------------------------------ the diffstat
assert.deepEqual(parseDiffStat(' a.txt | 2 +-\n b.txt | 1 +\n 2 files changed, 2 insertions(+), 1 deletion(-)\n'), { files: 2, insertions: 2, deletions: 1 });
assert.deepEqual(parseDiffStat(' 1 file changed, 1 insertion(+)\n'), { files: 1, insertions: 1, deletions: 0 });
assert.deepEqual(parseDiffStat(' 1 file changed, 12 deletions(-)\n'), { files: 1, insertions: 0, deletions: 12 });
assert.deepEqual(parseDiffStat(''), { files: 0, insertions: 0, deletions: 0 });
assert.deepEqual(parseDiffStat(undefined), { files: 0, insertions: 0, deletions: 0 });
ok('diffstat: the totals come from the last line, an empty diff is zeros');

// ------------------------------------------------------------------ the scan of the range
const header = (n) => `\u0001${SHA(n)}\n\n`;
const added = (file, lines, { mode = '' } = {}) => `diff --git a/${file} b/${file}\n${mode}index 0000000..1111111 100644\n--- ${mode.includes('new file') ? '/dev/null' : `a/${file}`}\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
{
  const clean = header(1) + added('src/a.js', ['const a = 1;', 'module.exports = a;']) + header(2) + added('README.md', ['# Title', 'Some words.']);
  const scan = scanPushPatch(clean);
  assert.deepEqual(scan.findings, []);
  assert.deepEqual(scan.protectedFiles, []);
  assert.equal(scan.incomplete, false);
  assert.equal(scan.files, 2);
  assert.equal(scan.commits, 2);
  assert.ok(scan.scannedChars > 20);
}
{
  const dirty = header(1) + added('src/a.js', ['const a = 1;']) + header(2) + added('src/deploy.js', ['const t = 1;', `const token = "${TOKEN}";`]);
  const scan = scanPushPatch(dirty);
  assert.equal(scan.findings.length, 1, 'one place');
  assert.equal(scan.findings[0].commit, SHA(2), 'in the commit that adds it');
  assert.equal(scan.findings[0].file, 'src/deploy.js');
  assert.ok(Object.keys(scan.findings[0].labels).length >= 1, 'with the kind of thing it looked like');
  assert.ok(!JSON.stringify(scan).includes(TOKEN), 'the secret itself is never in the answer');
  assert.ok(!JSON.stringify(scan).includes('Ab1Cd2Ef3G'), 'nor a piece of it');
}
{
  // a secret that a later commit removes was still in the history that would be pushed
  const history = header(1) + added('cfg.js', [`const t = "${TOKEN}";`]) + header(2) + `diff --git a/cfg.js b/cfg.js\nindex 1111111..2222222 100644\n--- a/cfg.js\n+++ b/cfg.js\n@@ -1 +1 @@\n-const t = "${TOKEN}";\n+const t = process.env.T;\n`;
  const scan = scanPushPatch(history);
  assert.equal(scan.findings.length, 1);
  assert.equal(scan.findings[0].commit, SHA(1), 'found in the commit that added it, not in the one that removed it');
}
{
  // removed lines and context lines are not new exposure
  const removal = header(1) + `diff --git a/cfg.js b/cfg.js\nindex 1111111..2222222 100644\n--- a/cfg.js\n+++ b/cfg.js\n@@ -1,2 +1,1 @@\n-const t = "${TOKEN}";\n  const keep = "${TOKEN}";\n+const t = 2;\n`;
  assert.deepEqual(scanPushPatch(removal).findings, [], 'a removed or an unchanged line is not scanned');
}
{
  // an added line that itself starts with "++" looks like a file header; it is content once the first @@ has been seen
  const sneaky = header(1) + `diff --git a/x.txt b/x.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1,2 @@\n+first\n+++ ${TOKEN}\n`;
  assert.equal(scanPushPatch(sneaky).findings.length, 1, 'an added line is scanned even when it starts with ++');
}
{
  // protected files: added or changed ones are refused, a deletion and a template are not
  const files = header(1)
    + added('.env', ['A=1'], { mode: 'new file mode 100644\n' })
    + added('config/credentials.json', ['{}'], { mode: 'new file mode 100644\n' })
    + added('.env.example', ['A='], { mode: 'new file mode 100644\n' })
    + added('deploy/id_rsa', ['x'], { mode: 'new file mode 100644\n' })
    + `diff --git a/.npmrc b/.npmrc\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/.npmrc\n+++ /dev/null\n@@ -1 +0,0 @@\n-registry=x\n`
    + `diff --git a/old.txt b/.env.production\nsimilarity index 90%\nrename from old.txt\nrename to .env.production\nindex 1111111..2222222 100644\n`;
  const scan = scanPushPatch(files);
  assert.deepEqual(scan.protectedFiles.map((entry) => entry.file).sort(), ['.env', '.env.production', 'config/credentials.json', 'deploy/id_rsa'].sort());
  assert.ok(scan.protectedFiles.every((entry) => entry.commit === SHA(1)));
}
{
  const binary = header(1) + `diff --git a/logo.png b/logo.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/logo.png differ\n` + added('a.txt', ['x']);
  const scan = scanPushPatch(binary);
  assert.equal(scan.binaryFiles, 1, 'a binary file is counted, not read');
  assert.equal(scan.files, 2);
}
{
  const oversized = scanPushPatch(header(1) + added('big.txt', ['x'.repeat(100)]), { limit: 50 });
  assert.equal(oversized.incomplete, true, 'more than the limit: it says it did not look at all of it');
  assert.deepEqual(oversized.findings, []);
  assert.equal(scanPushPatch('', {}).incomplete, false);
  assert.equal(scanPushPatch(undefined).files, 0);
}
{
  // the scan of an ordinary large change is bounded in time
  const lines = Array.from({ length: 20_000 }, (_, i) => `const value${i} = compute(${i}, "name-${i}", { enabled: ${i % 2 === 0} });`);
  const started = performance.now();
  const scan = scanPushPatch(header(1) + added('src/generated.js', lines));
  const took = performance.now() - started;
  assert.ok(scan.scannedChars > 1_000_000, `a megabyte of code was scanned (${scan.scannedChars})`);
  assert.deepEqual(scan.findings, [], 'and code is not mistaken for secrets');
  assert.ok(took < 20_000, `the scan of ${(scan.scannedChars / 1e6).toFixed(1)} MB took ${took.toFixed(0)} ms`);
  console.log(`    (scan: ${(scan.scannedChars / 1e6).toFixed(2)} MB in ${took.toFixed(0)} ms)`);
}
ok('scan: secrets are found in the commit that adds them (labels only, never the value), removed/context lines are not read, ++ lines are content, protected files and binaries are told apart, an oversized range says it is incomplete');

// ------------------------------------------------------------------ the answer of `git push --porcelain`
{
  const newBranch = parsePushPorcelain('To /srv/git/r.git\n*\trefs/heads/feat:refs/heads/feat\t[new branch]\nDone\n');
  assert.equal(newBranch.url, '/srv/git/r.git');
  assert.equal(newBranch.done, true);
  assert.equal(newBranch.rejected, 0);
  assert.deepEqual(newBranch.refs, [{ flag: '*', from: 'refs/heads/feat', to: 'refs/heads/feat', summary: '[new branch]', reason: '' }]);
  const fast = parsePushPorcelain('To https://github.com/o/r.git\n \trefs/heads/feat:refs/heads/feat\tabc1234..def5678\nDone\n');
  assert.equal(fast.refs[0].flag, ' ');
  assert.equal(fast.refs[0].summary, 'abc1234..def5678');
  const rejected = parsePushPorcelain('To /srv/git/r.git\n!\trefs/heads/feat:refs/heads/feat\t[rejected] (non-fast-forward)\nDone\n');
  assert.equal(rejected.rejected, 1);
  assert.equal(rejected.refs[0].reason, 'non-fast-forward');
  assert.equal(parsePushPorcelain('To /srv/git/r.git\n=\trefs/heads/feat:refs/heads/feat\t[up to date]\nDone\n').refs[0].flag, '=');
  assert.deepEqual(parsePushPorcelain(''), { url: '', refs: [], rejected: 0, done: false });
  assert.deepEqual(parsePushPorcelain(undefined), { url: '', refs: [], rejected: 0, done: false });
  assert.equal(parsePushPorcelain('fatal: something\n').done, false);
}
ok('porcelain: the url, one entry per ref, rejections counted, "Done" noticed');

// ------------------------------------------------------------------ what the approval card is told
{
  const commits = Array.from({ length: 120 }, (_, i) => ({ sha: SHA(i + 1), short: SHA(i + 1).slice(0, 7), subject: `commit ${i + 1}`, author: 'Dev', date: '2026-11-03T10:00:00+07:00' }));
  const plan = {
    remote: 'origin', remoteUrl: 'https://[REDACTED]@github.com/o/r.git', localBranch: 'feature/x', remoteRef: 'refs/heads/feature/x', headSha: SHA(120), setUpstream: true,
    commitCount: 120, commits, stat: ' a | 1 +\n 1 file changed, 1 insertion(+)\n', totals: { files: 1, insertions: 1, deletions: 0 }, defaultBranch: 'main', scan: { scannedChars: 99, files: 1, binaryFiles: 0 },
  };
  const detail = pushApprovalDetail(plan);
  assert.equal(detail.kind, 'git_push');
  assert.equal(detail.remote, 'origin');
  assert.equal(detail.url, 'https://[REDACTED]@github.com/o/r.git');
  assert.equal(detail.localBranch, 'feature/x');
  assert.equal(detail.remoteRef, 'refs/heads/feature/x');
  assert.equal(detail.setUpstream, true);
  assert.equal(detail.commitCount, 120);
  assert.equal(detail.commits.length, 50, 'at most 50 are listed');
  assert.equal(detail.commitsOmitted, 70, 'and the rest is counted');
  assert.deepEqual(detail.commits[0], { sha: SHA(1).slice(0, 7), subject: 'commit 1', author: 'Dev', date: '2026-11-03T10:00:00+07:00' }, 'a commit is shown by its short hash');
  assert.equal(detail.totals.files, 1);
  assert.match(detail.diffstat, /1 file changed/);
  assert.equal(detail.headSha, SHA(120));
  assert.equal(pushApprovalDetail({ ...plan, remoteUrl: `https://user:${'p'.repeat(12)}@github.com/o/r.git` }).url, 'https://[REDACTED]@github.com/o/r.git', 'an address that arrives with credentials leaves the card without them');
  const few = pushApprovalDetail({ ...plan, commitCount: 2, commits: commits.slice(0, 2) });
  assert.equal(few.commitsOmitted, 0);
  assert.equal(few.commits.length, 2);
  const longStat = pushApprovalDetail({ ...plan, stat: Array.from({ length: 300 }, (_, i) => ` file${i} | 1 +`).join('\n') });
  assert.equal(longStat.diffstat.split('\n').length, PUSH_LIMITS.statLines, 'a long diffstat is cut to exactly the limit, the totals line included');
  assert.match(longStat.diffstat, /^… \(\+261 dòng nữa\)$/m, 'and says how many lines are left out (300 lines, 38 kept, the totals line kept apart)');
  assert.equal(longStat.diffstat.split('\n').at(-1), ' file299 | 1 +', 'the last line of the stat is the last line of the stat');
}
ok('approval detail: kind, remote, redacted address, local branch -> remote ref, at most 50 commits (the rest counted), the diffstat (cut when long)');

console.log(`PASS: ${checks} git-push logic checks`);
