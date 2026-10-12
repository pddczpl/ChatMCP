import test from 'node:test';
import assert from 'node:assert/strict';
import { api, request } from '../src/lib/api.ts';

test('Hub state exposes actual agent summaries to the session list', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ csrfToken: 'test-token', agent: { activeTaskId: 'one', active: null, tasks: [{ id: 'one', prompt: 'Actual request', status: 'running', state: 'waiting_approval' }] } });
  try {
    const state = await api.getState();
    assert.equal(state.tasks?.length, 1);
    assert.equal(state.tasks[0].task, 'Actual request');
    assert.equal(state.tasks[0].status, 'waiting_approval');
  } finally { globalThis.fetch = original; }
});

test('an HTTP 200 HTML fallback is an API error, not empty successful state', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>fallback</html>', { status: 200 });
  try { await assert.rejects(request('/api/state'), /JSON/); }
  finally { globalThis.fetch = original; }
});

test('HTTP failures retain error codes for visible handling', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'Approval expired', code: 'approval_missing' }, { status: 404 });
  try { await assert.rejects(api.decidePermission('expired', true), { message: 'Approval expired', status: 404, code: 'approval_missing' }); }
  finally { globalThis.fetch = original; }
});

test('a valid JSON null from an optional endpoint remains valid data', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json(null);
  try { assert.equal(await request('/api/studio/delegates'), null); }
  finally { globalThis.fetch = original; }
});
