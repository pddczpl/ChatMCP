import { AgentGroups } from './AgentGroups';
import { CodingWorkers } from './CodingWorkers';

/**
 * Delegated work, in the work panel's Agents tab: groups of read-only helpers ('groups') and coding workers on their own Git branches
 * ('coding'). The Agents tab (AgentsTab.tsx) mounts one section at a time; each is its own component so that it can be rendered alone.
 */
export function OrchestratorTab({ section }: { section: 'groups' | 'coding' }) {
  return section === 'groups' ? <AgentGroups /> : <CodingWorkers />;
}
