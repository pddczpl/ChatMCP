// The Hub updates its list of models only when its owner asks (prov-5): one request to https://models.dev/api.json, no key and no data of the person in it, a size and a time limit,
// a document that is not the catalog refused, the old list kept when anything goes wrong, the new one written to the Hub's data folder in one step. What this suite holds the Hub to:
//   1. The address: models.dev and nothing else (a loopback address is allowed for a mirror on this machine and for tests).
//   2. The download (lib/model-catalog-build.mjs fetchRawCatalog), against a fake fetch and against a real loopback server: what is asked, the limits, the refusals.
//   3. The shape of a snapshot read from disk (checkSnapshot): a file in the data folder is not trusted to be well formed.
//   4. The store (lib/model-catalog-store.mjs): what is loaded at start, what is ignored and why, what a refresh does and does not change, two refreshes at once.
//   5. The routes: behind the bearer and the CSRF check like every other, the status, the refresh, and the list of models of a provider for the picker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MAX_DOWNLOAD_BYTES, SOURCE_URL, checkSnapshot, checkedSourceUrl, compactCatalog, fetchRawCatalog, snapshotIsIntact, validateRaw } from '../lib/model-catalog-build.mjs';
import { bundledSnapshot, catalogInfo, catalogSource, createCatalog, lookup, normalizeModelId, resetCatalog, useCatalog } from '../lib/model-catalog.mjs';
import { createCatalogStore } from '../lib/model-catalog-store.mjs';
import { UI_BUILD, createHubServer } from '../hub.mjs';
import { VERSION } from '../lib/manager.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-catalog-refresh-'));
const bundled = bundledSnapshot();

// A models.dev document that passes the guard (24 providers of 230 models and the three that must be there), with one model only this document has.
function rawDocument({ marker = 'claude-refresh-test', context = 777000 } = {}) {
  const model = (id, extra = {}) => ({ id, name: id, reasoning: false, tool_call: true, limit: { context: 128000, output: 8192 }, cost: { input: 1, output: 2 }, modalities: { input: ['text'] }, ...extra });
  const providers = {};
  for (let p = 0; p < 24; p += 1) { const models = {}; for (let m = 0; m < 230; m += 1) models[`m${m}`] = model(`m${m}`); providers[`p${p}`] = { id: `p${p}`, models }; }
  providers.anthropic = { id: 'anthropic', models: { [marker]: model(marker, { limit: { context, output: 64000 }, cost: { input: 3, output: 15, tiers: [{ input: 6, output: 22.5, tier: { type: 'context', size: 200000 } }] } }) } };
  providers.openai = { id: 'openai', models: { 'gpt-x': model('gpt-x') } };
  providers.google = { id: 'google', models: { 'gemini-x': model('gemini-x') } };
  return providers;
}
const response = (body, { status = 200, headers = {} } = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

// ------------------------------------------------------------------------------------------------------------------------------- 1. the address
{
  assert.equal(SOURCE_URL, 'https://models.dev/api.json');
  assert.equal(checkedSourceUrl(), SOURCE_URL);
  for (const good of ['https://models.dev/api.json', 'http://127.0.0.1:8123/api.json', 'http://localhost:8123/x/api.json', 'https://localhost/api.json', 'http://[::1]:9/api.json']) assert.equal(typeof checkedSourceUrl(good), 'string', good);
  for (const bad of ['http://models.dev/api.json', 'https://models.dev/other.json', 'https://models.dev/api.json?x=1', 'https://models.dev/api.json#x', 'https://user:pw@models.dev/api.json', 'https://models.dev.evil.com/api.json',
    'https://evil.example/api.json', 'https://evil.example/models.dev/api.json', 'ftp://models.dev/api.json', 'not a url', '', 'http://192.168.1.5/api.json', 'http://0.0.0.0/api.json', 'https://MODELS.DEV.evil.com/api.json',
    'http://user:pw@127.0.0.1:8123/api.json', 'http://127.0.0.1:8123/api.json?key=1', 'http://127.0.0.1:8123/api.json#frag']) {
    assert.throws(() => checkedSourceUrl(bad), { code: 'catalog_source_refused' }, bad);
  }
  assert.throws(() => createCatalogStore({ directory: base, url: 'https://evil.example/api.json' }), { code: 'catalog_source_refused' }, 'a store cannot be aimed anywhere else');
  ok('the address is https://models.dev/api.json; a loopback address is the only other one, and a login, a query or another host is refused');
}

// ------------------------------------------------------------------------------------------------------------------------------- 2. the download
{
  const calls = [];
  const fetchOf = (make) => async (target, init) => { calls.push({ target, init }); return make(target, init); };
  const document = rawDocument();
  const got = await fetchRawCatalog({ fetchImpl: fetchOf(() => response(document)) });
  assert.deepEqual(Object.keys(got).length, Object.keys(document).length);
  const { target, init } = calls[0];
  assert.equal(target, SOURCE_URL);
  assert.deepEqual([init.method, init.redirect, init.credentials, init.referrerPolicy], ['GET', 'error', 'omit', 'no-referrer']);
  assert.deepEqual(Object.keys(init.headers).map((name) => name.toLowerCase()), ['accept'], 'the only header is what the answer is asked to be: no key, no cookie, no identity of the person');
  assert.ok(init.signal instanceof AbortSignal, 'with a time limit');
  assert.equal(init.body, undefined, 'and nothing in the body');
  // refusals
  const refused = async (make, code, label, options = {}) => { await assert.rejects(fetchRawCatalog({ fetchImpl: fetchOf(make), ...options }), { code }, label); };
  await refused(() => response('nope', { status: 500 }), 'catalog_http', 'an error status');
  await refused(() => response('{"a":1}', { headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } }), 'catalog_too_large', 'a declared size over the limit');
  await refused(() => response('x'.repeat(2000)), 'catalog_too_large', 'a body over the limit, whatever it declared', { maxBytes: 1000 });
  await refused(() => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(400)); } })), 'catalog_too_large', 'a body that never ends is cut off at the limit', { maxBytes: 1000 });
  await refused(() => response('<html>not json</html>'), 'catalog_invalid', 'an answer that is not JSON');
  await refused(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, 'catalog_network', 'a network error');
  await refused(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }, 'catalog_timeout', 'a time out');
  const controller = new AbortController();
  controller.abort(new Error('the owner cancelled'));
  await assert.rejects(fetchRawCatalog({ fetchImpl: async () => { throw new Error('aborted'); }, signal: controller.signal }), /the owner cancelled/, 'an abort by the caller is the caller\'s reason');
  await assert.rejects(fetchRawCatalog({ url: 'https://evil.example/api.json', fetchImpl: fetchOf(() => response(document)) }), { code: 'catalog_source_refused' }, 'the address is checked before anything is sent');
  assert.equal(calls.filter((call) => call.target.includes('evil')).length, 0, 'nothing was sent to it');
  ok('the download asks for models.dev only, with no credentials and no body, and refuses an error status, a size over the limit (declared or streamed), a non-JSON answer, a network error and a time out');

  // The same against a real loopback server: a redirect is not followed, a slow answer times out, a long one is cut.
  const server = http.createServer((req, res) => {
    if (req.url === '/api.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(document)); }
    else if (req.url === '/redirect.json') { res.writeHead(302, { location: '/api.json' }); res.end(); }
    else if (req.url === '/slow.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
    else if (req.url === '/long.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); const timer = setInterval(() => res.write(' '.repeat(50000)), 5); res.on('close', () => clearInterval(timer)); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const real = await fetchRawCatalog({ url: `${origin}/api.json` });
    assert.equal(Object.keys(real).length, Object.keys(document).length, 'a document served by a real server is read');
    await assert.rejects(fetchRawCatalog({ url: `${origin}/redirect.json` }), { code: 'catalog_network' }, 'a redirect is refused, not followed');
    await assert.rejects(fetchRawCatalog({ url: `${origin}/slow.json`, timeoutMs: 300 }), (error) => ['catalog_timeout', 'catalog_network'].includes(error.code), 'an answer that does not end');
    await assert.rejects(fetchRawCatalog({ url: `${origin}/long.json`, maxBytes: 200000 }), { code: 'catalog_too_large' }, 'an answer that does not stop is cut at the limit');
    await assert.rejects(fetchRawCatalog({ url: `${origin}/missing.json` }), { code: 'catalog_http' }, 'a 404');
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  ok('against a real loopback server: a redirect is refused, a slow answer and a never-ending one are cut off');
}

// ------------------------------------------------------------------------------------------------------------------------------- 3. the shape of a snapshot
{
  assert.doesNotThrow(() => checkSnapshot(bundled));
  const broken = (change) => { const copy = structuredClone(bundled); change(copy); return copy; };
  const small = compactCatalog(rawDocument(), { generatedAt: '2026-11-02' });
  assert.doesNotThrow(() => checkSnapshot(small));
  const defects = {
    'not an object': null, 'an array': [], 'another format': broken((s) => { s.version = 3; }), 'no date': broken((s) => { delete s.generatedAt; }), 'a date that is not one': broken((s) => { s.generatedAt = 'yesterday'; }),
    'no hash': broken((s) => { delete s.sha256; }), 'rows not a list': broken((s) => { s.rows = {}; }), 'a row that is not a list': broken((s) => { s.rows[3] = 'row'; }), 'a row of the wrong length': broken((s) => { s.rows[3] = [1, 2]; }),
    'a window that is a string': broken((s) => { s.rows[0][0] = '100000'; }), 'a negative window': broken((s) => { s.rows[0][0] = -5; }), 'prices that are not four': broken((s) => { s.rows[1][3] = [1, 2]; }),
    'a flag that is not a number': broken((s) => { s.rows[0][4] = 'x'; }), 'options that are not a list': broken((s) => { s.rows[0][5] = 'e'; }), 'a canonical index out of range': broken((s) => { s.rows[0][6] = 10 ** 9; }),
    'tiers that are not a list': broken((s) => { s.rows[0][7] = 'tier'; }), 'a tier of the wrong length': broken((s) => { s.rows[0][6] = null; s.rows[0][7] = [[1, 2]]; }),
    'a tier with a rate that is not a number': broken((s) => { s.rows[0][6] = null; s.rows[0][7] = [[1000, 'x', 2, null, null]]; }),
    'providers not an object': broken((s) => { s.providers = []; }), 'a provider that is not an object': broken((s) => { s.providers.anthropic = 5; }), 'a row index out of range': broken((s) => { s.providers.anthropic.zz = s.rows.length; }),
    'a row index that is not an integer': broken((s) => { s.providers.anthropic.zz = 1.5; }), 'canon not a list': broken((s) => { s.canon = {}; }), 'a canon entry that is not text': broken((s) => { s.canon[0] = 7; }),
    'a model id with a line break': broken((s) => { s.providers.anthropic['bad\nid'] = 0; }), 'a model id longer than the Hub takes': broken((s) => { s.providers.anthropic['x'.repeat(151)] = 0; }), 'a model id with a space': broken((s) => { s.providers.anthropic['a b'] = 0; }),
    'a provider named __proto__': broken((s) => { Object.defineProperty(s.providers, '__proto__', { value: {}, enumerable: true, configurable: true, writable: true }); }), 'a provider id with a line break': broken((s) => { s.providers['a\nb'] = {}; }),
    'a canonical id with a line break': broken((s) => { s.canon[0] = 'a\nb'; }), 'a host that is not a host': broken((s) => { s.hosts['a b'] = 'anthropic'; }),
    'a date that does not exist': broken((s) => { s.generatedAt = '2026-13-45'; }), 'a date of nine thousand years ahead': broken((s) => { s.generatedAt = '9999-99-99'; }),
    'hosts not an object': broken((s) => { s.hosts = []; }), 'a host that is not text': broken((s) => { s.hosts['x.example'] = 5; }), 'too many rows': broken((s) => { s.rows = new Array(300001).fill([1, 1, null, null, 0, 0]); }),
  };
  for (const [label, snapshot] of Object.entries(defects)) assert.throws(() => checkSnapshot(snapshot), /snapshot/i, label);
  ok(`checkSnapshot accepts the bundled snapshot and a built one, and refuses ${Object.keys(defects).length} kinds of damage`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 3b. what a document names is not trusted either
{
  // A document that passes the guard and then names what it should not: a provider called __proto__, ids with a line break or without end, a tier too small to be one.
  const bomb = ':v1'.repeat(64000) + '\nx';
  const hostile = rawDocument();
  Object.defineProperty(hostile, '__proto__', { value: { id: '__proto__', models: { polluted: { id: 'polluted', limit: { context: 1000, output: 100 } } } }, enumerable: true, configurable: true, writable: true });
  hostile['bad\nprovider'] = { id: 'x', models: { fine: { id: 'fine' } } };
  const names = hostile.p0.models;
  names['line\nbreak'] = { id: 'line\nbreak' }; names['x'.repeat(200)] = { id: 'long' }; names['with space'] = { id: 'with space' }; names[bomb] = { id: 'bomb' };
  names.tiny = { id: 'tiny', limit: { context: 128000, output: 8192 }, cost: { input: 1, output: 2, tiers: [{ input: 5, output: 20, tier: { type: 'context', size: 0.5 } }] } };
  names.aliased = { id: 'aliased', canonical_model_id: 'maker/with\nbreak', limit: { context: 128000, output: 8192 } };
  assert.doesNotThrow(() => validateRaw(hostile), 'the guard lets it through: it is what the rest of the code has to hold');
  const started = performance.now();
  const snapshot = compactCatalog(hostile, { generatedAt: '2026-11-02' });
  assert.doesNotThrow(() => checkSnapshot(snapshot), 'what is built from it is a snapshot that can be read');
  assert.equal(Object.hasOwn(snapshot.providers, '__proto__'), false, 'no provider is called __proto__');
  assert.equal(snapshot.providers.polluted, undefined, 'and what it listed did not become the prototype of the providers');
  assert.deepEqual(Object.keys(snapshot.providers).filter((id) => !/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(id)), [], 'no provider with a name that is not one');
  assert.deepEqual(Object.keys(snapshot.providers.p0).filter((id) => id.length > 150 || /[\s\u0000-\u001f\u007f]/.test(id)), [], 'no model id with a line break, a space or an absurd length');
  assert.ok(Object.hasOwn(snapshot.providers.p0, 'tiny') && snapshot.rows[snapshot.providers.p0.tiny].length <= 7 && snapshot.rows[snapshot.providers.p0.tiny][7] === undefined, 'a tier of half a token is no tier');
  assert.ok(snapshot.canon.every((id) => !/[\s\u0000-\u001f\u007f]/.test(id)), 'no canonical id with a line break');
  assert.ok(Object.hasOwn(snapshot.providers.p0, 'm0') && Object.hasOwn(snapshot.providers, 'p1'), 'and the rest of the document is still there');
  // an id the Hub's own checks would refuse never reaches the catalog, and a long one that does (a catalog made before this check) cannot freeze it: the spelling of an id is not worked on at any length
  const quick = () => performance.now() - started;
  assert.ok(quick() < 5000, `building it took ${quick()} ms`);
  const slow = performance.now();
  assert.equal(normalizeModelId(bomb), bomb.trim().toLowerCase(), 'an id of 192,000 characters with a line break is left as it is');
  assert.ok(performance.now() - slow < 1000, `normalizing it took ${performance.now() - slow} ms (it took 3.4 s when the work grew with the square of the length)`);
  const hostileCatalog = createCatalog({ version: 2, generatedAt: '2026-01-01', source: 'test', sha256: '0'.repeat(64), canon: [], hosts: {}, rows: [[1000000, 128000, null, null, 1, 0], [128000, 8192, null, null, 1, 0]], providers: { openai: { [bomb]: 0, 'gpt-5': 1 } } });
  const asked = performance.now();
  assert.equal(hostileCatalog.lookup({ presetId: 'openai', model: 'gpt-5-mini' }).found, false);
  assert.ok(performance.now() - asked < 1000, `a lookup in a catalog that has such an id took ${performance.now() - asked} ms`);
  // the messages that quote the document are bounded and one line: they go to the log and to the page
  const lying = rawDocument();
  lying['y'.repeat(100000) + '\nforged: a line of the log'] = { notModels: true };
  let message = '';
  try { validateRaw(lying); } catch (error) { message = error.message; }
  assert.ok(message.length > 0 && message.length < 300 && !/[\n\r]/.test(message), `the message is ${message.length} characters long and has${/[\n\r]/.test(message) ? '' : ' no'} line break`);
  ok('a document that names what it should not (a provider __proto__, ids with a line break, a space or 192,000 characters, a tier of half a token) builds a snapshot without them, nothing freezes on them, and the messages that quote it are bounded');
}

// ------------------------------------------------------------------------------------------------------------------------------- 4. the store
let storeNumber = 0;
const storeFor = (options = {}) => {
  const directory = path.join(base, `hub-${(storeNumber += 1)}`);
  return createCatalogStore({ directory, now: () => new Date('2026-11-02T10:00:00Z'), ...options });
};
{
  const refreshedFile = (store) => store.file;
  const written = async (store) => JSON.parse(await fs.readFile(refreshedFile(store), 'utf8'));
  try {
    // nothing on disk
    let asked = 0;
    const store = storeFor({ fetchImpl: async () => { asked += 1; return response(rawDocument()); } });
    let status = await store.load();
    assert.deepEqual([status.source, status.label, status.ignored, status.lastRefresh, status.refreshing, status.url], ['bundled', `catalog@${bundled.generatedAt}`, null, null, false, SOURCE_URL]);
    assert.deepEqual([status.models, status.providers, status.bundled.generatedAt], [catalogInfo().models, catalogInfo().providers, bundled.generatedAt]);
    assert.equal(catalogSource(), 'bundled');
    assert.equal(lookup({ presetId: 'anthropic', model: 'claude-refresh-test' }).found, false);
    // nothing is fetched unless the owner asks: not at start, not by a timer, not when a model is looked up or the status is read
    for (const model of ['claude-sonnet-5-5', 'gpt-5-mini', 'my-own-finetune']) lookup({ presetId: 'anthropic', model });
    store.status();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(asked, 0, 'the store made no request before the owner asked for one');

    // a refresh
    status = await store.refresh();
    assert.equal(asked, 1, 'and one request for one press');
    assert.deepEqual([status.source, status.generatedAt, status.label, status.refreshing], ['refreshed', '2026-11-02', 'catalog@2026-11-02', false]);
    assert.deepEqual([status.lastRefresh.ok, status.lastRefresh.at], [true, '2026-11-02T10:00:00.000Z']);
    assert.equal(status.models, 24 * 230 + 3, 'the models of the new document');
    assert.equal(catalogSource(), 'refreshed');
    const answer = lookup({ presetId: 'anthropic', model: 'claude-refresh-test' });
    assert.deepEqual([answer.found, answer.confidence, answer.contextWindow, answer.source, answer.tiers.length], [true, 'exact', 777000, 'catalog@2026-11-02', 1], 'the new list answers at once');
    const file = await written(store);
    assert.equal(snapshotIsIntact(file), true);
    assert.deepEqual([file.version, file.generatedAt], [2, '2026-11-02']);
    assert.deepEqual((await fs.readdir(path.dirname(store.file))).filter((name) => name.includes('.tmp')), [], 'no half-written file is left');
    assert.deepEqual(snapshotIsIntact(bundledSnapshot()), true);
    assert.equal(bundledSnapshot().sha256, bundled.sha256, 'the list that ships with the Hub is not touched');

    // a new start reads what was written
    resetCatalog();
    assert.equal(catalogSource(), 'bundled');
    status = await createCatalogStore({ directory: path.dirname(store.file), now: () => new Date('2026-11-02T12:00:00Z'), fetchImpl: async () => { throw new Error('no network at start'); } }).load();
    assert.deepEqual([status.source, status.generatedAt, status.ignored], ['refreshed', '2026-11-02', null], 'the next start uses the refreshed list');
    assert.equal(lookup({ presetId: 'anthropic', model: 'claude-refresh-test' }).contextWindow, 777000);
    ok('a refresh replaces the list at once and on disk in one step, leaves the list that ships alone, and the next start reads it');

    // a refresh that fails changes nothing
    const keep = await fs.readFile(refreshedFile(store), 'utf8');
    for (const [label, make, code] of [
      ['an error status', () => response('boom', { status: 503 }), 'catalog_http'],
      ['a document that is not the catalog', () => response([]), 'catalog_unusable'],
      ['a catalog with too few models', () => response({ anthropic: { models: {} }, openai: { models: {} }, google: { models: {} } }), 'catalog_unusable'],
      ['an answer that is not JSON', () => response('<html>'), 'catalog_invalid'],
      ['a network error', () => { throw new TypeError('fetch failed'); }, 'catalog_network'],
      ['a size over the limit', () => response('x'.repeat(5000)), 'catalog_too_large'],
    ]) {
      const failing = createCatalogStore({ directory: path.dirname(store.file), now: () => new Date('2026-11-03T10:00:00Z'), fetchImpl: async () => make(), maxBytes: 4000 });
      await failing.load();
      const before = failing.status();
      await assert.rejects(failing.refresh(), (error) => error.code === code && error.statusCode === 502 && typeof error.message === 'string' && error.message.length > 10, label);
      const after = failing.status();
      assert.deepEqual([after.source, after.generatedAt, after.refreshing, after.lastRefresh.ok, after.lastRefresh.code], [before.source, before.generatedAt, false, false, code], `${label}: the list in use stays, the failure is recorded`);
      assert.equal(await fs.readFile(refreshedFile(store), 'utf8'), keep, `${label}: the file on disk is unchanged`);
    }
    ok('a refresh that fails (error status, not the catalog, too few models, not JSON, network, too large) changes neither the list in use nor the file, and says why');

    // a file on disk that is not to be used
    const directory = path.join(base, 'damaged');
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, 'model-catalog.json');
    const valid = compactCatalog(rawDocument(), { generatedAt: '2026-11-02' });
    const tampered = structuredClone(valid); tampered.rows[0][0] = 1;
    const wrongShape = { ...valid, rows: 'rows' };
    const cases = [
      ['not JSON', '{"version":', 'damaged'], ['a changed number (the hash no longer matches)', JSON.stringify(tampered), 'damaged'], ['a shape it cannot read', JSON.stringify(wrongShape), 'damaged'],
      ['another format', JSON.stringify({ ...valid, version: 9 }), 'damaged'], ['older than the list that ships', JSON.stringify(compactCatalog(rawDocument(), { generatedAt: '2026-01-01' })), 'older'],
      ['dated in the future', JSON.stringify(compactCatalog(rawDocument(), { generatedAt: '2099-01-01' })), 'future'], ['far too large', 'x'.repeat(13 * 1024 * 1024), 'damaged'],
    ];
    for (const [label, content, reason] of cases) {
      useCatalog(valid); // a refreshed list is in use when this start finds the file: a file it cannot use must not leave it in use
      await fs.writeFile(target, content);
      const ignoring = createCatalogStore({ directory, now: () => new Date('2026-11-02T10:00:00Z') });
      const loaded = await ignoring.load();
      assert.deepEqual([loaded.source, loaded.ignored?.reason, loaded.label], ['bundled', reason, `catalog@${bundled.generatedAt}`], label);
      assert.equal(typeof loaded.ignored.detail, 'string');
      assert.equal(lookup({ presetId: 'anthropic', model: 'claude-refresh-test' }).found, false, `${label}: the list that ships answers`);
    }
    // ...and a refresh over it puts a good one in its place
    const mending = createCatalogStore({ directory, now: () => new Date('2026-11-02T10:00:00Z'), fetchImpl: async () => response(rawDocument()) });
    await mending.load();
    assert.equal((await mending.refresh()).source, 'refreshed');
    assert.equal((await mending.load()).ignored, null);
    ok(`a file on disk that is damaged (${cases.filter((c) => c[2] === 'damaged').length} ways), older than the list that ships, or dated in the future is ignored with the reason, and a refresh mends it`);

    // two refreshes at once make one request
    resetCatalog();
    let requests = 0;
    const slow = storeFor({ fetchImpl: async () => { requests += 1; await new Promise((resolve) => setTimeout(resolve, 80)); return response(rawDocument({ marker: 'claude-once' })); } });
    await slow.load();
    const pending = slow.refresh();
    assert.equal(slow.status().refreshing, true);
    const [a, b] = await Promise.all([pending, slow.refresh()]);
    assert.deepEqual([requests, a.label, b.label, slow.status().refreshing], [1, 'catalog@2026-11-02', 'catalog@2026-11-02', false], 'one request answers both');
    // a refresh on the same day replaces the one before
    const replacing = createCatalogStore({ directory: path.dirname(slow.file), now: () => new Date('2026-11-02T18:00:00Z'), fetchImpl: async () => response(rawDocument({ marker: 'claude-twice' })) });
    await replacing.load();
    await replacing.refresh();
    assert.equal(lookup({ presetId: 'anthropic', model: 'claude-twice' }).found, true);
    assert.equal(lookup({ presetId: 'anthropic', model: 'claude-once' }).found, false);
    ok('two refreshes at once make one request; a second one the same day replaces the first');
  } finally { resetCatalog(); }
}

// ------------------------------------------------------------------------------------------------------------------------------- 4b. a refresh holds to what a start holds to
{
  // A machine whose clock is before the date of the list that ships would date the new list before the one it replaces, and the next start would ignore it as older: the update is refused, nothing is written.
  let asked = 0;
  const behind = createCatalogStore({ directory: path.join(base, 'hub-behind'), now: () => new Date('2020-01-01T00:00:00Z'), fetchImpl: async () => { asked += 1; return response(rawDocument()); } });
  await behind.load();
  await assert.rejects(() => behind.refresh(), (error) => error.code === 'catalog_clock' && error.statusCode === 409 && /clock|date/i.test(error.message), 'refused with its own code');
  await assert.rejects(() => fs.stat(behind.file), { code: 'ENOENT' }, 'nothing was written');
  assert.deepEqual([catalogSource(), behind.status().lastRefresh.ok, behind.status().lastRefresh.code], ['bundled', false, 'catalog_clock'], 'the list in use is the one that ships, and the status says why');
  assert.equal(asked, 0, 'and the date is checked before anything is downloaded');
  ok('a refresh is refused, before the download, when the clock of the machine is before the date of the list that ships');
}

// ------------------------------------------------------------------------------------------------------------------------------- 5. the routes
{
  const temp = await fs.mkdtemp(path.join(base, 'http-'));
  const server0 = net.createServer();
  await new Promise((resolve) => server0.listen(0, '127.0.0.1', resolve));
  const port = server0.address().port;
  await new Promise((resolve) => server0.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const secret = 'catalog-refresh-test-secret-0123456789abcdef';
  const auth = { Authorization: `Bearer ${secret}` };
  const manager = { workspace: temp, secrets: [], log: () => {}, hubDirectory: temp, state: () => ({ version: VERSION, workspace: { path: temp }, services: {} }) };
  let nextBody = () => response(rawDocument({ marker: 'claude-route-test' }));
  let downloads = 0;
  const store = createCatalogStore({ directory: path.join(temp, 'catalog'), now: () => new Date('2026-11-04T08:00:00Z'), fetchImpl: async () => { downloads += 1; return nextBody(); } });
  let activeTaskId = null;
  const hub = createHubServer(manager, { port, secret, agent: { state: () => ({ activeTaskId, tasks: [] }) }, bundleRoot: path.resolve('.'), catalogStore: store });
  await new Promise((resolve) => hub.listen(port, '127.0.0.1', resolve));
  let csrf = '';
  const get = async (route, headers = auth) => { const res = await fetch(origin + route, { headers }); return { status: res.status, value: await res.json().catch(() => null) }; };
  const post = async (route, body = {}, headers = {}) => {
    const res = await fetch(origin + route, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: origin, 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': csrf, 'X-ChatMCP-UI-Build': UI_BUILD, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, value: await res.json().catch(() => null) };
  };
  try {
    csrf = (await get('/api/state')).value.csrfToken;
    // the routes are behind the bearer like the others
    for (const route of ['/api/ai/catalog', '/api/ai/catalog/models?preset=openai']) assert.equal((await fetch(origin + route)).status, 401, `${route} needs the Hub secret`);
    assert.equal((await fetch(origin + '/api/ai/catalog/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, 'the refresh needs the Hub secret');
    assert.equal((await post('/api/ai/catalog/refresh', {}, { 'X-ChatMCP-CSRF': 'wrong' })).status, 403, 'and the dashboard\'s CSRF token');
    assert.equal((await post('/api/ai/catalog/refresh', {}, { Origin: 'http://evil.example' })).status, 403, 'and the dashboard\'s origin');

    let answer = await get('/api/ai/catalog');
    assert.deepEqual([answer.status, answer.value.source, answer.value.label, answer.value.url, answer.value.lastRefresh], [200, 'bundled', `catalog@${bundled.generatedAt}`, SOURCE_URL, null]);
    assert.ok(Number.isInteger(answer.value.ageDays) && answer.value.models > 9000 && answer.value.providers > 200, 'age, models and providers of the list in use');
    assert.equal(JSON.stringify(answer.value).includes(temp), false, 'the status names no folder of this machine');
    // reading the Hub never downloads anything: not the state, the status, the list of a provider's models, nor what is known of a model; and a press the layers refused did not either
    for (const route of ['/api/state', '/api/ai/catalog', '/api/ai/catalog/models?preset=anthropic', '/api/ai/model-info?preset=anthropic&model=claude-sonnet-5-5', '/api/ai/presets']) await get(route);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(downloads, 0, 'the Hub fetched nothing until the owner pressed the button');

    // a run keeps its plan and its price: the list is not replaced while a task is running
    activeTaskId = 'a-task';
    answer = await post('/api/ai/catalog/refresh');
    assert.deepEqual([answer.status, downloads], [409, 0], 'refused while a task runs, and nothing downloaded');
    assert.match(answer.value.error, /cập nhật danh sách model/i, 'in words about the list');
    activeTaskId = null;
    answer = await post('/api/ai/catalog/refresh');
    assert.equal(downloads, 1, 'one press, one download');
    assert.deepEqual([answer.status, answer.value.source, answer.value.label, answer.value.lastRefresh.ok], [200, 'refreshed', 'catalog@2026-11-04', true]);
    answer = await get('/api/ai/model-info?preset=anthropic&model=claude-route-test');
    assert.deepEqual([answer.status, answer.value.found, answer.value.contextWindow, answer.value.source], [200, true, 777000, 'catalog@2026-11-04'], 'the settings page is answered from the new list at once');
    answer = await get('/api/ai/catalog');
    assert.deepEqual([answer.value.source, answer.value.generatedAt], ['refreshed', '2026-11-04']);

    nextBody = () => response('boom', { status: 500 });
    answer = await post('/api/ai/catalog/refresh');
    assert.deepEqual([answer.status, answer.value.code], [502, 'catalog_http'], 'a failure is a gateway error with its code');
    assert.match(answer.value.error, /models\.dev/);
    answer = await get('/api/ai/catalog');
    assert.deepEqual([answer.value.source, answer.value.lastRefresh.ok, answer.value.lastRefresh.code], ['refreshed', false, 'catalog_http'], 'the list in use stays, the failure is shown');
    nextBody = () => response([]);
    assert.equal((await post('/api/ai/catalog/refresh')).value.code, 'catalog_unusable');

    // the list of a provider's models, for the picker
    answer = await get('/api/ai/catalog/models?preset=anthropic');
    assert.deepEqual([answer.status, answer.value.provider, answer.value.source, answer.value.local, answer.value.total], [200, 'anthropic', 'catalog@2026-11-04', false, 1]);
    assert.deepEqual(answer.value.models[0], { id: 'claude-route-test', contextWindow: 777000, maxInput: null, maxOutput: 64000, rates: { input: 3, output: 15 }, tiered: true, reasoning: false, toolCall: true, vision: false, status: null });
    resetCatalog();
    answer = await get('/api/ai/catalog/models?preset=openai');
    assert.equal(answer.value.provider, 'openai');
    assert.ok(answer.value.total > 50 && answer.value.models.length === answer.value.total);
    const mini = answer.value.models.find((entry) => entry.id === 'gpt-5-mini');
    assert.deepEqual([mini.contextWindow, mini.maxInput, mini.maxOutput, mini.rates, mini.reasoning, mini.toolCall], [400000, 272000, 128000, { input: 0.25, output: 2 }, true, true]);
    // only models the Hub can use are offered: the list is for choosing, and the Hub refuses to save an id such as "~anthropic/claude-sonnet-latest" (202 of the 9,056 ids of the snapshot)
    answer = await get('/api/ai/catalog/models?preset=openrouter');
    const takes = (id) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/.test(id);
    const everyId = createCatalog(bundled).modelIds('openrouter');
    assert.ok(everyId.some((id) => !takes(id)), 'the snapshot has ids of this provider that the Hub would refuse');
    assert.deepEqual([answer.value.models.every((entry) => takes(entry.id)), answer.value.total], [true, everyId.filter(takes).length], 'none of them is offered, and the total counts what is offered');
    answer = await get('/api/ai/catalog/models?preset=openai&limit=3');
    assert.deepEqual([answer.value.models.length, answer.value.total > 3, answer.value.truncated], [3, true, true]);
    answer = await get('/api/ai/catalog/models?preset=ollama');
    assert.deepEqual([answer.value.local, answer.value.models, answer.value.provider], [true, [], null]);
    answer = await get('/api/ai/catalog/models?preset=custom-openai&apiBaseUrl=https%3A%2F%2Flitellm.example.com');
    assert.deepEqual([answer.value.models, answer.value.provider], [[], null]);
    assert.equal((await get('/api/ai/catalog/models')).status, 400, 'no preset and no protocol: refused');
    assert.equal((await get('/api/ai/catalog/models?preset=nonsense')).status, 400);
    assert.equal((await get('/api/ai/catalog/models?preset=openai&limit=0')).status, 400);
    assert.equal((await get('/api/ai/catalog/models?preset=openai&limit=99999')).status, 400);
    // model-info says more about a model than the levels of thinking
    answer = await get('/api/ai/model-info?preset=openai&model=gpt-5.4');
    assert.deepEqual([answer.value.maxInput, answer.value.rates.input, answer.value.tiers.length, answer.value.status, answer.value.trusted, answer.value.capacity], [922000, 2.5, 1, null, true, 922000 + 16384]);
    answer = await get('/api/ai/model-info?preset=custom-openai&apiBaseUrl=https%3A%2F%2Fproxy.example.com&model=gpt-5-mini');
    assert.deepEqual([answer.value.found, answer.value.confidence, answer.value.trusted, answer.value.capacity], [true, 'alias', false, null], 'an alias is shown, but not relied on');
    assert.equal(answer.value.catalogModel, 'gpt-5-mini', 'and it says which model of the catalog it looks like');
    answer = await get('/api/ai/model-info?preset=openai&model=my-own-finetune');
    assert.deepEqual([answer.value.found, answer.value.catalogModel, answer.value.trusted], [false, null, false]);
    ok('the routes: behind the bearer, the origin and the CSRF token; status, refresh, failures with their codes, the list of a provider\'s models, and a model-info that says what the Hub would plan on');
  } finally {
    resetCatalog();
    hub.closeAllConnections?.();
    await new Promise((resolve) => hub.close(resolve));
  }
}

await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
console.log(`\nPASS: ${checks} model catalog refresh checks`);
