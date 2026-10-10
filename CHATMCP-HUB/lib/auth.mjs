// The one login of public mode: a long random owner token is exchanged for a session cookie.
//
//  * The token is compared in constant time (SHA-256 of both sides, then timingSafeEqual) so neither its length nor a matching
//    prefix is observable.
//  * A session is 256 random bits. Only its SHA-256 is kept in memory, so a memory dump or a log line cannot be replayed as a login.
//    The browser holds it in an HttpOnly, Secure, SameSite=Strict cookie; every session has its own CSRF token.
//  * A session ends after `idleMs` without use or `absoluteMs` after login; there are at most `maxSessions` (the oldest unused one is
//    dropped when a new owner device logs in). Nothing is written to disk: restarting the Hub logs everyone out.
//  * Wrong tokens are throttled per client address and, because X-Forwarded-For can be forged, also across all addresses. While a
//    limit is reached the token is not even looked at, so a blocked client learns nothing about whether a guess was right.
//
// The class has no HTTP and no timers of its own besides an unref'ed sweeper, so it is tested directly with a fake clock.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_INPUT = 1024;
const MAX_TRACKED_ADDRESSES = 5000;

/** True when two strings are equal; takes the same time whatever they contain. */
export function constantTimeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * The address a request came from, as far as it can be trusted. `hops` is how many proxies of ours stand between the Internet and
 * the Hub (each one appends the address it saw to X-Forwarded-For): the entry `hops` places from the END is the client as the
 * outermost proxy saw it, and entries to its left are whatever the client chose to send. With 0 hops, or a header that is too short
 * or does not hold an IP address, the address of the TCP peer is used.
 */
export function clientAddress(request, hops = 0) {
  const peer = request.socket?.remoteAddress ?? '';
  if (hops > 0) {
    const header = request.headers?.['x-forwarded-for'];
    const parts = String(Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    const candidate = parts.length >= hops ? parts[parts.length - hops] : null;
    if (candidate && net.isIP(candidate)) return normalizeAddress(candidate);
  }
  return normalizeAddress(peer) || 'unknown';
}

export function normalizeAddress(value) {
  let text = String(value ?? '').trim().toLowerCase();
  if (text.startsWith('::ffff:') && net.isIPv4(text.slice(7))) text = text.slice(7);
  if (net.isIPv6(text)) {
    // One person can rotate through a whole /64, so the throttle treats the /64 as one client.
    const groups = text.includes('::') ? expandIpv6(text) : text.split(':');
    return `${groups.slice(0, 4).map((group) => group.padStart(4, '0')).join(':')}::/64`;
  }
  return net.isIPv4(text) ? text : '';
}

function expandIpv6(text) {
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
}

export function parseCookies(header) {
  const jar = new Map();
  for (const piece of String(header ?? '').split(';')) {
    const at = piece.indexOf('=');
    if (at < 1) continue;
    const name = piece.slice(0, at).trim();
    if (name && !jar.has(name)) jar.set(name, piece.slice(at + 1).trim());
  }
  return jar;
}

export class OwnerAuth {
  /**
   * @param {object} options
   * @param {string} options.token  the owner token (already validated by public-config)
   * @param {{name: string, secure: boolean}} options.cookie
   * @param {{idleMs: number, absoluteMs: number, maxSessions: number}} options.session
   * @param {{perIp: {max: number, windowMs: number}, global: {max: number, windowMs: number}}} options.login
   * @param {number} [options.trustedProxyHops]
   * @param {() => number} [options.now]
   */
  constructor({ token, cookie, session, login, trustedProxyHops = 0, now = Date.now } = {}) {
    if (typeof token !== 'string' || token.length < 16) throw new TypeError('OwnerAuth needs the owner token.');
    this.tokenDigest = digest(token);
    this.cookie = cookie;
    this.limits = session;
    this.login = login;
    this.trustedProxyHops = trustedProxyHops;
    this.now = now;
    this.sessions = new Map(); // sha256(session id) as hex -> { csrf, createdAt, lastSeen, expiresAt, address }
    this.failures = new Map(); // address -> { count, resetAt }
    this.globalFailures = { count: 0, resetAt: 0 };
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  close() { clearInterval(this.sweeper); this.sessions.clear(); this.failures.clear(); }

  address(request) { return clientAddress(request, this.trustedProxyHops); }

  sweep() {
    const now = this.now();
    for (const [key, session] of this.sessions) if (this.#expired(session, now)) this.sessions.delete(key);
    for (const [address, entry] of this.failures) if (entry.resetAt <= now) this.failures.delete(address);
  }

  #expired(session, now) { return now >= session.expiresAt || now - session.lastSeen >= this.limits.idleMs; }

  /** The live session behind a request's cookie (and the moment is recorded as its last use), or null. */
  sessionFor(request) {
    const raw = parseCookies(request.headers?.cookie).get(this.cookie.name);
    if (typeof raw !== 'string' || !SESSION_ID.test(raw)) return null;
    const key = digest(raw).toString('hex');
    const session = this.sessions.get(key);
    if (!session) return null;
    const now = this.now();
    if (this.#expired(session, now)) { this.sessions.delete(key); return null; }
    session.lastSeen = now;
    return { key, csrf: session.csrf, createdAt: session.createdAt, expiresAt: session.expiresAt, idleExpiresAt: now + this.limits.idleMs, address: session.address };
  }

  /** The CSRF check for one session: the header must equal the token handed out with that session. */
  csrfOk(session, header) {
    return Boolean(session) && typeof header === 'string' && header.length === session.csrf.length && timingSafeEqual(Buffer.from(header), Buffer.from(session.csrf));
  }

  destroy(session) { if (session?.key) this.sessions.delete(session.key); }

  #blocked(address, now) {
    const entry = this.failures.get(address);
    if (entry && entry.resetAt > now && entry.count >= this.login.perIp.max) return Math.ceil((entry.resetAt - now) / 1000);
    if (this.globalFailures.resetAt > now && this.globalFailures.count >= this.login.global.max) return Math.ceil((this.globalFailures.resetAt - now) / 1000);
    return 0;
  }

  #recordFailure(address, now) {
    let entry = this.failures.get(address);
    if (!entry || entry.resetAt <= now) {
      if (this.failures.size >= MAX_TRACKED_ADDRESSES) this.sweep();
      if (this.failures.size >= MAX_TRACKED_ADDRESSES) this.failures.delete(this.failures.keys().next().value);
      entry = { count: 0, resetAt: now + this.login.perIp.windowMs };
      this.failures.set(address, entry);
    }
    entry.count += 1;
    if (this.globalFailures.resetAt <= now) this.globalFailures = { count: 0, resetAt: now + this.login.global.windowMs };
    this.globalFailures.count += 1;
  }

  /**
   * One login attempt. Returns { ok: true, id, csrf, expiresAt } (the id is shown here and nowhere else), or
   * { ok: false, status: 401 } for a wrong token, or { ok: false, status: 429, retryAfter } when a throttle is active.
   */
  attempt(candidate, address) {
    const now = this.now();
    const wait = this.#blocked(address, now);
    if (wait) return { ok: false, status: 429, retryAfter: wait };
    const good = typeof candidate === 'string' && candidate.length > 0 && candidate.length <= MAX_TOKEN_INPUT && timingSafeEqual(digest(candidate), this.tokenDigest);
    if (!good) {
      this.#recordFailure(address, now);
      return { ok: false, status: 401 };
    }
    this.failures.delete(address);
    this.sweep();
    while (this.sessions.size >= this.limits.maxSessions) {
      let oldest = null;
      for (const [key, session] of this.sessions) if (!oldest || session.lastSeen < oldest.lastSeen) oldest = { key, lastSeen: session.lastSeen };
      this.sessions.delete(oldest.key);
    }
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const expiresAt = now + this.limits.absoluteMs;
    this.sessions.set(digest(id).toString('hex'), { csrf, createdAt: now, lastSeen: now, expiresAt, address });
    return { ok: true, id, csrf, expiresAt };
  }

  /** Set-Cookie value for a fresh session. */
  cookieFor(id, expiresAt) {
    const maxAge = Math.max(1, Math.floor((expiresAt - this.now()) / 1000));
    return `${this.cookie.name}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.cookie.secure ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${this.cookie.name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${this.cookie.secure ? '; Secure' : ''}`;
  }

  stats() { return { sessions: this.sessions.size, trackedAddresses: this.failures.size, globalFailures: this.globalFailures.resetAt > this.now() ? this.globalFailures.count : 0 }; }
}
