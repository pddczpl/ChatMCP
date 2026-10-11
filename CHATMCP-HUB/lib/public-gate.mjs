// The front door of public mode: everything that runs before the Hub's own routes when it serves a browser over the Internet.
//
// Order of decisions for one request (hub.mjs calls these in turn):
//   1. GET|HEAD /healthz            - answered first and without a Host check: the platform's health probe is not a browser
//   2. Host header                  - must be one of the configured host names
//   3. X-Forwarded-Proto            - must say https (TLS is ended by the platform, never by the Hub)
//   4. Origin header (when present) - must be https://<one of those hosts>
//   5. handle()                     - login page and login/logout/session routes; then DEFAULT DENY: without a live session every
//                                     other request, whatever its method or path, gets 401. Routes that do not exist on a public
//                                     host answer 403 even to the owner. Only after all of that does a route of the Hub run.
//
// Because step 5 is a gate in front of the router, a route added to the Hub later is protected without anybody remembering to.
import fs from 'node:fs/promises';
import path from 'node:path';
import { hostAllowed, normalizeHostHeader, originAllowed } from './public-config.mjs';

const LOGIN_FILES = Object.freeze({ '/login': 'web/login.html', '/login.js': 'web/login.js', '/login.css': 'web/login.css' });
const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' });
const LOGIN_PAGE_PATHS = new Set(['/', '/index.html']);

/** Routes that exist in the loopback Hub and make no sense (or are not safe) on a public host. Method-independent on purpose. */
const DISABLED = Object.freeze({
  exact: new Set([
    '/api/extension-state', '/api/instructions', '/chat-route.js', '/auth/chatgpt/callback', '/api/auth/chatgpt/start',
    '/api/studio/terminal/events', '/api/studio/terminal/input', '/api/studio/terminal/resize',
    '/api/studio/intelligence/lsp/start', '/api/studio/intelligence/lsp', '/api/studio/preview', '/api/studio/sandbox',
    '/api/workspace/browse', '/api/vscode/open', '/api/hub/shutdown',
  ]),
  prefixes: Object.freeze(['/api/browser/']),
});

export const PUBLIC_POST_ROUTES = Object.freeze(['/api/auth/login', '/api/auth/logout', '/api/workspace/clone', '/api/workspace/create', '/api/workspace/delete', '/api/workspace/push', '/api/workspace/pr']);

export function createPublicGate({ config, auth, bundleRoot, isInitialized = () => true, log = () => {} }) {
  const fail = (status, error, code, extra = {}) => ({ status, body: { error, code, ...extra } });

  async function sendFile(res, file, { head = false } = {}) {
    const data = await fs.readFile(path.join(bundleRoot, file));
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', data.length);
    res.writeHead(200);
    res.end(head ? undefined : data);
  }

  return {
    config,
    auth,

    /** Extra response headers that only make sense for an Internet-facing site. */
    securityHeaders(res) {
      if (config.requireHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    },

    /** The platform's probe. Returns true when the request was answered. */
    healthz(req, res, url) {
      if (url.pathname !== '/healthz') return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Chỉ GET/HEAD.' })); return true; }
      const ready = isInitialized();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: ready }));
      return true;
    },

    hostOk(req) { return hostAllowed(config, req.headers.host); },

    /**
     * TLS is ended by the platform; the header it adds is how the Hub knows the browser used HTTPS. The LAST value is the one written by
     * the proxy closest to the Hub, so a client that adds its own "https" in front of it gains nothing.
     */
    httpsOk(req) {
      if (!config.requireHttps) return true;
      const raw = req.headers['x-forwarded-proto'];
      const values = String(Array.isArray(raw) ? raw.join(',') : raw ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
      return values.length > 0 && values.at(-1) === 'https';
    },

    originOk(origin) { return origin === undefined || originAllowed(config, origin); },

    /** Is this route one that a public host does not offer at all? */
    disabled(pathname) {
      return DISABLED.exact.has(pathname) || DISABLED.prefixes.some((prefix) => pathname.startsWith(prefix));
    },

    /** Extra checks of a POST body that depend on what the request asks for. Returns a refusal or null. */
    checkPost(pathname, payload, { execMode }) {
      if (pathname === '/api/studio/permissions/config' && payload.executionPolicy !== undefined && payload.executionPolicy !== 'host-review') {
        return fail(403, 'Chế độ công khai chỉ cho phép chính sách host-review (không có Full Access hay sandbox Docker).', 'public_mode_disabled');
      }
      if (pathname === '/api/studio/terminal/start') {
        if (payload.interactive || payload.sandbox) return fail(403, 'Terminal tương tác và Docker sandbox không có ở chế độ công khai; chỉ chạy được một lệnh không tương tác.', 'public_mode_disabled');
        if (execMode === 'no-shell') return fail(403, 'Máy chủ không tách được quyền cho lệnh của agent nên chạy lệnh đã bị tắt.', 'exec_unavailable');
      }
      if (pathname === '/api/studio/verify/run' && execMode === 'no-shell') return fail(403, 'Máy chủ không tách được quyền cho lệnh của agent nên chạy kiểm thử đã bị tắt.', 'exec_unavailable');
      return null;
    },

    /**
     * The gate itself. Resolves { handled: true } when it answered the request, or { handled: false, session } for a request that may
     * continue to the Hub's routes (session is always set in that case).
     */
    async handle({ req, res, url, origin, json, bodyJson }) {
      const pathname = url.pathname;
      const method = req.method;
      const read = method === 'GET' || method === 'HEAD';
      const reply = (outcome) => { json(outcome.status, outcome.body); return { handled: true }; };

      // -- login ------------------------------------------------------------------------------------------------------------
      if (method === 'POST' && pathname === '/api/auth/login') {
        if (origin === undefined || !originAllowed(config, origin)) return reply(fail(403, 'Origin không được phép.', 'origin_denied'));
        const payload = await bodyJson(req, 4096);
        const address = auth.address(req);
        const result = auth.attempt(payload?.token, address);
        if (!result.ok && result.status === 429) {
          res.setHeader('Retry-After', String(result.retryAfter));
          log(`Đăng nhập bị chặn tạm thời: ${address} (còn ${result.retryAfter}s)`);
          return reply(fail(429, `Thử sai quá nhiều lần. Chờ ${result.retryAfter} giây rồi thử lại.`, 'too_many_attempts', { retryAfter: result.retryAfter }));
        }
        if (!result.ok) {
          if (config.login.failureDelayMs) await new Promise((resolve) => setTimeout(resolve, config.login.failureDelayMs));
          log(`Đăng nhập sai từ ${address}`);
          return reply(fail(401, 'Token không đúng.', 'bad_token'));
        }
        res.setHeader('Set-Cookie', auth.cookieFor(result.id, result.expiresAt));
        log(`Đã đăng nhập từ ${address}`);
        json(200, { ok: true });
        return { handled: true };
      }

      const session = auth.sessionFor(req);

      // -- pages and files a visitor without a session may see ------------------------------------------------------------------
      if (read && LOGIN_FILES[pathname]) {
        if (session && pathname === '/login') { res.writeHead(302, { Location: '/' }); res.end(); return { handled: true }; }
        await sendFile(res, LOGIN_FILES[pathname], { head: method === 'HEAD' });
        return { handled: true };
      }
      if (!session) {
        if (read && LOGIN_PAGE_PATHS.has(pathname)) { await sendFile(res, LOGIN_FILES['/login'], { head: method === 'HEAD' }); return { handled: true }; }
        if (method === 'GET' && pathname === '/api/auth/session') { json(200, { authenticated: false }); return { handled: true }; }
        return reply(fail(401, 'Cần đăng nhập.', 'login_required'));
      }

      // -- from here on there is a live session -----------------------------------------------------------------------------
      if (read && pathname === '/api/auth/session') {
        json(200, { authenticated: true, expiresAt: new Date(session.expiresAt).toISOString(), idleExpiresAt: new Date(session.idleExpiresAt).toISOString(), clientAddress: auth.address(req), proxyHops: config.trustedProxyHops });
        return { handled: true };
      }
      if (method === 'POST' && pathname === '/api/auth/logout') {
        if (origin === undefined || !originAllowed(config, origin) || req.headers['x-chatmcp-request'] !== 'local-dashboard' || !auth.csrfOk(session, req.headers['x-chatmcp-csrf'])) {
          return reply(fail(403, 'Phiên trang không hợp lệ. Tải lại trang rồi thử lại.', 'csrf'));
        }
        auth.destroy(session);
        res.setHeader('Set-Cookie', auth.clearCookie());
        log('Đã đăng xuất.');
        json(200, { ok: true });
        return { handled: true };
      }
      if (this.disabled(pathname)) return reply(fail(403, 'Chức năng này không có ở chế độ công khai.', 'public_mode_disabled'));
      return { handled: false, session };
    },
  };
}

export { normalizeHostHeader };
