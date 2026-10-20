import { useTranslation } from '@/lib/i18n';
import { SectionLoader, lazySection } from './LazySection';

// Each section is a script of its own, fetched the first time its tab is opened, so that the first screen carries neither. They are made once,
// here: what the Progress and Changes tabs share with them (IsolatedChecksPanel, DiffView) stays in the first script because those tabs import it.
const AgentGroups = lazySection(() => import('./AgentGroups'), 'AgentGroups');
const CodingWorkers = lazySection(() => import('./CodingWorkers'), 'CodingWorkers');

/**
 * Delegated work, in the work panel's Agents tab: groups of read-only helpers ('groups') and coding workers on their own Git branches
 * ('coding'). The Agents tab (AgentsTab.tsx) mounts one section at a time; each is its own component (AgentGroups.tsx, CodingWorkers.tsx) so
 * that it can be rendered alone, which is also how the tests reach it: a server render cannot wait for a script.
 */
export function OrchestratorTab({ section }: { section: 'groups' | 'coding' }) {
  const { t } = useTranslation();
  return (
    <SectionLoader label={t(section === 'groups' ? 'agents_view_groups' : 'agents_view_coding')}>
      {section === 'groups' ? <AgentGroups /> : <CodingWorkers />}
    </SectionLoader>
  );
}
