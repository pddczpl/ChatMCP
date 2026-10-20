import { AlertTriangle, Bot, CircleDashed, CircleSlash, Loader2, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react';
import { useTranslation, type TranslationKey, type Translate } from '@/lib/i18n';
import type { AgentTone, ReportKind, WorkerProofKind } from '@/lib/agent-proof';
import type { DraftIssue } from '@/lib/agent-draft';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';

type ProofKind = WorkerProofKind | ReportKind;

const boxes: Record<AgentTone, { box: string; text: string }> = {
  success: { box: 'border-success/30 bg-success/[0.06]', text: 'text-success' },
  warning: { box: 'border-warning/30 bg-warning/[0.06]', text: 'text-warning' },
  danger: { box: 'border-danger/30 bg-danger/[0.06]', text: 'text-danger' },
  neutral: { box: 'border-line bg-surface', text: 'text-muted' },
};

const icons: Record<ProofKind, LucideIcon> = {
  verified: ShieldCheck,
  unverified: CircleDashed,
  'check-failed': XCircle,
  attention: AlertTriangle,
  failed: XCircle,
  stopped: CircleSlash,
  working: Loader2,
  'no-changes': CircleDashed,
  'ai-report': Bot,
};

/** The title and the note of a kind, in the language on screen ('check-failed' is stored as agent_proof_check_failed_title). */
export function proofText(kind: ProofKind, t: Translate): { title: string; note: string } {
  const stem = kind.replace(/-/g, '_');
  return { title: t(`agent_proof_${stem}_title` as TranslationKey), note: t(`agent_proof_${stem}_note` as TranslationKey) };
}

/**
 * What the Hub's own record says about a worker or a report. The tone is the evidence rule (lib/agent-proof.ts): green appears only here
 * and only for a check the Hub verified; the title says "AI reported" whenever the claim is the AI's.
 */
export function EvidenceLine({ tone, kind, facts, className }: { tone: AgentTone; kind: ProofKind; facts?: string; className?: string }) {
  const { t } = useTranslation();
  const { title, note } = proofText(kind, t);
  const Icon = icons[kind];
  const style = boxes[tone];
  return (
    <div data-testid="agent-proof" data-tone={tone} data-kind={kind} className={cn('rounded-lg border px-3 py-2', style.box, className)}>
      <div className="flex items-start gap-2">
        <Icon aria-hidden="true" className={cn('mt-0.5 h-4 w-4 shrink-0', style.text, kind === 'working' && 'animate-spin')} />
        <div className="min-w-0 space-y-0.5">
          <p className={cn('text-[13px] font-semibold leading-5', style.text)}>{title}</p>
          <p className="text-[12px] leading-4 text-muted">{note}</p>
          {facts && <p className="text-[12px] leading-4 text-muted">{facts}</p>}
        </div>
      </div>
    </div>
  );
}

const badgeVariants: Record<AgentTone, 'success' | 'warning' | 'danger' | 'neutral'> = { success: 'success', warning: 'warning', danger: 'danger', neutral: 'neutral' };

/** A status word with the colour of the evidence rule: the word is what the Hub reported, the colour is what the Hub proved. */
export function StatusBadge({ tone, children }: { tone: AgentTone; children: React.ReactNode }) {
  return <Badge variant={badgeVariants[tone]} data-tone={tone}>{children}</Badge>;
}

/** Text an AI wrote, kept apart from what the Hub recorded and labelled as the AI's. */
export function AiReport({ text, label, className }: { text: string; label?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid="ai-report" className={cn('space-y-1', className)}>
      <p className="text-[12px] font-medium text-muted">{label ?? t('agent_report_label')}</p>
      <p className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line-subtle bg-panel px-3 py-2 text-[13px] leading-5 text-fg select-text">{text}</p>
    </div>
  );
}

/** A line under a heading that is information, not an error: the folder delegated work acts on, or why it cannot run. */
export function NoticeLine({ tone = 'warning', role = 'status', testId, children, className }: { tone?: 'warning' | 'danger' | 'neutral'; role?: 'status' | 'alert'; testId?: string; children: React.ReactNode; className?: string }) {
  const style = boxes[tone];
  return <div role={role} data-tone={tone} data-testid={testId} className={cn('rounded-lg border px-3 py-2 text-[13px] leading-5', style.box, tone === 'neutral' ? 'text-muted' : 'text-fg', className)}>{children}</div>;
}

/** The sentence for one thing a form found wrong (lib/agent-draft.ts), in the language on screen. */
export function issueMessage(issue: DraftIssue, t: Translate): string {
  return t(`agent_draft_${issue.field}_${issue.code}` as TranslationKey, { max: issue.max ?? '', id: issue.detail ?? '' });
}

/** Which folder delegated work acts on; when the work panel shows another one, the reason the controls below are off. */
export function DelegationNotice({ blocked, primary, viewing }: { blocked: boolean; primary: string; viewing: string }) {
  const { t } = useTranslation();
  if (blocked) return <NoticeLine>{t('agents_other_folder', { primary, viewing })}</NoticeLine>;
  return primary ? <p className="break-all text-[12px] leading-4 text-faint">{t('agents_works_on', { folder: primary })}</p> : null;
}
