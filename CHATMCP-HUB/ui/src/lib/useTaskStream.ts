import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '@/store/useAppStore';
import { handleTaskStreamEvent } from './task-stream.ts';

export function useTaskStream() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const stream = new EventSource('/api/tasks/events');
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (taskId: string) => {
      pending.add(taskId);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({ queryKey: ['hubState'] });
        for (const id of pending) void queryClient.invalidateQueries({ queryKey: ['task', id] });
        pending.clear();
        // Inspector evidence is persisted by the tool, sometimes just after its event.
        for (const key of ['plan', 'gitStatus', 'gitDiff', 'checkpointsList', 'terminals', 'verifications']) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      }, 100);
    };
    stream.onopen = () => {
      useAppStore.getState().setStreamConnected(true);
      // SSE has no replay cursor. Reconcile from disk-backed state on every reconnect.
      useAppStore.getState().clearStreamingToken();
      refresh(useAppStore.getState().selectedTaskId);
    };
    stream.onerror = () => {
      useAppStore.getState().setStreamConnected(false);
      useAppStore.getState().clearStreamingToken();
      refresh(useAppStore.getState().selectedTaskId);
    };
    stream.onmessage = ({ data }) => {
      let value: unknown;
      try { value = JSON.parse(data); } catch { return; }
      handleTaskStreamEvent(value, {
        selectedTaskId: () => useAppStore.getState().selectedTaskId,
        append: (id, token) => useAppStore.getState().appendTaskToken(id, token),
        clear: () => useAppStore.getState().clearStreamingToken(),
        refresh,
      });
    };
    return () => {
      stream.close();
      if (timer) clearTimeout(timer);
      useAppStore.getState().setStreamConnected(false);
    };
  }, [queryClient]);
}
