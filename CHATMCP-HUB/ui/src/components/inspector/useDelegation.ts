import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { delegationTarget } from '@/lib/agent-proof';
import { useAppStore } from '@/store/useAppStore';

/**
 * Where delegated work would act and how the Hub is set up for it. Read-only groups and coding workers use the Hub's own project folder;
 * the permission mode decides whether the Hub accepts coding workers at all (it refuses them unless the mode is Autonomous).
 */
export function useDelegation() {
  const selectedWorkspacePath = useAppStore((state) => state.selectedWorkspacePath);
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const target = delegationTarget({ selectedWorkspacePath, activePath: hub?.workspaces?.activePath ?? undefined, primaryPath: hub?.workspace?.path ?? undefined });
  const permissions = hub?.studio?.permissions;
  return {
    ...target,
    /** The Hub's permission mode ('readonly' | 'review' | 'autonomous'); full access is a policy on top of Autonomous. */
    mode: permissions?.mode as string | undefined,
    fullAccess: permissions?.executionPolicy === 'full-access',
  };
}
