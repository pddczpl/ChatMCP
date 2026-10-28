import { AlertTriangle } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { formatNumber } from '@/lib/format';

export interface ContextPolicy {
  source: string;
  capacityTokens: number;
  maxHistoryTokens: number;
  compactAtTokens?: number;
  /** What the request may generate (the cap the agent sends). */
  reservedOutputTokens: number;
  /** What the history budget keeps free; differs from the cap only when the window is unknown. */
  plannedOutputTokens?: number;
  approximate?: boolean;
}

/**
 * The context budget of a task. An unknown window is a warning that says what to do (and, with `onFix`, takes you there),
 * never a quiet "estimated". `lang` pins the language for a caller that has none from the app (tests); the app's language is the default.
 */
export function ContextPolicyNotice({ policy, onFix, lang: pinned }: { policy: ContextPolicy; onFix?: () => void; lang?: 'vi' | 'en' }) {
  const { lang: current } = useTranslation();
  const lang = pinned ?? current;
  const vi = lang === 'vi';
  const grouped = (value: number) => formatNumber(value, lang);
  const planned = policy.plannedOutputTokens ?? policy.reservedOutputTokens;
  const details = vi
    ? `Lịch sử: khoảng ${grouped(policy.maxHistoryTokens)} token. Đầu ra: yêu cầu có thể dùng tới ${grouped(policy.reservedOutputTokens)} token; lịch sử được lập cho ${grouped(planned)}. Nguồn: ${policy.source}. Chỉ là ước tính, không phải token nhà cung cấp tính phí.`
    : `History: about ${grouped(policy.maxHistoryTokens)} tokens. Output: the request may use up to ${grouped(policy.reservedOutputTokens)} tokens; history is planned for ${grouped(planned)}. Source: ${policy.source}. Estimates, not provider-billed usage.`;
  if (policy.source === 'conservative_fallback') {
    return (
      <div data-testid="context-window-warning" role="status" title={details}
        className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/[0.08] px-3 py-2 text-[13px] leading-5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-fg">
          {vi
            ? `Chưa biết cửa sổ ngữ cảnh của model — đang lập kế hoạch với ${grouped(policy.capacityTokens)} token. Đặt kích thước thật trong Cài đặt → Mô hình AI (hoặc trong hồ sơ model).`
            : `Context window unknown — planning with ${grouped(policy.capacityTokens)} tokens. Set the model's real size in Settings → AI model (or in its model profile).`}
        </span>
        {onFix && (
          <button type="button" onClick={onFix} className="shrink-0 font-medium text-primary hover:underline">
            {vi ? 'Mở cài đặt' : 'Open settings'}
          </button>
        )}
      </div>
    );
  }
  const origin = policy.source === 'trusted_model_metadata' ? (vi ? 'từ metadata của model' : 'from model metadata') : (vi ? 'đã cấu hình' : 'configured');
  return (
    <span title={details}>
      {vi ? 'Ngữ cảnh' : 'Context'}: {grouped(policy.capacityTokens)} {vi ? 'token' : 'tokens'} ({origin})
    </span>
  );
}
