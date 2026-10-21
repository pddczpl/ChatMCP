import { AlertTriangle, Bot, CircleDashed, CircleSlash, Hourglass, Loader2, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react';
import { useTranslation, type TranslationKey, type Translate } from '@/lib/i18n';
import '@/lib/i18n-agents-sections'; // the strings only the sections ask for load with them
import type { AgentTone, ReportKind, VerificationNote, WorkerProofKind } from '@/lib/agent-proof';
import type { DraftIssue } from '@/lib/agent-draft';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { hasHidden } from '@/lib/hidden-chars';
import { HiddenNote, HiddenText } from './HiddenText';

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
  'awaiting-grant': Hourglass,
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
      <HiddenNote show={hasHidden(text)} />
      <p className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line-subtle bg-panel px-3 py-2 text-[13px] leading-5 text-fg select-text"><HiddenText text={text} /></p>
    </div>
  );
}

/**
 * The line for a note the Hub sent about how a worker's verification ended, in the language on screen. Each code the Hub sends has its line
 * (tests/agent-errors.test.mjs keeps the two lists equal); a code this page has no line for is shown as the Hub wrote it, and so is a "blocked"
 * note that has lost its reason.
 */
export function hubNoteText(note: VerificationNote, t: Translate): string {
  if (note.code === 'blocked' && !note.detail) return note.text ?? '';
  switch (note.code) {
    case 'no_checks': return t('agent_hub_note_no_checks');
    case 'grant_timeout': return t('agent_hub_note_grant_timeout');
    case 'blocked': return t('agent_hub_note_blocked', { reason: note.detail ?? '' });
    case 'verified': return t('agent_hub_note_verified');
    default: return note.text ?? '';
  }
}

/**
 * The Hub's own note about a worker, kept apart from the AI's report and labelled as the Hub's: plain text beside the evidence line, in no colour
 * of proof. Whether it may be shown at all is decided by `hubNoteOf` (lib/agent-proof.ts), which holds back the note that repeats the evidence.
 */
export function HubNote({ note }: { note: VerificationNote | null }) {
  const { t } = useTranslation();
  const text = note ? hubNoteText(note, t) : '';
  if (!note || !text) return null;
  return (
    <div className="space-y-0.5">
      <HiddenNote show={hasHidden(text)} />
      <p data-testid="hub-note" data-code={note.code} className="text-[12px] leading-4 text-muted select-text">
        <span className="font-medium text-fg">{t('agent_hub_note_label')}</span>{' '}<HiddenText text={text} />
      </p>
    </div>
  );
}

/** A line under a heading that is information, not an error: the folder delegated work acts on, or why it cannot run. */
export function NoticeLine({ tone = 'warning', role = 'status', testId, children, className }: { tone?: 'warning' | 'danger' | 'neutral'; role?: 'status' | 'alert'; testId?: string; children: React.ReactNode; className?: string }) {
  const style = boxes[tone];
  return <div role={role} data-tone={tone} data-testid={testId} className={cn('rounded-lg border px-3 py-2 text-[13px] leading-5', style.box, tone === 'neutral' ? 'text-muted' : 'text-fg', className)}>{children}</div>;
}

/** Why the Hub left a file out of a preview, in the language on screen; a reason this page does not know is shown as the Hub wrote it. */
export function skipReasonText(reason: string, t: Translate): string {
  switch (reason) {
    case 'sensitive_path': return t('coding_skip_sensitive_path');
    case 'file_limit': return t('coding_skip_file_limit');
    case 'deleted': return t('coding_skip_deleted');
    case 'too_large': return t('coding_skip_too_large');
    case 'binary': return t('coding_skip_binary');
    case 'invalid_utf8': return t('coding_skip_invalid_utf8');
    default: return reason;
  }
}

/** The sentence for one thing a form found wrong (lib/agent-draft.ts), in the language on screen. */
export function issueMessage(issue: DraftIssue, t: Translate): string {
  return t(`agent_draft_${issue.field}_${issue.code}` as TranslationKey, { max: issue.max ?? '', id: issue.detail ?? '' });
}

/**
 * What a form found wrong with one field. It is the field's description (the field points at it with aria-describedby), read when the field
 * is reached; it is not an alert, which would be announced again on every key typed.
 */
export function FieldIssues({ id, issues }: { id: string; issues: DraftIssue[] }) {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  return (
    <div id={id} className="space-y-0.5">
      {issues.map((issue) => <p key={`${issue.field}-${issue.code}-${issue.detail ?? ''}`} data-testid="field-issue" className="text-[12px] text-danger">{issueMessage(issue, t)}</p>)}
    </div>
  );
}

/** Which folder delegated work acts on; when the work panel shows another one, the reason the controls below are off. */
export function DelegationNotice({ blocked, primary, viewing }: { blocked: boolean; primary: string; viewing: string }) {
  const { t } = useTranslation();
  if (blocked) return <NoticeLine>{t('agents_other_folder', { primary, viewing })}</NoticeLine>;
  return primary ? <p className="break-all text-[12px] leading-4 text-faint">{t('agents_works_on', { folder: primary })}</p> : null;
}
