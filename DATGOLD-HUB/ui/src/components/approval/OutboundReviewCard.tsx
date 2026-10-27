import { useEffect, useRef, useState } from 'react';
import { Check, EyeOff, Eraser, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';
import { describeRedactions, formatCountdown, parseRedactionInput, secondsLeft } from '@/lib/outbound-review';
import type { OutboundReview } from '@/types';

export type ReviewAction = 'approve' | 'redact_more' | 'withhold';

interface Props {
  review: OutboundReview;
  onDecide: (action: ReviewAction, redact?: string[]) => void | Promise<void>;
  busy?: boolean;
}

/**
 * "Review before send": the tool result is held on this computer and nothing has been sent to chatgpt.com. The person reads the
 * exact text, can hide more of it, withhold it (ChatGPT then receives only a notice) or approve it. Nothing is sent until then.
 */
export function OutboundReviewCard({ review, onDecide, busy }: Props) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const [extra, setExtra] = useState('');
  const preview = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = secondsLeft(review.expiresAt, now);
  const expired = left === 0;
  const disabled = busy || expired;
  const pending = parseRedactionInput(extra);
  const applied = describeRedactions(review.redactions);

  // A selection made inside the preview becomes a line of the "redact more" box.
  const useSelection = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!text || !preview.current || !selection?.anchorNode || !preview.current.contains(selection.anchorNode)) return;
    setExtra((current) => (current ? `${current.replace(/\s+$/, '')}\n${text}` : text));
  };

  return (
    <section className="anim-rise my-4 space-y-3 rounded-xl border border-primary/50 bg-panel p-4 text-[13px] leading-5" data-testid="outbound-review-card" data-review-id={review.id} aria-label={t('agents_out_title')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-[14px] font-semibold"><ShieldQuestion className="h-4 w-4 text-primary" aria-hidden="true" />{t('agents_out_title')}</div>
          <p className="text-muted">{t('agents_out_held_1')} <span className="font-mono text-primary">{review.tool}</span> {t('agents_out_held_2', { turn: review.turn, bytes: review.bytes })} <strong>{t('agents_out_held_3')}</strong> {t('agents_out_held_4')}</p>
          {applied && <p className="text-muted" data-testid="outbound-review-applied">{t('agents_out_applied', { applied })}</p>}
          {review.withheld.length > 0 && <p className="text-muted">{t('agents_out_withheld', { files: review.withheld.join(', ') })}</p>}
          {left !== null && <p className="text-muted">{expired ? t('agents_out_expired') : <>{t('agents_out_left_1')} <time dateTime={review.expiresAt}>{formatCountdown(left)}</time> {t('agents_out_left_2')}</>}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={disabled} aria-label={t('agents_out_approve_name')} data-testid="outbound-review-approve" onClick={() => { void onDecide('approve'); }} className="gap-1"><Check className="h-3.5 w-3.5" />{t('agents_out_approve')}</Button>
          <Button size="sm" variant="secondary" disabled={disabled} aria-label={t('agents_out_withhold_name')} data-testid="outbound-review-withhold" onClick={() => { void onDecide('withhold'); }} className="gap-1"><EyeOff className="h-3.5 w-3.5" />{t('agents_out_withhold')}</Button>
        </div>
      </div>
      <pre ref={preview} data-testid="outbound-review-preview" className="max-h-72 select-text overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 font-mono text-[12px] leading-5"><code>{review.preview}</code></pre>
      <div className="space-y-1.5">
        <label htmlFor="outbound-review-extra" className="block text-muted">{t('agents_out_extra_help')}</label>
        <textarea id="outbound-review-extra" data-testid="outbound-review-extra" value={extra} onChange={(event) => setExtra(event.target.value)} rows={2} spellCheck={false}
          className="w-full rounded-lg border border-line bg-bg p-2 font-mono text-[12px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25" aria-label={t('agents_out_extra_label')} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={disabled} onClick={useSelection} data-testid="outbound-review-use-selection">{t('agents_out_use_selection')}</Button>
          <Button size="sm" variant="secondary" disabled={disabled || !pending.length} aria-label={t('agents_out_redact_name')} data-testid="outbound-review-redact" onClick={async () => { await onDecide('redact_more', pending); setExtra(''); }} className="gap-1"><Eraser className="h-3.5 w-3.5" />{t('agents_out_redact', { n: pending.length })}</Button>
        </div>
      </div>
    </section>
  );
}
