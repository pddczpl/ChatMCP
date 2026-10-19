// Per-launch Hub credential: a random bearer secret, the user-only file that tells local clients about it, and the
// helpers a client (launcher, second hub.mjs, tests) uses to talk to a Hub it did not start.
//
// What this protects: the loopback Hub is reachable by every local process, other OS accounts included, and by any
// web page the user opens (DNS rebinding, forged requests). Requiring `Authorization: Bearer <secret>` on every API
// route, with the secret only in a file the OS lets the current user read, keeps all of those out.
// What it does NOT protect: malware running as the same user can read the file like the desktop shell does.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const SESSION_FILE_VERSION = 1;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
export const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{32,256})$/;
/** The URL fragment key that carries a one-time ticket to a freshly opened dashboard. */
export const BOOT_FRAGMENT = 'chatmcp-boot';
/** How long a ticket stays redeemable, and how many may be outstanding at once. */
export const TICKET_TTL_MS = 60_000;
export const TICKET_LIMIT = 16;

export function sessionDirectory(hubDirectory) { return path.join(hubDirectory, 'run'); }
export function sessionFile(hubDirectory) { return path.join(sessionDirectory(hubDirectory), 'hub-session.json'); }

/**
 * The secret for this launch: CHATMCP_HUB_SECRET when the caller supplies one (tests, supervised starts), else 32 fresh
 * random bytes. A supplied value that is too weak is an error, never silently replaced.
 */
export function createSecret(env = process.env) {
  const configured = env.CHATMCP_HUB_SECRET;
  if (configured === undefined || configured === '') return randomBytes(32).toString('hex');
  if (!SECRET_PATTERN.test(configured))
    throw new Error('CHATMCP_HUB_SECRET must be 32-256 characters from A-Z a-z 0-9 _ - .');
  return configured;
}

/** Single-use, short-lived tickets that let a page trade a URL fragment for the real secret (it never sits in a URL). */
export function createTicketBook({ now = Date.now, ttlMs = TICKET_TTL_MS, limit = TICKET_LIMIT } = {}) {
  const tickets = new Map(); // sha256(ticket) -> expiry
  const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
  const sweep = () => { for (const [key, expiry] of tickets) if (expiry <= now()) tickets.delete(key); };
  return {
    issue() {
      sweep();
      while (tickets.size >= limit) tickets.delete(tickets.keys().next().value);
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(digest(ticket), now() + ttlMs);
      return { ticket, expiresInSeconds: Math.round(ttlMs / 1000) };
    },
    /** True exactly once per issued ticket, and only before it expires. */
    redeem(ticket) {
      if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 256) return false;
      sweep();
      return tickets.delete(digest(ticket));
    },
    get size() { sweep(); return tickets.size; },
  };
}

function windowsUserSid() {
  const out = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(out)?.[1];
  if (!sid) throw new Error('cannot determine the current Windows user SID');
  return sid;
}

/**
 * Create `directory` readable by the current user only. Windows: drop inherited ACEs and grant the user alone (a
 * failure is fatal: a secret in a world-readable folder is worse than a Hub that does not start). POSIX: mode 0700.
 */
export function protectDirectory(directory, { platform = process.platform } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform === 'win32') {
    const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
    try {
      execFileSync(icacls, [directory, '/inheritance:r', '/grant:r', `*${windowsUserSid()}:(OI)(CI)F`],
        { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    } catch (error) {
      throw new Error(`Cannot restrict ${directory} to the current user (${String(error.message).split('\n')[0]}). The Hub will not publish its session secret.`);
    }
  } else chmodSync(directory, 0o700);
}

/**
 * Publish {pid, port, secret} for local clients. The directory's ACL is fixed first, the file is written there and moved
 * into place atomically. `remove()` deletes it only while it is still ours (same pid and nonce).
 */
export async function writeSession(hubDirectory, { port, secret, pid = process.pid }) {
  const directory = sessionDirectory(hubDirectory);
  protectDirectory(directory);
  const file = sessionFile(hubDirectory);
  const nonce = randomUUID();
  const body = JSON.stringify({ version: SESSION_FILE_VERSION, app: 'chatmcp-local-hub', pid, port, secret, nonce, startedAt: new Date().toISOString() });
  const temporary = `${file}.${pid}.tmp`;
  await fs.writeFile(temporary, body, { mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  return {
    file, nonce,
    async remove() {
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (saved.nonce === nonce && saved.pid === pid) await fs.unlink(file);
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    },
  };
}

/** The published session of the Hub that owns `hubDirectory`, or null when there is none or it is malformed. */
export async function readSession(hubDirectory) {
  let saved;
  try { saved = JSON.parse(await fs.readFile(sessionFile(hubDirectory), 'utf8')); }
  catch { return null; }
  if (!saved || saved.version !== SESSION_FILE_VERSION || saved.app !== 'chatmcp-local-hub' ||
      !Number.isInteger(saved.pid) || saved.pid < 1 || !Number.isInteger(saved.port) ||
      typeof saved.secret !== 'string' || !SECRET_PATTERN.test(saved.secret)) return null;
  return saved;
}

export const bearerHeaders = (secret, extra = {}) => ({ ...extra, Authorization: `Bearer ${secret}` });

/** Health says the Hub requires the session secret. A Hub without that field predates it (v3.9.0 and older). */
export function hubRequiresBearer(health) { return health?.auth === 'bearer'; }

/** Same-origin POST headers the Hub demands of a dashboard-style caller, plus the bearer. */
export function mutationHeaders(origin, secret, csrfToken, extra = {}) {
  return bearerHeaders(secret, { 'Content-Type': 'application/json', Origin: origin, 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': csrfToken, ...extra });
}

/** Ask a running Hub for a one-time ticket; the dashboard URL to open is `${origin}/#chatmcp-boot=${ticket}`. */
export async function requestTicket(origin, secret, { signal = AbortSignal.timeout(5000) } = {}) {
  const response = await fetch(`${origin}/api/session/ticket`, {
    method: 'POST', redirect: 'error', signal, body: '{}',
    headers: bearerHeaders(secret, { 'Content-Type': 'application/json' }),
  });
  if (!response.ok) throw new Error(`Hub refused a session ticket (HTTP ${response.status}).`);
  const { ticket } = await response.json();
  if (typeof ticket !== 'string' || !ticket) throw new Error('Hub returned no session ticket.');
  return ticket;
}

export const dashboardUrl = (origin, ticket) => `${origin}/#${BOOT_FRAGMENT}=${encodeURIComponent(ticket)}`;

/**
 * Talk to a Hub that is already running on `origin`, using the secret in its state directory: optionally select
 * `project` as the workspace, and return the URL that opens the dashboard already signed in.
 * Throws a readable error when the Hub is not one this build can authenticate to.
 */
export async function attachToRunningHub({ origin, stateDirectory, project = null }) {
  const session = await readSession(stateDirectory);
  const port = Number(new URL(origin).port);
  if (!session || session.port !== port)
    throw new Error(`Cổng ${port} đang chạy một Hub mà bản này không có session để xác thực (không thấy ${sessionFile(stateDirectory)}). Chạy STOP-CHATMCP-HUB.cmd rồi START-CHATMCP-HUB.cmd; không dùng tiến trình cũ.`);
  const options = { redirect: 'error', signal: AbortSignal.timeout(5000) };
  const stateResponse = await fetch(`${origin}/api/state`, { ...options, headers: bearerHeaders(session.secret) });
  if (stateResponse.status === 401)
    throw new Error(`Hub trên cổng ${port} từ chối session đã lưu (Hub đã khởi động lại hoặc file cũ). Chạy STOP-CHATMCP-HUB.cmd rồi START-CHATMCP-HUB.cmd.`);
  if (!stateResponse.ok) throw new Error(`Hub trả HTTP ${stateResponse.status} cho /api/state.`);
  const state = await stateResponse.json();
  let selectError = null;
  if (project && state.workspace?.path !== project) {
    const response = await fetch(`${origin}/api/workspace/select`, {
      ...options, method: 'POST', headers: mutationHeaders(origin, session.secret, state.csrfToken), body: JSON.stringify({ path: project }),
    });
    if (!response.ok) selectError = (await response.json().catch(() => ({}))).error ?? 'Hub đang xử lý một thao tác.';
  }
  return { session, selectError, ticket: () => requestTicket(origin, session.secret) };
}
