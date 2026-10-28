import { useState, useEffect } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';
import { diffLines } from 'diff';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useTranslation, type TranslationKey } from '@/lib/i18n';
import { formatTime } from '@/lib/format';
import { riskInfo } from '@/lib/tool-labels';
import { cn } from '@/lib/utils';
import type { ApprovalView } from '@/lib/task-view';

export type PendingApproval = ApprovalView;
interface ApprovalStackProps {
  approvals: PendingApproval[];
  onApprove: (id: string) => void | Promise<void>;
  onDeny: (id: string, reason?: string) => void | Promise<void>;
  busy?: boolean;
}
const decisionKeys: Record<string, TranslationKey> = { approved: 'agents_apr_approved', denied: 'agents_apr_denied', expired: 'agents_apr_expired', cancelled: 'agents_apr_cancelled', blocked: 'agents_apr_blocked', policy: 'agents_apr_policy' };

const countdown = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** What the agent wants to do, how risky it is, exactly what would change, and the two buttons. */
export function ApprovalStack({ approvals, onApprove, onDeny, busy }: ApprovalStackProps) {
  const { lang, t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const [confirmDeny, setConfirmDeny] = useState<string | null>(null);
  useEffect(() => {
    if (!approvals.some(item => !item.decision && item.expiresAt)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approvals]);
  if (!approvals.length) return null;
  return (
    <div className="my-4 space-y-4">
      {approvals.map(item => {
        const expiresAt = item.expiresAt ? Date.parse(item.expiresAt) : NaN;
        const expired = Number.isFinite(expiresAt) && expiresAt <= now;
        const decision = item.decision || (expired ? 'expired' : undefined);
        const disabled = !!decision || busy;
        const diffs = item.oldContent !== undefined && item.newContent !== undefined ? diffLines(item.oldContent, item.newContent) : null;
        const risk = riskInfo(item.risk, lang);
        const pending = !decision;
        return (
          <section key={item.id} aria-label={t('agents_apr_title', { tool: item.tool })} data-approval-id={item.id}
            className={cn('anim-rise overflow-hidden rounded-xl border bg-panel select-text', pending ? 'border-warning/50' : 'border-line')}>
            <header className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5', pending ? 'border-warning/30 bg-warning/[0.08]' : 'border-line-subtle bg-surface')}>
              <ShieldAlert className={cn('h-4 w-4 shrink-0', pending ? 'text-warning' : 'text-muted')} />
              <span className="text-[14px] font-semibold">{decision ? (decisionKeys[decision] ? t(decisionKeys[decision]) : decision) : t('agents_apr_request')}</span>
              <Badge variant={risk.level === 'high' ? 'danger' : risk.level === 'medium' ? 'warning' : 'neutral'}>{risk.levelLabel}</Badge>
              {pending && Number.isFinite(expiresAt) && (
                <span className="ml-auto text-[12px] tabular-nums text-muted" title={item.expiresAt ? `${t('agents_apr_expires_at')} ${formatTime(item.expiresAt, lang)}` : undefined}>
                  {t('agents_apr_auto_deny')} {countdown(expiresAt - now)}
                </span>
              )}
            </header>

            <div className="space-y-3 px-4 py-3.5">
              <div className="space-y-1">
                <p className="text-[14px] font-medium leading-5 text-fg">{item.description}</p>
                <p className="font-mono text-[12px] text-primary">{item.tool}</p>
                <p className="text-[13px] text-muted">{t('agents_apr_risk')} <span className="font-medium text-fg">{risk.label}</span> <code className="ml-1 text-[12px] text-faint">{item.risk}</code></p>
                {item.reason && item.reason !== item.description && <p className="text-[13px] text-muted">{item.reason}</p>}
                {item.expiresAt && (
                  <p className="text-[12px] text-faint">{t('agents_apr_expires')} <time dateTime={item.expiresAt}>{formatTime(item.expiresAt, lang)}</time></p>
                )}
              </div>

              {item.targetPath && <p className="break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12px] text-fg">{item.targetPath}</p>}
              {item.command && <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 text-[12px] leading-5"><code>{item.command}</code></pre>}
              {diffs && (
                <div className="max-h-64 overflow-auto rounded-lg border border-line bg-bg font-mono text-[12px] leading-5" aria-label={t('agents_apr_diff')}>
                  {diffs.map((part, index) => (
                    <pre key={index} className={cn('whitespace-pre-wrap border-l-2 px-3 py-0.5',
                      part.added ? 'border-success bg-success/10 text-success' : part.removed ? 'border-danger bg-danger/10 text-danger' : 'border-transparent text-muted')}>
                      {part.added ? '+ ' : part.removed ? '- ' : '  '}{part.value}
                    </pre>
                  ))}
                </div>
              )}
              {item.diff && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 font-mono text-[12px] leading-5">{item.diff}</pre>}
              {item.detail && (
                <details className="text-[13px]">
                  <summary className="cursor-pointer text-muted hover:text-fg">{t('agents_apr_details')}</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 font-mono text-[12px] leading-5">{JSON.stringify(item.detail, null, 2)}</pre>
                </details>
              )}
              {!item.detail && item.preview && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 font-mono text-[12px] leading-5">{item.preview}</pre>}
            </div>

            <footer className="flex items-center justify-end gap-2 border-t border-line-subtle bg-surface px-4 py-3">
              {confirmDeny === item.id && !decision && (
                <Button size="sm" variant="danger" disabled={disabled} onClick={() => void onDeny(item.id)}>{t('agents_apr_confirm_deny')}</Button>
              )}
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => { if (!disabled) { if (confirmDeny === item.id) void onDeny(item.id); else setConfirmDeny(item.id); } }} className="gap-1">
                <X className="h-3.5 w-3.5" />{t('agents_apr_deny')}
              </Button>
              <Button size="sm" variant="primary" disabled={disabled} onClick={() => { if (!disabled) void onApprove(item.id); }} className="gap-1">
                <Check className="h-3.5 w-3.5" />{t('agents_apr_approve')}
              </Button>
            </footer>
          </section>
        );
      })}
    </div>
  );
}
