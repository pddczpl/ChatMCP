// Work that a Hub is doing, made on purpose: an agent task that is running and stays running until the proof lets it go. It is what stops an update (the shell refuses while the Hub reports work:
// native-shared/HubLifecycle.cs, WorkInState), made the way a person makes it: a workspace is chosen, a model is connected, a request is sent. The model is the scripted stand-in of the Hub's own
// end-to-end tests (tests/e2e/mock-model-server.mjs), which is told to take the request and answer nothing, so the task is busy for as long as the proof wants and no real model or key is involved.
import { sleep } from './cdp.mjs';

/**
 * Connects the Hub (`hub`, a HubClient) to `mock` (a started mock model), chooses `workspace` (a folder that exists), sends a request that the model never answers, and resolves once the Hub says that
 * it is working: {taskId, release}. `release()` cancels the task and waits until the Hub is idle again (the model is let go of too).
 */
export async function startRunningWork({ hub, mock, workspace, prompt = 'Hold the line: this task is the work that stops an update.', timeoutMs = 60_000 }) {
  await hub.must('/api/workspace/select', { path: workspace });
  await hub.must('/api/ai/config', { preset: 'ollama', apiBaseUrl: mock.url, model: 'mock-coder' });
  const tested = await hub.must('/api/ai/test', {});
  if (tested.ok !== true) throw new Error(`The Hub could not use the stand-in model: ${JSON.stringify(tested).slice(0, 200)}`);
  // after the check of the model (which must be answered) and before the request (which must not be)
  mock.inject({ kind: 'stall', afterEvents: 0, times: 50 });
  const started = await hub.must('/api/tasks/start', { prompt });
  const taskId = started.task?.id;
  if (typeof taskId !== 'string') throw new Error('The Hub started no task.');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await hub.state();
    if (state.agent?.activeTaskId === taskId) break;
    if (Date.now() >= deadline) throw new Error(`The Hub did not report the task as active within ${timeoutMs} ms (agent: ${JSON.stringify(state.agent).slice(0, 300)})`);
    await sleep(200);
  }
  return {
    taskId,
    async release() {
      await hub.post('/api/tasks/cancel', { id: taskId });
      const until = Date.now() + timeoutMs;
      for (;;) {
        const state = await hub.state();
        if (!state.agent?.activeTaskId) return;
        if (Date.now() >= until) throw new Error(`The Hub is still working ${timeoutMs} ms after the task was cancelled.`);
        await sleep(200);
      }
    },
  };
}
