import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { pushApprovalDetail } from '../../lib/git-push.mjs';

// The approval card of git_push, rendered by the real ApprovalStack for a request shaped by the Hub's own pushApprovalDetail() (lib/git-push.mjs): so the page and the Hub
// cannot drift apart. What is pinned is what the owner reads before saying yes: where the branch goes, which commits would be sent (oldest first, at most 50, the rest
// counted), the totals and the diffstat, in both languages, and that nothing in a commit message is taken for markup.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { ApprovalStack } from './src/components/approval/ApprovalStack';
  import { parseGitPushDetail, GIT_PUSH_COMMITS_SHOWN } from './src/lib/git-push-approval';
  import { translations } from './src/lib/i18n';
  export { ApprovalStack, parseGitPushDetail, GIT_PUSH_COMMITS_SHOWN, translations };
`, 'chatmcp-approval-git-push-');
after(dispose);
const { renderWith, ApprovalStack, parseGitPushDetail, GIT_PUSH_COMMITS_SHOWN, translations } = loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const sha = (n) => String(n).padStart(40, '0');
const commit = (n, subject = `commit ${n}`) => ({ sha: sha(n), short: sha(n).slice(0, 7), subject, author: 'Dev', date: '2026-11-03T10:00:00+07:00' });
const plan = (overrides = {}) => ({
  remote: 'origin', remoteUrl: 'https://[REDACTED]@github.com/o/r.git', localBranch: 'feature/x', remoteRef: 'refs/heads/feature/x', headSha: sha(3), setUpstream: true,
  commitCount: 3, commits: [commit(1, 'feat: add a'), commit(2, 'feat: add b (Tiếng Việt)'), commit(3, 'fix: c')], stat: ' a.txt | 1 +\n b.txt | 2 ++\n 2 files changed, 3 insertions(+)\n',
  totals: { files: 2, insertions: 3, deletions: 0 }, defaultBranch: 'main', scan: { scannedChars: 10, files: 2, binaryFiles: 0 }, ...overrides,
});
const approval = (detail, overrides = {}) => ({ id: 'req-1', tool: 'local.git_push', description: 'git push origin feature/x (3 commit)', risk: 'dangerous', reason: 'x', detail, ...overrides });
const render = (detail, lang = 'vi', overrides = {}) => renderWith(ApprovalStack, { approvals: [approval(detail, overrides)], onApprove() {}, onDeny() {} }, [], [], { lang }, {});
const inner = (html, testid) => {
  const open = new RegExp(`<([a-z0-9]+)[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  if (!open) return null;
  const rest = html.slice(open.index + open[0].length);
  return rest.slice(0, rest.indexOf(`</${open[1]}>`)).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
};

test('the card of a push says where the branch goes and lists the commits, oldest first (Vietnamese)', async () => {
  const html = await render(pushApprovalDetail(plan()));
  assert.match(html, /data-testid="git-push-preview"/);
  assert.match(html, /Đẩy nhánh lên remote/);
  assert.match(inner(html, 'git-push-remote'), /^origin https:\/\/\[REDACTED\]@github\.com\/o\/r\.git/, 'the remote and its address, without credentials');
  assert.match(inner(html, 'git-push-route'), /feature\/x → origin\/feature\/x/, 'local branch → remote / remote branch');
  assert.match(inner(html, 'git-push-route'), /đặt làm upstream/, 'and that the upstream is set');
  assert.equal(inner(html, 'git-push-count'), 'Số commit sẽ được gửi: 3');
  const list = inner(html, 'git-push-commits');
  assert.ok(list.indexOf('feat: add a') < list.indexOf('feat: add b (Tiếng Việt)') && list.indexOf('feat: add b (Tiếng Việt)') < list.indexOf('fix: c'), 'in the order they are applied');
  for (const n of [1, 2, 3]) assert.ok(list.includes(sha(n).slice(0, 7)), `commit ${n} by its short hash`);
  assert.ok(list.includes('Dev') && list.includes('2026-11-03'), 'with the author and the day');
  assert.equal(inner(html, 'git-push-changes'), 'Thay đổi: 2 tệp, +3 -0');
  assert.match(html, /<details>\s*<summary[^>]*>Thống kê thay đổi \(diffstat\)<\/summary>[\s\S]*b\.txt \| 2 \+\+/, 'the diffstat is one click away');
  assert.match(html, /không ép \(no force\)/, 'the card says the push never forces');
  assert.match(html, /không phải bảo đảm tuyệt đối/, 'and that the scan is a pattern scan');
  assert.equal(html.includes('data-testid="git-push-older"'), false, 'nothing is left out when everything is listed');
  assert.match(html, /Chi tiết thao tác/, 'the technical details stay below, as for every other action');
});

test('the same card in English', async () => {
  const html = await render(pushApprovalDetail(plan({ setUpstream: false })), 'en');
  assert.match(html, /Push a branch to a remote/);
  assert.equal(inner(html, 'git-push-count'), 'Commits that will be sent: 3');
  assert.equal(inner(html, 'git-push-changes'), 'Changes: 2 file(s), +3 -0');
  assert.doesNotMatch(inner(html, 'git-push-route'), /upstream/, 'no upstream line when the upstream is not set');
  assert.match(html, /Only this branch is pushed, without force and without hooks/);
  assert.doesNotMatch(html, /Số commit|Thay đổi|Đẩy nhánh/, 'nothing of the other language');
});

test('a long list says how many commits are not listed', async () => {
  const commits = Array.from({ length: 120 }, (_, i) => commit(i + 1));
  const detail = pushApprovalDetail(plan({ commitCount: 120, commits }));
  const html = await render(detail);
  assert.equal(inner(html, 'git-push-count'), 'Số commit sẽ được gửi: 120');
  assert.equal((inner(html, 'git-push-commits').match(/commit \d+/g) ?? []).length, 50, 'fifty are listed');
  assert.match(inner(html, 'git-push-older'), /70 commit cũ hơn/);
  const english = await render(detail, 'en');
  assert.match(inner(english, 'git-push-older'), /70 older commits/);
});

test('a commit message is text, never markup', async () => {
  const html = await render(pushApprovalDetail(plan({ commits: [commit(1, '<img src=x onerror=alert(1)> & "quoted"'), commit(2, '</li><script>alert(1)</script>')], commitCount: 2 })));
  assert.doesNotMatch(html, /<img src=x|<script>alert/, 'escaped by React');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a request that is not a push has no push section, and a broken one does not break the page', async () => {
  const other = await render({ kind: 'command', command: 'npm test' });
  assert.doesNotMatch(other, /git-push-preview/);
  for (const detail of [undefined, null, 'text', 5, [], { kind: 'git_push' }, { kind: 'git_push', commits: 'nope', totals: 5, commitCount: 'x' }, { kind: 'git_push', commits: [null, 5, { sha: 7 }, { sha: 'abc1234', subject: 's' }] }]) {
    const html = await render(detail);
    assert.match(html, /data-approval-id="req-1"/, `the card still renders for ${JSON.stringify(detail)}`);
  }
  const broken = await render({ kind: 'git_push', commits: [null, 5, { sha: 7 }, { sha: 'abc1234', subject: 's' }] });
  assert.equal((inner(broken, 'git-push-commits').match(/abc1234/g) ?? []).length, 1, 'only the entry that is a commit is listed');
});

test('parseGitPushDetail reads only what it knows, bounded', () => {
  assert.equal(parseGitPushDetail(undefined), null);
  assert.equal(parseGitPushDetail({ kind: 'edit' }), null);
  assert.equal(parseGitPushDetail([]), null);
  assert.equal(GIT_PUSH_COMMITS_SHOWN, 50);
  const view = parseGitPushDetail(pushApprovalDetail(plan()));
  assert.deepEqual({ ...view, commits: view.commits.length }, {
    remote: 'origin', url: 'https://[REDACTED]@github.com/o/r.git', localBranch: 'feature/x', remoteBranch: 'feature/x', setUpstream: true, commitCount: 3, commits: 3, commitsOmitted: 0,
    files: 2, insertions: 3, deletions: 0, diffstat: view.diffstat,
  });
  const many = parseGitPushDetail({ kind: 'git_push', commitCount: 500, commits: Array.from({ length: 80 }, (_, i) => ({ sha: `abc${i}`, subject: 's'.repeat(900) })) });
  assert.equal(many.commits.length, 50, 'never more than fifty, whatever was sent');
  assert.equal(many.commits[0].subject.length, 200, 'a subject is cut');
  assert.equal(many.commitsOmitted, 450);
  assert.equal(parseGitPushDetail({ kind: 'git_push', commitCount: -4, totals: { files: 'x', insertions: -1, deletions: Infinity } }).commitCount, 0);
  assert.equal(parseGitPushDetail({ kind: 'git_push', remoteRef: 'refs/heads/a/b' }).remoteBranch, 'a/b');
});

test('every string of the card exists in both languages, and the Vietnamese has its diacritics', () => {
  const keys = Object.keys(translations.vi).filter((key) => key.startsWith('agents_apr_push_'));
  assert.ok(keys.length >= 9, `the push strings: ${keys.length}`);
  for (const key of keys) {
    assert.equal(typeof translations.en[key], 'string', `${key} in English`);
    if (key !== 'agents_apr_push_remote') assert.notEqual(translations.en[key], translations.vi[key], `${key} is translated, not copied ("Remote" is the word in both languages)`);
    assert.deepEqual(translations.en[key].match(/\{\w+\}/g)?.sort() ?? [], translations.vi[key].match(/\{\w+\}/g)?.sort() ?? [], `${key}: the same placeholders in both`);
  }
  for (const key of ['agents_apr_push_title', 'agents_apr_push_commits', 'agents_apr_push_changes', 'agents_apr_push_note']) assert.match(translations.vi[key], DIACRITICS, `${key} is written with diacritics`);
  assert.deepEqual(Object.keys(translations.en).filter((key) => key.startsWith('agents_apr_push_')).sort(), keys.sort(), 'no key in only one language');
});
