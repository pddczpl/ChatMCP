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
    <section className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-[var(--muted)]" data-testid={testId} role="note" aria-label={copy.title}>
      <div className="flex items-start gap-2">
        <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-amber-500">{copy.title}</p>
          <p>{copy.summary}</p>
          {compact
            ? <details><summary className="cursor-pointer text-[var(--primary)]">{lang === 'en' ? 'More' : 'Chi tiết'}</summary><ul className="list-disc pl-4 mt-1 space-y-1">{copy.points.map((point) => <li key={point}>{point}</li>)}</ul></details>
            : <ul className="list-disc pl-4 space-y-1">{copy.points.map((point) => <li key={point}>{point}</li>)}</ul>}
        </div>
      </div>
    </section>
  );
}
