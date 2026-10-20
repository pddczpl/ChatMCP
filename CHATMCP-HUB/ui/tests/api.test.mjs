import test from 'node:test';
import assert from 'node:assert/strict';
import { api, request } from '../src/lib/api.ts';
import { getHubSecret, isHubSessionLost, onHubSessionLost, setHubSecret } from '../src/lib/session.ts';

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

test('every API call carries the Hub session secret as a bearer', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (route, init) => { seen.push({ route, headers: init.headers }); return Response.json({ ok: true }); };
  const secret = ['s', 'e', 'c', 'r', 'e', 't'].join('').repeat(8);
  setHubSecret(secret);
  try {
    await request('/api/state');
    await request('/api/ai/config', { method: 'POST', body: '{}' });
    assert.equal(seen.length, 2);
    for (const call of seen) assert.equal(call.headers.Authorization, 'Bearer ' + secret, `${call.route} sends the bearer`);
    assert.equal(seen[1].headers['Content-Type'], 'application/json');
  } finally { globalThis.fetch = original; setHubSecret(''); }
});

test('a Hub that refuses the session reports it once instead of reloading the page', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'Cần phiên Hub hợp lệ.', code: 'hub_auth_required' }, { status: 401 });
  let lost = 0;
  const stop = onHubSessionLost(() => { lost += 1; });
  setHubSecret('x'.repeat(40));
  try {
    await assert.rejects(request('/api/state'), { status: 401, code: 'hub_auth_required' });
    await assert.rejects(request('/api/state'), { status: 401, code: 'hub_auth_required' });
    assert.equal(lost, 1, 'listeners hear about it once');
    assert.equal(isHubSessionLost(), true);
    assert.equal(getHubSecret(), '', 'the stale secret is forgotten');
  } finally { stop(); globalThis.fetch = original; setHubSecret(''); }
});

test('the project-instructions switch is one POST of {enabled}, with the page headers, and a refusal keeps its code', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (route, init) => {
    seen.push({ route, method: init.method, body: init.body, headers: init.headers });
    const enabled = JSON.parse(init.body).enabled;
    if (seen.length === 3) return Response.json({ error: 'Biến môi trường CHATMCP_PROJECT_INSTRUCTIONS đang quyết định.', code: 'project_instructions_env' }, { status: 409 });
    return Response.json({ csrfToken: 'fresh-token', projectInstructions: { enabled, source: 'config', saved: enabled, variable: 'CHATMCP_PROJECT_INSTRUCTIONS', maxBytes: 8192, files: [] } });
  };
  setHubSecret('p'.repeat(40));
  try {
    const off = await api.setProjectInstructions(false);
    assert.deepEqual([seen[0].route, seen[0].method, seen[0].body], ['/api/agent/project-instructions', 'POST', '{"enabled":false}']);
    assert.equal(seen[0].headers['Content-Type'], 'application/json');
    assert.equal(seen[0].headers.Authorization, 'Bearer ' + 'p'.repeat(40), 'behind the bearer like every route');
    assert.equal(seen[0].headers['X-ChatMCP-Request'], 'local-dashboard', 'with the marker of the page');
    assert.equal(off.projectInstructions.enabled, false, 'it answers with the state that now applies');
    await api.setProjectInstructions(true);
    assert.equal(seen[1].body, '{"enabled":true}');
    assert.equal(seen[1].headers['X-ChatMCP-CSRF'], 'fresh-token', 'the token of the first answer is sent with the second call');
    await assert.rejects(api.setProjectInstructions(false), { status: 409, code: 'project_instructions_env', message: /CHATMCP_PROJECT_INSTRUCTIONS/ });
  } finally { globalThis.fetch = original; setHubSecret(''); }
});
