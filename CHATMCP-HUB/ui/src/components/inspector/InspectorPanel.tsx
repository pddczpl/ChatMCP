import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { api } from '@/lib/api';
import { delegationTarget } from '@/lib/agent-proof';
import { nextTabIndex } from '@/lib/tab-keys';
import { useAppStore, type InspectorTab } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ActivityTab } from './ActivityTab';
import { AgentsTab } from './AgentsTab';
import { FilesTab } from './FilesTab';
import { GitTab } from './GitTab';
import { TerminalTab } from './TerminalTab';
import { PlanTab } from './PlanTab';
import { PreviewTab } from './PreviewTab';

/** Tabs that are always in the strip. The activity log and the preview are used less: they sit under "More" until chosen. */
const PRIMARY: InspectorTab[] = ['plan', 'changes', 'files', 'terminal', 'agents'];
const OVERFLOW: InspectorTab[] = ['activity', 'preview'];

export function InspectorPanel() {
  const { activeTab, setActiveTab, selectedWorkspacePath } = useAppStore();
  const { t } = useTranslation();
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const labels: Record<InspectorTab, string> = {
    plan: t('tab_progress'),
    changes: t('tab_changes'),
    files: t('tab_files'),
    terminal: t('tab_terminal'),
    activity: t('tab_activity'),
    agents: t('tab_agents'),
    preview: t('tab_preview'),
  };
  const visible = OVERFLOW.includes(activeTab) ? [...PRIMARY, activeTab] : PRIMARY;
  const hidden = OVERFLOW.filter(tab => !visible.includes(tab));

  // The independent second-workspace case: file, Git and terminal tools stay bound to the primary workspace.
  const differentRoot = delegationTarget({ selectedWorkspacePath, activePath: hub?.workspaces?.activePath ?? undefined, primaryPath: hub?.workspace?.path ?? undefined }).blocked;

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') setMenuOpen(false); return; }
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [menuOpen]);

  // Keep the chosen tab in view when the strip scrolls (narrow panel).
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const next = nextTabIndex(event.key, visible.indexOf(activeTab), visible.length);
    if (next === null) return;
    event.preventDefault();
    setActiveTab(visible[next]);
    stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  const blocked = differentRoot && activeTab !== 'agents';

  return (
    <aside aria-label={t('inspector_nav')} className="flex h-full w-full min-w-0 flex-col border-l border-line bg-panel select-none">
      <div className="flex shrink-0 items-center border-b border-line px-1.5">
        <div ref={stripRef} role="tablist" aria-label={t('inspector_nav')} onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {visible.map(tab => {
            const selected = activeTab === tab;
            return (
              <button key={tab} type="button" role="tab" id={`inspector-tab-${tab}`} aria-selected={selected} aria-controls="inspector-tabpanel"
                tabIndex={selected ? 0 : -1} onClick={() => setActiveTab(tab)}
                className={cn(
                  'relative h-11 shrink-0 whitespace-nowrap px-2 text-[13px] font-medium transition-colors',
                  selected ? 'text-fg' : 'text-muted hover:text-fg',
                  'after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors',
                  selected ? 'after:bg-primary' : 'after:bg-transparent',
                )}>
                {labels[tab]}
              </button>
            );
          })}
        </div>
        {hidden.length > 0 && (
          <div ref={menuRef} className="relative shrink-0">
            <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('tab_more')} title={t('tab_more')}
              onClick={() => setMenuOpen(open => !open)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg">
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div role="menu" className="anim-pop absolute right-0 top-full z-50 mt-1 min-w-36 rounded-xl border border-line bg-panel p-1 shadow-[var(--shadow-pop)]">
                {hidden.map(tab => (
                  <button key={tab} type="button" role="menuitem" onClick={() => { setMenuOpen(false); setActiveTab(tab); }}
                    className="flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] text-fg transition-colors hover:bg-hover">
                    {labels[tab]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div id="inspector-tabpanel" role="tabpanel" aria-labelledby={`inspector-tab-${activeTab}`} className="min-h-0 flex-1 overflow-hidden">
        {blocked ? (
          <div role="status" className="space-y-2 p-4 text-[13px] text-muted">
            <p className="font-semibold text-fg">Workspace Inspector</p>
            <p>{t('insp_blocked_a')}</p>
            <p>{t('insp_blocked_b', { tab: labels.agents })}</p>
          </div>
        ) : (
          <>
            {activeTab === 'plan' && <PlanTab />}
            {activeTab === 'changes' && <GitTab />}
            {activeTab === 'files' && <FilesTab />}
            {activeTab === 'terminal' && <TerminalTab />}
            {activeTab === 'activity' && <ActivityTab />}
            {activeTab === 'agents' && <AgentsTab />}
            {activeTab === 'preview' && <PreviewTab />}
          </>
        )}
      </div>
    </aside>
  );
}
