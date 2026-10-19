import { useEffect, useRef, useState } from 'react';
import { Check, EyeOff, Eraser, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/Button';
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
    <section className="mx-4 my-3 rounded-xl border border-sky-500/50 bg-[var(--surface)] p-4 text-xs space-y-3" data-testid="outbound-review-card" data-review-id={review.id} aria-label="Xem lại trước khi gửi sang ChatGPT">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 font-semibold"><ShieldQuestion className="w-4 h-4 text-sky-400" aria-hidden="true" />Xem lại trước khi gửi sang ChatGPT</div>
          <p className="text-[var(--muted)]">Kết quả công cụ <span className="font-mono text-sky-300">{review.tool}</span> (gói #{review.turn}, {review.bytes} byte) đang được giữ trên máy bạn. <strong>Chưa có gì được gửi.</strong> Nội dung dưới đây là đúng văn bản sẽ được nhập vào cuộc chat nếu bạn duyệt.</p>
          {applied && <p className="text-[var(--muted)]" data-testid="outbound-review-applied">Đã tự động che: {applied}.</p>}
          {review.withheld.length > 0 && <p className="text-[var(--muted)]">Không gửi nội dung file được bảo vệ: {review.withheld.join(', ')}.</p>}
          {left !== null && <p className="text-[var(--muted)]">{expired ? 'Đã hết thời gian chờ: nhiệm vụ sẽ dừng và không gửi gì.' : <>Còn <time dateTime={review.expiresAt}>{formatCountdown(left)}</time> trước khi nhiệm vụ dừng mà không gửi gì.</>}</p>}
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="primary" disabled={disabled} aria-label="Approve and send" data-testid="outbound-review-approve" onClick={() => { void onDecide('approve'); }} className="gap-1"><Check className="w-3 h-3" />Duyệt và gửi</Button>
          <Button size="sm" variant="secondary" disabled={disabled} aria-label="Withhold this result" data-testid="outbound-review-withhold" onClick={() => { void onDecide('withhold'); }} className="gap-1"><EyeOff className="w-3 h-3" />Giữ lại, không gửi</Button>
        </div>
      </div>
      <pre ref={preview} data-testid="outbound-review-preview" className="p-3 bg-[var(--bg)] rounded overflow-auto whitespace-pre-wrap max-h-72 select-text"><code>{review.preview}</code></pre>
      <div className="space-y-1.5">
        <label htmlFor="outbound-review-extra" className="block text-[var(--muted)]">Che thêm: mỗi dòng một chuỗi (tối thiểu 3 ký tự). Chọn đoạn trong khung trên rồi nhấn "Thêm đoạn đang chọn".</label>
        <textarea id="outbound-review-extra" data-testid="outbound-review-extra" value={extra} onChange={(event) => setExtra(event.target.value)} rows={2} spellCheck={false}
          className="w-full rounded border border-[var(--line)] bg-[var(--bg)] p-2 font-mono" aria-label="Chuỗi cần che thêm, mỗi dòng một chuỗi" />
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="secondary" disabled={disabled} onClick={useSelection} data-testid="outbound-review-use-selection">Thêm đoạn đang chọn</Button>
          <Button size="sm" variant="secondary" disabled={disabled || !pending.length} aria-label="Redact more" data-testid="outbound-review-redact" onClick={async () => { await onDecide('redact_more', pending); setExtra(''); }} className="gap-1"><Eraser className="w-3 h-3" />Che thêm ({pending.length})</Button>
        </div>
      </div>
    </section>
  );
}
