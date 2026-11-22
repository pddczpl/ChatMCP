import { History } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { describeResume } from '@/lib/resume-chip';
import type { Task } from '@/types';

/**
 * Beside the model profile: how the latest run of this conversation started when it continued an earlier one (lib/resume-chip.ts), every number on hover. Drawn in
 * the warning tone when a prior call has no recorded result or an operation is unverified. Nothing is drawn for a conversation that did not resume. `lang` pins the
 * language for a caller that has none from the app (tests); the app's language is the default.
 */
export function ResumeChip({ task, lang: pinned }: { task: Pick<Task, 'resumeMode' | 'resume'>; lang?: 'vi' | 'en' }) {
  const { lang: current } = useTranslation();
  const view = describeResume(task, pinned ?? current);
  if (!view) return null;
  return (
    <span data-testid="resume-chip" data-mode={view.mode} data-attention={String(view.attention)} title={view.title}
      className={`inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] ${view.attention ? 'text-warning' : 'text-muted'}`}>
      <History className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{view.text}</span>
    </span>
  );
}
