// The MCP client SDK runtime (docs/MCP-CLIENT.md): pinned, staged, verified and loaded lazily.
//
//   1. Pins: lib/mcp/sdk.mjs, scripts/mcp-runtime/package.json, its lockfile and scripts/mcp-runtime/verify.mjs name the same client version; every
//      lockfile entry comes from the npm registry with an integrity and a licence; the shipped closure is the client's (no server SDK, no HTTP
//      server framework); the Hub itself keeps no runtime dependency, and no Hub module imports the SDK statically.
//   2. lib/mcp/sdk.mjs finds the runtime (CHATMCP_MCP_RUNTIME_DIR alone when set, else runtimes/mcp, else scripts/mcp-runtime), refuses a copy of
//      another version or with an export outside its package, and says `mcp_runtime_missing` when there is none; the manager reports it and
//      refuses to connect with that code.
//   3. A REAL Hub started without the runtime serves /api/health and reports mcp_runtime_missing in /api/state; with it, ready.
//   4. scripts/mcp-runtime/stage.mjs + verify.mjs: a staged copy passes; a changed byte, a stray file, a missing or consistently replaced licence
//      text, another client version and a reused destination are refused. scripts/Verify-McpRuntime.mjs connects the Hub's own code to a
//      server through the staged copy.
//   5. The packages compiled into the client's dist files are exactly those of scripts/mcp-runtime/licenses/MANIFEST.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MCP_CLIENT_VERSION, RUNTIME_DIR_ENV, defaultRuntimeRoots, loadMcpSdk, locateMcpRuntime } from '../lib/mcp/sdk.mjs';
import { McpClientManager } from '../lib/mcp/client-manager.mjs';
import { HUB, RUNTIME_INSTALL, runtimeRoot } from './support/mcp-tools.mjs';
import { startHub } from './e2e/hub-process.mjs';

const runtime = runtimeRoot();
if (!runtime) {
  console.log(`CHATMCP_TEST_SKIP: the MCP client SDK is not installed (run: ${RUNTIME_INSTALL})`);
  process.exit(0);
}
const scripts = runtime; // scripts/mcp-runtime of this checkout (or of the one a mutation copy was made from)
const { stageMcpRuntime } = await import(pathToFileURL(path.join(scripts, 'stage.mjs')).href);
const { verifyMcpRuntime, CLIENT_VERSION, MANIFEST_FILE } = await import(pathToFileURL(path.join(scripts, 'verify.mjs')).href);

let failures = 0;
let passed = 0;
async function test(name, body) {
  try { await body(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split('\n').slice(0, 6).join('\n  ')}`); }
}
const rejectsWith = async (promise, pattern, label) => {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, `${label}: expected a refusal`);
  assert.match(String(caught.code ?? caught.message), pattern, `${label}: ${caught.message}`);
  return caught;
};
const scratch = mkdtempSync(path.join(os.tmpdir(), 'datgold-mcp-runtime-'));
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

try {
  // ---------------------------------------------------------------------------------------------------------------------------------
  // 1. Pins
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('one client version everywhere: sdk.mjs, package.json, the lockfile, verify.mjs, the installed package', async () => {
    const manifest = json(path.join(scripts, 'package.json'));
    const lock = json(path.join(scripts, 'package-lock.json'));
    assert.deepEqual(Object.keys(manifest.dependencies), ['@modelcontextprotocol/client'], 'the runtime pins the client only (the node and server packages are server-side; tests/fixtures/mcp-reference has them)');
    assert.equal(manifest.dependencies['@modelcontextprotocol/client'], MCP_CLIENT_VERSION, 'an exact version, the one sdk.mjs accepts');
    assert.equal(lock.packages['node_modules/@modelcontextprotocol/client'].version, MCP_CLIENT_VERSION);
    assert.equal(CLIENT_VERSION, MCP_CLIENT_VERSION);
    assert.equal(json(path.join(scripts, 'node_modules', '@modelcontextprotocol', 'client', 'package.json')).version, MCP_CLIENT_VERSION, 'npm ci installed the pinned version');
  });

  await test('every lockfile entry is pinned (registry, integrity, licence); the closure is the client\'s', async () => {
    const lock = json(path.join(scripts, 'package-lock.json'));
    const entries = Object.entries(lock.packages).filter(([key]) => key);
    for (const [key, entry] of entries) {
      assert.ok(entry.version && /^sha512-/.test(entry.integrity) && entry.resolved?.startsWith('https://registry.npmjs.org/'), `${key} is pinned to the registry`);
      assert.ok(entry.license, `${key} names its licence`);
      assert.ok(!entry.dev, `${key} is not a devDependency`);
    }
    const names = entries.map(([key]) => key.slice('node_modules/'.length));
    for (const forbidden of ['@modelcontextprotocol/server', '@modelcontextprotocol/node', '@modelcontextprotocol/sdk', 'hono', '@hono/node-server', 'express']) assert.ok(!names.includes(forbidden), `${forbidden} is not shipped`);
    assert.equal(entries.length, 13, `the closure counted on 2026-11-20 (now ${entries.length}: update docs/MCP-CLIENT.md and this number together)`);
  });

  await test('the Hub keeps no runtime dependency and imports the SDK only dynamically, from lib/mcp/sdk.mjs', async () => {
    assert.equal(json(path.join(HUB, 'package.json')).dependencies, undefined, 'DATGOLD-HUB/package.json has no "dependencies"');
    const offenders = [];
    const walk = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.mjs') && /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]@modelcontextprotocol\//.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(HUB, file));
      }
    };
    walk(path.join(HUB, 'lib'));
    for (const file of ['hub.mjs']) if (/from\s*['"](?:\.\/)?lib\/mcp\//.test(readFileSync(path.join(HUB, file), 'utf8'))) offenders.push(`${file} imports lib/mcp`);
    assert.deepEqual(offenders, [], 'static imports of the SDK');
    const sdkSource = readFileSync(path.join(HUB, 'lib', 'mcp', 'sdk.mjs'), 'utf8');
    assert.match(sdkSource, /await Promise\.all\(\[import\(pathToFileURL\(located\.entries\.index\)/, 'sdk.mjs imports the SDK with import() of the located file');
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 2. Finding and loading
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('defaultRuntimeRoots: CHATMCP_MCP_RUNTIME_DIR alone when set, else runtimes/mcp then scripts/mcp-runtime', async () => {
    assert.deepEqual(defaultRuntimeRoots('/x/DATGOLD-HUB', {}), [path.join('/x/DATGOLD-HUB', 'runtimes', 'mcp'), path.join('/x/DATGOLD-HUB', '..', 'scripts', 'mcp-runtime')]);
    assert.deepEqual(defaultRuntimeRoots('/x/DATGOLD-HUB', { [RUNTIME_DIR_ENV]: '/elsewhere' }), [path.resolve('/elsewhere')]);
    assert.deepEqual(defaultRuntimeRoots('/x/DATGOLD-HUB', { [RUNTIME_DIR_ENV]: '   ' }).length, 2, 'a blank value is no override');
  });

  const empty = path.join(scratch, 'empty');
  mkdirSync(empty);
  await test('a missing runtime is `mcp_runtime_missing`; a wrong version or an export outside the package is `mcp_runtime_invalid`', async () => {
    assert.deepEqual(locateMcpRuntime([empty]), { state: 'missing', code: 'mcp_runtime_missing', roots: [empty] });
    await rejectsWith(loadMcpSdk({ roots: [empty] }), /^mcp_runtime_missing$/, 'loading from an empty folder');
    const fake = (name, manifest) => {
      const folder = path.join(scratch, name, 'node_modules', '@modelcontextprotocol', 'client');
      mkdirSync(path.join(folder, 'dist'), { recursive: true });
      writeFileSync(path.join(folder, 'package.json'), JSON.stringify(manifest));
      writeFileSync(path.join(folder, 'dist', 'index.mjs'), 'export const Client = 1;');
      writeFileSync(path.join(folder, 'dist', 'stdio.mjs'), 'export const DEFAULT_INHERITED_ENV_VARS = [];');
      // A cross-spawn that resolves, so that only the check of the classes can refuse this copy.
      const spawnFolder = path.join(scratch, name, 'node_modules', 'cross-spawn');
      mkdirSync(spawnFolder, { recursive: true });
      writeFileSync(path.join(spawnFolder, 'package.json'), JSON.stringify({ name: 'cross-spawn', version: '0.0.0', main: 'index.js' }));
      writeFileSync(path.join(spawnFolder, 'index.js'), 'module.exports = function spawn() {};');
      return path.join(scratch, name);
    };
    const exportsMap = { '.': { import: { default: './dist/index.mjs' } }, './stdio': { import: { default: './dist/stdio.mjs' } } };
    const older = fake('older', { name: '@modelcontextprotocol/client', version: '2.3.1', exports: exportsMap });
    assert.equal(locateMcpRuntime([older]).code, 'mcp_runtime_invalid', 'another version is refused');
    assert.equal(locateMcpRuntime([older, runtime]).code, 'mcp_runtime_invalid', 'the first copy found decides; a wrong one is not silently skipped');
    // ./../../../../evil.mjs from .../escaping/node_modules/@modelcontextprotocol/client is <scratch>/evil.mjs, a file that exists.
    writeFileSync(path.join(scratch, 'evil.mjs'), 'export const Client = 1;');
    const escaping = fake('escaping', { name: '@modelcontextprotocol/client', version: MCP_CLIENT_VERSION, exports: { ...exportsMap, '.': { import: { default: './../../../../evil.mjs' } } } });
    assert.equal(locateMcpRuntime([escaping]).code, 'mcp_runtime_invalid', 'an export that leaves the package is refused');
    const broken = fake('broken', { name: '@modelcontextprotocol/client', version: MCP_CLIENT_VERSION, exports: exportsMap });
    await rejectsWith(loadMcpSdk({ roots: [broken] }), /^mcp_runtime_invalid$/, 'a copy without the classes the Hub uses');
    assert.equal(locateMcpRuntime([empty, runtime]).state, 'ready', 'the next folder is tried when one has nothing');
  });

  await test('the real runtime loads once, with the parts the manager uses', async () => {
    const first = await loadMcpSdk({ roots: [runtime] });
    const second = await loadMcpSdk({ roots: [runtime] });
    assert.equal(first, second, 'imported once per folder');
    assert.equal(first.version, MCP_CLIENT_VERSION);
    for (const name of ['Client', 'StreamableHTTPClientTransport', 'ReadBuffer', 'serializeMessage', 'SdkError', 'spawn']) assert.equal(typeof first[name], 'function', name);
    assert.equal(first.SdkErrorCode.EraNegotiationFailed, 'ERA_NEGOTIATION_FAILED');
    assert.ok(first.inheritedEnvironment.includes('PATH'), 'the SDK allow-list of inherited variables');
  });

  await test('the manager reports mcp_runtime_missing and refuses to connect with that code', async () => {
    const manager = new McpClientManager({ hubDirectory: path.join(scratch, 'missing-hub'), runtimeRoots: [empty] });
    await manager.store.save('anything', { transport: 'stdio', command: process.execPath, args: ['-e', ''] });
    assert.deepEqual(manager.status().runtime, { state: 'missing', code: 'mcp_runtime_missing' });
    await rejectsWith(manager.connect('anything'), /^mcp_runtime_missing$/, 'connect without the runtime');
    assert.equal(manager.status().servers[0].lastError.code, 'mcp_runtime_missing');
    await manager.close();
    const ready = new McpClientManager({ hubDirectory: path.join(scratch, 'ready-hub'), runtimeRoots: [runtime] });
    assert.deepEqual(ready.status().runtime, { state: 'ready', version: MCP_CLIENT_VERSION });
    await ready.close();
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 3. A real Hub
  // ---------------------------------------------------------------------------------------------------------------------------------
  for (const [label, dir, expected] of [['without', empty, { state: 'missing', code: 'mcp_runtime_missing' }], ['with', runtime, { state: 'ready', version: MCP_CLIENT_VERSION }]]) {
    await test(`a real Hub started ${label} the MCP runtime serves /api/health and reports ${expected.code ?? expected.state} in /api/state`, async () => {
      const hubScratch = path.join(scratch, `hub-${label}`);
      const hub = await startHub({ scratch: hubScratch, env: { [RUNTIME_DIR_ENV]: dir } });
      try {
        const health = await fetch(`${hub.origin}/api/health`).then((response) => response.json());
        assert.equal(health.initialized, true);
        const state = await hub.state();
        assert.deepEqual(state.mcp.runtime, expected);
        assert.deepEqual(state.mcp.servers, [], 'no server is configured');
        assert.ok(!/Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/.test(hub.logText()), 'nothing tried to import the SDK at start');
      } finally { await hub.stop(); }
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 4. Staging
  // ---------------------------------------------------------------------------------------------------------------------------------
  const staged = path.join(scratch, 'staged');
  let summary = null;
  await test('stage.mjs copies the closure and the vendored texts; verify.mjs passes on it', async () => {
    summary = await stageMcpRuntime(staged, { source: scripts });
    assert.equal(summary.packages, 13);
    assert.equal(summary.bundled, 7);
    const verified = await verifyMcpRuntime(staged, { source: scripts });
    assert.equal(verified.verifiedFiles, summary.files);
    assert.equal(verified.bytes, summary.bytes);
    assert.ok(existsSync(path.join(staged, 'licenses', 'bundled', 'ajv@8.18.0', 'LICENSE')));
    console.log(`#   closure: ${summary.packages} packages, ${summary.files} files, ${summary.bytes} bytes (${(summary.bytes / 1024 / 1024).toFixed(1)} MiB), ${summary.bundled} compiled-in licence texts`);
    await rejectsWith(stageMcpRuntime(staged, { source: scripts }), /EEXIST/, 'a destination that exists');
  });

  const tampered = async (label, change, pattern) => {
    const copy = path.join(scratch, `tampered-${label.replace(/\W+/g, '-')}`);
    cpSync(staged, copy, { recursive: true });
    change(copy);
    await rejectsWith(verifyMcpRuntime(copy, { source: scripts }), pattern, label);
  };
  await test('verify.mjs refuses a changed byte, a stray file, a missing or replaced licence text and another client version', async () => {
    await tampered('a changed byte', (copy) => { const file = path.join(copy, 'node_modules', 'zod', 'package.json'); writeFileSync(file, `${readFileSync(file, 'utf8')} `); }, /Runtime integrity mismatch: node_modules\/zod\/package\.json/);
    await tampered('a stray file', (copy) => writeFileSync(path.join(copy, 'node_modules', 'extra.js'), 'x'), /File not in the runtime manifest: node_modules\/extra\.js/);
    await tampered('a missing package licence', (copy) => {
      rmSync(path.join(copy, 'node_modules', 'which', 'LICENSE'));
      const manifestFile = path.join(copy, MANIFEST_FILE);
      const manifest = json(manifestFile);
      manifest.files = manifest.files.filter((file) => file.path !== 'node_modules/which/LICENSE');
      writeFileSync(manifestFile, JSON.stringify(manifest));
    }, /carries no licence text: node_modules\/which/);
    await tampered('a compiled-in text replaced with its manifest entry', (copy) => {
      const relative = 'licenses/bundled/fast-uri@3.1.8/LICENSE';
      const text = 'Not the BSD text.\n';
      writeFileSync(path.join(copy, ...relative.split('/')), text);
      const manifestFile = path.join(copy, MANIFEST_FILE);
      const manifest = json(manifestFile);
      const entry = manifest.files.find((file) => file.path === relative);
      Object.assign(entry, { size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
      writeFileSync(manifestFile, JSON.stringify(manifest));
    }, /bundled fast-uri 3\.1\.8 is missing or differs/);
    await tampered('another client version', (copy) => { const manifestFile = path.join(copy, MANIFEST_FILE); const manifest = json(manifestFile); manifest.client = '2.3.1'; writeFileSync(manifestFile, JSON.stringify(manifest)); }, /staged MCP client is 2\.3\.1/);
    await tampered('a path outside the folder', (copy) => { const manifestFile = path.join(copy, MANIFEST_FILE); const manifest = json(manifestFile); manifest.files[0].path = '../outside'; writeFileSync(manifestFile, JSON.stringify(manifest)); }, /Invalid manifest entry/);
  });

  await test('scripts/Verify-McpRuntime.mjs connects the Hub\'s own code to a server through the staged copy', async () => {
    const result = spawnSync(process.execPath, [path.join(scripts, '..', 'Verify-McpRuntime.mjs'), HUB, staged], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(report.verified, true);
    assert.equal(report.tools, 1);
    assert.equal(report.client, MCP_CLIENT_VERSION);
    const bad = spawnSync(process.execPath, [path.join(scripts, '..', 'Verify-McpRuntime.mjs'), HUB, empty], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.notEqual(bad.status, 0, 'an empty runtime folder fails the check');
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 5. What the client compiles in
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('the packages compiled into the client are exactly those whose licence texts are vendored', async () => {
    const dist = path.join(scripts, 'node_modules', '@modelcontextprotocol', 'client', 'dist');
    const found = new Set();
    for (const name of readdirSync(dist)) {
      if (!/\.(?:mjs|cjs)$/.test(name) || !statSync(path.join(dist, name)).isFile()) continue;
      for (const match of readFileSync(path.join(dist, name), 'utf8').matchAll(/\/\/#region \.\.\/\.\.\/node_modules\/\.pnpm\/((?:@[^+/]+\+)?[^@/]+)@(\d+\.\d+\.\d+)[^/]*\//g)) {
        found.add(`${match[1].replace('+', '/')}@${match[2]}`);
      }
    }
    const vendored = json(path.join(scripts, 'licenses', 'MANIFEST.json')).packages.map((entry) => `${entry.name}@${entry.version}`);
    assert.deepEqual([...found].sort(), [...vendored].sort());
    assert.equal(json(path.join(scripts, 'licenses', 'MANIFEST.json')).bundledIn, `@modelcontextprotocol/client@${MCP_CLIENT_VERSION}`);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
