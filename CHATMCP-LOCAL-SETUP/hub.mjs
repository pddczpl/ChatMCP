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
const BUNDLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function equalToken(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function bodyJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
    const e = new Error('Yêu cầu phải dùng JSON.'); e.statusCode = 415; throw e;
  }
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    byteCount += chunk.length;
    if (byteCount > 65536) { const e = new Error('Yêu cầu quá lớn (tối đa 64 KB).'); e.statusCode = 413; throw e; }
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try { return body ? JSON.parse(body) : {}; }
  catch { const e = new Error('JSON không hợp lệ.'); e.statusCode = 400; throw e; }
}

export function createHubServer(manager, { port = 3007, token = randomBytes(32).toString('hex'), bundleRoot = BUNDLE_ROOT, provider = null, agent = null, onShutdown = () => {}, isInitialized = () => true } = {}) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  let aiBusy = false;
  const state = () => ({ ...manager.state(), ai: { ...(provider?.state() ?? { provider: 'openai', configured: false }), busy: aiBusy }, agent: agent?.state() ?? { activeTaskId: null, active: null, tasks: [] }, csrfToken: token });
  const requireNoTask = () => { if (agent?.state().activeTaskId) { const e = new Error('Hủy hoặc chờ nhiệm vụ hoàn tất trước khi thay đổi kết nối AI.'); e.statusCode = 409; throw e; } };
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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (!hosts.has(req.headers.host)) return json(403, { error: 'Host không được phép.' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const origin = req.headers.origin;
      const extensionRead = ['/api/extension-state', '/api/instructions'].includes(url.pathname);
      const extensionOrigin = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      if (origin && !origins.has(origin) && !(extensionRead && extensionOrigin && ['GET', 'OPTIONS'].includes(req.method))) {
        return json(403, { error: 'Origin không được phép.' });
      }
      if (extensionRead && extensionOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        if (extensionRead && extensionOrigin) {
          res.setHeader('Access-Control-Allow-Methods', 'GET');
          res.writeHead(204); return res.end();
        }
        return json(405, { error: 'Phương thức không được hỗ trợ.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { app: APP_ID, version: VERSION, initialized: isInitialized() });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state());
      if (!isInitialized() && (req.method === 'POST' || url.pathname === '/auth/chatgpt/callback')) return json(503, { error: 'Hub đang nạp cấu hình. Chờ vài giây rồi thử lại.' });
      if (req.method === 'GET' && url.pathname === '/api/catalog') return json(200, manager.catalog ?? { ready: false, tools: [], counts: {} });
      if (req.method === 'GET' && url.pathname === '/api/ai/models') return json(200, { models: provider ? await changeAi(() => provider.listModels()) : [] });
      if (req.method === 'GET' && url.pathname === '/auth/chatgpt/callback') {
        requireNoTask();
        if (!provider) throw new Error('Kết nối AI chưa khởi tạo.');
        await changeAi(() => provider.completeLogin(url.searchParams));
        res.writeHead(303, { Location: '/?login=complete' }); return res.end();
      }
      const taskRoute = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})(\/report)?$/);
      if (req.method === 'GET' && taskRoute) {
        const value = taskRoute[2] ? await agent?.report(taskRoute[1]) : agent?.get(taskRoute[1]);
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
        if (!origins.has(origin) || req.headers['x-chatmcp-request'] !== 'local-dashboard' || !equalToken(req.headers['x-chatmcp-csrf'], token)) {
          return json(403, { error: 'Phiên trang localhost không hợp lệ. Tải lại trang rồi thử lại.' });
        }
        const payload = await bodyJson(req);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(400, { error: 'Nội dung yêu cầu phải là JSON object.' });
        let result;
        switch (url.pathname) {
          case '/api/workspace/browse': result = await manager.browse(); break;
          case '/api/workspace/select': await manager.selectWorkspace(payload.path); result = state(); break;
          case '/api/services/start': await manager.start(); result = state(); break;
          case '/api/services/stop': await manager.stop(); result = state(); break;
          case '/api/vscode/open': result = await manager.openVsCode(); break;
          case '/api/ai/config': if (!provider) throw new Error('Kết nối AI chưa khởi tạo.'); await changeAi(() => provider.configure(payload)); result = state(); break;
          case '/api/auth/chatgpt/start': if (!provider) throw new Error('Kết nối AI chưa khởi tạo.'); result = await changeAi(() => provider.beginLogin({ baseUrl: `http://127.0.0.1:${port}` })); break;
          case '/api/auth/logout': if (!provider) throw new Error('Kết nối AI chưa khởi tạo.'); await changeAi(() => provider.logout()); result = state(); break;
          case '/api/tasks/start': if (!agent) throw new Error('Agent chưa khởi tạo.'); if (aiBusy) { const e = new Error('Kết nối AI đang thay đổi. Chờ hoàn tất rồi chạy nhiệm vụ.'); e.statusCode = 409; throw e; } result = { task: await agent.start(payload) }; break;
          case '/api/tasks/cancel': if (!agent) throw new Error('Agent chưa khởi tạo.'); result = { task: await agent.cancel(payload.id) }; break;
          case '/api/hub/shutdown': result = { ok: true }; setTimeout(() => void onShutdown(), 150); break;
          default: return json(404, { error: 'Không tìm thấy thao tác.' });
        }
        return json(200, { ...result, csrfToken: token });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Phương thức không được hỗ trợ.' });
      const staticFiles = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
      const filename = staticFiles[url.pathname];
      if (!filename) return json(404, { error: 'Không tìm thấy trang.' });
      const data = await fs.readFile(path.join(bundleRoot, 'web', filename));
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
      json(error.statusCode || 500, { error: safe });
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
  const { ModelProvider } = await import('./lib/provider.mjs');
  const { AgentRunner } = await import('./lib/agent.mjs');
  const provider = new ModelProvider({ directory: manager.hubDirectory, bundleRoot: BUNDLE_ROOT, log: (line) => manager.log(line), registerSecret: (value) => manager.registerSecret(value) });
  const agent = new AgentRunner({ manager, provider, taskDirectory: path.join(manager.hubDirectory, 'tasks'), log: (line) => manager.log(line) });
  let initialized = false;
  let closing = false;
  let releaseInstance = async () => {};
  const server = createHubServer(manager, { port: options.port, provider, agent, onShutdown: close, isInitialized: () => initialized });
  const url = `http://127.0.0.1:${options.port}`;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
    if (health?.app !== APP_ID) throw new Error(`Cổng ${options.port} đang do ứng dụng khác sử dụng. Hub không dừng ứng dụng đó.`);
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
    await provider.load();
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
  async function close() {
    if (closing) return;
    closing = true;
    manager.log('Đang dừng các tiến trình MCP do Hub quản lý...');
    const deadline = setTimeout(() => process.exit(1), 12000);
    await agent.shutdown().catch(() => {});
    await provider.shutdown?.().catch(() => {});
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
