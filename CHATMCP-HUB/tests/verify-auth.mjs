// The owner login of public mode (lib/auth.mjs), driven with a fake clock: sessions, CSRF, expiry, throttling, address handling.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OwnerAuth, clientAddress, constantTimeEqual, normalizeAddress, parseCookies } from '../lib/auth.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const TOKEN = 'k3Jf8Qm2Zx9LpA7vRt5YbN1cWd6HsE0uGiO4TaXe3Mw=';
const MINUTE = 60_000;
let clock = 1_000_000;
const make = (overrides = {}) => new OwnerAuth({
  token: TOKEN,
  cookie: { name: '__Host-chatmcp_session', secure: true },
  session: { idleMs: 60 * MINUTE, absoluteMs: 12 * 60 * MINUTE, maxSessions: 3 },
  login: { perIp: { max: 5, windowMs: 15 * MINUTE }, global: { max: 12, windowMs: 15 * MINUTE }, failureDelayMs: 0 },
  trustedProxyHops: 0,
  now: () => clock,
  ...overrides,
});
const withCookie = (id, extra = {}) => ({ headers: { cookie: `__Host-chatmcp_session=${id}`, ...extra }, socket: { remoteAddress: '203.0.113.9' } });
const sha = (text) => createHash('sha256').update(text).digest('hex');
// Same length, one character different (never equal to the input, whatever its last character is).
const tamper = (text) => `${text.slice(0, -1)}${text.endsWith('A') ? 'B' : 'A'}`;

// ---------------------------------------------------------------------------------------------------------------- comparison
{
  assert.equal(constantTimeEqual(TOKEN, TOKEN), true);
  assert.equal(constantTimeEqual(TOKEN, `${TOKEN}x`), false);
  assert.equal(constantTimeEqual(TOKEN, TOKEN.slice(0, -1)), false);
  assert.equal(constantTimeEqual('', TOKEN), false);
  assert.equal(constantTimeEqual('a'.repeat(5000), TOKEN), false, 'lengths never make the comparison throw');
  ok('constantTimeEqual compares through a digest, so any lengths are safe');
}

// ---------------------------------------------------------------------------------------------------------------- login and session
{
  const auth = make();
  const login = auth.attempt(TOKEN, '198.51.100.7');
  assert.equal(login.ok, true);
  assert.match(login.id, /^[A-Za-z0-9_-]{43}$/, '256 random bits as base64url');
  assert.match(login.csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(login.id, login.csrf);
  assert.equal(login.expiresAt, clock + 12 * 60 * MINUTE);
  assert.ok(![...auth.sessions.keys()].includes(login.id), 'the session id itself is not what is stored');
  assert.ok(auth.sessions.has(sha(login.id)), 'its SHA-256 is');
  assert.ok(!JSON.stringify([...auth.sessions.values()]).includes(login.id), 'nor does any stored value contain it');

  const session = auth.sessionFor(withCookie(login.id));
  assert.ok(session && session.csrf === login.csrf);
  assert.equal(auth.sessionFor(withCookie(tamper(login.id))), null, 'a guessed neighbour of a real id');
  assert.equal(auth.sessionFor(withCookie('short')), null);
  assert.equal(auth.sessionFor(withCookie(login.id.slice(0, 42))), null);
  assert.equal(auth.sessionFor({ headers: {}, socket: {} }), null, 'no cookie');
  assert.equal(auth.sessionFor({ headers: { cookie: `chatmcp_session=${login.id}` }, socket: {} }), null, 'the cookie of another name (no __Host- prefix) is not accepted');
  assert.equal(auth.sessionFor({ headers: { cookie: `x=1; __Host-chatmcp_session=${login.id}; y=2` }, socket: {} })?.csrf, login.csrf, 'among other cookies');
  assert.equal(auth.sessionFor({ headers: { cookie: `__Host-chatmcp_session=bogus; __Host-chatmcp_session=${login.id}` }, socket: {} }), null, 'the first cookie of that name wins, so a planted duplicate cannot select a session');
  ok('login issues a 256-bit session id kept only as a hash; lookups reject malformed, foreign and duplicated cookies');

  assert.equal(auth.csrfOk(session, login.csrf), true);
  assert.equal(auth.csrfOk(session, tamper(login.csrf)), false);
  assert.equal(auth.csrfOk(session, login.csrf.slice(0, -1)), false);
  assert.equal(auth.csrfOk(session, undefined), false);
  assert.equal(auth.csrfOk(session, ['x']), false);
  assert.equal(auth.csrfOk(null, login.csrf), false);
  const second = auth.attempt(TOKEN, '198.51.100.7');
  assert.notEqual(second.csrf, login.csrf, 'every session has its own CSRF token');
  assert.equal(auth.csrfOk(session, second.csrf), false, 'the CSRF token of one session is no good for another');
  ok('the CSRF token is per session and compared in constant time');

  auth.destroy(session);
  assert.equal(auth.sessionFor(withCookie(login.id)), null, 'logout ends the session');
  auth.close();
}

// ---------------------------------------------------------------------------------------------------------------- expiry
{
  const auth = make();
  const login = auth.attempt(TOKEN, '198.51.100.7');
  clock += 59 * MINUTE;
  assert.ok(auth.sessionFor(withCookie(login.id)), 'still inside the idle window');
  clock += 59 * MINUTE;
  assert.ok(auth.sessionFor(withCookie(login.id)), 'every use pushes the idle limit back');
  clock += 61 * MINUTE;
  assert.equal(auth.sessionFor(withCookie(login.id)), null, 'idle for an hour ends it');
  assert.equal(auth.sessions.size, 0, 'and it is forgotten');

  const long = auth.attempt(TOKEN, '198.51.100.7');
  for (let minute = 50; minute < 720; minute += 50) { clock += 50 * MINUTE; assert.ok(auth.sessionFor(withCookie(long.id)), `used every 50 minutes, minute ${minute}`); }
  clock += 30 * MINUTE; // minute 730: 30 minutes since the last use, but past the 12 hours since login
  assert.equal(auth.sessionFor(withCookie(long.id)), null, 'activity cannot extend a session past the absolute 12 hours');
  auth.close();
  ok('idle expiry (60 min) and absolute expiry (12 h) both end a session; use extends only the first');
}

// ---------------------------------------------------------------------------------------------------------------- session cap
{
  const auth = make();
  const ids = [];
  for (let i = 0; i < 3; i += 1) { clock += 1000; ids.push(auth.attempt(TOKEN, `198.51.100.${i + 1}`).id); }
  clock += 1000;
  assert.ok(auth.sessionFor(withCookie(ids[0])), 'touch the oldest one, so another is now the least recently used');
  clock += 1000;
  const fourth = auth.attempt(TOKEN, '198.51.100.9');
  assert.equal(auth.sessions.size, 3, 'at most maxSessions');
  assert.equal(auth.sessionFor(withCookie(ids[1])), null, 'the least recently used session was dropped');
  assert.ok(auth.sessionFor(withCookie(ids[0])) && auth.sessionFor(withCookie(ids[2])) && auth.sessionFor(withCookie(fourth.id)));
  auth.close();
  ok('a new login beyond the cap drops the least recently used session instead of failing');
}

// ---------------------------------------------------------------------------------------------------------------- throttling
{
  const auth = make();
  const bad = '198.51.100.20';
  for (let i = 1; i <= 5; i += 1) assert.deepEqual({ ...auth.attempt(`wrong-${i}`, bad) }, { ok: false, status: 401 });
  const blocked = auth.attempt(TOKEN, bad);
  assert.equal(blocked.status, 429, 'the sixth attempt is refused even though the token is right');
  assert.equal(blocked.retryAfter, 900);
  clock += 10 * MINUTE;
  assert.equal(auth.attempt(TOKEN, bad).retryAfter, 300, 'Retry-After counts down');
  assert.equal(auth.attempt(TOKEN, '198.51.100.21').ok, true, 'another address is not affected');
  clock += 5 * MINUTE;
  assert.equal(auth.attempt(TOKEN, bad).ok, true, 'after the window the owner can log in again');
  for (let i = 1; i <= 4; i += 1) auth.attempt('nope', bad);
  assert.equal(auth.attempt(TOKEN, bad).ok, true, 'a success resets the address counter');
  for (let i = 1; i <= 5; i += 1) auth.attempt('nope', bad);
  assert.equal(auth.attempt(TOKEN, bad).status, 429);
  auth.close();
  ok('5 wrong tokens per address block that address for the window — even for the right token — and a success resets it');
}

{
  const auth = make();
  // 12 failures from 12 different (forged) addresses use up the global allowance without any single address reaching its own limit.
  for (let i = 0; i < 12; i += 1) assert.equal(auth.attempt('guess', `192.0.2.${i + 1}`).status, 401);
  const refused = auth.attempt(TOKEN, '192.0.2.200');
  assert.equal(refused.status, 429, 'a fresh address is refused once the global allowance is gone');
  assert.ok(refused.retryAfter > 0 && refused.retryAfter <= 900);
  assert.equal(auth.stats().globalFailures, 12);
  clock += 15 * MINUTE + 1;
  assert.equal(auth.attempt(TOKEN, '192.0.2.200').ok, true, 'the allowance returns with the window');
  assert.equal(auth.stats().globalFailures, 0);
  auth.close();
  ok('forged addresses cannot evade the limit: a global allowance applies across all of them');
}

{
  const auth = make();
  for (const value of [undefined, null, 12345, {}, [], true, '', 'a'.repeat(5000), `${TOKEN}\n`, ` ${TOKEN}`]) {
    const result = auth.attempt(value, `203.0.113.${Math.floor(Math.random() * 200)}`);
    assert.equal(result.ok, false, JSON.stringify(value)?.slice(0, 40));
  }
  assert.equal(auth.sessions.size, 0);
  const many = make();
  for (let i = 0; i < 7000; i += 1) many.attempt('x', `10.${i >> 8 & 255}.${i & 255}.1`);
  assert.ok(many.stats().trackedAddresses <= 5000, 'the table of addresses has a bound');
  many.close(); auth.close();
  ok('anything that is not exactly the token fails (including trailing whitespace); the failure table is bounded');
}

// ---------------------------------------------------------------------------------------------------------------- cookie text
{
  const auth = make();
  const login = auth.attempt(TOKEN, '1.1.1.1');
  const header = auth.cookieFor(login.id, login.expiresAt);
  assert.match(header, new RegExp(`^__Host-chatmcp_session=${login.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$`));
  assert.ok(!/Domain=/i.test(header), '__Host- cookies must not carry Domain');
  const gone = auth.clearCookie();
  assert.match(gone, /^__Host-chatmcp_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure$/);
  const insecure = make({ cookie: { name: 'chatmcp_session', secure: false } });
  const plain = insecure.cookieFor('x'.repeat(43), clock + 5000);
  assert.ok(!/Secure/.test(plain) && /HttpOnly/.test(plain) && /SameSite=Strict/.test(plain) && /Max-Age=5/.test(plain));
  auth.close(); insecure.close();
  ok('Set-Cookie: HttpOnly, SameSite=Strict, Path=/, no Domain, Secure (with the __Host- prefix) unless insecure HTTP was confirmed');
}

// ---------------------------------------------------------------------------------------------------------------- client address
{
  const request = (forwarded, peer = '10.0.0.1') => ({ headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }, socket: { remoteAddress: peer } });
  assert.equal(clientAddress(request('1.2.3.4, 5.6.7.8'), 0), '10.0.0.1', 'with no proxy of ours the header is ignored');
  assert.equal(clientAddress(request('9.9.9.9, 1.2.3.4, 5.6.7.8'), 2), '1.2.3.4', 'two hops: the second entry from the right');
  assert.equal(clientAddress(request('6.6.6.6, 6.6.6.7, 6.6.6.8, 1.2.3.4, 5.6.7.8'), 2), '1.2.3.4', 'anything the client put on the left is ignored');
  assert.equal(clientAddress(request('1.2.3.4'), 2), '10.0.0.1', 'a header shorter than the hop count falls back to the peer');
  assert.equal(clientAddress(request(undefined), 2), '10.0.0.1');
  assert.equal(clientAddress(request('not-an-ip, 5.6.7.8'), 2), '10.0.0.1', 'a value that is not an IP address is not used');
  assert.equal(clientAddress(request('1.2.3.4; evil, 5.6.7.8'), 2), '10.0.0.1');
  assert.equal(clientAddress(request(['7.7.7.7', '1.2.3.4, 5.6.7.8']), 2), '1.2.3.4', 'repeated headers are joined');
  assert.equal(clientAddress(request('::ffff:1.2.3.4, 5.6.7.8'), 2), '1.2.3.4', 'IPv4-mapped IPv6 is the IPv4 address');
  assert.equal(clientAddress({ headers: {}, socket: {} }, 0), 'unknown');
  assert.equal(normalizeAddress('2001:db8:1:2:3:4:5:6'), '2001:0db8:0001:0002::/64');
  assert.equal(normalizeAddress('2001:db8:1:2:ffff::1'), '2001:0db8:0001:0002::/64', 'one /64 is one client');
  assert.equal(normalizeAddress('2001:db8::1'), '2001:0db8:0000:0000::/64');
  assert.equal(normalizeAddress('garbage'), '');
  assert.deepEqual([...parseCookies('a=1; b=2; a=3; =x; novalue')], [['a', '1'], ['b', '2']]);
  ok('client address: only the entry the outermost proxy appended is believed; /64 grouping for IPv6; garbage falls back to the peer');
}

console.log(`PASS: ${checks} auth checks (sessions, CSRF, expiry, throttling, cookies, client address)`);
