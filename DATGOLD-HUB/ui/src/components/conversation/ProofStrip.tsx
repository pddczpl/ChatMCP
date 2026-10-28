import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CircleDashed, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { assessProof, type ProofKind, type ProofTone, type RecordedCheck } from '@/lib/proof';
import { cn } from '@/lib/utils';
import type { Task } from '@/types';

const tones: Record<ProofTone, { box: string; icon: string }> = {
  success: { box: 'border-success/30 bg-success/[0.06]', icon: 'text-success' },
  warning: { box: 'border-warning/30 bg-warning/[0.06]', icon: 'text-warning' },
  danger: { box: 'border-danger/30 bg-danger/[0.06]', icon: 'text-danger' },
};

const icons: Record<ProofKind, LucideIcon> = {
  errors: XCircle,
  accepted: ShieldCheck,
  'checks-verified': ShieldCheck,
  incomplete: AlertTriangle,
  'unverified-run': CircleDashed,
  'no-evidence': CircleDashed,
};

/** The strip under a finished turn: reported done, or proven done, from what the Hub recorded (see lib/proof.ts). */
export function ProofStrip({ task }: { task: Task }) {
  const { lang } = useTranslation();
  const vi = lang === 'vi';
  const { setActiveTab } = useAppStore();
  const { data } = useQuery({
    queryKey: ['verification-evidence', task.id],
    queryFn: () => api.getVerifications(task.id),
    enabled: Boolean(task.id),
    refetchInterval: 4000,
  });
  const runs: RecordedCheck[] = Array.isArray(data?.runs) ? data.runs : [];
  const proof = assessProof(task, runs, vi);
  if (!proof) return null;

  const style = tones[proof.tone];
  const Icon = icons[proof.kind];
  return (
    <section aria-label={vi ? 'Bằng chứng của lượt này' : 'Evidence for this turn'} data-testid="proof-strip" data-tone={proof.tone} data-kind={proof.kind}
      className={cn('anim-rise my-4 rounded-xl border px-4 py-3', style.box)}>
      <div className="flex items-start gap-3">
        <Icon className={cn('mt-0.5 h-[18px] w-[18px] shrink-0', style.icon)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h4 className={cn('text-[14px] font-semibold leading-5', style.icon)}>{proof.title}</h4>
            {proof.chips.map(chip => (
              <span key={chip} className="inline-flex items-center rounded-full border border-line bg-panel px-2 py-0.5 text-[12px] font-medium text-muted">{chip}</span>
            ))}
          </div>
          <p className="mt-1 text-[13px] leading-5 text-muted">{proof.note}</p>
        </div>
        <button type="button" onClick={() => setActiveTab('plan')}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-primary transition-colors hover:bg-hover">
          {vi ? 'Xem bằng chứng' : 'View evidence'}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </section>
  );
}
