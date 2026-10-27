import { TriangleAlert } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { CHATGPT_WEB_RISK } from '@/lib/outbound-review';

interface Props {
  testId: string;
  /** Settings shows the whole list at once; the task view keeps it to the summary and one click for the rest. */
  compact?: boolean;
}

/** The honest label for the ChatGPT Web Companion: what it automates, the Terms-of-Use risk and where the content goes. */
export function ChatGptWebRiskNote({ testId, compact = false }: Props) {
  const lang = useAppStore((state) => state.lang);
  const copy = CHATGPT_WEB_RISK[lang === 'en' ? 'en' : 'vi'];
  return (
    <section className="rounded-xl border border-warning/40 bg-warning/[0.06] px-4 py-3 text-[13px] leading-5 text-muted" data-testid={testId} role="note" aria-label={copy.title}>
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-warning">{copy.title}</p>
          <p>{copy.summary}</p>
          {compact
            ? <details><summary className="cursor-pointer font-medium text-primary">{lang === 'en' ? 'More' : 'Chi tiết'}</summary><ul className="mt-1 list-disc space-y-1 pl-4">{copy.points.map((point) => <li key={point}>{point}</li>)}</ul></details>
            : <ul className="list-disc space-y-1 pl-4">{copy.points.map((point) => <li key={point}>{point}</li>)}</ul>}
        </div>
      </div>
    </section>
  );
}
