// Configuration of the Hub when it serves a browser over the Internet instead of 127.0.0.1 ("public mode").
//
// Everything is read from the environment (that is where Render, Docker and every other host put secrets) and checked here, in
// one place, before the Hub opens a port. A mistake never silently produces an open Hub: the Hub refuses to start instead.
//
//   CHATMCP_PUBLIC=1                       turn public mode on; without it the Hub only listens on loopback (Phase 1 behaviour)
//   CHATMCP_OWNER_TOKEN                    the one login secret (>= 32 characters, >= 12 different characters)
//   RENDER_EXTERNAL_HOSTNAME               set by Render; the host name the browser uses
//   CHATMCP_ALLOWED_HOSTS                  more host names (comma separated), e.g. a custom domain or localhost:10000 for a local test
//   CHATMCP_ALLOW_INSECURE_HTTP=1          accept plain HTTP (local test only; the session cookie loses Secure and the __Host- prefix)
//   CHATMCP_TRUSTED_PROXY_HOPS             proxies in front of the Hub when reading X-Forwarded-For (default 2 on Render, else 0)
//   CHATMCP_WORKSPACES_ROOT, CHATMCP_MAX_WORKSPACES, CHATMCP_MAX_CLONE_MB, CHATMCP_GIT_ALLOWED_HOSTS, GITHUB_TOKEN
//   CHATMCP_EXEC_MODE=broker|no-shell|same-user, CHATMCP_EXEC_BROKER=<socket>, CHATMCP_UNSAFE_SAME_USER_EXEC=1
//   CHATMCP_AI_PRESET, CHATMCP_AI_MODEL    model connection applied at start (the key itself comes from the preset's usual variable)
//
// The module is pure: it reads only the object it is given and returns a frozen description. Error messages never contain a secret.
import path from 'node:path';

export class PublicConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PublicConfigError';
    this.code = code;
  }
}

export const OWNER_TOKEN_MIN_LENGTH = 32;
export const OWNER_TOKEN_MIN_DISTINCT = 12;
const OWNER_TOKEN_MAX_LENGTH = 512;
const HOST_ENTRY = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const GIT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const GITHUB_TOKEN = /^[A-Za-z0-9_.-]{20,255}$/;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off']);
export const EXEC_MODES = Object.freeze(['broker', 'no-shell', 'same-user']);

const fail = (code, message) => new PublicConfigError(code, message);

/** 1/true/yes/on -> true; empty/0/false/no/off -> false; anything else is a mistake worth stopping for. */
export function truthyEnv(value, name = 'biến môi trường') {
  const text = String(value ?? '').trim().toLowerCase();
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  throw fail('bad_flag', `${name} có giá trị không hiểu được. Dùng 1 hoặc 0.`);
}

export function isLoopbackHost(host) {
  const text = String(host ?? '').trim().toLowerCase();
  return text === 'localhost' || text === '::1' || text === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(text);
}

/** Lower-cased Host header without a trailing dot; null when it cannot be a host name at all. */
export function normalizeHostHeader(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  let text = value.trim().toLowerCase();
  if (text.endsWith('.')) text = text.slice(0, -1);
  return HOST_ENTRY.test(text) ? text : null;
}

/**
 * The login secret has to be long and not repetitive. Render's generateValue (256 random bits, base64) always passes; a short
 * password chosen by a person does not, and the Hub refuses to run with it.
 */
export function checkOwnerToken(token) {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' };
  if (token.length > OWNER_TOKEN_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (/[\s\u0000-\u001f\u007f]/.test(token)) return { ok: false, reason: 'whitespace' };
  if (token.length < OWNER_TOKEN_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  if (new Set(token).size < OWNER_TOKEN_MIN_DISTINCT) return { ok: false, reason: 'low_variety' };
  return { ok: true, reason: '' };
}

function integer(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < min || number > max) throw fail('bad_number', `${name} phải là số nguyên từ ${min} đến ${max}.`);
  return number;
}

function hostEntries(env) {
  const raw = [env.RENDER_EXTERNAL_HOSTNAME, ...String(env.CHATMCP_ALLOWED_HOSTS ?? '').split(/[\s,]+/)].map((item) => String(item ?? '').trim()).filter(Boolean);
  const entries = new Set();
  for (const item of raw) {
    const normalized = normalizeHostHeader(item);
    if (!normalized || normalized.startsWith('-')) throw fail('bad_host', `Tên host không hợp lệ trong RENDER_EXTERNAL_HOSTNAME / CHATMCP_ALLOWED_HOSTS: "${item.slice(0, 80)}".`);
    entries.add(normalized);
  }
  return entries;
}

/**
 * @param {object} env  process.env or a stand-in
 * @param {{host?: string|null, port?: number|null, stateDir?: string|null}} options  values from the command line
 * @returns the configuration (enabled: false when public mode is off)
 */
export function resolvePublicConfig(env = process.env, { host = null, port = null, stateDir = null } = {}) {
  const enabled = truthyEnv(env.CHATMCP_PUBLIC, 'CHATMCP_PUBLIC');
  const bindHost = String(host ?? env.CHATMCP_HOST ?? (enabled ? '0.0.0.0' : '127.0.0.1')).trim();
  if (!bindHost || /[\s/]/.test(bindHost)) throw fail('bad_bind', 'Địa chỉ bind không hợp lệ.');
  if (!enabled) {
    if (!isLoopbackHost(bindHost)) throw fail('public_required', 'Bind ra ngoài loopback cần CHATMCP_PUBLIC=1 cùng CHATMCP_OWNER_TOKEN: Hub không có đăng nhập ở chế độ cục bộ nên không được mở ra mạng.');
    return Object.freeze({ enabled: false, host: bindHost });
  }

  const tokenCheck = checkOwnerToken(env.CHATMCP_OWNER_TOKEN);
  if (!tokenCheck.ok) {
    const why = {
      missing: 'Chưa đặt CHATMCP_OWNER_TOKEN.',
      too_long: `CHATMCP_OWNER_TOKEN dài quá ${OWNER_TOKEN_MAX_LENGTH} ký tự.`,
      whitespace: 'CHATMCP_OWNER_TOKEN không được chứa khoảng trắng hoặc ký tự điều khiển.',
      too_short: `CHATMCP_OWNER_TOKEN phải dài ít nhất ${OWNER_TOKEN_MIN_LENGTH} ký tự.`,
      low_variety: `CHATMCP_OWNER_TOKEN phải có ít nhất ${OWNER_TOKEN_MIN_DISTINCT} ký tự khác nhau.`,
    }[tokenCheck.reason];
    throw fail(`owner_token_${tokenCheck.reason}`, `${why} Chế độ công khai không khởi động khi thiếu hoặc yếu bí mật đăng nhập. Trên Render hãy dùng generateValue: true.`);
  }

  const allowedHosts = hostEntries(env);
  if (allowedHosts.size === 0) throw fail('allowed_hosts_missing', 'Chưa biết tên host công khai. Render tự đặt RENDER_EXTERNAL_HOSTNAME; nơi khác hãy đặt CHATMCP_ALLOWED_HOSTS (ví dụ ten-mien.example hoặc localhost:10000).');
  const allowInsecure = truthyEnv(env.CHATMCP_ALLOW_INSECURE_HTTP, 'CHATMCP_ALLOW_INSECURE_HTTP');
  const origins = new Set();
  for (const entry of allowedHosts) { origins.add(`https://${entry}`); if (allowInsecure) origins.add(`http://${entry}`); }

  const onRender = truthyEnv(env.RENDER, 'RENDER');
  const trustedProxyHops = integer(env, 'CHATMCP_TRUSTED_PROXY_HOPS', onRender ? 2 : 0, 0, 5);

  const resolvedState = stateDir ? path.resolve(stateDir) : null;
  const workspacesRootRaw = env.CHATMCP_WORKSPACES_ROOT || (resolvedState ? path.join(path.dirname(resolvedState), 'workspaces') : '');
  if (!workspacesRootRaw || !path.isAbsolute(workspacesRootRaw)) throw fail('workspaces_root', 'CHATMCP_WORKSPACES_ROOT phải là đường dẫn tuyệt đối (hoặc đặt --state-dir để suy ra).');
  const workspacesRoot = path.resolve(workspacesRootRaw);
  if (workspacesRoot === path.parse(workspacesRoot).root) throw fail('workspaces_root', 'Gốc workspace không được là thư mục gốc của ổ đĩa.');

  const gitHosts = String(env.CHATMCP_GIT_ALLOWED_HOSTS ?? 'github.com').split(/[\s,]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (gitHosts.length === 0 || gitHosts.some((item) => !GIT_HOST.test(item))) throw fail('bad_git_hosts', 'CHATMCP_GIT_ALLOWED_HOSTS phải là danh sách tên miền (ví dụ github.com).');
  const githubToken = String(env.GITHUB_TOKEN ?? '').trim();
  if (githubToken && !GITHUB_TOKEN.test(githubToken)) throw fail('bad_github_token', 'GITHUB_TOKEN có dạng không hợp lệ (dùng token chi tiết của GitHub, không kèm khoảng trắng hay dấu ngoặc).');

  const execMode = String(env.CHATMCP_EXEC_MODE ?? 'no-shell').trim().toLowerCase();
  if (!EXEC_MODES.includes(execMode)) throw fail('bad_exec_mode', `CHATMCP_EXEC_MODE phải là ${EXEC_MODES.join(', ')}.`);
  if (execMode === 'same-user' && !truthyEnv(env.CHATMCP_UNSAFE_SAME_USER_EXEC, 'CHATMCP_UNSAFE_SAME_USER_EXEC')) {
    throw fail('unsafe_exec_not_confirmed', 'same-user cho lệnh của agent chạy cùng tài khoản với Hub, nên đọc được token và khóa của Hub. Chỉ dùng để thử; xác nhận bằng CHATMCP_UNSAFE_SAME_USER_EXEC=1.');
  }
  const execBroker = String(env.CHATMCP_EXEC_BROKER ?? '').trim();
  if (execMode === 'broker' && (!execBroker || !path.isAbsolute(execBroker))) throw fail('exec_broker_missing', 'CHATMCP_EXEC_MODE=broker cần CHATMCP_EXEC_BROKER là đường dẫn tuyệt đối của socket.');

  const windowMs = integer(env, 'CHATMCP_LOGIN_WINDOW_SECONDS', 900, 1, 86_400) * 1000;
  return Object.freeze({
    enabled: true,
    host: bindHost,
    port: port ?? null,
    ownerToken: env.CHATMCP_OWNER_TOKEN,
    allowedHosts,
    origins,
    allowInsecure,
    requireHttps: !allowInsecure,
    trustedProxyHops,
    cookie: Object.freeze({ name: allowInsecure ? 'chatmcp_session' : '__Host-chatmcp_session', secure: !allowInsecure }),
    session: Object.freeze({
      idleMs: integer(env, 'CHATMCP_SESSION_IDLE_SECONDS', 3600, 5, 86_400) * 1000,
      absoluteMs: integer(env, 'CHATMCP_SESSION_MAX_SECONDS', 43_200, 10, 604_800) * 1000,
      maxSessions: integer(env, 'CHATMCP_MAX_SESSIONS', 5, 1, 20),
    }),
    login: Object.freeze({
      perIp: Object.freeze({ max: integer(env, 'CHATMCP_LOGIN_MAX_FAILURES_PER_IP', 5, 1, 1000), windowMs }),
      global: Object.freeze({ max: integer(env, 'CHATMCP_LOGIN_MAX_FAILURES_GLOBAL', 40, 1, 100_000), windowMs }),
      failureDelayMs: integer(env, 'CHATMCP_LOGIN_FAILURE_DELAY_MS', 400, 0, 10_000),
    }),
    workspaces: Object.freeze({
      root: workspacesRoot,
      max: integer(env, 'CHATMCP_MAX_WORKSPACES', 3, 1, 20),
      maxCloneBytes: integer(env, 'CHATMCP_MAX_CLONE_MB', 200, 10, 2000) * 1024 * 1024,
      gitHosts: Object.freeze(gitHosts),
      githubToken: githubToken || null,
    }),
    exec: Object.freeze({ mode: execMode, broker: execBroker || null, commandMaxSeconds: integer(env, 'CHATMCP_COMMAND_MAX_SECONDS', 300, 10, 900) }),
    ai: Object.freeze({ preset: String(env.CHATMCP_AI_PRESET ?? '').trim(), model: String(env.CHATMCP_AI_MODEL ?? '').trim() }),
  });
}

/** True when a Host header names one of the configured hosts (a ":443" suffix is the default HTTPS port and is ignored). */
export function hostAllowed(config, headerValue) {
  const host = normalizeHostHeader(headerValue);
  if (!host) return false;
  if (config.allowedHosts.has(host)) return true;
  return host.endsWith(':443') && config.allowedHosts.has(host.slice(0, -4));
}

/** An Origin header is acceptable when it is exactly https://<allowed host> (or http:// when insecure HTTP was confirmed). */
export function originAllowed(config, origin) {
  if (typeof origin !== 'string') return false;
  const text = origin.trim().toLowerCase();
  if (config.origins.has(text)) return true;
  return /^https:\/\/.+:443$/.test(text) && config.origins.has(text.slice(0, -4));
}

/** What may appear in a log line: the shape of the configuration, never a secret. */
export function describePublicConfig(config) {
  if (!config?.enabled) return { enabled: false };
  return {
    enabled: true, host: config.host, hosts: [...config.allowedHosts], https: config.requireHttps, proxyHops: config.trustedProxyHops,
    workspacesRoot: config.workspaces.root, maxWorkspaces: config.workspaces.max, gitHosts: [...config.workspaces.gitHosts],
    githubToken: config.workspaces.githubToken ? 'đã đặt' : 'chưa đặt', execMode: config.exec.mode, aiPreset: config.ai.preset || null,
  };
}
