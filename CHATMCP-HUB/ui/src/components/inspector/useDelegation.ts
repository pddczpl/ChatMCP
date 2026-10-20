import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { delegationTarget } from '@/lib/agent-proof';
import { useAppStore } from '@/store/useAppStore';

/**
 * Where delegated work would act and what the Hub is doing right now. Read-only groups and coding workers use the Hub's own project folder;
 * the permission mode decides whether the Hub accepts coding workers at all (it refuses them unless the mode is Autonomous), and it refuses
 * them, an analysis or a group while the main agent, a group, a coding run or a model change is going on. The page says so before the click.
 */
export function useDelegation() {
  const selectedWorkspacePath = useAppStore((state) => state.selectedWorkspacePath);
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const { data: coding } = useQuery({ queryKey: ['coding-runs'], queryFn: api.getCodingRuns, refetchInterval: 3000 });
  const target = delegationTarget({ selectedWorkspacePath, activePath: hub?.workspaces?.activePath ?? undefined, primaryPath: hub?.workspace?.path ?? undefined });
  const permissions = hub?.studio?.permissions;
  return {
    ...target,
    /** The Hub's permission mode ('readonly' | 'review' | 'autonomous'); full access is a policy on top of Autonomous. */
    mode: permissions?.mode as string | undefined,
    fullAccess: permissions?.executionPolicy === 'full-access',
    /** The main agent is working on a task. */
    agentBusy: Boolean(hub?.agent?.activeTaskId || hub?.taskId),
    /** A group of read-only helpers is running. */
    groupRunning: hub?.studio?.delegates?.running === true,
    /** The AI connection (provider, model, key) is being changed. */
    aiBusy: hub?.ai?.busy === true,
    /** A coding run is going on. */
    codingActive: Boolean(coding?.activeRunId),
  };
}
