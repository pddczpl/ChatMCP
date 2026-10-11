// Phase 4 verification suite: Skills Marketplace & Plugin System,
// Multi-User RBAC, Tenant Workspace Isolation, Enterprise Audit Trail, and Hub API integration.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PluginManager, MARKETPLACE_CATALOG, validateSkillUrl, parseSkillManifest, VERIFIED_REGISTRIES, normalizeSkillId, isPrivateOrReservedIp, safeFetchSkillManifest } from '../lib/plugins.mjs';
import { GovernanceManager, ROLES, PERMISSIONS_MATRIX } from '../lib/governance.mjs';
import { createHubServer } from '../hub.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { StudioDelegates } from '../lib/studio-delegates.mjs';
import { GitHubSkillRegistry } from '../lib/skill-registry.mjs';

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

  // SSRF protection on skill manifest URL
  assert.throws(() => validateSkillUrl('http://localhost:8080/skill.json'), { code: 'ssrf_blocked' });
  assert.throws(() => validateSkillUrl('http://127.0.0.1:3000/manifest.json'), { code: 'ssrf_blocked' });
  assert.throws(() => validateSkillUrl('http://169.254.169.254/latest/meta-data'), { code: 'ssrf_blocked' });
  assert.throws(() => validateSkillUrl('http://192.168.1.1/skill.md'), { code: 'ssrf_blocked' });
  assert.throws(() => validateSkillUrl('file:///etc/passwd'), { code: 'invalid_url' });
  assert.equal(validateSkillUrl('https://example.com/skill.md'), 'https://example.com/skill.md');
  ok('validateSkillUrl prevents SSRF to internal, loopback and cloud-metadata addresses');

  // parseSkillManifest strict verification
  assert.throws(() => parseSkillManifest('# Arbitrary Title\nSome content without frontmatter'), { code: 'invalid_manifest' });
  assert.throws(() => parseSkillManifest('---\nid: "unclosed quote\n---\nPrompt'), { code: 'malformed_yaml' });
  const parsedYaml = parseSkillManifest(`---
id: test-skill
name: Test Skill
version: 1.0.0
tools:
  - tool_a
  - tool_b
---
Skill prompt body.`);
  assert.equal(parsedYaml.id, 'test-skill');
  assert.equal(parsedYaml.license, 'unknown');
  assert.equal(parsedYaml.redistributable, false);
  assert.deepEqual(parsedYaml.tools, ['tool_a', 'tool_b']);

  const parsedOsi = parseSkillManifest(`---
id: osi-skill
name: OSI Skill
license: Apache-2.0
---
OSI prompt body.`);
  assert.equal(parsedOsi.license, 'Apache-2.0');
  assert.equal(parsedOsi.redistributable, false);
  ok('parseSkillManifest rejects raw markdown and malformed YAML, verifies licenses and provenance');

  // Custom ID validation: path separators, traversal, Windows devices
  await assert.rejects(() => pm.install('../../etc/passwd'), { code: 'invalid_skill_id' });
  await assert.rejects(() => pm.install('CON'), { code: 'invalid_skill_id' });
  await assert.rejects(() => pm.install('nested/slash'), { code: 'invalid_skill_id' });
  await assert.rejects(() => pm.install('COM1'), { code: 'invalid_skill_id' });
  await assert.rejects(() => pm.uninstall('../../etc'), { code: 'invalid_skill_id' });
  await assert.rejects(() => pm.uninstall('bad\\slash'), { code: 'invalid_skill_id' });
  ok('PluginManager rejects traversal, path separators, and Windows reserved names on install/uninstall');

  // Legacy persisted ID sanitization on load
  const corruptState = path.join(root, 'corrupt-state');
  await fs.mkdir(corruptState, { recursive: true });
  await fs.writeFile(path.join(corruptState, 'installed-plugins.json'), JSON.stringify({
    plugins: [
      { id: '../../outside-target', name: 'Corrupt Traversal' },
      { id: 'valid-recovered', name: 'Valid Plugin' },
    ],
  }), 'utf8');
  const corruptPm = new PluginManager({ stateDir: corruptState });
  await corruptPm.load();
  assert.equal(corruptPm.installed().some((p) => p.id === '../../outside-target'), false);
  assert.equal(corruptPm.installed().some((p) => p.id === 'valid-recovered'), true);
  ok('PluginManager drops legacy traversal IDs and loads valid plugins safely');

  // Mock DNS-based SSRF and Redirect SSRF rejection
  await assert.rejects(
    () => safeFetchSkillManifest('http://rebinding.test/skill.json', {
      dnsResolver: async () => ({ url: 'http://rebinding.test/skill.json', ip: '127.0.0.1' }),
    }),
    { code: 'ssrf_blocked' }
  );
  await assert.rejects(
    () => safeFetchSkillManifest('http://metadata.test/skill.json', {
      dnsResolver: async () => ({ url: 'http://metadata.test/skill.json', ip: '169.254.169.254' }),
    }),
    { code: 'ssrf_blocked' }
  );
  await assert.rejects(
    () => safeFetchSkillManifest('https://public-gateway.test/skill.json', {
      dnsResolver: async (u) => {
        if (u.includes('10.0.0.1') || u.includes('private')) throw Object.assign(new Error('ssrf'), { code: 'ssrf_blocked' });
        return { url: u, ip: '93.184.216.34' };
      },
      fetchFn: async () => ({
        status: 302,
        headers: new Map([['location', 'http://10.0.0.1/admin/skill.json']]),
      }),
    }),
    { code: 'ssrf_blocked' }
  );
  ok('safeFetchSkillManifest stops DNS rebinding and redirect SSRF to private/metadata IPs');
  // Verify the production, DNS-pinned HTTP transport enforces size limits
  // before buffering a complete chunked response.
  const { fetchPinnedSkillResponse } = await import('../lib/skill-http.mjs');
  const chunkServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write(Buffer.alloc(8192, 'a'));
    res.end(Buffer.alloc(8192, 'b'));
  });
  await new Promise(resolve => chunkServer.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      () => fetchPinnedSkillResponse('http://localhost:' + chunkServer.address().port + '/manifest', {
        ip: '127.0.0.1', maxBytes: 4096, timeoutMs: 4000,
      }),
      { code: 'response_too_large' }
    );
  } finally {
    await new Promise(resolve => chunkServer.close(resolve));
  }
  ok('Real pinned HTTP transport refuses oversized chunked responses');


  // Multi-file directory installation & skills-lock.json
  const skillDir = path.join(state, 'skills', 'sqlite-mcp-explorer');
  const manifestStat = await fs.stat(path.join(skillDir, 'manifest.json'));
  assert.ok(manifestStat.isFile(), 'manifest.json written to skill directory');
  const skillMdStat = await fs.stat(path.join(skillDir, 'SKILL.md'));
  assert.ok(skillMdStat.isFile(), 'SKILL.md written to skill directory');
  const lockData = JSON.parse(await fs.readFile(path.join(state, 'skills-lock.json'), 'utf8'));
  assert.ok(lockData.skills['sqlite-mcp-explorer']);
  ok('Multi-file skill directory structure and skills-lock.json tracking');

  // Dynamic token-budgeted skill selection
  const gitSelected = pm2.selectSkillsForTask({ prompt: 'Please commit my changes using git', limit: 2, tokenBudget: 4000 });
  assert.ok(gitSelected.length > 0);
  assert.equal(gitSelected[0].id, 'git-workflow-pro');

  // Unrelated prompt selects nothing
  const unrelatedSelected = pm2.selectSkillsForTask({ prompt: 'Tell me a funny joke about dolphins' });
  assert.deepEqual(unrelatedSelected, []);

  // Oversized first skill does not exceed context budget
  const budgetLimited = pm2.selectSkillsForTask({ prompt: 'git commit changes', tokenBudget: 150 });
  assert.ok(budgetLimited.length > 0);
  assert.ok(budgetLimited[0].systemPrompt.length <= 150);
  ok('selectSkillsForTask selects nothing when unrelated and truncates oversized first skill');
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
    studio: null,
    permissions: null,
    terminal: null,
    delegates: null,
    verification: null,
    intelligence: { close: () => {} },
    preview: null,
    log: () => {},
  };
  dummyManager.studio = new StudioWorkspace({ manager: dummyManager, directory: path.join(state, 'studio-p4') });

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

  // 8. Safe checkpoint preview and restore via Hub API
  await fs.writeFile(path.join(work, 'test-phase4-doc.txt'), 'version 1 content\n', 'utf8');
  const cp = await dummyManager.studio.checkpoint({ label: 'phase4-checkpoint', files: ['test-phase4-doc.txt'] });
  assert.ok(cp.id);

  // Preview checkpoint
  const prevRes = await hubRequest('GET', `/api/studio/preview-checkpoint?checkpointId=${cp.id}`);
  assert.equal(prevRes.status, 200);
  assert.equal(prevRes.body.ok, true);
  assert.equal(prevRes.body.checkpointId, cp.id);

  // Mutate file
  await fs.writeFile(path.join(work, 'test-phase4-doc.txt'), 'version 2 modified\n', 'utf8');

  // Stale expectedSha rejection
  const staleRes = await hubRequest('POST', '/api/studio/restore-checkpoint', {
    checkpointId: cp.id,
    expectedShas: { 'test-phase4-doc.txt': '0000000000000000000000000000000000000000000000000000000000000000' },
  });
  assert.equal(staleRes.status, 409);
  assert.equal(staleRes.body.code, 'stale_state');

  // Dry run
  const dryRes = await hubRequest('POST', '/api/studio/restore-checkpoint', {
    checkpointId: cp.id,
    dryRun: true,
  });
  assert.equal(dryRes.status, 200);
  assert.equal(dryRes.body.dryRun, true);
  assert.equal(await fs.readFile(path.join(work, 'test-phase4-doc.txt'), 'utf8'), 'version 2 modified\n');

  // Missing expectedShas rejection
  const missingShaRes = await hubRequest('POST', '/api/studio/restore-checkpoint', {
    checkpointId: cp.id,
  });
  assert.equal(missingShaRes.status, 400);
  assert.equal(missingShaRes.body.code, 'missing_expected_shas');

  // Guard uses the actual HubManager.taskId even without a mock taskEngine.
  dummyManager.taskId = 'active-local-task';
  const concurrentRestore = await hubRequest('POST', '/api/studio/restore-checkpoint', {
    checkpointId: cp.id,
    expectedShas: { 'test-phase4-doc.txt': 'placeholder-sha' },
  });
  assert.equal(concurrentRestore.status, 409);
  assert.equal(concurrentRestore.body.code, 'task_in_progress');
  dummyManager.taskId = null;
  // Active task guard rejection
  dummyManager.taskEngine = { state: () => ({ activeTaskId: 'active-agent-task-99' }) };
  const busyRes = await hubRequest('POST', '/api/studio/restore-checkpoint', {
    checkpointId: cp.id,
    expectedShas: { 'test-phase4-doc.txt': 'placeholder-sha' },
  });
  assert.equal(busyRes.status, 409);
  assert.equal(busyRes.body.code, 'task_in_progress');
  dummyManager.taskEngine = null;

  // Real safe restore with valid expectedShas
  const currentBytes = await fs.readFile(path.join(work, 'test-phase4-doc.txt'));
  const currentSha = crypto.createHash('sha256').update(currentBytes).digest('hex');
  const restRes = await hubRequest('POST', '/api/studio/restore-checkpoint', {
    checkpointId: cp.id,
    expectedShas: { 'test-phase4-doc.txt': currentSha },
  });
  assert.equal(restRes.status, 200);
  assert.equal(restRes.body.ok, true);
  assert.equal(await fs.readFile(path.join(work, 'test-phase4-doc.txt'), 'utf8'), 'version 1 content\n');
  assert.ok(restRes.body.undoCheckpointId, 'undo backup created');
  ok('Safe checkpoint restoration: preview, dryRun, stale-state rejection, and verified undo backup');

  hubServer.closeAllConnections();
  await new Promise((resolve) => hubServer.close(resolve));
}


// ----------------------------------------------------------------------------------------------------
// Phase 5: bounded read-only multi-agent DAG and pinned GitHub Skills Registry.
// ----------------------------------------------------------------------------------------------------
{
  const agentDir=path.join(root,'agent-dag');
  await fs.mkdir(agentDir,{recursive:true});
  const providerCalls=[];
  const delegates=new StudioDelegates({
    directory:agentDir,
    workspace:{
      root:work,
      search:async({query})=>({matches:[{path:'module.mjs',line:2,text:'export function demo() {}',query}]}),
    },
    provider:{
      ready:()=>true,
      respond:async({input,tools,instructions})=>{
        assert.deepEqual(tools,[],'subagents must not receive executable tools');
        const content=JSON.parse(input[0].content[0].text);
        providerCalls.push({role:content.role,dependencies:content.dependencies});
        assert.match(instructions,/read-only/i);
        return {output:[{type:'message',content:[{type:'output_text',text:content.role+' report with file:line evidence'}]}]};
      }
    }
  });
  const outcome=await delegates.orchestrate({maxConcurrency:2,nodes:[
    {id:'planner',role:'planner',question:'Plan the main modules',dependsOn:[]},
    {id:'researcher',role:'researcher',question:'Research implementation requirements',dependsOn:[]},
    {id:'reviewer',role:'reviewer',question:'Review the initial findings',dependsOn:['planner','researcher']},
  ]});
  assert.equal(outcome.status,'completed',JSON.stringify(outcome));
  assert.equal(outcome.workers.length,3);
  assert.equal(providerCalls.length,3);
  assert.equal(providerCalls[2].dependencies.length,2);
  assert.ok(providerCalls[2].dependencies.every(x=>x.summary.includes('report')));
  await assert.rejects(()=>delegates.orchestrate({nodes:[
    {id:'a',role:'reviewer',question:'Check A',dependsOn:['b']},
    {id:'b',role:'reviewer',question:'Check B',dependsOn:['a']},
  ]}),/chu trình/);
  ok('Multi-agent DAG parallel roles, dependencies, tool-free execution and cycle rejection');
}
{
  const registryDir=path.join(root,'registry');
  await fs.mkdir(registryDir,{recursive:true});
  const skillSha='a'.repeat(40);
  const calls=[];
  const transport=async(url)=>{
    calls.push(url);
    if(url.endsWith('/commits/HEAD'))return {text:JSON.stringify({sha:skillSha})};
    if(url.includes('/contents/skills?ref='))return {text:JSON.stringify([{type:'dir',path:'skills/test-skill'},{type:'file',path:'skills/ignored.txt'}])};
    if(url.includes('skills/test-skill/SKILL.md'))return {text:'---\nname: test-skill\ndescription: Integration fixture\nlicense: unknown\n---\nRead-only skill guidance.'};
    throw Error('Unexpected GitHub URL '+url);
  };
  const pm=new PluginManager({stateDir:registryDir});
  await pm.load();
  const registry=new GitHubSkillRegistry({pluginManager:pm,stateDir:registryDir,transport});
  await registry.load();
  const first=await registry.refresh({sourceId:'anthropic'});
  assert.equal(first.found,1,JSON.stringify(first));
  const results=registry.list({query:'test-skill'});
  assert.equal(results.length,1);
  assert.equal(results[0].revision,skillSha);
  assert.equal(results[0].redistributable,false);
  const installed=await registry.install({key:results[0].key});
  assert.ok(installed.readOnlyImport);
  assert.ok(pm.installed().some(p=>p.id===results[0].id));
  assert.ok(calls.some(x=>x.includes(skillSha+'/skills/test-skill/SKILL.md')));
  const second=await registry.refresh({sourceId:'anthropic'});
  assert.equal(second.total,1,'refresh must replace previous source index without duplicates');
  const restored=new GitHubSkillRegistry({pluginManager:pm,stateDir:registryDir,transport});
  await restored.load();
  assert.equal(restored.list().length,1);
  ok('GitHub SKILL.md discovery, pinned import, persistence and repeat refresh');
}

console.log(`\nPASS: ${checks} Phase 4 feature and integration checks passed cleanly.`);
