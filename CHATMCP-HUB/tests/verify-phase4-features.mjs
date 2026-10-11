// Phase 4 verification suite: Skills Marketplace & Plugin System,
// Multi-User RBAC, Tenant Workspace Isolation, Enterprise Audit Trail, and Hub API integration.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PluginManager, MARKETPLACE_CATALOG } from '../lib/plugins.mjs';
import { GovernanceManager, ROLES, PERMISSIONS_MATRIX } from '../lib/governance.mjs';
import { createHubServer } from '../hub.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: Phase 4 suite timeout'); process.exit(2); }, 60_000).unref();

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-phase4-'));
const work = path.join(root, 'work');
const state = path.join(root, 'state');
await fs.mkdir(work, { recursive: true });
await fs.mkdir(state, { recursive: true });

// ----------------------------------------------------------------------------------------------------
// Section 1: Skills Marketplace & Plugin Manager
// ----------------------------------------------------------------------------------------------------
console.log('--- Section 1: PluginManager & Skills Marketplace ---');
{
  assert.throws(() => new PluginManager({ stateDir: null }), /Cần thư mục lưu trạng thái/);
  assert.ok(MARKETPLACE_CATALOG.length >= 6, 'curated catalog has at least 6 plugins');

  const pm = new PluginManager({ stateDir: state });
  await pm.load();

  // Initial load installs default plugins
  const initialInstalled = pm.installed();
  assert.ok(initialInstalled.length >= 2, 'default plugins installed');
  assert.ok(initialInstalled.some((p) => p.id === 'git-workflow-pro'));
  ok('PluginManager initializes and provisions default marketplace plugins');

  // Browse catalog
  const catalog = pm.marketplace();
  assert.equal(catalog.length, MARKETPLACE_CATALOG.length);
  const gitPlugin = catalog.find((p) => p.id === 'git-workflow-pro');
  assert.equal(gitPlugin.isInstalled, true);
  assert.equal(gitPlugin.isEnabled, true);

  // Filter by category
  const codingPlugins = pm.marketplace({ category: 'coding' });
  assert.ok(codingPlugins.every((p) => p.category === 'coding'));

  // Search query
  const queryResult = pm.marketplace({ query: 'sqlite' });
  assert.equal(queryResult.length, 1);
  assert.equal(queryResult[0].id, 'sqlite-mcp-explorer');
  ok('Marketplace search, category filtering, and installation status');

  // Install a plugin from catalog
  const installedSqlite = await pm.install('sqlite-mcp-explorer');
  assert.equal(installedSqlite.id, 'sqlite-mcp-explorer');
  assert.equal(installedSqlite.enabled, true);
  assert.ok(pm.installed().some((p) => p.id === 'sqlite-mcp-explorer'));
  ok('Install plugin from marketplace catalog');

  // Re-install throws 409
  await assert.rejects(() => pm.install('sqlite-mcp-explorer'), /đã được cài đặt/);

  // Install custom plugin
  const customPlugin = await pm.install('my-custom-tool', {
    name: 'Custom Team Tool',
    category: 'custom',
    description: 'Internal project utility',
    tools: ['custom_ping'],
    systemPrompt: 'Custom prompt active',
  });
  assert.equal(customPlugin.id, 'my-custom-tool');
  assert.equal(customPlugin.name, 'Custom Team Tool');
  ok('Install custom plugin manifest');

  // Toggle enable/disable
  await pm.toggle('sqlite-mcp-explorer', false);
  let installedItem = pm.installed().find((p) => p.id === 'sqlite-mcp-explorer');
  assert.equal(installedItem.enabled, false);

  await pm.toggle('sqlite-mcp-explorer', true);
  installedItem = pm.installed().find((p) => p.id === 'sqlite-mcp-explorer');
  assert.equal(installedItem.enabled, true);
  ok('Toggle plugin enabled and disabled states');

  // Active skills injection
  const activeSkills = pm.activeSkills();
  assert.ok(activeSkills.some((s) => s.id === 'git-workflow-pro'));
  assert.ok(activeSkills.some((s) => s.id === 'sqlite-mcp-explorer'));
  for (const s of activeSkills) {
    assert.ok(typeof s.systemPrompt === 'string');
    assert.ok(Array.isArray(s.tools));
  }
  ok('Active skills aggregate prompts and tools for Agent');

  // Uninstall plugin
  const uninstalled = await pm.uninstall('my-custom-tool');
  assert.equal(uninstalled.ok, true);
  assert.ok(!pm.installed().some((p) => p.id === 'my-custom-tool'));
  ok('Uninstall plugin');

  // Persistence check
  const pm2 = new PluginManager({ stateDir: state });
  await pm2.load();
  assert.ok(pm2.installed().some((p) => p.id === 'sqlite-mcp-explorer'));
  ok('Plugin configuration persists and reloads');
}

// ----------------------------------------------------------------------------------------------------
// Section 2: Multi-User RBAC, Tenant Isolation & Enterprise Audit
// ----------------------------------------------------------------------------------------------------
console.log('--- Section 2: GovernanceManager (RBAC, Tenant Isolation & Audit) ---');
{
  assert.deepEqual([...ROLES], ['viewer', 'developer', 'admin']);
  const gov = new GovernanceManager({ stateDir: state });

  // RBAC checks
  assert.equal(gov.checkPermission('viewer', 'read'), true);
  assert.equal(gov.checkPermission('viewer', 'search'), true);
  assert.equal(gov.checkPermission('viewer', 'edit'), false);
  assert.equal(gov.checkPermission('viewer', 'manage_plugins'), false);

  assert.equal(gov.checkPermission('developer', 'read'), true);
  assert.equal(gov.checkPermission('developer', 'edit'), true);
  assert.equal(gov.checkPermission('developer', 'exec_cmd'), true);
  assert.equal(gov.checkPermission('developer', 'manage_plugins'), false);

  assert.equal(gov.checkPermission('admin', 'read'), true);
  assert.equal(gov.checkPermission('admin', 'edit'), true);
  assert.equal(gov.checkPermission('admin', 'manage_plugins'), true);
  assert.equal(gov.checkPermission('admin', 'shutdown'), true);

  // Enforcement
  assert.equal(gov.enforce('developer', 'edit'), true);
  assert.throws(() => gov.enforce('viewer', 'edit'), /không có quyền thực hiện thao tác "edit"/);
  ok('RBAC matrix and permission enforcement verify correctly');

  // Tenant workspace isolation
  const wsTenantA = path.join(work, 'tenant-a-ws');
  const wsTenantB = path.join(work, 'tenant-b-ws');
  await fs.mkdir(wsTenantA, { recursive: true });
  await fs.mkdir(wsTenantB, { recursive: true });

  gov.registerWorkspace('tenant-alpha', wsTenantA);
  gov.registerWorkspace('tenant-beta', wsTenantB);

  assert.equal(gov.canAccessWorkspace('tenant-alpha', wsTenantA), true);
  assert.equal(gov.canAccessWorkspace('tenant-alpha', wsTenantB), false);
  assert.equal(gov.canAccessWorkspace('tenant-beta', wsTenantB), true);
  assert.equal(gov.canAccessWorkspace('tenant-beta', wsTenantA), false);
  ok('Tenant workspace boundaries prevent cross-tenant access');

  // Structured Audit Logging
  await gov.logAudit({
    actor: 'user-alice',
    role: 'developer',
    action: 'edit',
    target: 'src/app.py',
    allowed: true,
  });

  await gov.logAudit({
    actor: 'user-bob',
    role: 'viewer',
    action: 'delete_file',
    target: 'src/app.py',
    allowed: false,
    reason: 'insufficient_role',
  });

  const logs = await gov.queryAudit({ limit: 10 });
  assert.equal(logs.length, 2);
  assert.equal(logs[0].actor, 'user-bob');
  assert.equal(logs[0].allowed, false);
  assert.equal(logs[1].actor, 'user-alice');
  assert.equal(logs[1].allowed, true);

  const filteredLogs = await gov.queryAudit({ action: 'edit' });
  assert.equal(filteredLogs.length, 1);
  assert.equal(filteredLogs[0].actor, 'user-alice');
  ok('Structured enterprise audit logging and compliance query');
}

// ----------------------------------------------------------------------------------------------------
// Section 3: Hub HTTP API Integration
// ----------------------------------------------------------------------------------------------------
console.log('--- Section 3: Hub HTTP API Integration for Phase 4 ---');
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
    studio: new StudioWorkspace({ manager: { workspace: work, secrets: [] }, directory: path.join(state, 'studio-p4') }),
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

  // 1. GET /api/plugins/marketplace
  const mktRes = await hubRequest('GET', '/api/plugins/marketplace?category=coding');
  assert.equal(mktRes.status, 200);
  assert.ok(Array.isArray(mktRes.body.catalog));
  assert.ok(mktRes.body.catalog.length >= 1);
  ok('GET /api/plugins/marketplace returns filtered catalog');

  // 2. GET /api/plugins/installed
  const instRes = await hubRequest('GET', '/api/plugins/installed');
  assert.equal(instRes.status, 200);
  assert.ok(Array.isArray(instRes.body.plugins));
  assert.ok(Array.isArray(instRes.body.activeSkills));
  ok('GET /api/plugins/installed returns active skills and plugins');

  // 3. POST /api/plugins/install
  const installRes = await hubRequest('POST', '/api/plugins/install', { id: 'docker-devops' });
  assert.equal(installRes.status, 200);
  assert.equal(installRes.body.installed.id, 'docker-devops');
  ok('POST /api/plugins/install provisions new plugin via Hub');

  // 4. POST /api/plugins/toggle
  const toggleRes = await hubRequest('POST', '/api/plugins/toggle', { id: 'docker-devops', enabled: false });
  assert.equal(toggleRes.status, 200);
  assert.equal(toggleRes.body.enabled, false);
  ok('POST /api/plugins/toggle changes active status via Hub');

  // 5. POST /api/governance/rbac/verify
  const rbacRes = await hubRequest('POST', '/api/governance/rbac/verify', { role: 'viewer', action: 'edit' });
  assert.equal(rbacRes.status, 200);
  assert.equal(rbacRes.body.allowed, false);
  ok('POST /api/governance/rbac/verify evaluates role permissions');

  // 6. GET /api/governance/audit
  const auditRes = await hubRequest('GET', '/api/governance/audit?limit=20');
  assert.equal(auditRes.status, 200);
  assert.ok(Array.isArray(auditRes.body.logs));
  ok('GET /api/governance/audit returns audit logs via Hub');

  // 7. POST /api/plugins/uninstall
  const uninstRes = await hubRequest('POST', '/api/plugins/uninstall', { id: 'docker-devops' });
  assert.equal(uninstRes.status, 200);
  assert.equal(uninstRes.body.ok, true);
  ok('POST /api/plugins/uninstall removes plugin via Hub');

  hubServer.closeAllConnections();
  await new Promise((resolve) => hubServer.close(resolve));
}

console.log(`\nPASS: ${checks} Phase 4 feature and integration checks passed cleanly.`);
