// Phase 3 verification suite: Multi-profile AI configuration, unified Sandbox Engine,
// cross-workspace concurrency locking, and Hub API integration.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceLock } from '../lib/workspace-lock.mjs';
import { AiProfiles } from '../lib/ai-profiles.mjs';
import { SandboxEngine, SANDBOX_MODES } from '../lib/sandbox-engine.mjs';
import { createHubServer, POST_ROUTES } from '../hub.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { writeJson, readJson } from '../lib/runtime.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: Phase 3 suite timeout'); process.exit(2); }, 60_000).unref();

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-phase3-'));
const work = path.join(root, 'work');
const state = path.join(root, 'state');
await fs.mkdir(work, { recursive: true });
await fs.mkdir(state, { recursive: true });

// ----------------------------------------------------------------------------------------------------
// Section 1: WorkspaceLock (cross-workspace concurrency locking & stale lock reclaim)
// ----------------------------------------------------------------------------------------------------
console.log('--- Section 1: WorkspaceLock ---');
{
  assert.throws(() => new WorkspaceLock({ workspaceRoot: null }), /Đường dẫn workspace không hợp lệ/);

  const lock = new WorkspaceLock({ workspaceRoot: work });
  let status = await lock.inspect();
  assert.equal(status.locked, false, 'initially unlocked');
  assert.equal(status.info, null);

  // Acquire lock
  const res = await lock.acquire('task-phase3-01');
  assert.equal(res.acquired, true);
  assert.equal(res.lock.taskId, 'task-phase3-01');
  assert.equal(res.lock.pid, process.pid);

  status = await lock.inspect();
  assert.equal(status.locked, true);
  assert.equal(status.info.taskId, 'task-phase3-01');
  assert.equal(status.info.stale, false);
  ok('lock acquired and inspected successfully');

  // Re-acquire by same process updates taskId
  const res2 = await lock.acquire('task-phase3-02');
  assert.equal(res2.acquired, true);
  assert.equal(res2.lock.taskId, 'task-phase3-02');
  ok('lock re-acquired by same PID updates task');

  // Simulate dead PID (stale lock recovery)
  const deadPid = 99999999;
  const lockFilePath = path.join(work, '.chatmcp-workspace.lock');
  await writeJson(lockFilePath, {
    pid: deadPid,
    taskId: 'dead-task',
    acquiredAt: Date.now() - 1000,
    workspaceRoot: work,
  });

  status = await lock.inspect();
  assert.equal(status.locked, false, 'dead PID lock is reported as unlocked');
  assert.equal(status.info.stale, true);
  assert.equal(status.info.reason, 'process_dead');

  // Acquiring over dead PID succeeds (reclaimed)
  const res3 = await lock.acquire('task-reclaimed');
  assert.equal(res3.acquired, true);
  assert.equal(res3.lock.pid, process.pid);
  ok('dead PID lock automatically reclaimed');

  // Release lock
  const released = await lock.release();
  assert.equal(released, true);
  status = await lock.inspect();
  assert.equal(status.locked, false);
  ok('lock released cleanly');
}

// ----------------------------------------------------------------------------------------------------
// Section 2: AiProfiles (multi-profile AI configuration manager)
// ----------------------------------------------------------------------------------------------------
console.log('--- Section 2: AiProfiles ---');
{
  const profilesDir = path.join(state, 'profiles-test');
  await fs.mkdir(profilesDir, { recursive: true });
  const aiProfiles = new AiProfiles({ stateDir: profilesDir });
  await aiProfiles.load();
  assert.deepEqual(aiProfiles.list(), []);
  assert.equal(aiProfiles.defaultProfileId, null);

  // Validation checks
  await assert.rejects(
    () => aiProfiles.upsert({ provider: 'invalid-provider', model: 'gpt-4o' }),
    /Nhà cung cấp không hợp lệ/
  );
  await assert.rejects(
    () => aiProfiles.upsert({ provider: 'openai-chat', model: '' }),
    /Tên model không được để trống/
  );
  await assert.rejects(
    () => aiProfiles.upsert({ id: 'bad id with spaces', provider: 'openai-chat', model: 'gpt-4o' }),
    /Mã profile chỉ gồm chữ, số/
  );
  ok('aiProfiles validation checks hold');

  // Add first profile: Anthropic Sonnet
  const sonnet = await aiProfiles.upsert({
    id: 'sonnet-coding',
    name: 'Claude 3.5 Sonnet (Coding)',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    apiKey: 'sk-ant-test-key-12345',
    contextWindow: 200000,
  });
  assert.equal(sonnet.id, 'sonnet-coding');
  assert.equal(sonnet.hasKey, true);
  assert.equal(sonnet.isDefault, true);
  assert.equal(aiProfiles.defaultProfileId, 'sonnet-coding');

  // Add second profile: OpenAI Reviewer
  const gpt = await aiProfiles.upsert({
    id: 'gpt-review',
    name: 'GPT-4o (Reviewer)',
    provider: 'openai-chat',
    model: 'gpt-4o',
    envKeyName: 'OPENAI_API_KEY',
    isDefault: false,
  });
  assert.equal(gpt.id, 'gpt-review');
  assert.equal(gpt.hasKey, true);
  assert.equal(gpt.isDefault, false);
  assert.equal(aiProfiles.defaultProfileId, 'sonnet-coding');
  ok('upsert creates profiles and manages default');

  // List profiles: ensures keys are never exposed
  const list = aiProfiles.list();
  assert.equal(list.length, 2);
  for (const item of list) {
    assert.equal('apiKey' in item, false, 'apiKey never leaked in list()');
    assert.equal('encryptedKey' in item, false, 'encryptedKey never leaked in list()');
  }
  ok('list() redacts secret credentials');

  // Resolve config with decrypted key
  const resolvedSonnet = await aiProfiles.resolveConfig('sonnet-coding');
  assert.equal(resolvedSonnet.apiKey, 'sk-ant-test-key-12345');
  assert.equal(resolvedSonnet.provider, 'anthropic');
  assert.equal(resolvedSonnet.model, 'claude-3-5-sonnet-20241022');

  // Switch default profile
  await aiProfiles.setDefault('gpt-review');
  assert.equal(aiProfiles.defaultProfileId, 'gpt-review');
  ok('setDefault profile switches active model');

  // Delete profile
  await aiProfiles.delete('gpt-review');
  assert.equal(aiProfiles.list().length, 1);
  assert.equal(aiProfiles.defaultProfileId, 'sonnet-coding', 'fallback default to remaining profile');
  ok('delete profile safely cascades default');

  // Persistence: reload from disk
  const reloaded = new AiProfiles({ stateDir: profilesDir });
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.defaultProfileId, 'sonnet-coding');
  ok('profiles persist and reload from ai-profiles.json');
}

// ----------------------------------------------------------------------------------------------------
// Section 3: SandboxEngine (execution abstraction & limits)
// ----------------------------------------------------------------------------------------------------
console.log('--- Section 3: SandboxEngine ---');
{
  assert.deepEqual([...SANDBOX_MODES],['host']);
  assert.throws(()=>new SandboxEngine({mode:'broker'}),/sandbox không hợp lệ/);
  assert.throws(()=>new SandboxEngine({mode:'isolated'}),/sandbox không hợp lệ/);
  assert.throws(() => new SandboxEngine({ mode: 'invalid-sandbox' }), /Chế độ sandbox không hợp lệ/);

  const engine = new SandboxEngine({
    mode: 'host',
    workspaceRoot: work,
    limits: { timeoutSeconds: 30, maxMemoryMb: 256 },
    trustedInternal: true,
  });

  const status = engine.status();
  assert.equal(status.mode, 'host');
  assert.equal(status.workspaceRoot, work);
  assert.equal(status.limits.timeoutSeconds, 30);
  assert.equal(status.osIsolated,false,'host mode must not be represented as an OS sandbox');
  ok('sandbox engine initialization and status check');

  // Missing command validation
  await assert.rejects(() => engine.execute({ command: '' }), /Lệnh thực thi không được để trống/);

  // Real shell execution under host mode
  const execResult = await engine.execute({
    command: `${JSON.stringify(process.execPath)} -e "console.log('phase3-sandbox-active')"`,
  });
  assert.equal(execResult.exitCode, 0);
  assert.match(execResult.stdout, /phase3-sandbox-active/);
  assert.equal(execResult.mode, 'host');
  assert.equal(execResult.timedOut, false);
  assert.ok(execResult.durationMs >= 0);
  ok('sandbox host execution runs real process and captures metrics');
}

// ----------------------------------------------------------------------------------------------------
// Section 4: Hub HTTP Integration
// ----------------------------------------------------------------------------------------------------
console.log('--- Section 4: Hub HTTP Integration ---');
{
  const hubPort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

  const csrfToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const dummyManager = {
    workspace: work,
    stateDir: state,
    stateDirectory: state,
    secrets: [],
    state: () => ({ workspace: work, services: { proxy: { state: 'ready' }, desktop: { state: 'ready' } } }),
    studio: new StudioWorkspace({ manager: { workspace: work, secrets: [] }, directory: path.join(state, 'studio-int') }),
    permissions: null,
    terminal: null,
    delegates: null,
    verification: null,
    intelligence: { close: () => {} },
    preview: null,
    log: () => {},
  };

  const hubServer = createHubServer(dummyManager, {
    port: hubPort,
    token: csrfToken,
    execMode: 'no-shell',
  });

  await new Promise((resolve) => hubServer.listen(hubPort, '127.0.0.1', resolve));

  async function hubRequest(method, pathname, body = null) {
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: hubPort,
        path: pathname,
        method,
        headers: {
          'Host': `127.0.0.1:${hubPort}`,
          'Origin': `http://127.0.0.1:${hubPort}`,
          'X-ChatMCP-Request': 'local-dashboard',
          'X-ChatMCP-CSRF': csrfToken,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // 1. GET /api/ai/profiles
  const getProfiles = await hubRequest('GET', '/api/ai/profiles');
  assert.equal(getProfiles.status, 200);
  assert.ok(Array.isArray(getProfiles.body.profiles));
  ok('GET /api/ai/profiles returns 200 and list');

  // 2. POST /api/ai/profiles/upsert
  const upsertRes = await hubRequest('POST', '/api/ai/profiles/upsert', {
    id: 'deepseek-coder',
    name: 'DeepSeek Coder',
    provider: 'openai-chat',
    model: 'deepseek-coder-v2',
    apiKey: 'sk-dsk-12345',
  });
  assert.equal(upsertRes.status, 200);
  assert.equal(upsertRes.body.profile.id, 'deepseek-coder');
  assert.equal(upsertRes.body.profile.hasKey, true);
  ok('POST /api/ai/profiles/upsert creates profile via Hub');

  // 3. GET /api/sandbox/status
  const sandboxStatus = await hubRequest('GET', '/api/sandbox/status');
  assert.equal(sandboxStatus.status, 200);
  assert.equal(sandboxStatus.body.mode, 'host');
  assert.equal(sandboxStatus.body.limits.timeoutSeconds, 120);
  ok('GET /api/sandbox/status returns active sandbox status');

  // 4. GET /api/workspace/lock
  const lockStatus = await hubRequest('GET', '/api/workspace/lock');
  assert.equal(lockStatus.status, 200);
  assert.equal(typeof lockStatus.body.locked, 'boolean');
  ok('GET /api/workspace/lock returns workspace lock status');

  // 5. POST /api/ai/profiles/delete
  const deleteRes = await hubRequest('POST', '/api/ai/profiles/delete', { id: 'deepseek-coder' });
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.ok, true);
  ok('POST /api/ai/profiles/delete removes profile via Hub');

  hubServer.closeAllConnections();
  await new Promise((resolve) => hubServer.close(resolve));
}

console.log(`\nPASS: ${checks} Phase 3 feature and integration checks passed cleanly.`);
