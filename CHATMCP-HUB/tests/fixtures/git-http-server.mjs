// A small Git smart-HTTP server for tests: Node's http module in front of `git http-backend` (the CGI program that ships with Git).
// It lets the workspace tests clone from and push to a real server over a real HTTP connection without leaving the machine, and
// records every request so that a test can say which requests carried a credential and which never arrived.
//
//   const server = await startGitHttpServer({ root, token: 'secret', privateRepos: ['octo/private.git'] });
//   server.origin           http://127.0.0.1:PORT
//   server.requests         [{ method, path, query, authorization, authorized, status }]
//   await server.close()
//
// Reading a repository named in `privateRepos` needs the token; pushing (git-receive-pack) always needs it when a token is set.
// The token travels the way GitHub expects it from a Git client: Basic base64("x-access-token:<token>").
import { execFile, spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_BODY = 64 * 1024 * 1024;
// An empty file stands in for "no configuration" (Git for Windows does not reliably accept the null device there).
const EMPTY_CONFIG = path.join(os.tmpdir(), `chatmcp-fixture-empty-${process.pid}.cfg`);
fsSync.writeFileSync(EMPTY_CONFIG, '');
process.once('exit', () => { try { fsSync.unlinkSync(EMPTY_CONFIG); } catch { /* already gone */ } });

/** Path of git-http-backend, or null when this Git does not have it. */
export async function findHttpBackend() {
  try {
    const { stdout } = await run('git', ['--exec-path']);
    const directory = stdout.trim();
    for (const name of ['git-http-backend', 'git-http-backend.exe']) {
      const candidate = path.join(directory, name);
      try { await fs.access(candidate); return candidate; } catch { /* next */ }
    }
  } catch { /* no git */ }
  return null;
}

/** Environment for the Git commands a test runs itself: no user or system configuration, a fixed identity. */
export function isolatedGitEnv(extra = {}) {
  const base = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'PATHEXT', 'COMSPEC']) if (process.env[name] !== undefined) base[name] = process.env[name];
  return {
    ...base,
    HOME: os.tmpdir(), USERPROFILE: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@fixture.invalid', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@fixture.invalid',
    LC_ALL: 'C', ...extra,
  };
}

export async function git(args, { cwd, env = {}, input } = {}) {
  const pending = run('git', args, { cwd, env: isolatedGitEnv(env), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  if (input !== undefined) pending.child.stdin.end(input);
  const { stdout } = await pending;
  return stdout;
}

/**
 * Creates <root>/<name> as a bare repository whose `main` branch holds `commits` (each { files: {path: text}, message }), plus the
 * extra branches in `branches` (name -> commits made on top of main). Returns the sha of every branch tip.
 */
export async function createBareRepo(root, name, { commits, branches = {} }) {
  const bare = path.join(root, name);
  await fs.mkdir(bare, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', '--', bare]);
  await git(['-C', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  await git(['-C', bare, 'config', 'http.receivepack', 'true']);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-work-'));
  try {
    await git(['init', '--initial-branch=main', '--', work]);
    const apply = async (list) => {
      for (const commit of list) {
        for (const [file, text] of Object.entries(commit.files ?? {})) {
          const target = path.join(work, file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, text);
        }
        await git(['-C', work, 'add', '-A']);
        await git(['-C', work, 'commit', '-q', '--allow-empty', '-m', commit.message ?? 'commit']);
      }
    };
    await apply(commits);
    const tips = { main: (await git(['-C', work, 'rev-parse', 'HEAD'])).trim() };
    await git(['-C', work, 'push', '-q', bare, 'main:refs/heads/main']);
    for (const [branch, list] of Object.entries(branches)) {
      await git(['-C', work, 'checkout', '-q', '-b', branch, 'main']);
      await apply(list);
      tips[branch] = (await git(['-C', work, 'rev-parse', 'HEAD'])).trim();
      await git(['-C', work, 'push', '-q', bare, `${branch}:refs/heads/${branch}`]);
      await git(['-C', work, 'checkout', '-q', 'main']);
    }
    await fs.writeFile(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
    return tips;
  } finally { await fs.rm(work, { recursive: true, force: true }).catch(() => {}); }
}

function parseCgi(buffer) {
  const text = buffer.toString('latin1');
  let end = text.indexOf('\r\n\r\n');
  let skip = 4;
  if (end < 0) { end = text.indexOf('\n\n'); skip = 2; }
  if (end < 0) return null;
  const head = text.slice(0, end).split(/\r?\n/);
  let status = 200;
  const headers = {};
  for (const line of head) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200; else headers[name] = value;
  }
  return { status, headers, bodyStart: end + skip };
}

export async function startGitHttpServer({ root, token = null, privateRepos = [], host = '127.0.0.1', port = 0 } = {}) {
  const backend = await findHttpBackend();
  if (!backend) throw new Error('git-http-backend is not available');
  const expected = token ? `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` : null;
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(chunk); });
    req.on('error', () => {});
    req.on('end', () => {
      const url = new URL(req.url, `http://${host}`);
      const pathname = decodeURIComponent(url.pathname);
      const record = { method: req.method, path: pathname, query: url.search.replace(/^\?/, ''), authorization: req.headers.authorization ?? null, authorized: false, status: 0 };
      requests.push(record);
      const presented = String(req.headers.authorization ?? '');
      const authorized = Boolean(expected) && presented.replace(/^basic\s/i, 'Basic ') === expected;
      record.authorized = authorized;
      const repoName = pathname.replace(/^\/+/, '').replace(/\/(?:info\/refs|git-upload-pack|git-receive-pack)$/, '');
      const writes = pathname.endsWith('/git-receive-pack') || url.search.includes('service=git-receive-pack');
      const needsAuth = Boolean(expected) && (writes || privateRepos.includes(repoName));
      if (needsAuth && !authorized) {
        record.status = 401;
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"', 'Content-Type': 'text/plain' });
        res.end('authentication required');
        return;
      }
      const body = Buffer.concat(chunks);
      const env = {
        PATH: process.env.PATH ?? process.env.Path ?? '', SystemRoot: process.env.SystemRoot ?? '', GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method, PATH_INFO: pathname, QUERY_STRING: url.search.replace(/^\?/, ''), CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(body.length), REMOTE_ADDR: '127.0.0.1', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: req.headers['git-protocol'] ?? '', HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
        ...(authorized ? { REMOTE_USER: 'x-access-token' } : {}),
      };
      const child = spawn(backend, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const out = [];
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end(body);
      child.once('error', () => { record.status = 500; res.writeHead(500); res.end('backend failed'); });
      child.once('close', () => {
        const buffer = Buffer.concat(out);
        const parsed = parseCgi(buffer);
        if (!parsed) { record.status = 502; res.writeHead(502); res.end('bad CGI response'); return; }
        record.status = parsed.status;
        res.writeHead(parsed.status, parsed.headers);
        res.end(buffer.subarray(parsed.bodyStart));
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actualPort = server.address().port;
  return {
    host, port: actualPort, hostPort: `${host}:${actualPort}`, origin: `http://${host}:${actualPort}`, root, requests,
    async close() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}

// Run directly, the fixture serves <root> until it is stopped: node tests/fixtures/git-http-server.mjs <root> [port]
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invoked && process.argv[2]) {
  const served = await startGitHttpServer({ root: path.resolve(process.argv[2]), port: Number(process.argv[3] ?? 0), token: process.env.FIXTURE_TOKEN || null });
  console.log(`serving ${served.root} at ${served.origin}`);
}
