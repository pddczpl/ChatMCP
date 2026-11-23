import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { openDraft, reconcile, type PlanDraft } from '@/lib/plan-draft';
import type { Plan } from '@/types';
import { usePlanDrafts } from '@/store/usePlanDrafts';

/**
 * The plan of a task as the Hub has it now, and the owner's draft of it, which a refetch never changes (lib/plan-draft.ts `reconcile`). The Plan tab and the
 * approval card both use it, so they show one plan and one draft.
 */
export function usePlan(taskId: string) {
  const queryClient = useQueryClient();
  const { data: plan, error, isLoading } = useQuery({
    queryKey: ['plan', taskId],
    queryFn: () => api.getPlan(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 2500,
  });
  const stored = usePlanDrafts((state) => state.drafts[taskId] ?? null);
  const setDraft = usePlanDrafts((state) => state.setDraft);
  const { draft, conflict } = stored && plan ? reconcile(stored, plan) : { draft: stored, conflict: null };
  return {
    plan, error, isLoading, draft, conflict,
    open: () => { if (plan) setDraft(taskId, openDraft(plan)); },
    change: (next: PlanDraft) => setDraft(taskId, next),
    drop: () => setDraft(taskId, null),
    /** The Hub saved the draft: what it answered is the plan now (a read that was under way would bring the older one back), and the draft is done. */
    adopt: async (saved: Plan) => {
      setDraft(taskId, null);
      await queryClient.cancelQueries({ queryKey: ['plan', taskId] });
      queryClient.setQueryData(['plan', taskId], saved);
    },
    reread: () => queryClient.invalidateQueries({ queryKey: ['plan', taskId] }),
  };
}
