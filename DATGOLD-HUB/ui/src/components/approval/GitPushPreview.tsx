import { GitBranch } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { parseGitPushDetail } from '@/lib/git-push-approval';

/**
 * The part of the approval card that is specific to git_push: where the branch goes and the commits that would be sent, which the Hub worked out from the repository
 * (not the two names the model wrote). Renders nothing for a request that is not a push.
 */
export function GitPushPreview({ detail }: { detail: unknown }) {
  const { t } = useTranslation();
  const push = parseGitPushDetail(detail);
  if (!push) return null;
  return (
    <section data-testid="git-push-preview" aria-label={t('agents_apr_push_title')} className="space-y-2.5 rounded-lg border border-line bg-surface px-3 py-3 text-[13px]">
      <p className="flex items-center gap-1.5 font-medium text-fg"><GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('agents_apr_push_title')}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">{t('agents_apr_push_remote')}</dt>
        <dd className="break-all font-mono text-[12px]" data-testid="git-push-remote">{push.remote} <span className="text-faint">{push.url}</span></dd>
        <dt className="text-muted">{t('agents_apr_push_route')}</dt>
        <dd className="break-all font-mono text-[12px]" data-testid="git-push-route">
          {push.localBranch} → {push.remote}/{push.remoteBranch}
          {push.setUpstream && <span className="ml-1.5 font-sans text-faint">{t('agents_apr_push_upstream')}</span>}
        </dd>
      </dl>
      <p className="font-medium text-fg" data-testid="git-push-count">{t('agents_apr_push_commits', { count: push.commitCount })}</p>
      <ol className="max-h-56 space-y-0.5 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-[12px] leading-5" data-testid="git-push-commits">
        {push.commits.map((commit, index) => (
          <li key={`${commit.sha}-${index}`} className="flex flex-wrap gap-x-2">
            <code className="text-primary">{commit.sha}</code>
            <span className="min-w-0 break-words text-fg">{commit.subject}</span>
            <span className="text-faint">{[commit.author, commit.date.slice(0, 10)].filter(Boolean).join(' · ')}</span>
          </li>
        ))}
      </ol>
      {push.commitsOmitted > 0 && <p className="text-muted" data-testid="git-push-older">{t('agents_apr_push_older', { count: push.commitsOmitted })}</p>}
      <p className="text-muted" data-testid="git-push-changes">{t('agents_apr_push_changes', { files: push.files, insertions: push.insertions, deletions: push.deletions })}</p>
      {push.diffstat && (
        <details>
          <summary className="cursor-pointer text-muted hover:text-fg">{t('agents_apr_push_stat')}</summary>
          <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-2 font-mono text-[12px] leading-5">{push.diffstat}</pre>
        </details>
      )}
      <p className="text-[12px] text-faint">{t('agents_apr_push_note')}</p>
    </section>
  );
}
