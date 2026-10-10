#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { HubManager, VERSION } from './lib/manager.mjs';
import { redact } from './lib/runtime.mjs';
import { acquireInstanceLock } from './lib/instance-lock.mjs';

const APP_ID = 'chatmcp-local-hub';
export const UI_BUILD = '2.2.8-react-offline';
// Prevent a new installer from silently reopening a stale daemon at :3007.
export function assertCompatibleRunningHub(health, port=3007) {
  if (health?.app !== APP_ID) throw new Error(`Cổng ${port} đang do ứng dụng khác sử dụng. Không tự dừng tiến trình đó.`);
  if (health.version !== VERSION || health.uiBuild !== UI_BUILD) {
    throw new Error(`Cổng ${port} vẫn chạy Hub ${health.version ?? 'không rõ'} (${health.uiBuild ?? 'UI cũ'}), nhưng bản đang mở là ${VERSION} (${UI_BUILD}). Hãy chạy STOP-CHATMCP-HUB.cmd, đợi cổng 3007 tắt rồi START-CHATMCP-HUB.cmd; không dùng tiến trình cũ.`);
  }
  return true;
}

const POST_ROUTES = Object.freeze(['/api/agent/mode','/api/tasks/start','/api/tasks/continue','/api/tasks/delete','/api/tasks/cancel','/api/tasks/auto-resume','/api/ai/config','/api/ai/clear-key','/api/ai/test','/api/workspace/browse','/api/workspace/select','/api/services/start','/api/services/stop','/api/browser/pair-code','/api/browser/unpair','/api/vscode/open','/api/studio/permissions/config','/api/studio/permissions/decide','/api/studio/file/save','/api/studio/checkpoint','/api/studio/restore','/api/studio/accept','/api/studio/terminal/start','/api/studio/terminal/stop','/api/studio/plan/set','/api/studio/verify/run','/api/studio/delegates/research','/api/studio/intelligence/index','/api/studio/intelligence/lsp/start','/api/studio/terminal/input','/api/studio/terminal/resize','/api/hub/shutdown']);
const BUNDLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

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

export function createHubServer(manager, { port = 3007, token = randomBytes(32).toString('hex'), bundleRoot = BUNDLE_ROOT, provider = null, agent = null, browser = null, onShutdown = () => {}, isInitialized = () => true } = {}) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  let aiBusy = false;
  const taskEngine = agent ?? browser;
  const studio = manager.studio;
  const gate = manager.permissions;
  const terminal = manager.terminal;
  const delegates = manager.delegates;
  const verification = manager.verification;
  const intelligence = manager.intelligence;
  const preview = manager.preview;
  const state = () => ({ ...manager.state(), ai: { ...(provider?.state() ?? { provider: 'disabled', configured: false }), busy: aiBusy }, browser: browser?.browserState() ?? null, agent: taskEngine?.state() ?? { activeTaskId: null, active: null, tasks: [] }, studio: studio ? {workspace:studio.root, permissions:gate?.state()??null, terminals:terminal?.state()??[], features:['files','code-search','git-diff','checkpoints','review','terminal','skills','plan','test-discovery','test-evidence','research-delegates','docker-readonly-sandbox','interactive-terminal','optional-conpty','python-ast-index','optional-lsp','local-preview','light-dark-theme'], delegates:delegates?.state()??null} : null, csrfToken: token });
  const requireNoTask = () => { if (taskEngine?.state().activeTaskId) { const e = new Error('Hủy hoặc chờ nhiệm vụ hoàn tất trước khi thay đổi kết nối AI.'); e.statusCode = 409; throw e; } };
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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (!hosts.has(req.headers.host)) return json(403, { error: 'Host không được phép.' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      // Treat trailing slashes on API paths consistently across builds.
      if (url.pathname.startsWith('/api/') && url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
      const origin = req.headers.origin;
      const extensionRead = ['/api/extension-state', '/api/instructions'].includes(url.pathname);
      const browserRoute = /^\/api\/browser\/clients\/(pair|poll|claim|sent|reply|fail)$/.exec(url.pathname);
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
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { app: APP_ID, version: VERSION, uiBuild: UI_BUILD, initialized: isInitialized() });
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return json(200, { app: APP_ID, version: VERSION, uiBuild: UI_BUILD, postRoutes: POST_ROUTES, frontend: 'React', offlineAssets: true });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state());
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
        return json(200, await browser[browserRoute[1]](payload));
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
          case '/api/studio/git/diff': value=await studio.gitDiff({file:pick('file'),staged:pick('staged')==='true'});break;
          case '/api/studio/git/check': value=await studio.gitDiffCheck();break;
          case '/api/studio/checkpoints': value=await studio.checkpoints();break;
          case '/api/studio/review': value=await studio.review({checkpointId:pick('checkpointId'),file:pick('file')});break;
          case '/api/studio/checks': value=await studio.checks();break;
          case '/api/studio/verifications': value=await verification?.list({taskId:pick('taskId')}) ?? {runs:[],total:0};break;
          case '/api/studio/skills': value=await studio.skills();break;
          case '/api/studio/terminal': value=terminal?.state()??[];break;
          case '/api/studio/terminal/capabilities': value=await terminal?.capabilities()??{};break;
          case '/api/studio/delegates': value=delegates?.state()??null;break;
          case '/api/studio/workflow': value=await manager.workflow.state(pick('taskId'));break;
          case '/api/studio/plan': value=await studio.plan({taskId:pick('taskId')});break;
          default:return json(404,{error:'Không tìm thấy Studio endpoint.'});
        }
        return json(200,value);
      }
      if (req.method === 'GET' && url.pathname === '/api/catalog') return json(200, manager.catalog ?? { ready: false, tools: [], counts: {} });
      if (req.method === 'GET' && url.pathname === '/api/ai/models') return json(200, { models: provider ? await changeAi(() => provider.listModels()) : [] });
      if (req.method === 'GET' && url.pathname === '/auth/chatgpt/callback') return json(410, { error: 'Không hỗ trợ kết nối OAuth ChatGPT trong chế độ này.' });
      const taskRoute = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})(\/report)?$/);
      if (req.method === 'GET' && taskRoute) {
        const value = taskRoute[2] ? await taskEngine?.report(taskRoute[1]) : taskEngine?.get(taskRoute[1]);
        if (value === null || value === undefined) return json(404, { error: 'Không tìm thấy nhiệm vụ.' });
        if (!taskRoute[2]) return json(200, value);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="CHATMCP-${taskRoute[1]}.txt"`);
        return res.end(value);
      }
      if (req.method === 'GET' && url.pathname === '/api/extension-state') {
        const state = manager.state();
        return json(200, { version: VERSION, workspace: state.workspace, proxyUrl: state.proxyUrl, ready: state.services.proxy.state === 'ready' && state.services.desktop.state === 'ready', generation: state.generation, instanceId: state.instanceId });
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
        if (!origins.has(origin) || req.headers['x-chatmcp-request'] !== 'local-dashboard' || !equalToken(req.headers['x-chatmcp-csrf'], token)) {
          return json(403, { error: 'Phiên trang localhost không hợp lệ. Tải lại trang rồi thử lại.' });
        }
        const payload = await bodyJson(req);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(400, { error: 'Nội dung yêu cầu phải là JSON object.' });
        let result;
        switch (url.pathname) {
          case '/api/studio/permissions/config': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Đợi tác vụ hiện tại dừng trước khi đổi quyền công cụ.'),{statusCode:409});result=gate.configure(payload);break;
          case '/api/studio/permissions/decide': result=gate.decide(payload.id,payload.approved);break;
          case '/api/studio/checkpoint': result=await studio.checkpoint(payload);break;
          case '/api/studio/file/save': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không ghi file trên Windows host. Đổi sang host-review để lưu bản chỉnh sửa sau khi review.'),{statusCode:403});if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Đợi agent dừng trước khi lưu file từ editor.'),{statusCode:409});result=await studio.save(payload);break;
          case '/api/studio/restore': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không khôi phục file trực tiếp trên Windows host.'),{statusCode:403});result=await studio.restore(payload);break;
          case '/api/studio/accept': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: không thay đổi file trực tiếp trên Windows host.'),{statusCode:403});result=await studio.accept(payload);break;
          case '/api/studio/delegates/research': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Đợi agent chính hoàn tất trước khi phân tích song song.'),{statusCode:409});result=await delegates.research(payload);break;
          case '/api/studio/terminal/start': if(gate?.executionPolicy==='sandbox-only'&&!payload.sandbox)throw Object.assign(new Error('Sandbox-only: terminal phải bật Docker sandbox; không cho chạy trực tiếp trên Windows host.'),{statusCode:403});if(taskEngine?.state()?.activeTaskId) throw Object.assign(new Error('Để tránh xung đột file, dừng agent trước khi chạy terminal thủ công.'),{statusCode:409});result=await terminal.start(payload);break;
          case '/api/studio/terminal/stop': result=terminal.stop(payload.id);break;
          case '/api/studio/terminal/input': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Chờ agent dừng trước khi nhập terminal.'),{statusCode:409});result=terminal.write(payload.id,payload.text);break;
          case '/api/studio/terminal/resize': result=terminal.resize(payload.id,payload);break;
          case '/api/studio/intelligence/index': result=await intelligence.index({force:Boolean(payload.force)});break;
          case '/api/studio/intelligence/lsp/start': if(gate?.executionPolicy==='sandbox-only')throw Object.assign(new Error('Sandbox-only: language server chạy trên Windows host. Chuyển sang host-review nếu bạn chấp nhận chạy LSP trên host.'),{statusCode:403});result=await intelligence.lspStart({language:payload.language});break;
          case '/api/studio/plan/set': result=await studio.plan({...payload,operation:'set'});break;
          case '/api/studio/verify/run': if(taskEngine?.state()?.activeTaskId)throw Object.assign(new Error('Để tránh xung đột file, chờ agent dừng trước khi chạy kiểm thử thủ công.'),{statusCode:409});if(!verification)throw Object.assign(new Error('Bộ kiểm thử chưa khởi tạo.'),{statusCode:503});result=await verification.start(payload);break;
          case '/api/workspace/browse': result = await manager.browse(); break;
          case '/api/workspace/select': await manager.selectWorkspace(payload.path); result = state(); break;
          case '/api/services/start': await manager.start(); result = state(); break;
          case '/api/services/stop': await manager.stop(); result = state(); break;
          case '/api/vscode/open': result = await manager.openVsCode(); break;
          case '/api/browser/pair-code': if (!browser) throw new Error('Browser runner chưa khởi tạo.'); result = await browser.createPairCode(); break;
          case '/api/browser/unpair': if (!browser) throw new Error('Browser runner chưa khởi tạo.'); await browser.unpair(); result = state(); break;
          case '/api/ai/config': if (!provider) throw new Error('Kết nối AI chưa khởi tạo.'); await changeAi(() => provider.configure(payload)); result = state(); break;
          case '/api/ai/clear-key': if (!provider) throw new Error('Kết nối AI chưa khởi tạo.'); await changeAi(() => provider.clearKey()); result = state(); break;
          case '/api/ai/test': if (!provider) throw new Error('Kết nối AI chưa khởi tạo.'); result = await changeAi(async () => {
            if (!provider.ready()) throw Object.assign(new Error('Chưa cấu hình API key/model.'), { statusCode:409 });
            const testSignal = AbortSignal.timeout(38000);
            let response;
            try {
              response = typeof provider.diagnoseConnection === 'function'
                ? await provider.diagnoseConnection({ signal: testSignal })
                : await provider.respond({ input: [{role:'user', content:[{type:'input_text',text:'Reply with only OK.'}]}], instructions:'Simple API connectivity check. Reply with OK.', tools: [], signal: testSignal });
            } catch (error) {
              if (testSignal.aborted) throw Object.assign(new Error('Kiểm tra gateway quá 38 giây. Kiểm tra kết nối, URL và giao thức rồi thử lại.'), { statusCode:504 });
              throw error;
            }
            return { ok:true, model: provider.snapshot().model, responsePresent: response.responsePresent === true || response.output?.some(x=>x.type==='message') === true,
              autoSelected:response.autoSelected === true, protocol:response.protocol || provider.state().protocol,
              authMode:response.authMode || provider.state().authMode,attempts:Array.isArray(response.attempts)?response.attempts:undefined };
          }); break;
          case '/api/agent/mode': if (!agent) throw new Error('Agent chưa khởi tạo.'); await changeAi(() => agent.configure(payload)); result = state(); break;
          case '/api/auth/chatgpt/start': return json(410, { error: 'Dùng chế độ ChatGPT Web qua Browser Companion, không dùng OAuth ChatGPT trong Hub.' });
          case '/api/auth/logout': return json(410, { error: 'Để xoá API key đã lưu, dùng /api/ai/clear-key.' });
          case '/api/tasks/start': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); if (aiBusy) { const e = new Error('Kết nối AI đang thay đổi. Chờ hoàn tất rồi chạy nhiệm vụ.'); e.statusCode = 409; throw e; } result = { task: await taskEngine.start(payload) }; break;
          case '/api/tasks/continue': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); if (aiBusy) { const e = new Error('Kết nối AI đang thay đổi.'); e.statusCode=409; throw e; } result = { task: await taskEngine.continue(payload) }; break;
          case '/api/tasks/delete': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); result = await taskEngine.delete(payload.id); break;
          case '/api/tasks/cancel': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); result = { task: await taskEngine.cancel(payload.id) }; break;
          case '/api/tasks/auto-resume': if (!taskEngine) throw new Error('Agent chưa khởi tạo.'); result = { task: await taskEngine.setAutoResume(payload) }; break;
          case '/api/hub/shutdown': result = { ok: true }; setTimeout(() => void onShutdown(), 150); break;
          default: return json(404, { error: `Không tìm thấy thao tác POST ${url.pathname} trên Hub ${VERSION}. Có thể dashboard và tiến trình Hub không cùng phiên bản; hãy STOP/START Hub và Ctrl+F5.`, code:'unknown_action', path:url.pathname, method:'POST', serverVersion:VERSION, uiBuild:UI_BUILD });
        }
        return json(200, { ...result, csrfToken: token });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Phương thức không được hỗ trợ.' });
      const staticFiles = { '/': 'web/index.html', '/index.html': 'web/index.html', '/legacy': 'web/legacy.html', '/legacy.html': 'web/legacy.html', '/app.js': 'web/app.js', '/style.css': 'web/style.css', '/studio.css': 'web/studio.css', '/studio.js': 'web/studio.js', '/react-app.js': 'web/react-app.js', '/react.css': 'web/react.css', '/vendor/react.production.min.js': 'web/vendor/react.production.min.js', '/vendor/react-dom.production.min.js': 'web/vendor/react-dom.production.min.js', '/chat-route.js': 'extension/chat-route.js' };
      const filename = staticFiles[url.pathname];
      if (!filename) return json(404, { error: 'Không tìm thấy trang.' });
      const data = await fs.readFile(path.join(bundleRoot, filename));
      res.setHeader('Content-Type', MIME[path.extname(filename)]);
      res.setHeader('Content-Length', data.length);
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

export function parseArguments(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repo-root', '--project', '--port'].includes(args[i]) || args[i + 1] === undefined) throw new Error('Tham số launcher không hợp lệ.');
    values[args[i]] = args[i + 1];
  }
  const port = Number(values['--port'] ?? 3007);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3006) throw new Error('Cổng dashboard không hợp lệ. Cổng 3006 dành cho MCP.');
  if (!values['--repo-root']) throw new Error('Thiếu đường dẫn repository Cloud Harness.');
  return { repoRoot: values['--repo-root'], project: values['--project'], port };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const manager = new HubManager({ repoRoot: options.repoRoot, bundleRoot: BUNDLE_ROOT });
  await manager.load(options.project);
  const { BrowserRunner } = await import('./lib/browser-runner.mjs');
  const { AgentRunner } = await import('./lib/agent.mjs');
  const { GatewayProvider } = await import('./lib/gateway-provider.mjs');
  const { DualAgent } = await import('./lib/dual-agent.mjs');
  const { StudioWorkspace } = await import('./lib/studio-workspace.mjs');
  const { StudioTerminal } = await import('./lib/studio-terminal.mjs');
  const { PermissionGate } = await import('./lib/permissions.mjs');
  const { StudioTools } = await import('./lib/studio-tools.mjs');
  const { StudioDelegates } = await import('./lib/studio-delegates.mjs');
  const { StudioWorkflow } = await import('./lib/studio-workflow.mjs');
  const { StudioVerification } = await import('./lib/studio-verification.mjs');
  const { RecoveryScheduler } = await import('./lib/studio-resumer.mjs');
  const { CodeIntelligence } = await import('./lib/studio-intelligence.mjs');
  const { previewStatus } = await import('./lib/studio-preview.mjs');
  manager.studio=new StudioWorkspace({manager,directory:path.join(manager.hubDirectory,'studio')});
  manager.workflow=new StudioWorkflow({directory:path.join(manager.hubDirectory,'studio','workflows')});
  manager.intelligence=new CodeIntelligence({workspace:manager.studio,directory:path.join(manager.hubDirectory,'studio','index'),bundleRoot:BUNDLE_ROOT});
  manager.preview=previewStatus;
  manager.terminal=new StudioTerminal({workspace:manager.studio});
  manager.verification=new StudioVerification({workspace:manager.studio,terminal:manager.terminal,directory:path.join(manager.hubDirectory,'studio','verifications'),secrets:()=>manager.secrets||[]});
  manager.permissions=new PermissionGate({manager,workspace:manager.studio,directory:path.join(manager.hubDirectory,'studio')});
  manager.verification.permissions=manager.permissions;
  manager.studioTools=new StudioTools({workspace:manager.studio,gate:manager.permissions,intelligence:manager.intelligence});
  manager.permissions.onEvent=(event)=>manager.log(`${event.type}: ${event.toolName??event.name??event.id??''}`);
  const browser = new BrowserRunner({ manager, directory: path.join(manager.hubDirectory, 'browser'), log: (line) => manager.log(line) });
  const provider = new GatewayProvider({ manager, bundleRoot: BUNDLE_ROOT, directory: path.join(manager.hubDirectory, 'gateway') });
  manager.delegates=new StudioDelegates({workspace:manager.studio,provider,directory:path.join(manager.hubDirectory,'studio','delegates')});
  await manager.delegates.load();
  const apiAgent = new AgentRunner({ manager, provider, taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: (line) => manager.log(line) });
  const agent = new DualAgent({ browser, api: apiAgent, directory: manager.hubDirectory });
  const resumer = new RecoveryScheduler({ agent, manager, provider, browser, log:(line)=>manager.log(line) });
  await manager.permissions.load();
  let initialized = false;
  let closing = false;
  let releaseInstance = async () => {};
  const server = createHubServer(manager, { port: options.port, browser, agent, provider, onShutdown: close, isInitialized: () => initialized });
  const url = `http://127.0.0.1:${options.port}`;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
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
    await openDashboard(url, manager);
    manager.log('Hub đã chạy sẵn; đã mở lại trang quản lý.');
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
  manager.log(`MCP: ${PROXY_URL_FOR_LOG}`);
  await openDashboard(url, manager);
  if (manager.workspace) void manager.start().catch(() => {});
  else manager.log('Chọn thư mục workspace trên trang localhost để bắt đầu.');
  resumer.start();
  async function close() {
    if (closing) return;
    closing = true;
    resumer.stop();
    manager.log('Đang dừng các tiến trình MCP do Hub quản lý...');
    const deadline = setTimeout(() => process.exit(1), 12000);
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
const PROXY_URL_FOR_LOG = 'http://127.0.0.1:3006/mcp';

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[CHATMCP-HUB] ${error.message}`); process.exitCode = 1; });
}
