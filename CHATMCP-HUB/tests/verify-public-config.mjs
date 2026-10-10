// Public-mode configuration (lib/public-config.mjs): what the Hub accepts before it opens a port on the Internet, and what it refuses.
//
// The rule being tested is "a mistake never produces an open Hub": no token, a weak token, no host name, a typo in a flag, or a bind
// to a non-loopback address without public mode must each stop the start with a specific, secret-free message.
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  checkOwnerToken, describePublicConfig, hostAllowed, isLoopbackHost, normalizeHostHeader, originAllowed, PublicConfigError, resolvePublicConfig, truthyEnv,
} from '../lib/public-config.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const TOKEN = 'k3Jf8Qm2Zx9LpA7vRt5YbN1cWd6HsE0uGiO4TaXe3Mw='; // 44 characters, the shape of Render's generateValue
const RENDER = { RENDER: 'true', RENDER_EXTERNAL_HOSTNAME: 'chatmcp-abc123.onrender.com', CHATMCP_PUBLIC: '1', CHATMCP_OWNER_TOKEN: TOKEN, PORT: '10000' };
const STATE = '/var/lib/chatmcp/state';
const resolve = (env, options = {}) => resolvePublicConfig(env, { stateDir: STATE, ...options });

function refused(env, code, label, options) {
  let error = null;
  try { resolve(env, options); } catch (caught) { error = caught; }
  assert.ok(error instanceof PublicConfigError, `${label}: expected PublicConfigError, got ${error}`);
  assert.equal(error.code, code, `${label}: code ${error.code} (${error.message})`);
  for (const secret of [env.CHATMCP_OWNER_TOKEN, env.GITHUB_TOKEN, env.CHATMCP_MASTER_KEY]) {
    if (secret && secret.length >= 8) assert.ok(!error.message.includes(secret), `${label}: the message leaks a secret`);
  }
  return error;
}

// ---------------------------------------------------------------------------------------------------------------- off by default
{
  const off = resolvePublicConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.host, '127.0.0.1');
  assert.equal(resolvePublicConfig({ CHATMCP_PUBLIC: '0' }).enabled, false);
  assert.equal(resolvePublicConfig({ CHATMCP_PUBLIC: '' }).enabled, false);
  for (const loopback of ['127.0.0.1', 'localhost', '::1', '127.8.8.8']) assert.equal(resolvePublicConfig({}, { host: loopback }).host, loopback);
  ok('public mode is off by default and keeps the loopback bind of Phase 1');
}

// ---------------------------------------------------------------------------------------------------------------- no open Hub by accident
{
  for (const host of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.5', 'example.com', 'localhost.evil.com', '127.0.0.1.evil.com']) {
    refused({}, 'public_required', `bind ${host} without public mode`, { host });
    refused({ CHATMCP_HOST: host }, 'public_required', `CHATMCP_HOST=${host} without public mode`);
  }
  refused({ CHATMCP_PUBLIC: 'ture' }, 'bad_flag', 'a typo in CHATMCP_PUBLIC must not be read as "off"');
  refused({ CHATMCP_PUBLIC: '2' }, 'bad_flag', 'CHATMCP_PUBLIC=2');
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost(undefined), false);
  ok('a non-loopback bind without CHATMCP_PUBLIC=1 stops the Hub; an unreadable flag stops it too');
}

// ---------------------------------------------------------------------------------------------------------------- the login secret
{
  const base = { ...RENDER };
  delete base.CHATMCP_OWNER_TOKEN;
  refused(base, 'owner_token_missing', 'no token');
  refused({ ...base, CHATMCP_OWNER_TOKEN: '' }, 'owner_token_missing', 'empty token');
  refused({ ...base, CHATMCP_OWNER_TOKEN: 'short-secret-1' }, 'owner_token_too_short', 'short token');
  refused({ ...base, CHATMCP_OWNER_TOKEN: 'a'.repeat(40) }, 'owner_token_low_variety', 'one repeated character');
  refused({ ...base, CHATMCP_OWNER_TOKEN: 'abababababababababababababababab' }, 'owner_token_low_variety', 'two characters repeated');
  refused({ ...base, CHATMCP_OWNER_TOKEN: `${TOKEN} extra` }, 'owner_token_whitespace', 'space inside the token');
  refused({ ...base, CHATMCP_OWNER_TOKEN: `${TOKEN}\n` }, 'owner_token_whitespace', 'trailing newline');
  refused({ ...base, CHATMCP_OWNER_TOKEN: `${TOKEN}${'x'.repeat(600)}` }, 'owner_token_too_long', 'absurdly long token');
  assert.equal(checkOwnerToken(TOKEN).ok, true);
  assert.equal(checkOwnerToken('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6').ok, true, 'exactly 32 characters with enough variety is accepted');
  assert.equal(checkOwnerToken('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p').ok, false, '31 characters is not');
  assert.equal(checkOwnerToken(undefined).ok, false);
  assert.equal(checkOwnerToken(12345678).ok, false);
  ok('the owner token must be present, 32+ characters, 12+ different characters, without whitespace; messages never contain it');
}

// ---------------------------------------------------------------------------------------------------------------- host names
{
  const noHost = { ...RENDER };
  delete noHost.RENDER_EXTERNAL_HOSTNAME;
  refused(noHost, 'allowed_hosts_missing', 'no host name at all');
  for (const bad of ['evil.com/path', 'a,b.com/x', '-x.example.com', '*.onrender.com', 'exa_mple.com', 'https://x.example.com', 'x.example.com:99999999', 'x@example.com']) {
    refused({ ...RENDER, CHATMCP_ALLOWED_HOSTS: bad }, 'bad_host', `host ${bad}`);
  }
  const spaced = resolve({ ...RENDER, CHATMCP_ALLOWED_HOSTS: 'one.example.org two.example.org\tthree.example.org' });
  assert.deepEqual([...spaced.allowedHosts].sort(), ['chatmcp-abc123.onrender.com', 'one.example.org', 'three.example.org', 'two.example.org'], 'a list may be separated by commas or white space');
  const two = resolve({ ...RENDER, CHATMCP_ALLOWED_HOSTS: 'Studio.Example.org, localhost:10000' });
  assert.deepEqual([...two.allowedHosts].sort(), ['chatmcp-abc123.onrender.com', 'localhost:10000', 'studio.example.org']);
  assert.ok(two.origins.has('https://studio.example.org') && !two.origins.has('http://studio.example.org'));
  ok('at least one valid host name is required; wildcards, paths, schemes and credentials are refused');
}

// ---------------------------------------------------------------------------------------------------------------- a Render-shaped configuration
{
  const config = resolve(RENDER, { port: 10000 });
  assert.equal(config.enabled, true);
  assert.equal(config.host, '0.0.0.0', 'public mode binds every interface by default (Render requires 0.0.0.0)');
  assert.equal(config.port, 10000);
  assert.equal(config.requireHttps, true);
  assert.equal(config.cookie.name, '__Host-chatmcp_session');
  assert.equal(config.cookie.secure, true);
  assert.equal(config.trustedProxyHops, 2, 'default on Render');
  assert.equal(config.session.idleMs, 3_600_000);
  assert.equal(config.session.absoluteMs, 43_200_000);
  assert.equal(config.session.maxSessions, 5);
  assert.deepEqual({ ...config.login.perIp }, { max: 5, windowMs: 900_000 });
  assert.equal(config.login.global.max, 40);
  assert.equal(config.login.failureDelayMs, 400);
  assert.equal(config.workspaces.root, path.resolve('/var/lib/chatmcp/workspaces'), 'derived from the state directory');
  assert.equal(config.workspaces.max, 3);
  assert.equal(config.workspaces.maxCloneBytes, 200 * 1024 * 1024);
  assert.deepEqual([...config.workspaces.gitHosts], ['github.com']);
  assert.equal(config.workspaces.githubToken, null);
  assert.equal(config.exec.mode, 'no-shell', 'without the supervisor no command runs');
  assert.equal(config.exec.commandMaxSeconds, 300);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.login) && Object.isFrozen(config.workspaces));
  const notOnRender = resolve({ ...RENDER, RENDER: '' });
  assert.equal(notOnRender.trustedProxyHops, 0, 'no proxy is assumed outside Render, so a spoofed X-Forwarded-For is not believed');
  assert.equal(resolve({ ...RENDER, CHATMCP_TRUSTED_PROXY_HOPS: '1' }).trustedProxyHops, 1);
  assert.equal(resolve({ ...RENDER, CHATMCP_HOST: '127.0.0.1' }).host, '127.0.0.1', 'public mode behind a tunnel may stay on loopback');
  ok('a Render-shaped environment yields the documented defaults (HTTPS only, __Host- cookie, 2 proxy hops, github.com only)');
}

// ---------------------------------------------------------------------------------------------------------------- insecure mode is explicit and only for tests
{
  const config = resolve({ ...RENDER, CHATMCP_ALLOW_INSECURE_HTTP: '1', CHATMCP_ALLOWED_HOSTS: 'localhost:10000' });
  assert.equal(config.requireHttps, false);
  assert.equal(config.cookie.name, 'chatmcp_session', 'the __Host- prefix needs Secure, which needs HTTPS');
  assert.equal(config.cookie.secure, false);
  assert.ok(config.origins.has('http://localhost:10000') && config.origins.has('https://localhost:10000'));
  refused({ ...RENDER, CHATMCP_ALLOW_INSECURE_HTTP: 'maybe' }, 'bad_flag', 'insecure flag typo');
  ok('plain HTTP needs CHATMCP_ALLOW_INSECURE_HTTP=1 and changes the cookie name and flags accordingly');
}

// ---------------------------------------------------------------------------------------------------------------- Host and Origin matching
{
  const config = resolve({ ...RENDER, CHATMCP_ALLOWED_HOSTS: 'localhost:10000' });
  const good = 'chatmcp-abc123.onrender.com';
  for (const header of [good, good.toUpperCase(), `${good}.`, `${good}:443`, 'localhost:10000']) assert.equal(hostAllowed(config, header), true, header);
  for (const header of [`${good}:8443`, `${good}:80`, 'localhost', 'localhost:10001', `${good}.evil.com`, `evil-${good}`, `evil.com#${good}`, `${good}\r\nX-Evil: 1`,
    `${good} `.repeat(2), '', ' ', undefined, null, 42, ['x'], '127.0.0.1:10000', '[::1]:10000', `${good}/`, `@${good}`, 'chatmcp-abc123.onrender.com:443:443', 'ｃｈａｔｍｃｐ-abc123.onrender.com']) {
    assert.equal(hostAllowed(config, header), false, JSON.stringify(header));
  }
  assert.equal(normalizeHostHeader('Example.COM.'), 'example.com');
  assert.equal(normalizeHostHeader('x'.repeat(300)), null);
  for (const origin of [`https://${good}`, `HTTPS://${good.toUpperCase()}`, `https://${good}:443`, 'https://localhost:10000']) assert.equal(originAllowed(config, origin), true, origin);
  for (const origin of [`http://${good}`, 'null', 'https://evil.com', `https://${good}.evil.com`, `https://${good}/`, `https://${good}:8443`, `https://user@${good}`, '', undefined, null, `chrome-extension://${'a'.repeat(32)}`, 'http://localhost:10000']) {
    assert.equal(originAllowed(config, origin), false, JSON.stringify(origin));
  }
  ok('Host and Origin matching: exact host (case, trailing dot and :443 tolerated), nothing else — no suffix tricks, no header injection, no http without the insecure flag');
}

// ---------------------------------------------------------------------------------------------------------------- command execution mode
{
  refused({ ...RENDER, CHATMCP_EXEC_MODE: 'same-user' }, 'unsafe_exec_not_confirmed', 'same-user without confirmation');
  assert.equal(resolve({ ...RENDER, CHATMCP_EXEC_MODE: 'same-user', CHATMCP_UNSAFE_SAME_USER_EXEC: '1' }).exec.mode, 'same-user');
  refused({ ...RENDER, CHATMCP_EXEC_MODE: 'broker' }, 'exec_broker_missing', 'broker without a socket');
  refused({ ...RENDER, CHATMCP_EXEC_MODE: 'broker', CHATMCP_EXEC_BROKER: 'relative/exec.sock' }, 'exec_broker_missing', 'relative socket path');
  refused({ ...RENDER, CHATMCP_EXEC_MODE: 'root' }, 'bad_exec_mode', 'unknown mode');
  const broker = resolve({ ...RENDER, CHATMCP_EXEC_MODE: 'broker', CHATMCP_EXEC_BROKER: '/run/chatmcp/exec.sock' });
  assert.equal(broker.exec.mode, 'broker');
  assert.equal(broker.exec.broker, '/run/chatmcp/exec.sock');
  ok('command execution: broker needs its socket; same-user needs an explicit unsafe confirmation; unknown modes are refused');
}

// ---------------------------------------------------------------------------------------------------------------- workspaces and Git
{
  refused({ ...RENDER, CHATMCP_WORKSPACES_ROOT: 'work/space' }, 'workspaces_root', 'relative workspace root');
  refused({ ...RENDER, CHATMCP_WORKSPACES_ROOT: '/' }, 'workspaces_root', 'workspace root = /');
  assert.equal(resolve({ ...RENDER, CHATMCP_WORKSPACES_ROOT: '/data/ws/' }).workspaces.root, path.resolve('/data/ws'));
  for (const bad of ['localhost', 'github.com/evil', '*.com', 'a b', 'git@github.com', '']) {
    if (bad === '') continue; // an empty value falls back to the default
    refused({ ...RENDER, CHATMCP_GIT_ALLOWED_HOSTS: bad }, 'bad_git_hosts', `git host ${bad}`);
  }
  assert.deepEqual([...resolve({ ...RENDER, CHATMCP_GIT_ALLOWED_HOSTS: 'GitHub.com, gitlab.com' }).workspaces.gitHosts], ['github.com', 'gitlab.com']);
  const GH = 'github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  assert.equal(resolve({ ...RENDER, GITHUB_TOKEN: GH }).workspaces.githubToken, GH);
  refused({ ...RENDER, GITHUB_TOKEN: 'ghp_short' }, 'bad_github_token', 'short GitHub token');
  refused({ ...RENDER, GITHUB_TOKEN: `${GH} ${GH}` }, 'bad_github_token', 'GitHub token with a space');
  for (const [name, value] of [['CHATMCP_MAX_WORKSPACES', '0'], ['CHATMCP_MAX_WORKSPACES', 'abc'], ['CHATMCP_MAX_WORKSPACES', '21'], ['CHATMCP_MAX_CLONE_MB', '5'], ['CHATMCP_TRUSTED_PROXY_HOPS', '9'],
    ['CHATMCP_LOGIN_MAX_FAILURES_PER_IP', '0'], ['CHATMCP_COMMAND_MAX_SECONDS', '5000'], ['CHATMCP_SESSION_IDLE_SECONDS', '1.5']]) {
    refused({ ...RENDER, [name]: value }, 'bad_number', `${name}=${value}`);
  }
  ok('workspace root, Git host list, GitHub token shape and numeric limits are validated');
}

// ---------------------------------------------------------------------------------------------------------------- nothing secret in what can be logged
{
  const GH = 'github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const config = resolve({ ...RENDER, GITHUB_TOKEN: GH, CHATMCP_AI_PRESET: 'gemini' });
  const text = JSON.stringify(describePublicConfig(config));
  assert.ok(!text.includes(TOKEN) && !text.includes(GH), 'the summary contains neither secret');
  assert.match(text, /"githubToken":"đã đặt"/);
  assert.match(text, /chatmcp-abc123\.onrender\.com/);
  assert.deepEqual(describePublicConfig(resolvePublicConfig({})), { enabled: false });
  assert.equal(truthyEnv('YES'), true);
  assert.equal(truthyEnv(' off '), false);
  ok('describePublicConfig() is safe to log (secrets are reported as "đã đặt" / absent)');
}

console.log(`PASS: ${checks} public-config checks (defaults, refusals, host/origin matching, secret hygiene)`);
