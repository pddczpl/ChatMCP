interface StreamSink {
  selectedTaskId(): string;
  append(taskId: string, token: string): void;
  clear(): void;
  refresh(taskId: string): void;
}

export function handleTaskStreamEvent(value: unknown, sink: StreamSink): void {
  if (!value || typeof value !== 'object') return;
  const event = value as { type?: string; taskId?: string; token?: unknown; state?: string; event?: { type?: string } };
  if (typeof event.taskId !== 'string') return;
  const selected = event.taskId === sink.selectedTaskId();
  if (event.type === 'token') {
    if (selected && typeof event.token === 'string') sink.append(event.taskId, event.token);
    return;
  }
  if (event.type !== 'state' && event.type !== 'event') return;
  const resting = ['paused', 'completed', 'failed', 'cancelled', 'uncertain'].includes(event.state ?? '');
  // Persisted assistant events replace deltas. A new model turn starts a new stream.
  if (selected && (resting || ['model', 'assistant', 'continuation'].includes(event.event?.type ?? ''))) sink.clear();
  sink.refresh(event.taskId);
}
