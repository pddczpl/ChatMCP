import { FileText } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { describeTurn } from '@/lib/project-instructions';
import type { Task } from '@/types';

/**
 * Under a finished turn: which project instruction files (AGENTS.md, CLAUDE.md) the Hub put into the instructions of this run, how much of each, and the skills the model
 * read on demand. A record of what the Hub did, never a proof: it is drawn like any other note and never in the colours of the evidence strip, because being loaded is not
 * being followed (lib/project-instructions.ts). Nothing is drawn for a task that has no record, and for a workspace that has no such file.
 * `lang` pins the language for a caller that has none from the app (tests); the app's language is the default.
 */
export function ProjectInstructionsNote({ task, lang: pinned }: { task: Pick<Task, 'projectInstructions' | 'events'>; lang?: 'vi' | 'en' }) {
  const { lang: current } = useTranslation();
  const lang = pinned ?? current;
  const view = describeTurn(task, lang);
  if (!view) return null;
  return (
    <section aria-label={view.headline} data-testid="project-instructions-note" data-kind={view.kind} title={view.note}
      className="my-3 rounded-lg border border-line bg-panel px-3 py-2 text-[12px] leading-5 text-muted">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <FileText className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
        <span className="font-medium text-fg">{view.headline}</span>
        {view.files.map(file => (
          <span key={file} data-testid="project-instructions-file" className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-fg">{file}</span>
        ))}
      </div>
      {view.skills.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="project-instructions-skills">
          <span className="font-medium text-fg">{view.skillsLabel}</span>
          {view.skills.map(skill => (
            <span key={skill} className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-fg">{skill}</span>
          ))}
        </div>
      )}
      <p className="mt-1">{view.note}</p>
    </section>
  );
}
