// git_push: publish ONE local branch to a remote that is already configured, and nothing else.
//
// What this module decides, in two halves:
//   * the pure half - which names may be pushed, what is shown of a remote's address, how the log, the diffstat and the answer of
//     `git push --porcelain` are read, what the scan of the commits to be sent looks for, what the approval card is told;
//   * the Git half - planPush() looks at the repository WITHOUT touching the network and decides whether this push may be put in front of the
//     person at all; executePush() runs after they said yes.
//
// The rules (the tool never forces, so there is no option for it): one branch, spelled out in full as `refs/heads/b:refs/heads/b`; a remote that is
// already configured (a name, never an address); not main, not master, not the remote's default branch; not a branch that was rewritten (that
// needs a force); nothing that looks like a secret or is a protected file in any of the commits that would be sent; not a repository whose own
// configuration names a program for the network (a credential helper, an ssh command ...); hooks never run; a timeout; a stop ends it.
//
// Everything Git or the remote says goes through redactPushOutput() before it is shown or returned.
import { inspectGitSafety } from './git-trust.mjs';
import { redactText } from './outbound-redaction.mjs';
import { isProtectedPath } from './protected-paths.mjs';

export const PUSH_LIMITS = Object.freeze({
  commits: 50, // commits listed on the approval card
  timeoutMs: 90_000, // the whole push, remote default probe included
  scanChars: 4 * 1024 * 1024, // text of the commits that is read for secrets; a range with more is refused
  statLines: 40, // lines of diffstat on the card
  outputChars: 4000, // what is returned of Git's own words
  subjectChars: 200,
  authorChars: 80,
});

const SECRET_MARK = '[REDACTED]';
const fault = (code, message) => ({ ok: false, code, message });
const shown = (value) => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60);

// ------------------------------------------------------------------------------------------------------------------------------
// Names
// ------------------------------------------------------------------------------------------------------------------------------
const PSEUDO_REF = /^(?:HEAD|[A-Z][A-Z_]*_HEAD)$/i;
// ASCII controls, space, DEL and the characters Git forbids in a ref (~ ^ : ? * [ \), plus every Unicode separator, format character (bidi, zero width) and control.
const FORBIDDEN_IN_REF = /[\u0000-\u0020\u007f~^:?*[\\\p{Cc}\p{Cf}\p{Z}\p{Cs}\p{Co}\p{Cn}]/u;

/** A plain branch name (`feature/x`): what `git check-ref-format --branch` accepts, minus everything that could be read as an option, a refspec or a full ref. */
export function isPlainBranchName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
  if (name.startsWith('-') || name.startsWith('+') || name.startsWith('refs/')) return false;
  if (FORBIDDEN_IN_REF.test(name) || name.includes('..') || name.includes('@{') || name === '@' || name.endsWith('.')) return false;
  if (PSEUDO_REF.test(name)) return false;
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** The name of a remote, as `git remote` lists it. An address, a path, a pattern or an option is not one. */
export function isPlainRemoteName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/** What is wrong with the arguments of a call, in words for the model. Empty: nothing. */
export function pushArgumentProblems(args = {}) {
  const problems = [];
  if (args.remote !== undefined && !isPlainRemoteName(args.remote)) {
    problems.push(`remote: "${shown(args.remote)}" không phải tên của một remote đã cấu hình (chỉ nhận tên như "origin"; không nhận địa chỉ, đường dẫn, mẫu hay tùy chọn)`);
  }
  if (args.branch !== undefined && !isPlainBranchName(args.branch)) {
    problems.push(`branch: "${shown(args.branch)}" không phải tên nhánh thường (git_push chỉ đẩy một nhánh theo tên: không refspec, không "+", không ":", không --force/--delete/--mirror/--all/--tags)`);
  }
  return problems;
}

const ALWAYS_PROTECTED = new Set(['main', 'master']);

/**
 * Why this branch is not pushed by the tool, or null when it may be. Compared without regard to case: on a disk that ignores case, `Main` and `main` are one file.
 * @param {string|null} defaultBranch the default branch of the remote, when it is known
 */
export function protectedBranchReason(branch, defaultBranch = null) {
  const name = String(branch ?? '').toLowerCase();
  const isDefault = typeof defaultBranch === 'string' && defaultBranch !== '' && name === defaultBranch.toLowerCase();
  if (!ALWAYS_PROTECTED.has(name) && !isDefault) return null;
  const why = isDefault ? `"${branch}" là nhánh mặc định của remote` : `"${branch}" là nhánh chính`;
  return `${why}. git_push không đẩy thẳng lên nhánh chính hoặc nhánh mặc định: hãy làm việc trên một nhánh tính năng (git_branch create) rồi mở pull request; chủ dự án có thể tự đẩy nhánh này bằng tay.`;
}

// ------------------------------------------------------------------------------------------------------------------------------
// What is shown
// ------------------------------------------------------------------------------------------------------------------------------
const SSH_SCHEME = /^(?:ssh|git\+ssh|ssh\+git)$/i;

/**
 * The address of a remote without its credentials: the user part of an http(s) address (it can be the token itself), the password of any other
 * address, and a token in the query. The user name of an ssh address is not a secret. A plain path is returned as it is.
 */
export function redactRemoteUrl(url) {
  if (typeof url !== 'string') return '';
  let text = url.trim();
  const parts = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(text);
  if (parts) {
    const [, scheme, authority, rest] = parts;
    const at = authority.lastIndexOf('@'); // a password can hold an @: the last one ends the user part
    if (at !== -1) {
      const userinfo = authority.slice(0, at);
      const colon = userinfo.indexOf(':');
      const visible = SSH_SCHEME.test(scheme) ? (colon === -1 ? userinfo : `${userinfo.slice(0, colon)}:${SECRET_MARK}`) : SECRET_MARK;
      text = `${scheme}://${visible}@${authority.slice(at + 1)}${rest}`;
    }
  }
  return redactText(text).text;
}

/** Git's own words for the person and the model: addresses without credentials, secrets the Hub knows, token shapes, a bounded length. */
export function redactPushOutput(text, secrets = []) {
  if (typeof text !== 'string' || text === '') return '';
  let out = text.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"<>]+/g, (url) => redactRemoteUrl(url));
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join(SECRET_MARK);
  out = redactText(out).text;
  if (out.length > PUSH_LIMITS.outputChars) {
    const head = Math.floor(PUSH_LIMITS.outputChars * 0.6);
    const tail = PUSH_LIMITS.outputChars - head;
    out = `${out.slice(0, head)}\n… [đã cắt ${out.length - PUSH_LIMITS.outputChars} ký tự] …\n${out.slice(out.length - tail)}`;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Reading what Git prints
// ------------------------------------------------------------------------------------------------------------------------------
const FIELD = '\u001f';

/** `git log -z --format=%H%x1f%an%x1f%aI%x1f%s`: one record per commit, separated by NUL. */
export function parseCommitList(text) {
  if (typeof text !== 'string') return [];
  const commits = [];
  for (const record of text.split('\0')) {
    const fields = record.replace(/^\n+/, '').split(FIELD);
    if (fields.length < 4 || !/^[0-9a-f]{40,64}$/.test(fields[0])) continue;
    commits.push({
      sha: fields[0], short: fields[0].slice(0, 7), author: fields[1].slice(0, PUSH_LIMITS.authorChars), date: fields[2],
      subject: fields.slice(3).join(FIELD).slice(0, PUSH_LIMITS.subjectChars),
    });
  }
  return commits;
}

/** The totals on the last line of `git diff --stat`. */
export function parseDiffStat(text) {
  const totals = { files: 0, insertions: 0, deletions: 0 };
  if (typeof text !== 'string') return totals;
  const last = text.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(last);
  if (match) { totals.files = Number(match[1]); totals.insertions = Number(match[2] ?? 0); totals.deletions = Number(match[3] ?? 0); }
  return totals;
}

/** `git push --porcelain`: "To <url>", one tab-separated line per ref (flag, from:to, summary), "Done". */
export function parsePushPorcelain(text) {
  const result = { url: '', refs: [], rejected: 0, done: false };
  if (typeof text !== 'string') return result;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('To ')) { result.url = line.slice(3).trim(); continue; }
    if (line === 'Done') { result.done = true; continue; }
    const match = /^([ +\-*=!])\t([^:\t]*):([^\t]*)\t(.*)$/.exec(line);
    if (!match) continue;
    const [, flag, from, to, rest] = match;
    const detail = /^(.*?)(?: \(([^()]*)\))?$/.exec(rest);
    result.refs.push({ flag, from, to, summary: detail[1], reason: detail[2] ?? '' });
    if (flag === '!') result.rejected += 1;
  }
  return result;
}

// ------------------------------------------------------------------------------------------------------------------------------
// The scan of the commits that would be sent
// ------------------------------------------------------------------------------------------------------------------------------
function unquoteGitPath(value) {
  const text = value.trim();
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text;
  const bytes = [];
  const inner = text.slice(1, -1);
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
    const next = inner[i + 1];
    bytes.push(...Buffer.from(next === 't' ? '\t' : next === 'n' ? '\n' : (next ?? ''), 'utf8'));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path of a `diff --git a/x b/x` header (the two halves of an unrenamed file are equal, which resolves a name with spaces). */
function pathOfDiffHeader(line) {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) return unquoteGitPath(rest.slice(0, rest.indexOf('" ', 1) + 1)).replace(/^a\//, '');
  const length = (rest.length - 5) / 2;
  if (Number.isInteger(length) && length > 0 && rest.startsWith('a/') && rest.slice(2, 2 + length) === rest.slice(rest.length - length)) return rest.slice(2, 2 + length);
  const at = rest.lastIndexOf(' b/');
  return at === -1 ? rest : rest.slice(at + 3);
}

/**
 * Reads the output of `git log -p --unified=0 --format=%x01%H` for the commits that would be sent. A commit line starts with U+0001; inside a file, the lines before the
 * first `@@` are the header, after it a line that starts with "+" is an ADDED line (also when it reads "+++ ..."): only added lines can be a new exposure, a removed or an
 * unchanged line is not read. Reports labels, files and commits, never a matched text.
 * @param {string} patch
 * @param {{limit?: number}} [options] a patch longer than `limit` is not read: `incomplete` is true and the caller refuses
 */
export function scanPushPatch(patch, { limit = PUSH_LIMITS.scanChars } = {}) {
  const report = { findings: [], protectedFiles: [], binaryFiles: 0, files: 0, commits: 0, scannedChars: 0, incomplete: false };
  const text = typeof patch === 'string' ? patch : '';
  if (text.length > limit) return { ...report, incomplete: true };
  let commit = '';
  let file = null;
  const finish = () => {
    if (!file) return;
    if (file.binary) report.binaryFiles += 1;
    if (!file.deleted && isProtectedPath(file.path)) report.protectedFiles.push({ commit, file: file.path });
    if (!file.binary && file.added.length) {
      const added = file.added.join('\n');
      report.scannedChars += added.length;
      const { labels, count } = redactText(added);
      if (count > 0) report.findings.push({ commit, file: file.path, labels });
    }
    file = null;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('\u0001')) { finish(); commit = line.slice(1).trim(); report.commits += 1; continue; }
    if (line.startsWith('diff --git ')) { finish(); file = { path: pathOfDiffHeader(line), deleted: false, binary: false, inHunk: false, added: [] }; report.files += 1; continue; }
    if (!file) continue;
    if (!file.inHunk) {
      if (line.startsWith('@@')) file.inHunk = true;
      else if (line.startsWith('deleted file mode')) file.deleted = true;
      else if (line.startsWith('rename to ')) file.path = unquoteGitPath(line.slice('rename to '.length));
      else if (line.startsWith('+++ b/')) file.path = unquoteGitPath(line.slice('+++ b/'.length).replace(/\t.*$/, ''));
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
    } else if (line.startsWith('+')) file.added.push(line.slice(1));
  }
  finish();
  return report;
}

// ------------------------------------------------------------------------------------------------------------------------------
// The approval card
// ------------------------------------------------------------------------------------------------------------------------------
function clipStat(stat) {
  const lines = String(stat ?? '').split('\n').filter((line) => line.trim() !== '');
  if (lines.length <= PUSH_LIMITS.statLines) return lines.join('\n');
  const kept = lines.slice(0, PUSH_LIMITS.statLines - 2);
  return [...kept, `… (+${lines.length - kept.length - 1} dòng nữa)`, lines.at(-1)].join('\n');
}

/** What the permission request carries for the approval card: the remote and where the branch goes, the commits (at most 50, the rest counted) and the diffstat. */
export function pushApprovalDetail(plan) {
  const listed = (plan.commits ?? []).slice(0, PUSH_LIMITS.commits).map((commit) => ({ sha: commit.short ?? String(commit.sha).slice(0, 7), subject: commit.subject, author: commit.author, date: commit.date }));
  const total = Number.isInteger(plan.commitCount) ? plan.commitCount : listed.length;
  return {
    kind: 'git_push',
    remote: plan.remote,
    url: redactRemoteUrl(plan.remoteUrl),
    localBranch: plan.localBranch,
    remoteRef: plan.remoteRef,
    setUpstream: plan.setUpstream === true,
    commitCount: total,
    commits: listed,
    commitsOmitted: Math.max(0, total - listed.length),
    totals: plan.totals ?? { files: 0, insertions: 0, deletions: 0 },
    diffstat: clipStat(plan.stat),
    headSha: plan.headSha,
    defaultBranch: plan.defaultBranch ?? null,
    scanned: plan.scan ?? null,
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Git: the plan, which touches no network
// ------------------------------------------------------------------------------------------------------------------------------
const isRunnerFault = (error) => typeof error?.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code) && Number.isInteger(error.statusCode);
const secretsOf = (git, extra = []) => [...(typeof git?.secrets === 'function' ? git.secrets() ?? [] : []), ...extra];
/** An address that Git hands to a program (`ext::sh -c ...`, `x::y`), or that reads as an option. */
const isProgramAddress = (url) => /^[A-Za-z0-9+.-]+::/.test(url) || url.startsWith('-') || /[\0\r\n]/.test(url);
/**
 * Settings of the HTTP transport that the REPOSITORY could use to send a push through a proxy of its own or to weaken the check of the certificate (together they let the
 * author of a folder read what is sent), to add a header, to override the DNS answer for a host or to name the certificates to trust. A regular expression over the names Git
 * reports, for the repository's own configuration (`git config --local` and `--worktree`; the person's own global configuration is theirs and is not looked at).
 */
const TRANSPORT_SETTINGS = '^https?\\.(.*\\.)?(proxy|proxyauthmethod|sslverify|sslcainfo|sslcapath|sslcert|sslkey|pinnedpubkey|extraheader|cookiefile|curloptresolve)$';

/**
 * Looks at the repository and decides whether this push may be put in front of the person. Local Git only: nothing is sent, nothing is asked of the remote.
 * @returns {Promise<{ok: true, plan: object} | {ok: false, code: string, message: string}>}
 *   throws only for a stop (the signal) and for a failure that is not the repository's (Git missing is reported as a refusal too)
 */
export async function planPush(git, { remote = 'origin', branch, setUpstream, signal, scanLimit = PUSH_LIMITS.scanChars } = {}) {
  try {
    return await plan(git, { remote, branch, setUpstream, signal, scanLimit });
  } catch (error) {
    if (signal?.aborted || !isRunnerFault(error)) throw error;
    return fault(error.code, error.message);
  }
}

async function plan(git, { remote, branch, setUpstream, signal, scanLimit }) {
  const root = await git.ensureRepo({ signal });
  const run = (args, options = {}) => git.text(args, { signal, ...options });
  const secrets = secretsOf(git);

  // the repository's own configuration must not name a program that Git would run to talk to the network
  const safety = await inspectGitSafety(root, { hooks: false });
  const programs = safety.risks.filter((risk) => risk.affects === 'network').map((risk) => risk.key); // (a configuration too large to read is refused by the runner already)
  // `--local` is `.git/config`; `--worktree` is `.git/config.worktree` when extensions.worktreeConfig is on (a linked worktree has its own, under the common directory) and
  // `.git/config` again when it is off. `--local` alone never reads the worktree file, and Git applies what is in it.
  const transport = new Set();
  for (const scope of ['--local', '--worktree']) {
    const found = await run(['config', scope, '--name-only', '--get-regexp', TRANSPORT_SETTINGS]);
    if (found.code === 0) for (const line of found.stdout.split('\n')) if (line.trim()) transport.add(line.trim());
  }
  programs.push(...transport);
  if (programs.length) {
    return fault('push_untrusted_repo', `Cấu hình của kho này (.git/config, .git/config.worktree) có mục chạy chương trình hoặc đổi đường đi của kết nối khi Git nói chuyện với remote: ${programs.slice(0, 6).join(', ')}. git_push không đẩy khi chưa kiểm tra để tránh chạy mã của kho hoặc để lộ dữ liệu qua proxy của kho. Xem và xóa các mục đó nếu bạn tin kho, hoặc tự đẩy bằng terminal.`);
  }

  const listed = await run(['remote']);
  const remotes = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (listed.code !== 0 || !remotes.includes(remote)) {
    return fault('remote_not_found', `Remote "${remote}" chưa được cấu hình. Remote hiện có: ${remotes.join(', ') || '(không có)'}. git_push không thêm remote mới.`);
  }
  // `--all`: a remote can have several push addresses, and `git push` goes to every one of them while the card would show one
  const address = await run(['remote', 'get-url', '--push', '--all', remote]);
  const urls = address.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (address.code === 0 && urls.length > 1) {
    return fault('push_bad_remote', `Remote "${remote}" có nhiều địa chỉ đẩy (pushurl). git_push chỉ đẩy lên một nơi mỗi lần, nên từ chối; để lại một địa chỉ hoặc tự đẩy bằng terminal.`);
  }
  const url = urls[0] ?? '';
  if (address.code !== 0 || !url || isProgramAddress(url)) {
    return fault('push_bad_remote', `Địa chỉ của remote "${remote}" không dùng được để đẩy (rỗng, bắt đầu bằng "-" hoặc là kiểu giao cho một chương trình như "ext::"). Địa chỉ: ${redactPushOutput(url, secrets).slice(0, 120)}`);
  }

  let name = branch;
  if (name === undefined) {
    const current = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    name = current.stdout.trim();
    if (current.code !== 0 || !name) return fault('detached_head', 'HEAD không ở trên nhánh nào (detached) nên không biết đẩy nhánh nào. Chuyển sang một nhánh hoặc truyền branch.');
    if (!isPlainBranchName(name)) return fault('bad_branch', `Tên nhánh hiện tại ("${shown(name)}") không phải tên nhánh thường nên git_push không đẩy.`);
  }
  const head = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]);
  const headSha = head.stdout.trim();
  if (head.code !== 0 || !headSha) return fault('branch_not_found', `Không có nhánh cục bộ "${name}".`);

  const symbolic = await run(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  const defaultBranch = symbolic.code === 0 && symbolic.stdout.trim().startsWith(`${remote}/`) ? symbolic.stdout.trim().slice(remote.length + 1) : null;
  const protectedReason = protectedBranchReason(name, defaultBranch);
  if (protectedReason) return fault('push_protected_branch', protectedReason);

  const tracking = await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}^{commit}`]);
  const trackingSha = tracking.code === 0 ? tracking.stdout.trim() : null;
  if (trackingSha) {
    const ancestor = await run(['merge-base', '--is-ancestor', trackingSha, headSha]);
    if (ancestor.code !== 0) {
      return fault('push_not_fast_forward', `Nhánh "${name}" không chứa hết các commit mà ${remote}/${name} đang có (đã viết lại lịch sử, hoặc người khác đã đẩy thêm). Đẩy được nó cần --force, mà git_push không bao giờ ép. Lấy thay đổi mới (fetch) rồi rebase/merge, hoặc nhờ chủ dự án tự xử lý.`);
    }
  }

  const range = [`refs/heads/${name}`, '--not', `--remotes=${remote}`];
  const counted = await run(['rev-list', '--count', ...range]);
  const commitCount = counted.code === 0 ? Number(counted.stdout.trim()) : 0;
  if (!Number.isInteger(commitCount) || commitCount < 1) return fault('nothing_to_push', `Không có commit nào để đẩy: ${remote} đã có mọi commit của nhánh "${name}" (theo lần fetch gần nhất).`);

  const log = await run(['log', '-z', '--no-color', '--no-show-signature', `--max-count=${PUSH_LIMITS.commits}`, '--format=%H%x1f%an%x1f%aI%x1f%s', ...range]);
  const commits = parseCommitList(log.stdout).reverse(); // the newest 50, the oldest of them first

  const patch = await run(['log', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--unified=0', '--diff-filter=d', '--format=%x01%H', ...range], { maxBytes: scanLimit + 4096 });
  if (patch.code !== 0 || patch.truncated) return fault('push_scan_incomplete', 'Không đọc hết được các commit sắp đẩy để tìm bí mật (phạm vi quá lớn hoặc Git báo lỗi) nên git_push từ chối. Hãy kiểm tra rồi tự đẩy bằng tay.');
  const scan = scanPushPatch(patch.stdout, { limit: scanLimit });
  if (scan.incomplete) return fault('push_scan_incomplete', `Các commit sắp đẩy dài hơn ${Math.round(scanLimit / 1024)} KB văn bản nên không đọc hết để tìm bí mật; git_push từ chối. Hãy kiểm tra rồi tự đẩy bằng tay.`);
  if (scan.findings.length) {
    const where = scan.findings.slice(0, 5).map((finding) => `${Object.entries(finding.labels).map(([label, n]) => `${label}×${n}`).join(', ')} trong ${finding.file} (commit ${finding.commit.slice(0, 7)})`).join('; ');
    return fault('push_secret_found', `Các commit sắp đẩy có nội dung giống thông tin bí mật: ${where}${scan.findings.length > 5 ? `; và ${scan.findings.length - 5} chỗ nữa` : ''}. git_push từ chối và không hỏi duyệt. Gỡ bí mật khỏi các commit (và thu hồi nó nếu đã lộ) rồi thử lại, hoặc nhờ chủ dự án tự kiểm tra và đẩy.`);
  }
  if (scan.protectedFiles.length) {
    const where = scan.protectedFiles.slice(0, 5).map((entry) => `${entry.file} (commit ${entry.commit.slice(0, 7)})`).join(', ');
    return fault('push_protected_file', `Các commit sắp đẩy có file bí mật hoặc file được bảo vệ: ${where}. git_push từ chối và không hỏi duyệt. Gỡ file khỏi lịch sử rồi thử lại, hoặc nhờ chủ dự án tự xử lý.`);
  }

  // the diffstat: against where the remote's history meets this branch
  let base = null;
  for (const candidate of [trackingSha, defaultBranch && `refs/remotes/${remote}/${defaultBranch}`, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`]) {
    if (!candidate) continue;
    const merged = await run(['merge-base', headSha, candidate]);
    if (merged.code === 0 && merged.stdout.trim()) { base = merged.stdout.trim(); break; }
  }
  if (!base) base = (await run(['hash-object', '-t', 'tree', '--stdin'])).stdout.trim() || null; // stdin is closed: the empty tree
  let stat = '';
  if (base) {
    const diff = await run(['diff', '--stat=100', '--no-color', '--no-ext-diff', '--no-textconv', base, headSha, '--'], { maxBytes: 400_000 });
    if (diff.code === 0) stat = diff.stdout;
  }

  const configured = await run(['config', '--get', `branch.${name}.merge`]);
  const hasUpstream = configured.code === 0 && configured.stdout.trim() !== '';
  return {
    ok: true,
    plan: {
      remote, remoteUrl: redactRemoteUrl(url), localBranch: name, remoteRef: `refs/heads/${name}`, headSha, trackingSha, hasUpstream,
      setUpstream: typeof setUpstream === 'boolean' ? setUpstream : !hasUpstream,
      commitCount, commits, stat, totals: parseDiffStat(stat), defaultBranch,
      scan: { scannedChars: scan.scannedChars, files: scan.files, binaryFiles: scan.binaryFiles },
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Git: the push, after the person said yes
// ------------------------------------------------------------------------------------------------------------------------------
/**
 * Pushes exactly what the plan showed. A stop (the signal) rejects; a refusal or a failure is returned.
 * @returns {Promise<{ok: true, pushed: true, remote: string, branch: string, ref: string, range: {from: string|null, to: string}, commits: number, setUpstream: boolean, upstream: string|null, url: string, output: string} | {ok: false, code: string, message: string}>}
 */
export async function executePush(git, plan, { signal, timeoutMs = PUSH_LIMITS.timeoutMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(500, deadline - Date.now());
  const secrets = secretsOf(git);
  const words = (text) => redactPushOutput(text, secrets);
  const branch = plan.localBranch;
  try {
    const now = await git.text(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { signal });
    if (now.code !== 0 || now.stdout.trim() !== plan.headSha) {
      return fault('plan_changed', `Nhánh "${branch}" đã thay đổi sau khi danh sách commit được chuẩn bị cho bạn duyệt nên không đẩy. Gọi lại git_push để có danh sách mới.`);
    }
    // origin/HEAD may say nothing (a remote added by hand): the remote itself says what its default branch is
    const probe = await git.text(['ls-remote', '--symref', plan.remote, 'HEAD'], { signal, timeoutMs: Math.min(30_000, left()), maxBytes: 64_000 });
    if (probe.timedOut) return fault('push_timeout', `Hỏi remote "${plan.remote}" quá ${Math.round(timeoutMs / 1000)} giây nên đã dừng; chưa đẩy gì.`);
    if (probe.code !== 0) return fault('push_failed', `Không kết nối được remote "${plan.remote}": ${words(probe.stderr).trim().slice(-600) || `git thoát với mã ${probe.code}`}. Chưa đẩy gì.`);
    const remoteDefault = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(probe.stdout)?.[1] ?? null;
    const protectedReason = protectedBranchReason(branch, remoteDefault);
    if (protectedReason) return fault('push_protected_branch', protectedReason);

    const result = await git.text([
      'push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', ...(plan.setUpstream ? ['--set-upstream'] : []),
      plan.remote, `refs/heads/${branch}:refs/heads/${branch}`,
    ], { signal, writes: true, timeoutMs: left(), maxBytes: 400_000 });
    if (result.timedOut) return fault('push_timeout', `Đẩy mất quá ${Math.round(timeoutMs / 1000)} giây nên đã dừng. Kiểm tra mạng và quyền truy cập, rồi thử lại.`);
    const parsed = parsePushPorcelain(result.stdout);
    const output = words(`${result.stdout}\n${result.stderr}`).trim();
    if (result.code !== 0 || parsed.rejected > 0) {
      const code = parsed.rejected > 0 ? 'push_rejected' : 'push_failed';
      const lead = parsed.rejected > 0 ? `Remote "${plan.remote}" từ chối bản đẩy` : `Đẩy lên "${plan.remote}" thất bại`;
      return fault(code, `${lead}. git_push không ép nên không có cách nào khác ngoài xử lý nguyên nhân:\n${output.slice(-1500)}`);
    }
    return {
      ok: true, pushed: true, remote: plan.remote, branch, ref: plan.remoteRef, range: { from: plan.trackingSha ?? null, to: plan.headSha },
      commits: plan.commitCount, setUpstream: plan.setUpstream, upstream: plan.setUpstream ? `${plan.remote}/${branch}` : null, url: plan.remoteUrl, output,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw error;
  }
}
