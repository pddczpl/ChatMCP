#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { HubManager, VERSION, BACKENDS, defaultDataDirectory } from './lib/manager.mjs';
import { redact } from './lib/runtime.mjs';
import { acquireInstanceLock } from './lib/instance-lock.mjs';
import { ATTACHMENT_BODY_LIMIT } from './lib/attachment-limits.mjs';
import { EDITABLE_FILE_BYTES, EDITOR_BODY_LIMIT, planConflict } from './lib/studio-workspace.mjs';
import { publicPresets } from './lib/provider-presets.mjs';
import { modelInfo, modelInfoQuery, modelsList, modelsQuery } from './lib/model-info.mjs';
import { createCatalogStore } from './lib/model-catalog-store.mjs';
import { AiProfiles } from './lib/ai-profiles.mjs';
import { WorkspaceLock } from './lib/workspace-lock.mjs';
import { SandboxEngine } from './lib/sandbox-engine.mjs';
import { PermissionGate, decisionExtras } from './lib/permissions.mjs';
import { PluginManager } from './lib/plugins.mjs';
import { CodingWorktreeOrchestrator } from './lib/coding-orchestrator.mjs';
import { GitHubSkillRegistry } from './lib/skill-registry.mjs';
import { BEARER_PATTERN, attachToRunningHub, createSecret, createTicketBook, dashboardUrl, hubRequiresBearer, writeSession } from './lib/hub-session.mjs';
import { followProviderWindow } from './lib/tool-selector.mjs';
import { ProjectInstructionsStore, projectInstructionsSetting } from './lib/project-instructions.mjs';
import { AgentOptionsStore, agentOptionsView } from './lib/agent-options.mjs';
import { createUpdateChecker, updateOptionsFromEnvironment } from './lib/update-check.mjs';
import { createUpdateDownloader } from './lib/update-download.mjs';
import { createAppliedNote } from './lib/update-applied.mjs';
import { loadReleaseKeys } from './lib/release-signature.mjs';
import { createProtector } from './lib/secret-box.mjs';
import { ProofHttpApi } from './lib/proof/http-api.mjs';

const APP_ID = 'chatmcp-local-hub';
export const UI_BUILD = '3.11.2-react-agent';
// Prevent a new installer from silently reopening a stale daemon at :3007.
export function assertCompatibleRunningHub(health, port=3007) {
  if (health?.app !== APP_ID) throw new Error(`Cổng ${port} đang do ứng dụng khác sử dụng. Không tự dừng tiến trình đó.`);
  if (health.version !== VERSION || health.uiBuild !== UI_BUILD) {
    throw new Error(`Cổng ${port} vẫn chạy Hub ${health.version ?? 'không rõ'} (${health.uiBuild ?? 'UI cũ'}), nhưng bản đang mở là ${VERSION} (${UI_BUILD}). Hãy chạy STOP-CHATMCP-HUB.cmd, đợi cổng 3007 tắt rồi START-CHATMCP-HUB.cmd; không dùng tiến trình cũ.`);
  }
  return true;
}

// A Hub from before the per-launch secret (v3.9.0 and older) answers /api/health without `auth`. This build cannot
// authenticate to it, so it must be stopped, never reused: it hands its CSRF token to any local process.
export function assertBearerHub(health, port=3007) {
  if (!hubRequiresBearer(health)) throw new Error(`Cổng ${port} đang chạy Hub ${health?.version ?? 'không rõ'} chưa có xác thực phiên (bản cũ). Hãy chạy STOP-CHATMCP-HUB.cmd, đợi cổng ${port} tắt rồi START-CHATMCP-HUB.cmd; không dùng tiến trình cũ.`);
  return true;
}

export const POST_ROUTES = Object.freeze(['/api/agent/mode','/api/agent/project-instructions','/api/agent/options','/api/tasks/start','/api/tasks/continue','/api/tasks/delete','/api/tasks/cancel','/api/tasks/auto-resume','/api/tasks/accept-criterion','/api/proof/trust-acceptance','/api/proof/revoke-acceptance','/api/workflows/cancel','/api/ai/config','/api/ai/clear-key','/api/ai/test','/api/ai/catalog/refresh','/api/workspace/browse','/api/workspace/select','/api/workspaces/add','/api/workspaces/activate','/api/workspaces/remove','/api/services/start','/api/services/stop','/api/browser/pair-code','/api/browser/unpair','/api/browser/recover-url/request','/api/browser/outbound/decide','/api/browser/privacy/config','/api/studio/permissions/config','/api/studio/permissions/decide','/api/studio/file/save','/api/studio/checkpoint','/api/studio/restore','/api/studio/restore-checkpoint','/api/studio/review/reject-created','/api/studio/accept','/api/studio/terminal/start','/api/studio/terminal/stop','/api/studio/plan/set','/api/studio/plan/decide','/api/studio/verify/run','/api/studio/delegates/research','/api/studio/delegates/orchestrate','/api/studio/delegates/cancel','/api/studio/dynamic-delegates/run','/api/studio/dynamic-delegates/cancel','/api/studio/coding/plan','/api/studio/coding/run','/api/studio/coding/cancel','/api/studio/coding/recovery/acknowledge','/api/studio/coding/integrate','/api/studio/coding/publish','/api/studio/coding/check-grant','/api/studio/intelligence/index','/api/studio/intelligence/engines/probe','/api/studio/intelligence/lsp/start','/api/studio/terminal/input','/api/studio/terminal/resize','/api/hub/shutdown','/api/ai/profiles/upsert','/api/ai/profiles/delete','/api/ai/profiles/default','/api/plugins/install','/api/plugins/registry/refresh','/api/plugins/registry/install','/api/plugins/registry/source/add','/api/plugins/registry/source/remove','/api/plugins/uninstall','/api/plugins/toggle','/api/hooks/approve-project','/api/mcp/server/upsert','/api/mcp/server/delete','/api/mcp/server/test','/api/mcp/server/launch-record','/api/mcp/server/approve-launch','/api/mcp/server/tool-review','/api/mcp/server/approve-tools','/api/mcp/server/tool-policy','/api/mcp/reload','/api/update/check','/api/update/skip','/api/update/auto-check','/api/update/download','/api/update/download-cancel','/api/update/applied-dismiss']);
// Every route the Hub answers besides POST_ROUTES (tests/verify-hub-auth.mjs compares these lists with the source).
export const GET_ROUTES = Object.freeze(['/api/health','/api/capabilities','/api/state','/api/background-tasks','/api/workspaces','/api/catalog','/api/ai/models','/api/ai/model-info','/api/ai/catalog','/api/ai/catalog/models','/api/ai/presets','/api/ai/profiles','/api/sandbox/status','/api/workspace/lock','/api/plugins/registry','/api/plugins/marketplace','/api/plugins/installed','/api/tasks/events','/api/tasks/:id','/api/tasks/:id/report','/api/tasks/:id/stream','/api/tasks/:id/proof','/api/proof/acceptance','/api/extension-state','/api/instructions','/api/studio/terminal/events','/api/studio/intelligence/status','/api/studio/intelligence/symbols','/api/studio/intelligence/references','/api/studio/intelligence/definitions','/api/studio/intelligence/lsp','/api/studio/sandbox','/api/studio/preview','/api/studio/tree','/api/studio/file','/api/studio/search','/api/studio/git/status','/api/studio/git/refs','/api/studio/git/diff','/api/studio/git/check','/api/studio/checkpoints','/api/studio/review','/api/studio/task-review','/api/studio/preview-checkpoint','/api/studio/checks','/api/studio/verifications','/api/studio/skills','/api/studio/terminal','/api/studio/terminal/capabilities','/api/studio/delegates','/api/studio/dynamic-delegates','/api/studio/coding','/api/studio/coding/context','/api/studio/coding/recovery','/api/studio/coding/review','/api/studio/coding/checks','/api/studio/workflow','/api/studio/plan','/api/update/status','/api/mcp/servers','/auth/chatgpt/callback']);
// Bootstrap of a dashboard without the long-lived secret in a URL: POST ticket (bearer) -> page opens /#chatmcp-boot=<ticket> -> POST redeem.
export const SESSION_ROUTES = Object.freeze(['/api/session/ticket','/api/session/redeem']);
// Everything under /api/ and /auth/ needs `Authorization: Bearer <per-launch secret>` except these named exceptions:
// the two unauthenticated probes, the Companion's pairing routes (their own bearer) and the two read-only routes the
// Companion polls from its chrome-extension:// origin (it has no secret; tests/verify-hub-auth.mjs pins this list).
export const PUBLIC_API_ROUTES = Object.freeze(['/api/health','/api/capabilities']);
export const EXTENSION_READ_ROUTES = Object.freeze(['/api/extension-state','/api/instructions']);
export const EXTENSION_PAIRED_ROUTE = /^\/api\/browser\/clients\/(pair|poll|claim|sent|reply|fail|recover-url)$/;
const BUNDLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
});
const CSP_BASE = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const CSP_LOOPBACK = `${CSP_BASE}; frame-src http://127.0.0.1:* http://localhost:*`;
const STATIC_FILES = Object.freeze({
  '/': 'web/dist/index.html',
  '/index.html': 'web/dist/index.html',
  '/favicon.ico': 'web/dist/favicon.ico',
  '/chatmcp-logo.png': 'web/dist/chatmcp-logo.png',
  '/chat-route.js': 'extension/chat-route.js'
});
// The dashboard is the Vite build in web/dist (npm run build --prefix DATGOLD-HUB/ui). There is no older page to fall back to.
const UI_INDEX = 'web/dist/index.html';
const UI_NOT_BUILT = Object.freeze({ error: 'The dashboard is not built. Run: npm run build --prefix DATGOLD-HUB/ui', code: 'ui_not_built' });
function equalToken(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// The body a POST may carry where 64 KB is not enough. A save carries the whole text of the file (up to EDITABLE_FILE_BYTES); the answer to one that is too big is save()'s own,
// which says what the limit is. (A Map, not a comparison: tests/verify-hub-auth.mjs finds the routes of the Hub by reading its source for comparisons and cases.)
const BODY_LIMIT_OF = new Map([['/api/studio/file/save', EDITOR_BODY_LIMIT]]);

async function bodyJson(req, limit = 65536) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
    const e = new Error('Yêu cầu phải dùng JSON.'); e.statusCode = 415; throw e;
  }
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    byteCount += chunk.length;
    if (byteCount > limit) { const e = new Error('Yêu cầu vượt giới hạn dung lượng của thao tác.'); e.statusCode = 413; throw e; }
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try { return body ? JSON.parse(body) : {}; }
  catch { const e = new Error('JSON không hợp lệ.'); e.statusCode = 400; throw e; }
}

/** Local-only HTTP Hub: localhost and 127.0.0.1 only. */
export function createHubServer(manager, {port=3007,token=randomBytes(32).toString('hex'),secret=randomBytes(32).toString('hex'),bundleRoot=BUNDLE_ROOT,provider=null,agent=null,browser=null,workspaceRegistry=null,onShutdown=()=>{},isInitialized=()=>true,catalogStore=null,updates=null,downloads=null,applied=null}={}) {
  // `token` is the CSRF token of the dashboard; `secret` is the bearer every API caller must present. There is no way to
  // build a server without one: a caller that does not pass a secret gets a random one nobody knows.
  const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
  const tickets=createTicketBook();
  const hasBearer=(request)=>{const match=BEARER_PATTERN.exec(request.headers.authorization??'');return Boolean(match)&&equalToken(match[1],secret);};
  const origins=new Set([...hosts].map(host=>`http://${host}`));
  const staticFiles=STATIC_FILES;
  let aiBusy = false;
  const taskEngine = agent ?? browser;
  const studio = manager.studio;
  const permissions = manager.permissions;
  const gate = manager.permissions instanceof PermissionGate ? manager.permissions : null;
  const terminal = manager.terminal;
  const delegates = manager.delegates;
  const dynamic = manager.dynamicDelegates;
  const coding = manager.codingOrchestrator;
  const verification = manager.verification;
  const intelligence = manager.intelligence;
  const preview = manager.preview;
  // ---- the plan of a task (P9 ac-10, docs/PLAN-MODE.md "The plan and its revision") ----------------------------------------------------
  // A chat that runs beside the first (ConcurrentApiAgent) keeps its plan in a studio of its own; every other task's plan is in the Hub's.
  const planStudio = (taskId) => taskEngine?.api?.studioFor?.(taskId) ?? studio;
  // A conflict says which revision the plan is at, so that the page can read it again and answer on that revision.
  const planConflictJson = (error) => ({ error: redact(String(error.message ?? '').split('\n')[0], manager.secrets ?? []), code: 'plan_conflict', revision: error.revision, updatedBy: error.updatedBy });
  // The plan requests that wait, on the Hub's gate or on the gate of a chat that runs beside it.
  const pendingPlanRequests = () => [...(gate?.state().pending ?? []), ...(taskEngine?.api?.pendingApprovals?.() ?? [])].filter((item) => item.category === 'plan');
  /**
   * An answer to a plan request, held against the plan file. An approval, and any answer that names a revision, must be about the revision the
   * plan is at (`revision`; by default the one the request names): an owner's edit since the proposal makes it a 409 plan_conflict and the request
   * stays pending. An edited plan that comes with an approval is saved first as the owner's revision. The gate then gets the approved text and
   * its revision, so the model is given what the plan file holds under the number planApproval records.
   */
  async function answerPlan(request, approved, { feedback, plan, execution, revision }) {
    const store = planStudio(request.taskId);
    const current = await store.plan({ taskId: request.taskId });
    const base = revision ?? request.detail?.revision ?? null;
    if ((approved || revision !== null) && current.revision !== base) throw planConflict(current);
    let approvedPlan = current;
    if (approved && plan !== null && plan !== current.text) approvedPlan = await store.plan({ taskId: request.taskId, operation: 'text', text: plan, by: 'user', expectedRevision: current.revision });
    // A denial passes what it was sent: the gate refuses an edited plan or an execution that comes with one (400, the request stays pending).
    const extras = approved ? { feedback, plan: approvedPlan.text, execution, revision: approvedPlan.revision } : { feedback, plan, execution, revision };
    return (gate?.state().pending || []).some((item) => item.id === request.id) ? gate.decide(request.id, approved, extras) : taskEngine?.api?.decidePermission?.(request.id, approved, extras);
  }
  const hubStateDir = manager.hubDirectory ?? manager.stateDirectory ?? manager.stateDir ?? defaultDataDirectory();
  const aiProfiles = new AiProfiles({ stateDir: hubStateDir, keyStore: provider?.keyStore ?? provider?.protector ?? (provider?.protect && provider?.unprotect ? { encrypt: (t) => provider.protect(t), decrypt: (b) => provider.unprotect(b) } : null) });
  const profilesReady=aiProfiles.load().catch(error=>{
    manager.log?.('Model profiles could not be read: '+String(error?.code||'storage_error'));
    return false;
  });
  manager.aiProfiles=aiProfiles;
  // The list of models the Hub knows: the snapshot that ships, or the newer one its owner had it fetch (lib/model-catalog-store.mjs). Read once, at start; fetched only by POST /api/ai/catalog/refresh.
  const catalogs=catalogStore??createCatalogStore({directory:hubStateDir});
  const catalogReady=catalogs.load().catch(error=>{
    manager.log?.('The model catalog could not be read: '+String(error?.code||'storage_error'));
    return false;
  });
  // Resolve and bind a profile before starting a task. Decrypted keys stay in
  // task-local GatewayProvider objects; only a safe revision/reference is
  // returned to task JSON, UI and recovery journals.
  manager.resolveAiProfileProvider=async ({profileId=null,expectedRevision=null}={})=>{
    if(await profilesReady===false)throw Object.assign(new Error('AI profile storage is unavailable.'),{
      code:'profiles_unavailable',statusCode:503});
    // A task created before the profile feature, or explicitly using the
    // global gateway, must not silently inherit a new default on restart.
    if(profileId==='__global__')return {provider,effectiveProfile:null};
    const id=profileId || aiProfiles.defaultProfileId || null;
    if(!id)return {provider,effectiveProfile:null};
    if(typeof provider?.forkForTask!=='function')
      throw Object.assign(new Error('Model profiles require a compatible API provider.'),{code:'profile_unsupported',statusCode:409});
    const publicInfo=aiProfiles.get(id);
    if(!publicInfo)throw Object.assign(new Error('Selected model profile does not exist.'),{code:'profile_not_found',statusCode:404});
    const config=await aiProfiles.resolveConfig(id);
    if(expectedRevision && expectedRevision!==config.revision)
      throw Object.assign(new Error('The model profile changed. Review its endpoint and credentials before starting a new task.'),{
        code:'profile_revision_changed',statusCode:409});
    const taskProvider=provider.forkForTask(config);
    return {provider:taskProvider,effectiveProfile:{
      id:config.id,name:config.name||config.id,revision:config.revision,
      provider:config.provider,protocol:config.protocol,model:config.model,
      endpointOrigin:new URL(config.apiBaseUrl).origin,
      contextWindow:config.contextWindow,
      ratesUsdPerMillion:config.ratesUsdPerMillion??null,
      credentialSource:publicInfo.hasKey?'protected_reference':'none',
      // What the fork keeps of the profile. Header NAMES only: the values are secrets and live in the task's provider alone.
      customPath:config.customPath||null,
      customHeaderNames:config.customHeaders.map(header=>header.name),
      promptCaching:taskProvider.capabilities().promptCaching,
    }};
  };
  const pluginManager = manager.pluginManager ?? new PluginManager({ stateDir: hubStateDir });
  manager.pluginManager = pluginManager;
  pluginManager.load().catch(() => {});
  // Keep discovery beside the installed skill library, including isolated Hub profiles.
  const skillRegistry = new GitHubSkillRegistry({ pluginManager, stateDir: pluginManager.stateDir ?? hubStateDir });
  skillRegistry.load().catch(() => {});
  const sandboxEngine = manager.sandboxEngine || new SandboxEngine({
    mode: 'host',
    workspaceRoot: manager.workspace,
    workspace: manager.studio,
    registry: manager.executionRegistry,
    permissionGate: gate,
  });
  manager.sandboxEngine = sandboxEngine;
  manager.executionRegistry = sandboxEngine.registry;
  const state = (csrf = token) => ({ ...manager.state(), workspaces:workspaceRegistry?.state()??{activePath:manager.workspace,items:manager.workspace?[{path:manager.workspace,name:path.basename(manager.workspace)}]:[]}, ai: { ...(provider?.state() ?? { provider: 'disabled', configured: false }), profiles: aiProfiles.list(), defaultProfileId: aiProfiles.defaultProfileId, busy: aiBusy }, plugins: { count: pluginManager.installed().length, active: pluginManager.activeSkills().length }, projectInstructions: { ...(manager.projectInstructionsSetting?.current() ?? taskEngine?.api?.primary?.projectInstructions ?? projectInstructionsSetting()) }, agentOptions: { ...(manager.agentOptions?.current() ?? agentOptionsView()) }, update: updateState(), browser: browser?.browserState() ?? null, agent: taskEngine?.state() ?? { activeTaskId: null, active: null, tasks: [] }, studio: studio ? {workspace:studio.root, permissions: { ...(permissions?.state?.()??gate?.state()??{}), pending: [...(permissions?.state?.().pending??[]), ...(taskEngine?.api?.pendingApprovals?.()??[]), ...(browser?.pendingApprovals?.()??[]), ...(manager.mcpHost?.pendingApprovals?.()??[])] }, terminals:terminal?.state()??[], features:['files','code-search','git-diff','checkpoints','review','terminal','skills','plan','test-discovery','test-evidence','research-delegates','docker-readonly-sandbox','interactive-terminal','optional-conpty','python-ast-index','optional-lsp','local-preview','light-dark-theme'], delegates:delegates?.state()??null,dynamicDelegates:dynamic?.state()??null} : null, csrfToken: csrf });
  const requireNoTask = (message = 'Dừng các tác vụ AI đang chạy trước khi đổi Base URL, API key hoặc model.') => { if (taskEngine?.state().activeTaskId || dynamic?.activeRunId || coding?.active || delegates?.running) { const e = new Error(message); e.statusCode = 409; throw e; } };
  // The owner's external MCP servers (lib/mcp/http-api.mjs, docs/MCP-CLIENT.md): the routes work on the client manager assembleStudio gave the manager, and
  // every write refuses while a task, a coding or dynamic worker or a delegate runs (409 mcp_task_active), like the other settings of a run.
  // The module is imported on first use, like every part of lib/mcp (tests/verify-mcp-runtime.mjs: hub.mjs imports none of it statically).
  let mcpRoutes = null;
  let mcpModule = null;
  const mcpApi = async () => {
    if (!manager.mcp) throw Object.assign(new Error('The MCP client manager is not initialized.'), { statusCode: 503, code: 'mcp_unavailable' });
    mcpModule ??= import('./lib/mcp/http-api.mjs');
    const { McpHttpApi } = await mcpModule;
    if (mcpRoutes?.mcp !== manager.mcp) {
      mcpRoutes = new McpHttpApi({ mcp: manager.mcp, mask: (text) => redact(text, manager.secrets ?? []),
        busy: () => Boolean(taskEngine?.state()?.activeTaskId || dynamic?.activeRunId || coding?.active || coding?.integrating || delegates?.running) });
    }
    return mcpRoutes;
  };
  // The state of the update notice with the state of the download under it (`update.download`) and what the last update left (`update.applied`, null when nothing): all memory, so reading it never touches the network or a file.
  const updateState = () => (updates ? { ...updates.status(), download: downloads ? downloads.status() : { state: 'idle' }, applied: applied ? applied.status() : null } : null);
  const updateUnavailable = () => Object.assign(new Error('Kiểm tra bản cập nhật chưa khởi tạo.'), { statusCode: 503, code: 'update_unavailable' });
  const changeAi = async (operation) => {
    requireNoTask();
    if (aiBusy) { const e = new Error('Đang thay đổi kết nối AI. Chờ thao tác hiện tại hoàn tất.'); e.statusCode = 409; throw e; }
    aiBusy = true;
    try { return await operation(); } finally { aiBusy = false; }
  };
  // Proof packs and the owner's trust in an acceptance file (lib/proof/http-api.mjs, docs/PROOF-HUB-API.md). What it answers is {status, headers, body}.
  const proofApi = new ProofHttpApi({ manager, log: (line) => manager.log?.(line) });
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP_LOOPBACK);
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const send = (answer) => { res.writeHead(answer.status, answer.headers); res.end(answer.body); };
    try {
      if (!hosts.has(req.headers.host)) return json(403, { error: 'Host không được phép.' });
      // Only the pathname and query are used below; the base just lets a relative request target parse. Who the request is for is
      // decided by the Host check, never by what a client puts in the request line.
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      // Treat trailing slashes on API paths consistently across builds.
      if (url.pathname.startsWith('/api/') && url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
      const origin = req.headers.origin;
      const csrfNow = token;
      const stateNow = () => state(csrfNow);
      const extensionRead = ['/api/extension-state', '/api/instructions'].includes(url.pathname);
      const browserRoute = EXTENSION_PAIRED_ROUTE.exec(url.pathname);
      const extensionOrigin = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      if (origin && !origins.has(origin) && !((extensionRead && ['GET', 'OPTIONS'].includes(req.method) || browserRoute && ['POST', 'OPTIONS'].includes(req.method)) && extensionOrigin)) {
        return json(403, { error: 'Origin không được phép.' });
      }
      if ((extensionRead || browserRoute) && extensionOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        if ((extensionRead || browserRoute) && extensionOrigin) {
          res.setHeader('Access-Control-Allow-Methods', browserRoute ? 'POST' : 'GET');
          if (browserRoute) res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          res.writeHead(204); return res.end();
        }
        return json(405, { error: 'Phương thức không được hỗ trợ.' });
      }
      // One default-deny gate for the whole API surface. Static dashboard files carry no secret and stay open so the page
      // can load and bootstrap; every /api/ and /auth/ request needs the bearer unless it is one of the named exceptions.
      const publicProbe = req.method === 'GET' && PUBLIC_API_ROUTES.includes(url.pathname);
      const companionRead = req.method === 'GET' && extensionRead && extensionOrigin;
      const companionPaired = req.method === 'POST' && Boolean(browserRoute);
      const ticketRedeem = req.method === 'POST' && url.pathname === '/api/session/redeem';
      if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) && !publicProbe && !companionRead && !companionPaired && !ticketRedeem && !hasBearer(req)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="chatmcp-hub"');
        return json(401, { error: 'Cần phiên Hub hợp lệ. Mở lại DatGold từ launcher.', code: 'hub_auth_required' });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { app: APP_ID, version: VERSION, uiBuild: UI_BUILD, initialized: isInitialized(), backend: manager.backend, auth: 'bearer' });
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return json(200, { app: APP_ID, version: VERSION, uiBuild: UI_BUILD, postRoutes: POST_ROUTES, frontend: 'React', offlineAssets: true, auth: 'bearer' });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state(csrfNow));
      if (req.method === 'POST' && url.pathname === '/api/session/ticket') return json(200, tickets.issue());
      if (ticketRedeem) {
        // The ticket is the credential; the page proves it is ours with the same Origin and marker a dashboard POST carries.
        if (!origins.has(origin) || req.headers['x-chatmcp-request'] !== 'local-dashboard') return json(403, { error: 'Phiên trang localhost không hợp lệ. Tải lại trang.', code: 'csrf' });
        const payload = await bodyJson(req, 4096);
        if (!tickets.redeem(payload?.ticket)) return json(401, { error: 'Mã mở phiên đã hết hạn hoặc đã dùng. Mở lại DatGold từ launcher.', code: 'hub_ticket_invalid' });
        return json(200, { secret });
      }
      if (!isInitialized() && (req.method === 'POST' || url.pathname === '/auth/chatgpt/callback')) return json(503, { error: 'Hub đang nạp cấu hình. Chờ vài giây rồi thử lại.' });
      if (req.method === 'POST' && browserRoute) {
        if (!browser) return json(503, { error: 'Browser runner chưa khởi tạo.' });
        if (origin && !extensionOrigin) return json(403, { error: 'Thao tác này dành cho tiện ích đã ghép.' });
        const payload = await bodyJson(req, browserRoute[1] === 'reply' ? 8 * 1024 * 1024 : 65536);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(400, { error: 'Nội dung phải là JSON object.' });
        if (browserRoute[1] === 'pair') {
          if (origin && origin !== `chrome-extension://${payload.extensionId}`) return json(403, { error: 'Định danh tiện ích không khớp Origin.' });
          return json(200, await browser.pair(payload));
        }
        const bearer = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '');
        browser.authenticate(bearer?.[1], payload.clientId, origin);
        return json(200, await (browserRoute[1]==='recover-url'?browser.recoverUrl(payload):browser[browserRoute[1]](payload)));
      }
      if (req.method === 'GET' && url.pathname === '/api/studio/terminal/events') {
        if(!terminal) return json(503,{error:'Terminal chưa sẵn sàng.'});
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write(': connected\n\n');
        const dispose=terminal.subscribe(event=>{if(!res.destroyed)res.write(`data: ${JSON.stringify(event)}\n\n`);});
        const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},15000);
        const close=()=>{clearInterval(heartbeat);dispose();};
        req.once('close',close);res.once('close',close);
        return;
      }
      // Read-only code intelligence and review endpoints. All paths are
      // constrained to the selected workspace (including symlink resolution).
      if (req.method === 'GET' && url.pathname.startsWith('/api/studio/')) {
        if(!studio) return json(503,{error:'Studio chưa sẵn sàng.'});
        const pick=(name)=>url.searchParams.get(name)??'';
        let value;
        switch(url.pathname){
          case '/api/studio/intelligence/status': value=await intelligence?.status() ?? {available:false};break;
          case '/api/studio/intelligence/symbols': value=await intelligence?.symbols({query:pick('query'),limit:Number(pick('limit'))||100})??{matches:[]};break;
          case '/api/studio/intelligence/references': value=await intelligence?.references({symbol:pick('symbol')})??{matches:[]};break;
          case '/api/studio/intelligence/definitions': value=await intelligence?.definitions({symbol:pick('symbol')})??{matches:[]};break;
          case '/api/studio/intelligence/lsp': value=await intelligence?.lspRequest({language:pick('language')||'python',method:pick('method')||'definition',file:pick('file'),line:Number(pick('line'))||1,column:Number(pick('column'))||1})??{result:null};break;
          case '/api/studio/sandbox': value=await terminal?.sandbox?.status()??{ready:false};break;
          case '/api/studio/preview': value=await preview?.({port:pick('port'),pathname:pick('pathname')||'/'})??{ready:false};break;
          case '/api/studio/tree': value=await studio.tree({directory:pick('directory'),limit:Number(pick('limit'))||250});break;
          case '/api/studio/file': value=await studio.read({file:pick('file'),maxBytes:Math.min(EDITABLE_FILE_BYTES,Number(pick('maxBytes'))||120000)});break;
          case '/api/studio/search': value=await studio.search({query:pick('query'),mode:pick('mode')||'text',limit:Number(pick('limit'))||60});break;
          case '/api/studio/git/status': value=await studio.gitStatus();break;
          case '/api/studio/git/refs': {
            const desired=pick('workspacePath');
            if(desired&&workspaceRegistry){
              const entry=await workspaceRegistry.resolve(desired);
              if(entry.path!==manager.workspace&&taskEngine?.api?.gitRefs)
                return json(200,await taskEngine.api.gitRefs(entry.path));
            }
            const git=studio.gitRunner;
            const [branchesRun,worktreesRun,branchRun]=await Promise.all([
              git.text(['for-each-ref','--format=%(refname)%09%(refname:short)','refs/heads'],{timeoutMs:15000}),
              git.text(['worktree','list','--porcelain'],{timeoutMs:15000}),
              git.text(['symbolic-ref','--quiet','--short','HEAD'],{timeoutMs:15000}),
            ]);
            if(branchesRun.truncated||worktreesRun.truncated||branchesRun.timedOut||worktreesRun.timedOut)
              throw Object.assign(new Error('Git discovery returned truncated or timed-out output.'),{statusCode:409});
            if(branchesRun.code!==0||worktreesRun.code!==0) {
              value={branches:[],worktrees:[],currentBranch:null,gitAvailable:false};
              break;
            }
            const branches=branchesRun.stdout.split(/\r?\n/).filter(Boolean).slice(0,120)
              .map(line=>{const [ref,name]=line.split('\t');return {ref,name};})
              .filter(b=>/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(b.ref)&&b.name);
            const worktrees=worktreesRun.stdout.trim().split(/\r?\n\r?\n/)
              .filter(Boolean).slice(0,100).map(block=>{
                const rows=block.split(/\r?\n/);
                const field=(prefix)=>rows.find(x=>x.startsWith(prefix))?.slice(prefix.length)||null;
                const gitBranch=field('branch ');
                return {path:field('worktree '),head:field('HEAD '),
                  branch:gitBranch?.startsWith('refs/heads/')?gitBranch.slice(11):null};
              }).filter(x=>x.path);
            value={branches,worktrees,currentBranch:branchRun.code===0?branchRun.stdout.trim():null,gitAvailable:true};
            break;
          }
          case '/api/studio/git/diff': value=await studio.gitDiff({file:pick('file'),staged:pick('staged')==='true'});break;
          case '/api/studio/git/check': value=await studio.gitDiffCheck();break;
          case '/api/studio/checkpoints': value=await studio.checkpoints();break;
          case '/api/studio/review': value=await studio.review({checkpointId:pick('checkpointId'),file:pick('file')});break;
          case '/api/studio/task-review': {
            // A task that has stopped says when: what Git finds after that is not the task's.
            const task=taskEngine?.get?.(pick('taskId'));
            value=await studio.taskReview({taskId:pick('taskId'),until:task&&task.status!=='running'?task.finishedAt:null});
            break;
          }
          case '/api/studio/preview-checkpoint': value=await studio.previewCheckpoint({checkpointId:pick('checkpointId')});break;
          case '/api/studio/checks': value=await studio.checks();break;
          case '/api/studio/verifications': value=await verification?.list({taskId:pick('taskId')}) ?? {runs:[],total:0};break;
          case '/api/studio/skills': value=await studio.skills();break;
          case '/api/studio/terminal': value=terminal?.state()??[];break;
          case '/api/studio/terminal/capabilities': value=await terminal?.capabilities()??{};break;
          case '/api/studio/delegates': value=delegates?.state()??null;break;
          case '/api/studio/dynamic-delegates': value=dynamic?.state()??{activeRunId:null,last:null};break;
          case '/api/studio/coding': value=coding?.state()??{activeRunId:null,jobs:[]};break;
          case '/api/studio/coding/context': value=await coding.contextPreview({runId:pick('runId'),workerId:pick('workerId'),maxFiles:Math.max(1,Math.min(8,Number(pick('maxFiles'))||6))});break;
          case '/api/studio/coding/recovery': value=await coding.recoveryStatus({runId:pick('runId')});break;
          case '/api/studio/coding/review':value=await coding.review({runId:pick('runId'),workerId:pick('workerId')||null});break;
          case '/api/studio/coding/checks': value=await coding.discoverWorkerChecks({workerId:pick('workerId')});break;
          case '/api/studio/workflow': value=await manager.workflow.state(pick('taskId'));break;
          case '/api/studio/plan': value=await planStudio(pick('taskId')).plan({taskId:pick('taskId')});break;
          default:return json(404,{error:'Không tìm thấy Studio endpoint.'});
        }
        return json(200,value);
      }
      if (req.method === 'GET' && url.pathname === '/api/background-tasks') {
        // Web Companion sessions are actual background executions too.
        // Never count them as fabricated API tasks or hide their owning chat.
        const tasks=[...(taskEngine?.api?.backgroundTasks?.()??[]),
          ...(browser?.backgroundTasks?.()??[])];
        const registered=workspaceRegistry?.state().items.map(item=>item.path);
        const isRegistered=folder=>registered?.some(root=>
          process.platform==='win32' ? root.toLowerCase()===String(folder).toLowerCase() : root===folder);
        const workflows=taskEngine?.api?.workflows?.list?.()??[];
        return json(200,{
          tasks:registered?tasks.filter(task=>isRegistered(task.workspacePath)):tasks,
          workflows:registered?workflows.filter(w=>isRegistered(w.workspacePath)):workflows,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/workspaces')
        return json(200,workspaceRegistry?.state()??{activePath:manager.workspace,items:[]});
      if (req.method === 'GET' && url.pathname === '/api/catalog') return json(200, manager.catalog ?? { ready: false, tools: [], counts: {} });
      if (req.method === 'GET' && url.pathname === '/api/ai/models') {
        // Asking the provider for its model list changes nothing, so it does not take the "AI is being reconfigured" lock.
        if (!provider) return json(200, { models: [], source: 'none' });
        const signal = AbortSignal.timeout(35000);
        if (typeof provider.discoverModels !== 'function') return json(200, { models: await provider.listModels(), source: 'configured' });
        return json(200, await provider.discoverModels({ signal }));
      }
      // What the catalog knows about a model (its limits and prices, what the Hub would plan on, the levels of thinking effort it can be given): a file read, no network, nothing about the key.
      if (req.method === 'GET' && url.pathname === '/api/ai/model-info') { await catalogReady; return json(200, modelInfo(modelInfoQuery(url.searchParams))); }
      // The list of models the Hub knows (which snapshot, how old, whether the owner updated it) and, for the model picker, the models of one provider with their facts. Neither touches the network.
      if (req.method === 'GET' && url.pathname === '/api/ai/catalog') { await catalogReady; return json(200, catalogs.status()); }
      if (req.method === 'GET' && url.pathname === '/api/ai/catalog/models') { await catalogReady; return json(200, modelsList(modelsQuery(url.searchParams))); }
      if (req.method === 'GET' && url.pathname === '/api/ai/presets') return json(200,{ presets: publicPresets(provider?.env ?? process.env), envKeys: provider?.envKeys() ?? [] });
      if (req.method === 'GET' && url.pathname === '/api/ai/profiles') return json(200, { profiles: aiProfiles.list(), defaultProfileId: aiProfiles.defaultProfileId });
      // The owner's external MCP servers as the screen may see them: no secret, in plain or protected form (lib/mcp/http-api.mjs).
      if (req.method === 'GET' && url.pathname === '/api/mcp/servers') return json(200, await (await mcpApi()).servers());
      // The acceptance file of the open project as its owner is asked to trust it: its sha256, criteria and commands (lib/proof/http-api.mjs).
      if (req.method === 'GET' && url.pathname === '/api/proof/acceptance') return send(await proofApi.acceptance(url.searchParams));
      if (req.method === 'GET' && url.pathname === '/api/sandbox/status') return json(200, sandboxEngine.status());
      // The update notice (lib/update-check.mjs): what the Hub already knows about a newer release. A read of memory, never a request to the network: the check is the POST below.
      if (req.method === 'GET' && url.pathname === '/api/update/status') { if (!updates) return json(503, { error: 'Kiểm tra bản cập nhật chưa khởi tạo.', code: 'update_unavailable' }); return json(200, { update: updateState() }); }
      if (req.method === 'GET' && url.pathname === '/api/workspace/lock') {
        const lock = new WorkspaceLock({ workspaceRoot: manager.workspace || BUNDLE_ROOT });
        return json(200, await lock.inspect());
      }
      if (req.method === 'GET' && url.pathname === '/api/plugins/registry') {
        return json(200, { sources: skillRegistry.sources(), skills: skillRegistry.list({ query: url.searchParams.get('query') || '' }), updates: skillRegistry.updates() });
      }
      if (req.method === 'GET' && url.pathname === '/api/plugins/marketplace') {
        return json(200, { catalog: pluginManager.marketplace({ category: url.searchParams.get('category'), query: url.searchParams.get('query') }) });
      }
      if (req.method === 'GET' && url.pathname === '/api/plugins/installed') {
        return json(200, { plugins: pluginManager.installed(), activeSkills: pluginManager.activeSkills() });
      }
      if (req.method === 'GET' && url.pathname === '/auth/chatgpt/callback') return json(410, { error: 'Không hỗ trợ kết nối OAuth ChatGPT trong chế độ này.' });
      if (req.method === 'GET' && url.pathname === '/api/tasks/events') {
        if (!taskEngine) return json(503, { error: 'Agent chưa sẵn sàng.' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        const dispose = taskEngine.subscribe?.((event) => {
          if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
        req.on('close', () => { clearInterval(heartbeat); dispose?.(); });
        return;
      }
      const taskRoute = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})(\/report|\/stream|\/proof)?$/);
      if (req.method === 'GET' && taskRoute) {
        if (taskRoute[2] === '/stream') {
          const task = taskEngine?.get(taskRoute[1]);
          if (!task) return json(404, { error: 'Không tìm thấy nhiệm vụ.' });
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(': connected\n\n');
          res.write(`data: ${JSON.stringify({ type: 'task_snapshot', task })}\n\n`);
          const dispose = taskEngine.subscribe?.((event) => {
            if (event.taskId === taskRoute[1] && !res.destroyed) {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          });
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
          req.on('close', () => { clearInterval(heartbeat); dispose?.(); });
          return;
        }
        // The pack of the task's last run (json, md, html), checked whole before it is answered.
        if (taskRoute[2] === '/proof') return send(await proofApi.proof(taskRoute[1], () => taskEngine?.get(taskRoute[1]) ?? null, url.searchParams));
        const value = taskRoute[2] === '/report' ? await taskEngine?.report(taskRoute[1]) : taskEngine?.get(taskRoute[1]);
        if (value === null || value === undefined) return json(404, { error: 'Không tìm thấy nhiệm vụ.' });
        if (!taskRoute[2]) return json(200, value);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="DATGOLD-${taskRoute[1]}.txt"`);
        return res.end(value);
      }
      if (req.method === 'GET' && url.pathname === '/api/extension-state') {
        const state = manager.state();
        return json(200, { version: VERSION, workspace: state.workspace, proxyUrl: state.proxyUrl, ready: state.services.local?.state === 'ready', generation: state.generation, instanceId: state.instanceId });
      }
      if (req.method === 'GET' && url.pathname === '/api/instructions') {
        const text = manager.instructions();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (url.searchParams.get('download') === '1') res.setHeader('Content-Disposition', 'attachment; filename="DATGOLD-WORKSPACE-INSTRUCTIONS.txt"');
        return res.end(text);
      }
      if (req.method === 'POST') {
        const expectedUi = req.headers['x-chatmcp-ui-build'];
        if (expectedUi && expectedUi !== UI_BUILD) return json(409, { error: `Giao diện phiên bản ${expectedUi} không khớp Hub ${VERSION}. Hãy STOP Hub cũ, START bản mới và nhấn Ctrl+F5.`, code: 'ui_backend_version_mismatch', serverVersion: VERSION, uiBuild: UI_BUILD });
        // Local dashboard mutations require the matching Origin and CSRF.
        const requestOk=origins.has(origin)&&req.headers['x-chatmcp-request']==='local-dashboard'
          &&equalToken(req.headers['x-chatmcp-csrf'],token);
        if(!requestOk)return json(403,{error:'Phiên trang localhost không hợp lệ. Tải lại trang.',code:'csrf'});
        const payload = await bodyJson(req, ['/api/tasks/start','/api/tasks/continue'].includes(url.pathname) ? ATTACHMENT_BODY_LIMIT : (BODY_LIMIT_OF.get(url.pathname) ?? 65536));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(400, { error: 'Nội dung yêu cầu phải là JSON object.' });
        const unknownAction = () => json(404, { error: `Không tìm thấy thao tác POST ${url.pathname} trên Hub ${VERSION}. Có thể dashboard và tiến trình Hub không cùng phiên bản; hãy STOP/START Hub và Ctrl+F5.`, code:'unknown_action', path:url.pathname, method:'POST', serverVersion:VERSION, uiBuild:UI_BUILD });
        const requireIdle = (message) => { if (taskEngine?.state()?.activeTaskId) throw Object.assign(new Error(message), { statusCode: 409 }); };
        let result;
        switch (url.pathname) {
          case '/api/studio/permissions/config':
            // A live detached coding or dynamic worker may have inherited the
            // previous authority. Refuse permission changes until its owner
            // has explicitly stopped/reconciled that run, rather than letting
            // stale workers continue with the wrong Full Access policy.
            if(taskEngine?.state()?.activeTaskId||coding?.active||coding?.integrating||
               dynamic?.activeRunId||delegates?.running)
              throw Object.assign(new Error('Dừng các coding/dynamic/research workers và tác vụ chính trước khi đổi quyền.'),{
                code:'workers_active',statusCode:409,
              });
            result=gate.configure(payload);break;
          case '/api/studio/permissions/decide': {
              // The feedback and the edited plan of an answer (plan mode, docs/PLAN-MODE.md) are checked here for type and length; the gate that holds
              // the request checks that it is a plan request. The Companion and the MCP host hold no plan request: an answer with either goes to none of them.
              const extras=decisionExtras(payload);
              const plain=extras.feedback===null&&extras.plan===null&&extras.execution===null&&extras.revision===null;
              // A plan request is answered against the plan file (answerPlan: the revision, an edit saved as the owner's revision).
              const planRequest=pendingPlanRequests().find((item)=>item.id===payload.id);
              if(planRequest){
                if(typeof payload.approved!=='boolean')throw Object.assign(new Error('approved phải là boolean.'),{code:'bad_decision',statusCode:400});
                try{result=await answerPlan(planRequest,payload.approved,extras);}
                catch(error){if(error?.code==='plan_conflict')return json(409,planConflictJson(error));throw error;}
              }
              else result=(gate?.state().pending||[]).some(p=>p.id===payload.id)
                ? gate.decide(payload.id,payload.approved,extras)
                : taskEngine?.api?.decidePermission?.(payload.id,payload.approved,extras)
                  || (plain?(browser?.decidePermission?.(payload.id,payload.approved)
                    || manager.mcpHost?.decide?.(payload.id,payload.approved)):null);
              if(!result)throw Object.assign(new Error('Không tìm thấy yêu cầu phê duyệt.'),{statusCode:404});
              break;
            }
          // Only the label of a checkpoint is the page's to give. Which task a checkpoint belongs to, and which files it covers, are the Hub's own record of what a tool call did (a review
          // is made from them), so a request cannot name them.
          case '/api/studio/checkpoint': result=await studio.checkpoint({label:payload.label});break;
          case '/api/studio/file/save': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không ghi file trên Windows host. Đổi sang host-review để lưu bản chỉnh sửa sau khi review.'),{statusCode:403});if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Đợi agent dừng trước khi lưu file từ editor.'),{statusCode:409});result=await studio.save(payload);break;
          case '/api/studio/restore': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không khôi phục file trực tiếp trên Windows host.'),{statusCode:403});result=await studio.restore(payload);break;
          case '/api/studio/restore-checkpoint': if(taskEngine?.state()?.activeTaskId || agent?.state()?.activeTaskId || manager?.taskEngine?.state()?.activeTaskId || manager?.agent?.state()?.activeTaskId)throw Object.assign(new Error('Để tránh xung đột file, chờ agent dừng trước khi khôi phục checkpoint.'),{code:'task_in_progress',statusCode:409});if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không khôi phục checkpoint trực tiếp trên Windows host.'),{statusCode:403});result=await studio.restoreCheckpoint(payload);break;
          case '/api/studio/review/reject-created': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Chờ agent dừng trước khi từ chối file nó đã tạo.'),{code:'task_in_progress',statusCode:409});if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không chuyển file khỏi workspace trên Windows host.'),{statusCode:403});result=await studio.rejectCreated(payload);break;
          case '/api/studio/accept': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không thay đổi file trực tiếp trên Windows host.'),{statusCode:403});result=await studio.accept(payload);break;
          case '/api/studio/coding/plan': result=payload.modelAssist===true?await coding.planWithModel(payload):coding.plan(payload);break;
          case '/api/studio/coding/run': if(manager.taskId||delegates?.running)throw Object.assign(new Error('Wait for active agent/research tasks.'),{statusCode:409});result=await coding.run(payload);break;
          case '/api/studio/coding/cancel': result=coding.cancel();break;
          case '/api/studio/coding/recovery/acknowledge': result=await coding.acknowledgeRecovery(payload);break;
          case '/api/studio/coding/check-grant': result=await coding.grantCheck(payload);break;
          case '/api/studio/coding/integrate': result=await coding.integrate(payload);break;
          case '/api/studio/coding/publish': result=await coding.publish(payload);break;
          case '/api/studio/delegates/cancel': result=delegates.cancel();break;
          case '/api/studio/dynamic-delegates/run':
            if(!dynamic) throw Object.assign(new Error('Dynamic delegation is not initialized.'),{statusCode:503});
            if(manager.taskId||coding?.active||delegates?.running||aiBusy)
              throw Object.assign(new Error('Finish other active agent/model jobs before dynamic delegation.'),{statusCode:409});
            result=await dynamic.run(payload);break;
          case '/api/studio/dynamic-delegates/cancel': result=dynamic?.cancel()??{cancelled:false};break;
          case '/api/studio/delegates/orchestrate': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Chờ agent chính hoàn thành.'),{statusCode:409});result=await delegates.orchestrate(payload);break;
          case '/api/studio/delegates/research': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Đợi agent chính hoàn tất trước khi phân tích song song.'),{statusCode:409});result=await delegates.research(payload);break;
          case '/api/studio/terminal/start': if(gate?.executionPolicy==='sandbox-only'&&!payload.sandbox)throw Object.assign(new Error('Sandbox-only: terminal phải bật Docker sandbox; không cho chạy trực tiếp trên Windows host.'),{statusCode:403});if(taskEngine?.state()?.activeTaskId) throw Object.assign(new Error('Để tránh xung đột file, dừng agent trước khi chạy terminal thủ công.'),{statusCode:409});result=await terminal.start(payload);break;
          case '/api/studio/terminal/stop': result=terminal.stop(payload.id);break;
          case '/api/studio/terminal/input': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Chờ agent dừng trước khi nhập terminal.'),{statusCode:409});result=terminal.write(payload.id,payload.text);break;
          case '/api/studio/terminal/resize': result=terminal.resize(payload.id,payload);break;
          case '/api/studio/intelligence/index': result=await intelligence.index({force:Boolean(payload.force)});break;
          case '/api/studio/intelligence/engines/probe':
            if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Host language-server checks are not allowed in sandbox-only mode.'),{statusCode:403});
            result=await intelligence.engineHealth({probe:true});break;
          case '/api/studio/intelligence/lsp/start': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: language server chạy trên Windows host. Chuyển sang host-review nếu bạn chấp nhận chạy LSP trên host.'),{statusCode:403});result=await intelligence.lspStart({language:payload.language});break;
          // The owner's edit of a plan: always as the user (the page cannot write as the model), from `baseRevision` when the page sends the
          // revision it showed (another revision: 409 with the current one), unconditionally when it sends none.
          case '/api/studio/plan/set': {
            // A baseRevision that is not a whole number is refused by the plan itself (400 bad_revision), before anything is read.
            try{result=await planStudio(payload.taskId).plan({taskId:payload.taskId,operation:'set',title:payload.title??'',items:payload.items??[],text:payload.text,by:'user',expectedRevision:payload.baseRevision??null});}
            catch(error){if(error?.code==='plan_conflict')return json(409,planConflictJson(error));throw error;}
            break;
          }
          // The owner's decision on the plan a task waits with (docs/PLAN-MODE.md): approve it, choosing how it is carried out (`execution`: the mode of
          // the task afterwards), or request changes with feedback. `revision` is the revision the owner looked at; another one is 409.
          case '/api/studio/plan/decide': {
            if(typeof payload.taskId!=='string'||!/^[0-9a-f-]{36}$/i.test(payload.taskId))throw Object.assign(new Error('Cần ID hội thoại hợp lệ.'),{code:'bad_task_id',statusCode:400});
            if(!['approve','request_changes'].includes(payload.decision))throw Object.assign(new Error('decision phải là approve hoặc request_changes.'),{code:'bad_decision',statusCode:400});
            if(!(Number.isSafeInteger(payload.revision)&&payload.revision>=0))throw Object.assign(new Error('revision (bản kế hoạch người dùng đang xem) phải là số nguyên không âm.'),{code:'bad_revision',statusCode:400});
            const approve=payload.decision==='approve';
            const {feedback,execution}=decisionExtras({feedback:payload.feedback,execution:payload.execution});
            if(!approve&&feedback===null)throw Object.assign(new Error('Yêu cầu sửa kế hoạch cần phản hồi (feedback).'),{code:'feedback_required',statusCode:400});
            if(!approve&&execution!==null)throw Object.assign(new Error('Cách thực hiện (execution) chỉ đi kèm việc duyệt kế hoạch.'),{code:'bad_execution',statusCode:400});
            const planRequest=pendingPlanRequests().find((item)=>item.taskId===payload.taskId);
            if(!planRequest)throw Object.assign(new Error('Tác vụ này không có kế hoạch nào đang chờ duyệt.'),{code:'no_plan_request',statusCode:404});
            let answered;
            try{answered=await answerPlan(planRequest,approve,{feedback,plan:null,execution,revision:payload.revision});}
            catch(error){if(error?.code==='plan_conflict')return json(409,planConflictJson(error));throw error;}
            if(!answered)throw Object.assign(new Error('Yêu cầu duyệt kế hoạch đã hết hạn hoặc không còn.'),{code:'not_pending',statusCode:404});
            result={ok:true,taskId:payload.taskId,id:planRequest.id,decision:payload.decision,revision:payload.revision,execution};
            break;
          }
          case '/api/studio/verify/run': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Để tránh xung đột file, chờ agent dừng trước khi chạy kiểm thử thủ công.'),{statusCode:409});if(!verification)throw Object.assign(new Error('Bộ kiểm thử chưa khởi tạo.'),{statusCode:503});result=await verification.start(payload);break;
          case '/api/workspace/browse': result = await manager.browse({initialPath:payload.initialPath}); break;
          case '/api/workspaces/add': {
            if(!workspaceRegistry)throw Object.assign(new Error('Multi-workspace registry unavailable.'),{statusCode:503});
            const entry=await workspaceRegistry.add(payload.path);
            if(!manager.workspace)await manager.selectWorkspace(entry.path);
            result={workspace:entry,workspaces:workspaceRegistry.state()};
            break;
          }
          case '/api/workspaces/activate': {
            if(!workspaceRegistry)throw Object.assign(new Error('Multi-workspace registry unavailable.'),{statusCode:503});
            result=await workspaceRegistry.activate(payload.path);
            break;
          }
          case '/api/workspaces/remove': {
            if(!workspaceRegistry)throw Object.assign(new Error('Multi-workspace registry unavailable.'),{statusCode:503});
            const target=(await workspaceRegistry.resolve(payload.path)).path;
            const sameRoot=p=>process.platform==='win32'
              ? String(p||'').toLowerCase()===target.toLowerCase() : p===target;
            const engine=taskEngine?.state();
            const running=engine?.activeTaskIds??(engine?.activeTaskId?[engine.activeTaskId]:[]);
            const busyStates=new Set(['queued','preparing','planning','running','waiting_approval','verifying']);
            const hasLiveTask=running.some(id=>{
              const task=taskEngine.get(id);return sameRoot(task?.workspacePath||task?.workspace?.path);
            })||(engine?.tasks||[]).some(task=>
              sameRoot(task.workspacePath||task.workspace?.path)&&
              busyStates.has(task.state||task.status));
            if(hasLiveTask)
              throw Object.assign(new Error('Workspace còn task/subagent đang chạy hoặc xếp hàng. Dừng chúng trước khi gỡ workspace.'),{statusCode:409,code:'workspace_tasks_active'});
            if(sameRoot(manager.workspace)&&(coding?.active||coding?.integrating||dynamic?.activeRunId||delegates?.running))
              throw Object.assign(new Error('Dừng các coding/research workers của workspace chính trước khi gỡ.'),{statusCode:409,code:'workspace_workers_active'});
            result=await workspaceRegistry.remove(target);
            break;
          }
          case '/api/workspace/select': if(taskEngine?.state()?.activeTaskIds?.length || coding?.active||coding?.integrating||dynamic?.activeRunId)
            throw Object.assign(new Error('Stop coding/dynamic workers before switching the legacy Studio workspace.'),{statusCode:409});
            await manager.selectWorkspace(payload.path);
            if(workspaceRegistry){
              await workspaceRegistry.add(payload.path);
              await workspaceRegistry.activate(payload.path);
            }
            result = stateNow(); break;
          case '/api/services/start': await manager.start(); result = stateNow(); break;
          case '/api/services/stop': if(coding?.active||coding?.integrating||dynamic?.activeRunId)throw Object.assign(new Error('Stop coding/dynamic workers before stopping services.'),{statusCode:409});await manager.stop(); result = stateNow(); break;
          case '/api/browser/pair-code': if (!browser) throw new Error('Browser runner chưa khởi tạo.'); result = await browser.createPairCode(); break;
          case '/api/browser/recover-url/request': if(!browser)throw new Error('Browser runner chưa khởi tạo.'); result=browser.requestUrlRecovery(payload);break;
          case '/api/browser/outbound/decide': if (!browser) throw new Error('Browser runner chưa khởi tạo.'); result = await browser.decideOutbound(payload); break;
          case '/api/browser/privacy/config': if (!browser) throw new Error('Browser runner chưa khởi tạo.'); await browser.configurePrivacy(payload); result = stateNow(); break;
          case '/api/browser/unpair': if (!browser) throw new Error('Browser runner chưa khởi tạo.'); await browser.unpair(); result = stateNow(); break;
          case '/api/ai/config': if (!provider) throw new Error('Kết nối AI chưa khởi tạo.'); await changeAi(() => provider.configure(payload)); result = stateNow(); break;
          case '/api/ai/clear-key': if (!provider) throw new Error('Kết nối AI chưa khởi tạo.'); await changeAi(() => provider.clearKey()); result = stateNow(); break;
          case '/api/ai/test': if (!provider) throw new Error('Kết nối AI chưa khởi tạo.'); result = await changeAi(async () => {
            if (!provider.ready()) throw Object.assign(new Error('Chưa cấu hình API key/model.'), { statusCode:409 });
            const diagnosticDeadlineMs = payload.strictProtocol === true ? 50_000 : 120_000;
            const testSignal = AbortSignal.timeout(diagnosticDeadlineMs);
            let response;
            try {
              response = typeof provider.diagnoseConnection === 'function'
                ? await provider.diagnoseConnection({ signal: testSignal, strictProtocol: payload.strictProtocol === true })
                : await provider.respond({ input: [{role:'user', content:[{type:'input_text',text:'Reply with only OK.'}]}], instructions:'Simple API connectivity check. Reply with OK.', tools: [], signal: testSignal });
            } catch (error) {
              if (testSignal.aborted) throw Object.assign(new Error('Kiểm tra gateway vượt thời gian cho phép. Mỗi phép thử có tối đa 20 giây; kiểm tra URL, giao thức và model.'), { statusCode:504 });
              throw error;
            }
            return { ok:true, model: provider.snapshot().model, responsePresent: response.responsePresent === true || response.output?.some(x=>x.type==='message') === true,
              autoSelected:response.autoSelected === true, protocol:response.protocol || provider.state().protocol,
              authMode:response.authMode || provider.state().authMode,attempts:Array.isArray(response.attempts)?response.attempts:undefined,
              toolCalling:response.toolCalling,toolCallingNote:response.toolCallingNote };
          }); break;
          case '/api/agent/mode': if (!agent) throw new Error('Agent chưa khởi tạo.');
            // Selecting the transport for NEW chats is not a model/API key
            // reconfiguration and must not interrupt jobs already running.
            await agent.configure(payload); result = stateNow(); break;
          // The owner's switch for AGENTS.md / CLAUDE.md (lib/project-instructions.mjs ProjectInstructionsStore). Like the transport above it applies to the NEXT run of every runner
          // and does not interrupt one that is going (that run keeps what it loaded), so nothing is refused while a task runs. Refused: a value that is not true or false (400) and a
          // change while CHATMCP_PROJECT_INSTRUCTIONS decides (409): the variable is the stronger setting.
          case '/api/agent/project-instructions': if (!manager.projectInstructionsSetting) throw Object.assign(new Error('Cài đặt hướng dẫn dự án chưa khởi tạo.'), { statusCode: 503 });
            await manager.projectInstructionsSetting.set(payload.enabled); result = stateNow(); break;
          case '/api/agent/options': if (!manager.agentOptions) throw Object.assign(new Error('Cài đặt tác tử chưa khởi tạo.'), { statusCode: 503 });
            await manager.agentOptions.set(payload); result = stateNow(); break;
          case '/api/auth/chatgpt/start': return json(410, { error: 'Dùng chế độ ChatGPT Web qua Browser Companion, không dùng OAuth ChatGPT trong Hub.' });
          case '/api/auth/logout': return json(410, { error: 'Để xoá API key đã lưu, dùng /api/ai/clear-key.' });
          case '/api/tasks/start': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); if (aiBusy) { const e = new Error('Kết nối AI đang thay đổi. Chờ hoàn tất rồi chạy nhiệm vụ.'); e.statusCode = 409; throw e; } result = { task: await taskEngine.start(payload) }; break;
          case '/api/tasks/continue': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); if (aiBusy) { const e = new Error('Kết nối AI đang thay đổi.'); e.statusCode=409; throw e; } result = { task: await taskEngine.continue(payload) }; break;
          case '/api/tasks/delete': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); result = await taskEngine.delete(payload.id); break;
          case '/api/tasks/cancel': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); result = { task: await taskEngine.cancel(payload.id) }; break;
          case '/api/workflows/cancel': {
            const workflow=taskEngine?.api?.workflows?.get?.(payload.id);
            if(!workflow)throw Object.assign(new Error('Workflow không tồn tại.'),{statusCode:404});
            if(workspaceRegistry)await workspaceRegistry.resolve(workflow.workspacePath);
            result={workflow:await taskEngine.api.workflows.cancel(payload.id)};
            break;
          }
          case '/api/tasks/auto-resume': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); result = { task: await taskEngine.setAutoResume(payload) }; break;
          case '/api/tasks/accept-criterion':
            if(!taskEngine?.acceptCriterion)throw Object.assign(
              new Error('Owner acceptance is unavailable.'),{statusCode:501});
            result={task:await taskEngine.acceptCriterion(payload)};break;
          // The owner trusts the acceptance file they were shown, by the sha256 of its exact bytes (the Hub reads the file again), or takes that back. Never by path or "latest";
          // only this page's POST reaches it: no tool of the model, no MCP client, not the ACP agent or the Companion.
          case '/api/proof/trust-acceptance': return send(await proofApi.trust(payload));
          case '/api/proof/revoke-acceptance': return send(await proofApi.revoke(payload));
          // The one request the Hub makes for this list, and only because its owner pressed the button: to models.dev, with nothing of theirs in it. A failure leaves the list in use as it was.
          case '/api/ai/catalog/refresh': requireNoTask('Chờ các tác vụ AI đang chạy xong rồi mới cập nhật danh sách model: mỗi lượt chạy giữ nguyên kế hoạch và giá của nó.'); await catalogReady; result = await catalogs.refresh(); break;
          case '/api/ai/profiles/upsert': result = { profile: await aiProfiles.upsert(payload) }; break;
          case '/api/ai/profiles/delete': result = await aiProfiles.delete(payload.id); break;
          case '/api/ai/profiles/default': result = await aiProfiles.setDefault(payload.id); break;
          case '/api/plugins/registry/source/add': result=await skillRegistry.addSource(payload);break;
          case '/api/plugins/registry/source/remove': result=await skillRegistry.removeSource(payload);break;
          case '/api/plugins/registry/refresh': result=await skillRegistry.refresh({sourceId:payload.sourceId});break;
          case '/api/plugins/registry/install': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Chờ agent hoàn thành trước khi cài skill.'),{statusCode:409});result={installed:await skillRegistry.install({key:payload.key,update:payload.update===true})};break;
          case '/api/plugins/install': result = { installed: await pluginManager.install(payload.id, payload.custom, payload.url) }; break;
          case '/api/plugins/uninstall': result = await pluginManager.uninstall(payload.id); break;
          case '/api/plugins/toggle': result = await pluginManager.toggle(payload.id, payload.enabled); break;
          // The owner approves the sha256 of the project's .chatmcp/hooks.json that they reviewed (lib/hooks.mjs). The project is always the
          // one the Hub has open: a caller cannot name another folder. Behind the bearer like every /api route.
          case '/api/hooks/approve-project': if (!manager.hooks) throw Object.assign(new Error('Hooks chưa khởi tạo.'), { statusCode: 503 }); result = await manager.hooks.approveProject({ projectRoot: manager.workspace, sha256: payload.sha256 }); break;
          // The update notice (lib/update-check.mjs). The owner's own acts, behind the same layers as every route: a check is a look at GitHub, the manifest and then its signature (at most one a minute,
          // two callers share it), skipping a version and the choice to check on its own write two small files. Nothing here downloads or starts anything.
          case '/api/update/check': { if (!updates) throw updateUnavailable(); const answer = await updates.check(); result = { update: updateState(), checked: answer.checked, throttled: answer.throttled }; break; }
          case '/api/update/skip': if (!updates) throw updateUnavailable(); await updates.skip(payload.version); result = { update: updateState() }; break;
          case '/api/update/auto-check': if (!updates) throw updateUnavailable(); await updates.setAutoCheck(payload.enabled); result = { update: updateState() }; break;
          // The download (lib/update-download.mjs): only from the owner's click, and the body is {version} (and, for "Download again", again: true) and nothing else is read. It looks at the release again (signature, platform, version, room on the disk)
          // before it fetches one byte, then streams the installer to a .part file of the Hub's data folder. It is allowed while agent tasks run (only applying an update needs them idle) and it installs nothing.
          case '/api/update/download': { if (!updates || !downloads) throw updateUnavailable(); const answer = await downloads.start(payload); result = { update: updateState(), started: answer.started }; break; }
          case '/api/update/download-cancel': { if (!downloads) throw updateUnavailable(); const answer = await downloads.cancel(); result = { update: updateState(), cancelled: answer.cancelled }; break; }
          // The owner has read what the last update left (lib/update-applied.mjs): the note is cleared in memory. The file was consumed when the Hub started, so nothing is written and nothing is asked.
          case '/api/update/applied-dismiss': if (!applied) throw updateUnavailable(); applied.dismiss(); result = { update: updateState() }; break;
          // The owner's external MCP servers (lib/mcp/http-api.mjs): the body is checked there, every write refuses while a task is active (409 mcp_task_active),
          // and an approval names the fingerprint the owner was shown (expectedFingerprint).
          case '/api/mcp/server/upsert': result = await (await mcpApi()).upsert(payload); break;
          case '/api/mcp/server/delete': result = await (await mcpApi()).remove(payload); break;
          case '/api/mcp/server/test': result = await (await mcpApi()).test(payload); break;
          case '/api/mcp/server/launch-record': result = await (await mcpApi()).launchRecord(payload); break;
          case '/api/mcp/server/approve-launch': result = await (await mcpApi()).approveLaunch(payload); break;
          case '/api/mcp/server/tool-review': result = await (await mcpApi()).toolReview(payload); break;
          case '/api/mcp/server/approve-tools': result = await (await mcpApi()).approveTools(payload); break;
          case '/api/mcp/server/tool-policy': result = await (await mcpApi()).toolPolicy(payload); break;
          case '/api/mcp/reload': result = await (await mcpApi()).reload(payload); break;
          case '/api/hub/shutdown': result = { ok: true }; setTimeout(() => void onShutdown(), 150); break;
          default: return unknownAction();
        }
        return json(200, { ...result, csrfToken: csrfNow });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Phương thức không được hỗ trợ.' });
      let filename = Object.hasOwn(staticFiles, url.pathname) ? staticFiles[url.pathname] : undefined;
      let isImmutable = false;
      if (!filename && url.pathname.startsWith('/assets/')) {
        let decoded = '';
        try { decoded = decodeURIComponent(url.pathname); } catch { return json(400, { error: 'Đường dẫn không hợp lệ.' }); }
        const normalized = path.posix.normalize(decoded);
        if (!normalized.includes('..') && normalized.startsWith('/assets/')) {
          const ext = path.extname(normalized).toLowerCase();
          if (Object.hasOwn(MIME, ext)) {
            filename = path.join('web/dist', normalized).replace(/\\/g, '/');
            isImmutable = true;
          }
        }
      }
      if (!filename) return json(404, { error: 'Không tìm thấy trang.' });
      const fullPath = path.resolve(bundleRoot, filename);
      if (!fullPath.startsWith(bundleRoot)) return json(403, { error: 'Đường dẫn không hợp lệ.' });
      let data;
      try {
        data = await fs.readFile(fullPath);
      } catch {
        if (filename === UI_INDEX) return json(503, UI_NOT_BUILT);
        return json(404, { error: 'Không tìm thấy trang.' });
      }
      res.setHeader('Content-Type', MIME[path.extname(filename)] || 'application/octet-stream');
      res.setHeader('Content-Length', data.length);
      if (isImmutable) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      res.writeHead(200);
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) return res.end();
      const safe = redact(String(error.message ?? 'Thao tác chưa hoàn tất.').split('\n')[0], manager.secrets ?? []);
      // Runtime errors are logged through the manager's sanitizer; never expose
      // raw source config or a stack trace in an HTTP response.
      manager.log(error.message ?? 'Thao tác chưa hoàn tất.');
      json(error.statusCode || 500, { error: safe, code: /^[a-z0-9_-]{1,80}$/i.test(String(error.code||'')) ? error.code : undefined });
    }
  });
  server.requestTimeout = 0; // A user can leave the native folder picker open.
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  // For the process that owns this server (it opens its own dashboard): a one-time ticket, never the secret itself.
  server.issueBootstrapTicket = () => tickets.issue().ticket;
  return server;
}

// The foreground runner. Its tool list follows the context window of the model of the task it starts (see lib/tool-selector.mjs): an unknown
// or small window gets the task-selected schemas instead of all 103. AgentRunner is passed in because main() loads it lazily.
export function createPrimaryAgentRunner(AgentRunner, { manager, provider, taskDirectory, log, env = process.env }) {
  return followProviderWindow(new AgentRunner({ manager, provider, taskDirectory, log, projectInstructions: manager.projectInstructionsSetting, agentOptions: manager.agentOptions }), env);
}

// What the host of the MCP server (lib/mcp/host.mjs) asks before a client's write: whether the Hub works in the workspace now. Any task of
// the agents (the foreground one, a pooled chat, the Companion's), the manager's own task or service operation, or the coding orchestrator
// merging a worker into the checkout: one writer at a time, so a client's write waits for all of them.
export function hostPrimaryState(manager, agent) {
  return () => ({ busy: Boolean(manager.taskId || manager.busy || agent?.state?.()?.activeTaskId || manager.codingOrchestrator?.integrating) });
}

// `url` is what is logged; `target` (the same address plus a one-time sign-in ticket in the fragment) is what is opened.
async function openDashboard(url, manager, target = url) {
  if (process.platform !== 'win32') {
    manager.log(`Mở ${url}`);
    // The sign-in link is single-use and short-lived; show it on a terminal only, never in hub.log.
    if (process.stdout.isTTY && target !== url) console.log(`Sign-in link (single use, 60 s): ${target}`);
    return;
  }
  // This URL is constructed from a validated numeric port and a base64url ticket, never shell input.
  const rundll = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe');
  await new Promise((resolve) => {
    const opener = spawn(rundll, ['url.dll,FileProtocolHandler', target], { detached: true, stdio: 'ignore', shell: false });
    opener.once('error', () => { manager.log(`Mở trình duyệt tại ${url}`); resolve(); });
    opener.once('spawn', () => { opener.unref(); resolve(); });
  });
}

// Local-only Hub command line; public hosting and the old Cloud Harness
// backend are intentionally unsupported and must fail closed.
const VALUE_OPTIONS=['--project','--port','--state-dir','--log-file','--backend'];
export function parseArguments(args,env=process.env){
  const values={};
  let open=!/^(1|true|yes)$/i.test(env.CHATMCP_NO_OPEN??'');
  for(let i=0;i<args.length;i++){
    if(args[i]==='--no-open'){open=false;continue;}
    if(!VALUE_OPTIONS.includes(args[i])||args[i+1]===undefined)throw new Error('Unknown/unsupported local Hub option.');
    values[args[i]]=args[++i];
  }
  if(/^(1|true|yes|on)$/i.test(String(env.CHATMCP_PUBLIC??'').trim())||
     (env.CHATMCP_EXEC_MODE&&env.CHATMCP_EXEC_MODE!=='host'))
    throw new Error('Cloud/public execution removed: CHATMCP_PUBLIC and hosted execution modes unsupported.');
  const backend=values['--backend']??(env.CHATMCP_BACKEND||'local');
  if(backend!=='local')throw new Error('Only backend local is supported. Legacy MCP/Cloud Harness backend was removed.');
  const port=Number(values['--port']??3007);
  if(!Number.isInteger(port)||port<1024||port>65535||port===3006)throw new Error('Invalid local dashboard port (3006 reserved).');
  return {repoRoot:null,project:values['--project'],port,
    stateDir:path.resolve(values['--state-dir']??defaultDataDirectory(env)),
    backend:'local',host:'127.0.0.1',open,
    logFile:values['--log-file']?path.resolve(values['--log-file']):null};
}

// Console output, plus an append-only file when the launcher asked for one. The background launcher on Windows
// starts the Hub without any inherited pipe (otherwise a caller that captures the launcher's output waits until
// the Hub exits), so the file is the only place its messages and fatal errors can go.
function appendToLog(file, line) {
  if (!file) return;
  try { appendFileSync(file, `${line}\n`, { mode: 0o600 }); } catch { /* the log is best effort */ }
}
function logFileOf(args) {
  const index = args.indexOf('--log-file');
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : null;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArguments(args, env);
  // The secret belongs to this process alone: take it, then remove it from the environment every child (agent tools,
  // terminals, the language servers) would otherwise inherit.
  const secret = createSecret(env);
  delete process.env.CHATMCP_HUB_SECRET;
  if (env !== process.env) { env = { ...env }; delete env.CHATMCP_HUB_SECRET; }
  if(options.logFile){
    const fatal=error=>{appendToLog(options.logFile,`[CHATMCP-HUB] Fatal: ${redact(error?.stack??error?.message??error)}`);process.exit(1);};
    process.once('uncaughtException',fatal);
  }
  const manager=new HubManager({bundleRoot:BUNDLE_ROOT,dataDirectory:options.stateDir,backend:'local',
    log:line=>{console.log(line);appendToLog(options.logFile,line);}});
  await manager.load(options.project);
  // The owner's saved choice for AGENTS.md / CLAUDE.md, read before any runner exists and before the Hub says it is initialised, so that the first task after a restart already
  // follows it. Every runner (the foreground one, the pooled chats, the coding workers) is given this one object, which is asked at the start of each run.
  manager.projectInstructionsSetting = new ProjectInstructionsStore({ directory: manager.hubDirectory, env, log: (line) => manager.log(line) });
  await manager.projectInstructionsSetting.load();
  manager.agentOptions = new AgentOptionsStore({ directory: manager.hubDirectory, log: (line) => manager.log(line) });
  await manager.agentOptions.load();
  // The update notice: found out and kept here, read before the Hub says it is initialised so that the first /api/state already knows what the last check found. It asks nothing until the owner has
  // said yes (lib/update-check.mjs WHEN_UNANSWERED) and its timer starts only below, once the Hub is up. The test hooks of the environment are read here and nowhere else. The keys that the signature
  // of a release is checked with are the ones in lib/release-keys.json (a placeholder until the owner has made a key), plus the test key beside a loopback feed.
  const releaseKeys = loadReleaseKeys();
  for (const skipped of releaseKeys.ignored) manager.log(`Khóa phát hành bị bỏ qua (${skipped.reason}).`);
  const updateHooks = updateOptionsFromEnvironment(env, (line) => manager.log(line));
  const updates = createUpdateChecker({ directory: manager.hubDirectory, currentVersion: VERSION, log: (line) => manager.log(line), releaseKeys: releaseKeys.keys, ...updateHooks });
  await updates.load();
  // The download of the installer: it reads the offer of the notice, looks at the release again when the owner clicks, and keeps what it fetched in <data>/updates. Start-up only cleans that folder of what a
  // Hub that was killed left, and finds a finished download again (`downloads.load()`, below, once this process holds the instance lock); it downloads nothing. A check that has finished tells it to
  // drop a download that is not on offer any more.
  const downloads = createUpdateDownloader({
    directory: manager.hubDirectory, currentVersion: VERSION, feedUrl: updates.feedUrl, releaseKeys: updates.trustedKeys(), offer: () => updates.status(), log: (line) => manager.log(line),
    ...(updateHooks.platform ? { platform: updateHooks.platform } : {}),
  });
  updates.onChecked(() => downloads.reconcile());
  // What the last update left (the installer's result file): read once the Hub holds the instance lock, below, and shown by the page until it is dismissed.
  // The marker of an update that stopped halfway is in the folder of the installation, which is the parent of the folder this file is in (installer/HubLifecycle: <installation>\DATGOLD-HUB\hub.mjs): a Hub that
  // somebody starts by hand behind it leaves the result file alone.
  const applied = createAppliedNote({ directory: manager.hubDirectory, currentVersion: VERSION, installDirectory: path.dirname(BUNDLE_ROOT), log: (line) => manager.log(line) });
  const { BrowserRunner } = await import('./lib/browser-runner.mjs');
  const { AgentRunner } = await import('./lib/agent.mjs');
  const { ConcurrentApiAgent } = await import('./lib/concurrent-api-agent.mjs');
  const { WorkspaceRegistry } = await import('./lib/workspace-registry.mjs');
  const { GatewayProvider } = await import('./lib/gateway-provider.mjs');
  const { DualAgent } = await import('./lib/dual-agent.mjs');
  const { assembleStudio } = await import('./lib/assemble.mjs');
  const { StudioDelegates } = await import('./lib/studio-delegates.mjs');
  const { DynamicDelegates } = await import('./lib/dynamic-delegates.mjs');
  const { RecoveryScheduler } = await import('./lib/studio-resumer.mjs');
  manager.registerSecret(secret);
  assembleStudio(manager,{bundleRoot:BUNDLE_ROOT});
  const workspaceRegistry=new WorkspaceRegistry({manager,directory:manager.hubDirectory});
  await workspaceRegistry.load();
  manager.workspaceRegistry=workspaceRegistry;
  const browser = new BrowserRunner({ manager, directory: path.join(manager.hubDirectory, 'browser'), log: (line) => manager.log(line) });
  const provider = new GatewayProvider({ manager, bundleRoot: BUNDLE_ROOT, directory: path.join(manager.hubDirectory, 'gateway'), env });
  manager.delegates=new StudioDelegates({workspace:manager.studio,provider,directory:path.join(manager.hubDirectory,'studio','delegates')});
  await manager.delegates.load();
  manager.dynamicDelegates=new DynamicDelegates({workspace:manager.studio,provider,directory:path.join(manager.hubDirectory,'studio','dynamic-delegates')});
  await manager.dynamicDelegates.load();
  manager.codingOrchestrator=new CodingWorktreeOrchestrator({manager,provider,directory:path.join(manager.hubDirectory,'coding-orchestrator'),bundleRoot:BUNDLE_ROOT});
  await manager.codingOrchestrator.load();
  const primaryAgent = createPrimaryAgentRunner(AgentRunner, { manager, provider, taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: (line) => manager.log(line), env });
  const apiAgent = new ConcurrentApiAgent({ primary: primaryAgent, manager, provider, bundleRoot: BUNDLE_ROOT,
    directory: path.join(manager.hubDirectory, 'api-conversations'), log: line => manager.log(line) });
  manager.spawnBackgroundAgent = (parentTaskId,request) => apiAgent.spawnAgent(parentTaskId,request);
  manager.spawnWorkflow = (parentTaskId,request) => apiAgent.spawnWorkflow(parentTaskId,request);
  const agent = new DualAgent({ browser, api: apiAgent, directory: manager.hubDirectory, defaultMode:'api' });
  const resumer = new RecoveryScheduler({ agent, manager, provider, browser, log:(line)=>manager.log(line) });
  await manager.permissions.load();
  let initialized=false,closing=false;
  let releaseInstance=async()=>{};
  let session=null;
  let mcpServer=null,mcpHost=null;
  const server=createHubServer(manager,{port:options.port,secret,browser,agent,provider,workspaceRegistry,onShutdown:close,updates,downloads,applied,
    isInitialized:()=>initialized});
  const url=`http://127.0.0.1:${options.port}`;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port,'127.0.0.1',resolve); });
  } catch (error) {
    if(error.code!=='EADDRINUSE') throw error;
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
    assertCompatibleRunningHub(health, options.port);
    assertBearerHub(health, options.port);
    const running = await attachToRunningHub({ origin: url, stateDirectory: options.stateDir, project: options.project });
    if (running.selectError) manager.log(running.selectError);
    if (options.open) await openDashboard(url, manager, dashboardUrl(url, await running.ticket()));
    manager.log(`Hub đã chạy sẵn tại ${url}.`);
    return;
  }
  try {
    releaseInstance = await acquireInstanceLock(manager.hubDirectory, options.port);
    // Finding what a killed Hub left in the folder of updates DELETES it, so only the Hub that holds the data folder may do it: a second start of the launcher gets as far as the code above before it
    // finds out that another Hub runs, and must not remove the first one's half-written download.
    await downloads.load();
    await applied.load();
    // Published only once this process holds the instance lock, and before /api/health reports "initialized".
    session = await writeSession(manager.hubDirectory, { port: options.port, secret });
    await browser.load();
    await provider.load();
    await apiAgent.load();
    await agent.load();
    initialized = true;
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await session?.remove().catch(() => {});
    await releaseInstance().catch(() => {});
    throw error;
  }
  if (!existsSync(path.join(BUNDLE_ROOT, UI_INDEX))) manager.log(`${UI_NOT_BUILT.error} (the dashboard answers 503 until then).`);
  manager.log(`Dashboard: ${url}`);
  manager.log(`Local-only Hub: 127.0.0.1 · Data: ${manager.hubDirectory}`);
  // The MCP server for local clients (docs/MCP-SERVER.md): its own listener, off unless the owner turned it on (CHATMCP_MCP_SERVER or
  // <data>/mcp-server.json). It never throws here: a missing SDK, a bad or busy port is a status and one log line, and the Hub runs on.
  // Its tools are the profiles of the token's scope (lib/mcp/tool-profiles.mjs: verify by default, read and write opt-in), served by the host
  // (lib/mcp/host.mjs): a manager and a task per client on the Hub's workspace, the Hub's permission gate in Review (reads run, anything
  // else asks the owner), approvals in /api/state and the decide route above; a write waits while the agent works. Nothing is made before a call.
  const { startHubMcpServer } = await import('./lib/mcp/server.mjs');
  const { McpHost } = await import('./lib/mcp/host.mjs');
  const { PROFILE_HOST_TOOLS, mcpProfileProvider } = await import('./lib/mcp/tool-profiles.mjs');
  mcpHost = new McpHost({ bundleRoot: BUNDLE_ROOT, directory: path.join(manager.hubDirectory, 'mcp-host'), workspace: () => manager.workspace,
    primaryState: hostPrimaryState(manager, agent),
    hooks: manager.hooks, mcp: manager.mcp, pluginManager: manager.pluginManager, secrets: manager.secrets, scope: 'profiles', tools: PROFILE_HOST_TOOLS, log: (line) => manager.log(line) });
  manager.mcpHost = mcpHost;
  mcpServer = await startHubMcpServer({ env, directory: manager.hubDirectory, protector: createProtector({ bundleRoot: BUNDLE_ROOT, directory: manager.hubDirectory, env }),
    name: 'DatGold Hub', version: VERSION, dashboardPort: options.port, log: (line) => manager.log(line), registerSecret: (value) => manager.registerSecret(value), ...mcpProfileProvider({ host: mcpHost, version: VERSION }) })
    .catch((error) => { manager.log(`MCP server: not started (${error?.code ?? 'error'}).`); return null; });
  manager.mcpServer = mcpServer;
  if (options.open) await openDashboard(url, manager, dashboardUrl(url, server.issueBootstrapTicket()));
  if (manager.workspace) void manager.start().catch(() => {});
  else manager.log('Chọn thư mục workspace trên trang localhost để bắt đầu.');
  resumer.start();
  updates.start();
  async function close() {
    if (closing) return;
    closing = true;
    resumer.stop();
    updates.stop();
    manager.log('Đang dừng DatGold local Hub...');
    // One short line per step as it begins, with the time since the stop began: a log that ends in the middle names the step the Hub was in, and so does the line of the deadline.
    const began = Date.now();
    let step = 'start';
    const mark = (name) => { step = name; manager.log(`Stop: ${name} (+${Date.now() - began} ms)`); };
    const deadline = setTimeout(() => { manager.log(`Stop: still in ${step} after 12 s, exiting`); process.exit(1); }, 12000);
    mark('downloads'); await downloads.stop().catch(() => {}); // a download in progress is cut and its .part removed
    manager.codingOrchestrator?.cancel();
    manager.dynamicDelegates?.cancel();
    manager.permissions?.shutdown();
    mark('terminal'); await manager.terminal?.close(); manager.intelligence?.close();
    mark('agent'); await agent.shutdown().catch(() => {});
    mark('manager'); await manager.shutdown().catch(() => {});
    mark('mcp server'); await mcpServer?.close().catch(() => {}); await mcpHost?.close().catch(() => {});
    mark('server'); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    mark('session'); await session?.remove().catch(() => {});
    mark('instance lock'); await releaseInstance().catch(() => {});
    clearTimeout(deadline);
    mark('done');
    process.exit(0);
  }
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const line = `[CHATMCP-HUB] ${error.message}`;
    console.error(line);
    appendToLog(logFileOf(process.argv.slice(2)), line);
    process.exitCode = 1;
  });
}
