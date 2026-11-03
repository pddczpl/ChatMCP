import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/lib/api.ts';
import { setHubSecret } from '../src/lib/session.ts';

// The two calls the Review tab adds to the client: the review of a conversation (GET) and moving a new file away (POST). The save and the acceptance it also uses were there already.

const TASK = '0b9a3f3e-1d5c-4c1a-9d40-6b8f2a7c1e55';

async function withFetch(answer, run) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (route, init = {}) => { seen.push({ route, init }); return typeof answer === 'function' ? answer(route, init) : Response.json(answer); };
  setHubSecret('s'.repeat(64));
  try { await run(seen); } finally { globalThis.fetch = original; setHubSecret(''); }
}

test('the review of a conversation is one GET naming the conversation, with the bearer', async () => {
  await withFetch({ taskId: TASK, files: [] }, async (seen) => {
    const answer = await api.getTaskReview(TASK);
    assert.equal(answer.taskId, TASK);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].route, `/api/studio/task-review?taskId=${TASK}`);
    assert.equal(seen[0].init.method ?? 'GET', 'GET');
    assert.equal(seen[0].init.headers.Authorization, `Bearer ${'s'.repeat(64)}`);
  });
});

test('a conversation id is written into the address safely', async () => {
  await withFetch({ files: [] }, async (seen) => {
    await api.getTaskReview('a b&c=d');
    assert.equal(seen[0].route, '/api/studio/task-review?taskId=a%20b%26c%3Dd');
  });
});

test('moving a new file away is one POST of the conversation, the file and the sha that was reviewed', async () => {
  await withFetch({ ok: true, path: 'new.txt' }, async (seen) => {
    await api.rejectCreated(TASK, 'src/new.txt', 'a'.repeat(64));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].route, '/api/studio/review/reject-created');
    assert.equal(seen[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(seen[0].init.body), { taskId: TASK, file: 'src/new.txt', expectedSha: 'a'.repeat(64) });
    assert.equal(seen[0].init.headers['Content-Type'], 'application/json');
    assert.equal(seen[0].init.headers['X-ChatMCP-Request'], 'local-dashboard');
  });
});

test('a refusal of the Hub keeps its status and code, so that the tab can tell a changed file from a running task', async () => {
  await withFetch(() => Response.json({ error: 'File đã thay đổi', code: 'stale_review' }, { status: 409 }), async () => {
    await assert.rejects(api.rejectCreated(TASK, 'a.txt', 'a'.repeat(64)), { status: 409, code: 'stale_review' });
  });
  await withFetch(() => Response.json({ error: 'Đợi agent dừng trước khi lưu file từ editor.' }, { status: 409 }), async () => {
    await assert.rejects(api.saveFile('a.txt', 'x', 'a'.repeat(64)), (error) => error.status === 409 && error.code === undefined);
  });
});
