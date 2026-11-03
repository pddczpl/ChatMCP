// What the approval request of git_push carries (lib/git-push.mjs, pushApprovalDetail): the remote and where the branch goes, the commits that would be sent and the
// diffstat. The Hub worked all of it out from the repository; this reads it defensively, because it arrives as JSON and the card must never throw on a shape it does not know.

export interface GitPushCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitPushView {
  remote: string;
  url: string;
  localBranch: string;
  remoteBranch: string;
  setUpstream: boolean;
  commitCount: number;
  commits: GitPushCommit[];
  commitsOmitted: number;
  files: number;
  insertions: number;
  deletions: number;
  diffstat: string;
}

/** The most commits the card lists, whatever the Hub sent (the Hub sends at most 50). */
export const GIT_PUSH_COMMITS_SHOWN = 50;

const text = (value: unknown, limit: number): string => (typeof value === 'string' ? value.slice(0, limit) : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/** The push the request describes, or null when the request is not a git_push one (or has nothing to show). */
export function parseGitPushDetail(detail: unknown): GitPushView | null {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const raw = detail as Record<string, unknown>;
  if (raw.kind !== 'git_push') return null;
  const commits: GitPushCommit[] = (Array.isArray(raw.commits) ? raw.commits : []).slice(0, GIT_PUSH_COMMITS_SHOWN).flatMap((entry): GitPushCommit[] => {
    if (entry === null || typeof entry !== 'object') return [];
    const commit = entry as Record<string, unknown>;
    const sha = text(commit.sha, 12);
    return sha ? [{ sha, subject: text(commit.subject, 200), author: text(commit.author, 80), date: text(commit.date, 40) }] : [];
  });
  const totals = raw.totals !== null && typeof raw.totals === 'object' ? raw.totals as Record<string, unknown> : {};
  const commitCount = Math.max(count(raw.commitCount), commits.length);
  return {
    remote: text(raw.remote, 64),
    url: text(raw.url, 300),
    localBranch: text(raw.localBranch, 200),
    remoteBranch: text(raw.remoteRef, 220).replace(/^refs\/heads\//, ''),
    setUpstream: raw.setUpstream === true,
    commitCount,
    commits,
    commitsOmitted: Math.max(0, commitCount - commits.length),
    files: count(totals.files),
    insertions: count(totals.insertions),
    deletions: count(totals.deletions),
    diffstat: text(raw.diffstat, 6000),
  };
}
