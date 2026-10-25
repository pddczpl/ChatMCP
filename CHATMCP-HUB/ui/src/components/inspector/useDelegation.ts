import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { delegationTarget } from '@/lib/agent-proof';
import { useAppStore } from '@/store/useAppStore';

/**
 * Which folder the work panel shows against the folder the Hub works on. A coding worker acts on the Hub's own project folder, so with another folder
 * in view nobody is asked from here to allow a check for it (`blocked`).
 */
export function useDelegation() {
  const selectedWorkspacePath = useAppStore((state) => state.selectedWorkspacePath);
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  return delegationTarget({ selectedWorkspacePath, activePath: hub?.workspaces?.activePath ?? undefined, primaryPath: hub?.workspace?.path ?? undefined });
}
