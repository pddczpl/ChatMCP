import { Puzzle } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { describeSkillSelection } from '@/lib/skill-selection';
import type { Task } from '@/types';

/**
 * Under a finished turn: which skills the Hub took for this run and on what grounds (a word of the request, the Vietnamese phrase it was read from, the words of the skill's
 * description, the kind of project, an earlier message), or why it took none, with the skill that came closest. A record of what the Hub did, never a proof: it is drawn like any
 * other note and never in the colours of the evidence strip, because a skill being taken is not a skill being followed (lib/skill-selection.ts). Nothing is drawn for a task that
 * has no record. `lang` pins the language for a caller that has none from the app (tests); the app's language is the default.
 */
export function SkillSelectionNote({ task, lang: pinned }: { task: Pick<Task, 'skillSelection'>; lang?: 'vi' | 'en' }) {
  const { lang: current } = useTranslation();
  const lang = pinned ?? current;
  const view = describeSkillSelection(task.skillSelection, lang);
  if (!view) return null;
  return (
    <section aria-label={view.headline} data-testid="skill-selection-note" data-kind={view.kind}
      className="my-3 rounded-lg border border-line bg-panel px-3 py-2 text-[12px] leading-5 text-muted">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Puzzle className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
        <span className="font-medium text-fg">{view.headline}</span>
      </div>
      {view.skills.length > 0 && (
        <ul className="mt-1 space-y-1" data-testid="skill-selection-skills">
          {view.skills.map((skill, index) => (
            <li key={`${skill.id}:${index}`} data-testid="skill-selection-skill" className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-fg">{skill.name}</span>
              {skill.reasons.length > 0 && <span>{skill.reasons.join(' · ')}</span>}
            </li>
          ))}
        </ul>
      )}
      {view.nearest && <p className="mt-1" data-testid="skill-selection-nearest">{view.nearest}</p>}
      {view.project && <p className="mt-1" data-testid="skill-selection-project">{view.project}</p>}
      <p className="mt-1">{view.note}</p>
    </section>
  );
}
