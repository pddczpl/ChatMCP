import { useEffect, useRef, useState } from 'react';
import { useTranslation, type TranslationKey } from '@/lib/i18n';
import { nextTabIndex } from '@/lib/tab-keys';
import { cn } from '@/lib/utils';
import { BackgroundTasks } from '@/components/layout/BackgroundTasks';
import { OrchestratorTab } from './OrchestratorTab';

export type AgentsView = 'background' | 'groups' | 'coding';
const VIEWS: { id: AgentsView; label: TranslationKey }[] = [
  { id: 'background', label: 'agents_view_background' },
  { id: 'groups', label: 'agents_view_groups' },
  { id: 'coding', label: 'agents_view_coding' },
];

/**
 * The work panel's Agents tab: what is running in the background, and where the owner hands out work. A section switch (a tablist, with
 * the same keys as the panel's own) instead of one long page; background tasks come first so the tab opens on what it always showed.
 */
export function AgentsTab({ initialView = 'background' }: { initialView?: AgentsView }) {
  const { t } = useTranslation();
  const [view, setView] = useState<AgentsView>(initialView);
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep the chosen section in view when the switch scrolls (a narrow panel).
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [view]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const next = nextTabIndex(event.key, VIEWS.findIndex((item) => item.id === view), VIEWS.length);
    if (next === null) return;
    event.preventDefault();
    setView(VIEWS[next].id);
    stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-3 py-2">
        <div ref={stripRef} role="tablist" aria-label={t('agents_views_label')} onKeyDown={onKeyDown}
          className="flex gap-0.5 overflow-x-auto rounded-lg border border-line bg-surface p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {VIEWS.map(({ id, label }) => {
            const selected = id === view;
            return (
              <button key={id} type="button" role="tab" id={`agents-view-${id}`} aria-selected={selected} aria-controls="agents-viewpanel"
                tabIndex={selected ? 0 : -1} onClick={() => setView(id)}
                className={cn('h-7 flex-1 shrink-0 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors',
                  selected ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg')}>
                {t(label)}
              </button>
            );
          })}
        </div>
      </div>
      <div id="agents-viewpanel" role="tabpanel" aria-labelledby={`agents-view-${view}`} className="min-h-0 flex-1 overflow-hidden">
        {view === 'background' && <BackgroundTasks />}
        {view === 'groups' && <OrchestratorTab section="groups" />}
        {view === 'coding' && <OrchestratorTab section="coding" />}
      </div>
    </div>
  );
}
