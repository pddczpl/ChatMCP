#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { HubManager, VERSION, BACKENDS, defaultDataDirectory } from './lib/manager.mjs';
import { redact } from './lib/runtime.mjs';
import { acquireInstanceLock } from './lib/instance-lock.mjs';
import { publicPresets } from './lib/provider-presets.mjs';
import { AiProfiles } from './lib/ai-profiles.mjs';
import { WorkspaceLock } from './lib/workspace-lock.mjs';
import { SandboxEngine } from './lib/sandbox-engine.mjs';
import { PermissionGate } from './lib/permissions.mjs';
import { PluginManager } from './lib/plugins.mjs';
import { CodingWorktreeOrchestrator } from './lib/coding-orchestrator.mjs';
import { GitHubSkillRegistry } from './lib/skill-registry.mjs';

const APP_ID = 'chatmcp-local-hub';
export const UI_BUILD = '3.8.1-react-agent';
// Prevent a new installer from silently reopening a stale daemon at :3007.
export function assertCompatibleRunningHub(health, port=3007) {
  if (health?.app !== APP_ID) throw new Error(`Cổng ${port} đang do ứng dụng khác sử dụng. Không tự dừng tiến trình đó.`);
  if (health.version !== VERSION || health.uiBuild !== UI_BUILD) {
    throw new Error(`Cổng ${port} vẫn chạy Hub ${health.version ?? 'không rõ'} (${health.uiBuild ?? 'UI cũ'}), nhưng bản đang mở là ${VERSION} (${UI_BUILD}). Hãy chạy STOP-CHATMCP-HUB.cmd, đợi cổng 3007 tắt rồi START-CHATMCP-HUB.cmd; không dùng tiến trình cũ.`);
  }
  return true;
}

export const POST_ROUTES = Object.freeze(['/api/agent/mode','/api/tasks/start','/api/tasks/continue','/api/tasks/delete','/api/tasks/cancel','/api/tasks/auto-resume','/api/workflows/cancel','/api/ai/config','/api/ai/clear-key','/api/ai/test','/api/workspace/browse','/api/workspace/select','/api/workspaces/add','/api/workspaces/activate','/api/workspaces/remove','/api/services/start','/api/services/stop','/api/browser/pair-code','/api/browser/unpair','/api/browser/recover-url/request','/api/studio/permissions/config','/api/studio/permissions/decide','/api/studio/file/save','/api/studio/checkpoint','/api/studio/restore','/api/studio/restore-checkpoint','/api/studio/accept','/api/studio/terminal/start','/api/studio/terminal/stop','/api/studio/plan/set','/api/studio/verify/run','/api/studio/delegates/research','/api/studio/delegates/orchestrate','/api/studio/delegates/cancel','/api/studio/dynamic-delegates/run','/api/studio/dynamic-delegates/cancel','/api/studio/coding/plan','/api/studio/coding/run','/api/studio/coding/cancel','/api/studio/coding/recovery/acknowledge','/api/studio/coding/integrate','/api/studio/coding/publish','/api/studio/coding/check-grant','/api/studio/intelligence/index','/api/studio/intelligence/engines/probe','/api/studio/intelligence/lsp/start','/api/studio/terminal/input','/api/studio/terminal/resize','/api/hub/shutdown','/api/ai/profiles/upsert','/api/ai/profiles/delete','/api/ai/profiles/default','/api/plugins/install','/api/plugins/registry/refresh','/api/plugins/registry/install','/api/plugins/registry/source/add','/api/plugins/registry/source/remove','/api/plugins/uninstall','/api/plugins/toggle']);
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
  '/classic': 'web/index.html',
  '/classic.html': 'web/index.html',
  '/legacy': 'web/legacy.html',
  '/legacy.html': 'web/legacy.html',
  '/app.js': 'web/app.js',
  '/style.css': 'web/style.css',
  '/studio.css': 'web/studio.css',
  '/studio.js': 'web/studio.js',
  '/react-app.js': 'web/react-app.js',
  '/ui-logic.js': 'web/ui-logic.js',
  '/onboarding.js': 'web/onboarding.js',
  '/react.css': 'web/react.css',
  '/vendor/react.production.min.js': 'web/vendor/react.production.min.js',
  '/vendor/react-dom.production.min.js': 'web/vendor/react-dom.production.min.js',
  '/chat-route.js': 'extension/chat-route.js'
});
function equalToken(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

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
export function createHubServer(manager, {port=3007,token=randomBytes(32).toString('hex'),bundleRoot=BUNDLE_ROOT,provider=null,agent=null,browser=null,workspaceRegistry=null,onShutdown=()=>{},isInitialized=()=>true}={}) {
  const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
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
  const hubStateDir = manager.hubDirectory ?? manager.stateDirectory ?? manager.stateDir ?? defaultDataDirectory();
  const aiProfiles = new AiProfiles({ stateDir: hubStateDir, keyStore: provider?.keyStore ?? provider?.protector ?? (provider?.protect && provider?.unprotect ? { encrypt: (t) => provider.protect(t), decrypt: (b) => provider.unprotect(b) } : null) });
  aiProfiles.load().catch(() => {});
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
  const state = (csrf = token) => ({ ...manager.state(), workspaces:workspaceRegistry?.state()??{activePath:manager.workspace,items:manager.workspace?[{path:manager.workspace,name:path.basename(manager.workspace)}]:[]}, ai: { ...(provider?.state() ?? { provider: 'disabled', configured: false }), profiles: aiProfiles.list(), defaultProfileId: aiProfiles.defaultProfileId, busy: aiBusy }, plugins: { count: pluginManager.installed().length, active: pluginManager.activeSkills().length }, browser: browser?.browserState() ?? null, agent: taskEngine?.state() ?? { activeTaskId: null, active: null, tasks: [] }, studio: studio ? {workspace:studio.root, permissions: { ...(permissions?.state?.()??gate?.state()??{}), pending: [...(permissions?.state?.().pending??[]), ...(taskEngine?.api?.pendingApprovals?.()??[]), ...(browser?.pendingApprovals?.()??[])] }, terminals:terminal?.state()??[], features:['files','code-search','git-diff','checkpoints','review','terminal','skills','plan','test-discovery','test-evidence','research-delegates','docker-readonly-sandbox','interactive-terminal','optional-conpty','python-ast-index','optional-lsp','local-preview','light-dark-theme'], delegates:delegates?.state()??null,dynamicDelegates:dynamic?.state()??null} : null, csrfToken: csrf });
  const requireNoTask = () => { if (taskEngine?.state().activeTaskId || dynamic?.activeRunId || coding?.active || delegates?.running) { const e = new Error('Dừng các tác vụ AI đang chạy trước khi đổi Base URL, API key hoặc model.'); e.statusCode = 409; throw e; } };
  const changeAi = async (operation) => {
    requireNoTask();
    if (aiBusy) { const e = new Error('Đang thay đổi kết nối AI. Chờ thao tác hiện tại hoàn tất.'); e.statusCode = 409; throw e; }
    aiBusy = true;
    try { return await operation(); } finally { aiBusy = false; }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP_LOOPBACK);
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
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
      const browserRoute = /^\/api\/browser\/clients\/(pair|poll|claim|sent|reply|fail|recover-url)$/.exec(url.pathname);
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
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { app: APP_ID, version: VERSION, uiBuild: UI_BUILD, initialized: isInitialized(), backend: manager.backend });
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return json(200, { app: APP_ID, version: VERSION, uiBuild: UI_BUILD, postRoutes: POST_ROUTES, frontend: 'React', offlineAssets: true });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state(csrfNow));
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
          case '/api/studio/file': value=await studio.read({file:pick('file'),maxBytes:Math.min(250000,Number(pick('maxBytes'))||120000)});break;
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
          case '/api/studio/plan': value=await studio.plan({taskId:pick('taskId')});break;
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
      if (req.method === 'GET' && url.pathname === '/api/ai/presets') return json(200, { presets: publicPresets(provider?.env ?? process.env), envKeys: provider?.envKeys() ?? [] });
      if (req.method === 'GET' && url.pathname === '/api/ai/profiles') return json(200, { profiles: aiProfiles.list(), defaultProfileId: aiProfiles.defaultProfileId });
      if (req.method === 'GET' && url.pathname === '/api/sandbox/status') return json(200, sandboxEngine.status());
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
      const taskRoute = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})(\/report|\/stream)?$/);
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
        const value = taskRoute[2] === '/report' ? await taskEngine?.report(taskRoute[1]) : taskEngine?.get(taskRoute[1]);
        if (value === null || value === undefined) return json(404, { error: 'Không tìm thấy nhiệm vụ.' });
        if (!taskRoute[2]) return json(200, value);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="CHATMCP-${taskRoute[1]}.txt"`);
        return res.end(value);
      }
      if (req.method === 'GET' && url.pathname === '/api/extension-state') {
        const state = manager.state();
        return json(200, { version: VERSION, workspace: state.workspace, proxyUrl: state.proxyUrl, ready: state.services.local?.state === 'ready', generation: state.generation, instanceId: state.instanceId });
      }
      if (req.method === 'GET' && url.pathname === '/api/instructions') {
        const text = manager.instructions();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (url.searchParams.get('download') === '1') res.setHeader('Content-Disposition', 'attachment; filename="CHATMCP-WORKSPACE-INSTRUCTIONS.txt"');
        return res.end(text);
      }
      if (req.method === 'POST') {
        const expectedUi = req.headers['x-chatmcp-ui-build'];
        if (expectedUi && expectedUi !== UI_BUILD) return json(409, { error: `Giao diện phiên bản ${expectedUi} không khớp Hub ${VERSION}. Hãy STOP Hub cũ, START bản mới và nhấn Ctrl+F5.`, code: 'ui_backend_version_mismatch', serverVersion: VERSION, uiBuild: UI_BUILD });
        // Local dashboard mutations require the matching Origin and CSRF.
        const requestOk=origins.has(origin)&&req.headers['x-chatmcp-request']==='local-dashboard'
          &&equalToken(req.headers['x-chatmcp-csrf'],token);
        if(!requestOk)return json(403,{error:'Phiên trang localhost không hợp lệ. Tải lại trang.',code:'csrf'});
        const payload = await bodyJson(req, ['/api/tasks/start','/api/tasks/continue'].includes(url.pathname) ? 8 * 1024 * 1024 : 65536);
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
          case '/api/studio/permissions/decide': result=(gate?.state().pending||[]).some(p=>p.id===payload.id)
              ? gate.decide(payload.id,payload.approved)
              : taskEngine?.api?.decidePermission?.(payload.id,payload.approved)
                || browser?.decidePermission?.(payload.id,payload.approved);
              if(!result)throw Object.assign(new Error('Không tìm thấy yêu cầu phê duyệt.'),{statusCode:404});
              break;
          case '/api/studio/checkpoint': result=await studio.checkpoint(payload);break;
          case '/api/studio/file/save': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không ghi file trên Windows host. Đổi sang host-review để lưu bản chỉnh sửa sau khi review.'),{statusCode:403});if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Đợi agent dừng trước khi lưu file từ editor.'),{statusCode:409});result=await studio.save(payload);break;
          case '/api/studio/restore': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không khôi phục file trực tiếp trên Windows host.'),{statusCode:403});result=await studio.restore(payload);break;
          case '/api/studio/restore-checkpoint': if(taskEngine?.state()?.activeTaskId || agent?.state()?.activeTaskId || manager?.taskEngine?.state()?.activeTaskId || manager?.agent?.state()?.activeTaskId)throw Object.assign(new Error('Để tránh xung đột file, chờ agent dừng trước khi khôi phục checkpoint.'),{code:'task_in_progress',statusCode:409});if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không khôi phục checkpoint trực tiếp trên Windows host.'),{statusCode:403});result=await studio.restoreCheckpoint(payload);break;
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
          case '/api/studio/plan/set': result=await studio.plan({...payload,operation:'set'});break;
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
        if ((url.pathname === '/' || url.pathname === '/index.html') && filename === 'web/dist/index.html') {
          try {
            data = await fs.readFile(path.join(bundleRoot, 'web/index.html'));
            filename = 'web/index.html';
          } catch {
            return json(404, { error: 'Không tìm thấy trang.' });
          }
        } else {
          return json(404, { error: 'Không tìm thấy trang.' });
        }
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
  return server;
}

async function openDashboard(url, manager) {
  if (process.platform !== 'win32') { manager.log(`Mở ${url}`); return; }
  // This URL is constructed from a validated numeric port, never shell input.
  const rundll = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe');
  await new Promise((resolve) => {
    const opener = spawn(rundll, ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', shell: false });
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
  if(options.logFile){
    const fatal=error=>{appendToLog(options.logFile,`[CHATMCP-HUB] Fatal: ${redact(error?.stack??error?.message??error)}`);process.exit(1);};
    process.once('uncaughtException',fatal);
  }
  const manager=new HubManager({bundleRoot:BUNDLE_ROOT,dataDirectory:options.stateDir,backend:'local',
    log:line=>{console.log(line);appendToLog(options.logFile,line);}});
  await manager.load(options.project);
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
  const primaryAgent = new AgentRunner({ manager, provider, taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: (line) => manager.log(line) });
  const apiAgent = new ConcurrentApiAgent({ primary: primaryAgent, manager, provider, bundleRoot: BUNDLE_ROOT,
    directory: path.join(manager.hubDirectory, 'api-conversations'), log: line => manager.log(line) });
  manager.spawnBackgroundAgent = (parentTaskId,request) => apiAgent.spawnAgent(parentTaskId,request);
  manager.spawnWorkflow = (parentTaskId,request) => apiAgent.spawnWorkflow(parentTaskId,request);
  const agent = new DualAgent({ browser, api: apiAgent, directory: manager.hubDirectory, defaultMode:'api' });
  const resumer = new RecoveryScheduler({ agent, manager, provider, browser, log:(line)=>manager.log(line) });
  await manager.permissions.load();
  let initialized=false,closing=false;
  let releaseInstance=async()=>{};
  const server=createHubServer(manager,{port:options.port,browser,agent,provider,workspaceRegistry,onShutdown:close,
    isInitialized:()=>initialized});
  const url=`http://127.0.0.1:${options.port}`;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port,'127.0.0.1',resolve); });
  } catch (error) {
    if(error.code!=='EADDRINUSE') throw error;
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
    assertCompatibleRunningHub(health, options.port);
    if (options.project) {
      const state = await fetch(`${url}/api/state`).then((r) => r.json());
      const response = await fetch(`${url}/api/workspace/select`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': state.csrfToken },
        body: JSON.stringify({ path: options.project }),
      });
      if (!response.ok) manager.log((await response.json()).error ?? 'Hub đang xử lý một thao tác.');
    }
    if (options.open) await openDashboard(url, manager);
    manager.log(`Hub đã chạy sẵn tại ${url}.`);
    return;
  }
  try {
    releaseInstance = await acquireInstanceLock(manager.hubDirectory, options.port);
    await browser.load();
    await provider.load();
    await apiAgent.load();
    await agent.load();
    initialized = true;
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await releaseInstance().catch(() => {});
    throw error;
  }
  manager.log(`Dashboard: ${url}`);
  manager.log(`Local-only Hub: 127.0.0.1 · Data: ${manager.hubDirectory}`);
  if (options.open) await openDashboard(url, manager);
  if (manager.workspace) void manager.start().catch(() => {});
  else manager.log('Chọn thư mục workspace trên trang localhost để bắt đầu.');
  resumer.start();
  async function close() {
    if (closing) return;
    closing = true;
    resumer.stop();
    manager.log('Đang dừng ChatMCP local Hub...');
    const deadline = setTimeout(() => process.exit(1), 12000);
    manager.codingOrchestrator?.cancel();
    manager.dynamicDelegates?.cancel();
    manager.permissions?.shutdown(); await manager.terminal?.close(); manager.intelligence?.close();
    await agent.shutdown().catch(() => {});
    await manager.shutdown().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await releaseInstance().catch(() => {});
    clearTimeout(deadline);
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
