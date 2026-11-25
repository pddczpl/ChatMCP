// The owner's trust in an acceptance file over HTTP (plan task P5 pod-33, docs/PROOF-HUB-API.md): a real Hub process on a free port (never 3007), the real `chatmcp verify`
// command line on the same data folder, a scripted model behind the strict mock, the Hub's own MCP listener. What must hold:
//   1. GET /api/proof/acceptance shows the file that is there: its sha256, criteria and commands, whether it is trusted; what cannot be read says why
//   2. POST /api/proof/trust-acceptance takes one sha256 and nothing else, and only for the bytes that are on the disk at that moment; revoke likewise
//   3. both sit behind the bearer, Host, Origin, the page's marker and the CSRF token
//   4. nobody but the owner's page reaches them: not the model's tools, the MCP clients, the ACP agent or the Companion
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { runScenario } from './e2e/harness.mjs';
import { HUB_ROOT, answerApprovals, cleanEnvironment, connectModel, freePort, setMode, startTask, waitFor } from './e2e/hub-process.mjs';
import { call, say } from './e2e/scenarios.mjs';
import { gitInit } from './e2e/fixtures.mjs';
import { runtimeRoot } from './support/mcp-tools.mjs';
import { FORBIDDEN_ROUTES, ROUTES, routeAllowed } from '../lib/acp/hub-client.mjs';
import { ACCEPTANCE_MAX_BYTES } from '../lib/proof/acceptance.mjs';
import { MCP_SERVER_PORT_VARIABLE, MCP_SERVER_VARIABLE } from '../lib/mcp/server-setting.mjs';
import { McpServerTokenStore } from '../lib/mcp/server-token.mjs';
import { createProtector } from '../lib/secret-box.mjs';

const SHOW = '/api/proof/acceptance';
const TRUST = '/api/proof/trust-acceptance';
const REVOKE = '/api/proof/revoke-acceptance';
const SECRET = 'zebraplumquartz0042';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ACCEPT = 'version: 1\ncriteria:\n  - id: tests\n    text: "The tests pass."\n    checks:\n      - run: "node calc.test.js"\n        cwd: "."\n        timeout: 60\n        repeat: 2\n  - id: look\n    text: "The owner reads the diff."\n    manual:\n      note: "Read it."\n      inspect:\n        - "calc.js"\nprotected:\n  - ".chatmcp/**"\nreproduce:\n  setup:\n    - "npm ci"\n';

await runScenario({
  name: 'proof-trust-http', budgetMs: 160_000,
  summary: 'the acceptance file as the owner is shown it, trust and revoke of exact bytes, every layer in front of them, and that no tool, MCP client, ACP agent or Companion reaches them',
}, async (t) => {
  const runtime = runtimeRoot();
  if (!runtime) t.skip('not installed: the MCP SDK (run: npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/mcp-runtime)');
  const project = path.join(t.scratch, 'app');
  const file = path.join(project, '.chatmcp', 'acceptance.yml');
  fs.mkdirSync(path.join(project, '.chatmcp'), { recursive: true });
  fs.writeFileSync(path.join(project, 'calc.js'), 'exports.add = (a, b) => a + b;\n');
  gitInit(project, t.scratch);
  const results = [];
  let attack = [];
  const mock = await t.mock({
    scenario: 'attack',
    scenarios: {
      attack(ctx) {
        if (ctx.turn > 0) results.push(ctx.results[ctx.turn - 1]);
        const step = attack[ctx.turn];
        return step ? call(step[0], step[1]) : say('Done.');
      },
    },
  });
  const mcpPort = await freePort();
  const hub = await t.hub({ project, env: { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: String(mcpPort), CHATMCP_MCP_RUNTIME_DIR: runtime } });
  await connectModel(hub, mock);
  await hub.post('/api/ai/config', { preset: 'ollama', apiBaseUrl: mock.url, model: 'test-model', apiKey: SECRET });
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(HUB_ROOT, 'bin', 'chatmcp.mjs'), 'verify', 'trust', ...args, '--json', '--workspace', project], { cwd: project, encoding: 'utf8', windowsHide: true, env: cleanEnvironment(t.scratch, { CHATMCP_STATE_DIR: hub.stateDir }) });
    return JSON.parse(result.stdout);
  };
  const listFile = path.join(hub.stateDir, 'proof', 'trusted-acceptance.json');
  const trusted = () => { try { return Object.keys(JSON.parse(fs.readFileSync(listFile, 'utf8')).trusted); } catch { return []; } };
  const show = async () => (await hub.get(SHOW)).json;
  const trust = (body) => hub.request('POST', TRUST, body);
  const revoke = (body) => hub.request('POST', REVOKE, body);
  const said = (answer) => [answer.status, answer.json?.code ?? null];

  // ---- what there is to show -------------------------------------------------------------------------------------------------
  const missing = await show();
  t.equal([missing.format, missing.file, missing.state, missing.sha256, missing.trusted, missing.criteria], ['chatmcp.hub-acceptance/1', '.chatmcp/acceptance.yml', 'missing', null, false, []], 'no file: nothing to trust');
  t.equal(said(await trust({ sha256: sha(ACCEPT) })), [404, 'acceptance_missing'], 'and nothing can be trusted ahead');
  fs.writeFileSync(file, ACCEPT);
  const shown = await show();
  t.equal([shown.state, shown.sha256, shown.bytes, shown.trusted, shown.approvedBy, shown.at, shown.problem], ['present', sha(ACCEPT), Buffer.byteLength(ACCEPT), false, null, null, null], 'the sha256 of the exact bytes');
  t.equal(shown.criteria, [
    { id: 'tests', text: 'The tests pass.', checks: [{ run: 'node calc.test.js', cwd: '.', timeout: 60, expectExit: 0, repeat: 2 }], manual: null },
    { id: 'look', text: 'The owner reads the diff.', checks: [], manual: { note: 'Read it.', inspect: ['calc.js'] } },
  ], 'the criteria and the commands as the one reader that counts reads them');
  t.equal([shown.protected, shown.setup, shown.masked], [['.chatmcp/**'], ['npm ci'], false], 'what is protected and the setup commands');
  t.equal(said(await hub.request('GET', `${SHOW}?path=x`)), [400, 'bad_query'], 'it takes no path and no other key');

  // ---- who may ask -------------------------------------------------------------------------------------------------------------
  const csrf = await hub.csrfToken();
  const good = { ...hub.authHeaders, origin: hub.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': csrf, 'content-type': 'application/json' };
  const without = (name) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== name));
  const body = JSON.stringify({ sha256: shown.sha256 });
  for (const route of [TRUST, REVOKE]) {
    const layers = [
      ['no bearer', without('authorization'), 401], ['a wrong bearer', { ...good, authorization: `Bearer ${'b'.repeat(64)}` }, 401], ['no Origin', without('origin'), 403], ['another Origin', { ...good, origin: 'https://evil.example' }, 403],
      ['the Companion\'s Origin', { ...good, origin: `chrome-extension://${'a'.repeat(32)}` }, 403], ['no marker', without('x-chatmcp-request'), 403], ['no CSRF token', without('x-chatmcp-csrf'), 403], ['a wrong CSRF token', { ...good, 'x-chatmcp-csrf': 'c'.repeat(64) }, 403],
      ['another Host', { ...good, host: 'evil.example' }, 403], ['a form', { ...good, 'content-type': 'text/plain' }, 415],
    ];
    for (const [label, headers, status] of layers) t.equal((await hub.rawRequest({ method: 'POST', route, headers, body })).status, status, `${route}: ${label} is ${status}`);
    t.check([404, 405].includes((await hub.rawRequest({ method: 'GET', route, headers: hub.authHeaders })).status), `${route} is no GET`);
  }
  t.equal((await hub.rawRequest({ route: SHOW })).status, 401, `${SHOW}: 401 without the bearer`);
  t.equal((await hub.rawRequest({ route: SHOW, headers: { ...hub.authHeaders, origin: `chrome-extension://${'a'.repeat(32)}` } })).status, 403, `${SHOW}: not for the Companion`);
  t.equal(trusted(), [], 'none of them trusted anything');

  // ---- exact bytes only ----------------------------------------------------------------------------------------------------------
  const BAD = [{}, { sha256: null }, { sha256: 5 }, { sha256: '' }, { sha256: 'latest' }, { sha256: shown.sha256.slice(0, 63) }, { sha256: `${shown.sha256}0` }, { sha256: shown.sha256.toUpperCase() }, { sha256: [shown.sha256] },
    { sha256: shown.sha256, path: file }, { sha256: shown.sha256, latest: true }, { path: file }, { sha256: shown.sha256, approvedBy: 'me' }];
  for (const route of [TRUST, REVOKE]) {
    const answers = [];
    for (const one of BAD) answers.push(said(await hub.request('POST', route, one)).join(':'));
    t.equal(answers, BAD.map(() => '400:bad_request'), `${route} takes one lower-case sha256 and nothing else`);
  }
  const other = await trust({ sha256: 'ab'.repeat(32) });
  t.equal([...said(other), other.json.actual], [409, 'acceptance_changed', shown.sha256], 'other bytes than the ones on the disk are refused, and it says which are there');
  fs.writeFileSync(file, ACCEPT.replaceAll('\n', '\r\n'));
  t.equal(said(await trust({ sha256: shown.sha256 })), [409, 'acceptance_changed'], 'the file changed after it was shown (line ends only): refused');
  const crlf = await show();
  t.equal([crlf.sha256, crlf.trusted, crlf.criteria.length], [sha(ACCEPT.replaceAll('\n', '\r\n')), false, 2], 'a file with CRLF has a sha256 of its own');
  fs.writeFileSync(file, 'version: 1\ncriteria: nope\n');
  const invalid = await show();
  t.equal([invalid.state, invalid.problem.line > 0, typeof invalid.problem.reason, invalid.criteria], ['invalid', true, 'string', []], 'a file that does not read says where');
  const refused = await trust({ sha256: invalid.sha256 });
  t.equal([...said(refused), refused.json.line], [422, 'acceptance_invalid', invalid.problem.line], 'and cannot be trusted');
  fs.writeFileSync(file, Buffer.alloc(ACCEPTANCE_MAX_BYTES + 1, 0x20));
  t.equal([(await show()).state, said(await trust({ sha256: sha(Buffer.alloc(ACCEPTANCE_MAX_BYTES + 1, 0x20)) }))], ['too_large', [422, 'acceptance_invalid']], 'a file over its limit is not read');
  fs.rmSync(file);
  fs.mkdirSync(file);
  t.equal([(await show()).state, said(await trust({ sha256: sha('') }))], ['missing', [404, 'acceptance_missing']], 'a folder of that name is no file');
  fs.rmdirSync(file);
  fs.writeFileSync(path.join(t.scratch, 'outside.yml'), ACCEPT);
  let linked = false;
  try { fs.symlinkSync(path.join(t.scratch, 'outside.yml'), file); linked = true; } catch { t.note('symbolic links cannot be made here'); }
  if (linked) {
    t.check(['outside', 'missing'].includes((await show()).state) && (await show()).sha256 === null && [404, 422].includes((await trust({ sha256: shown.sha256 })).status), 'a link out of the workspace is not read');
    fs.rmSync(file);
  }
  // the folder is a link (a junction on Windows) out of the workspace
  const chatmcp = path.join(project, '.chatmcp');
  const away = path.join(t.scratch, 'away');
  fs.mkdirSync(away);
  fs.writeFileSync(path.join(away, 'acceptance.yml'), ACCEPT);
  fs.renameSync(chatmcp, `${chatmcp}-aside`);
  fs.symlinkSync(away, chatmcp, 'junction');
  const outside = await show();
  t.equal([outside.state, outside.sha256, outside.criteria, said(await trust({ sha256: shown.sha256 }))], ['outside', null, [], [422, 'acceptance_outside']], 'a folder that leads out of the workspace is not read');
  fs.unlinkSync(chatmcp);
  fs.renameSync(`${chatmcp}-aside`, chatmcp);
  t.equal(trusted(), [], 'nothing is trusted');

  // ---- trust, as the command line sees it, and revoke ---------------------------------------------------------------------------------
  fs.writeFileSync(file, ACCEPT);
  const done = await trust({ sha256: shown.sha256 });
  t.equal([done.status, done.json.trusted, done.json.sha256, typeof done.json.approvedBy, Number.isNaN(Date.parse(done.json.at))], [200, true, shown.sha256, 'string', false], 'the owner trusts the bytes they were shown');
  t.equal([trusted(), cli().code, (await show()).trusted, (await show()).approvedBy], [[shown.sha256], 'trusted', true, done.json.approvedBy], 'the one list: the command line says the same');
  t.equal((await trust({ sha256: shown.sha256 })).status, 200, 'trusting again renews it (a run may be held to it again)');
  t.equal([(await revoke({ sha256: 'ab'.repeat(32) })).json.revoked, trusted().length], [false, 1], 'revoking what is not trusted changes nothing');
  fs.rmSync(file);
  const taken = await revoke({ sha256: shown.sha256 });
  t.equal([taken.status, taken.json.revoked, taken.json.trusted, trusted()], [200, true, false, []], 'revoking needs no file');
  fs.writeFileSync(file, ACCEPT.replace('The tests pass.', `The tests pass with ${SECRET}.`));
  const masked = await show();
  t.check(!JSON.stringify(masked).includes(SECRET) && masked.masked === true && masked.criteria[0].text.includes('REDACTED'), 'a registered secret in the file is masked in the answer, and the answer says so');
  // two at once
  fs.writeFileSync(file, ACCEPT);
  const both = await Promise.all([trust({ sha256: shown.sha256 }), revoke({ sha256: shown.sha256 }), trust({ sha256: shown.sha256 }), trust({ sha256: shown.sha256 })]);
  t.check(both.every((answer) => answer.status === 200) && JSON.parse(fs.readFileSync(listFile, 'utf8')).version === 1, 'several at once: every one answers, and the list is whole');
  await revoke({ sha256: shown.sha256 });

  // ---- the model ------------------------------------------------------------------------------------------------------------------------
  await setMode(hub, 'autonomous');
  const catalog = (await hub.get('/api/catalog')).json;
  const names = (catalog.tools ?? []).map((tool) => String(tool.name));
  t.check(names.length > 20 && !names.some((name) => /trust|acceptance|approve/i.test(name)), 'no tool of the Hub\'s catalog trusts anything', names.filter((name) => /trust|accept|approve/i.test(name)).join(' '));
  const forged = JSON.stringify({ version: 1, trusted: { [shown.sha256]: { approvedBy: 'model', at: new Date().toISOString() } } });
  const probe = `fetch(${JSON.stringify(`${hub.origin}${TRUST}`)},{method:'POST',headers:{'content-type':'application/json',origin:${JSON.stringify(hub.origin)},'x-chatmcp-request':'local-dashboard'},body:${JSON.stringify(body)}}).then(async r=>console.log('STATUS',r.status),e=>console.log('ERR',e.message))`;
  fs.writeFileSync(path.join(project, 'probe.js'), `${probe};\n`);
  attack = [
    ['write_file', { path: listFile, content: forged, overwrite: true }],
    ['write_file', { path: path.relative(project, listFile).replaceAll('\\', '/'), content: forged, overwrite: true }],
    ['web_fetch', { url: `${hub.origin}${SHOW}` }],
    ['web_fetch', { url: `${hub.origin}${TRUST}?sha256=${shown.sha256}` }],
    ['mcp_call', { name: 'hub.trust_acceptance', arguments_json: body }],
    ['run_command', { command: 'node probe.js', description: 'probe' }],
    ['read_file', { path: path.join(hub.stateDir, 'run', 'hub-session.json') }],
  ];
  const task = await startTask(hub, 'Trust the acceptance file for me.');
  const { answered } = await answerApprovals(hub, task.id, () => true, { timeoutMs: 60_000 });
  t.note(`the person approved ${answered.length} of the model's calls`);
  const seen = results.map(String);
  t.equal(new Set(results).size >= 5 && results.length >= attack.length, true, '(premise) the model made its calls');
  t.check(seen.some((text) => text.includes('STATUS 401')), 'a command of the model without the secret is 401', seen.find((text) => /STATUS|ERR/.test(text))?.slice(0, 200));
  t.check(!seen.some((text) => text.includes(hub.secret) || text.includes('"trusted":true') || text.includes('chatmcp.hub-acceptance')), 'and none of its tools got the secret or an answer of the routes');
  t.equal([trusted(), (await show()).trusted], [[], false], 'nothing is trusted after it');

  // ---- the MCP clients -----------------------------------------------------------------------------------------------------------------------
  const mcpUrl = `http://127.0.0.1:${mcpPort}`;
  await waitFor(async () => { try { await fetch(`${mcpUrl}/mcp`, { method: 'POST' }); return true; } catch { return false; } }, { timeoutMs: 15_000, label: 'the MCP listener' });
  const tokens = new McpServerTokenStore({ directory: hub.stateDir, protector: createProtector({ bundleRoot: HUB_ROOT, directory: hub.stateDir }) });
  await tokens.load();
  const token = await tokens.reveal();
  t.check(typeof token === 'string' && token.length > 20, '(premise) the MCP listener has a token');
  t.equal((await hub.rawRequest({ method: 'POST', route: TRUST, headers: { ...good, authorization: `Bearer ${token}` }, body })).status, 401, 'the token of an MCP client is not the secret of the Hub');
  for (const headers of [{}, { authorization: `Bearer ${randomBytes(32).toString('hex')}` }, { authorization: hub.authorization }, { authorization: `Bearer ${token}` }]) {
    for (const [method, route] of [['POST', TRUST], ['POST', REVOKE], ['GET', SHOW]]) {
      const answer = await new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: mcpPort, method, path: route, headers: { 'content-type': 'application/json', ...headers } }, (response) => { let text = ''; response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text })); });
        request.on('error', reject);
        request.end(method === 'POST' ? body : undefined);
      });
      t.check(answer.status >= 400 && !answer.text.includes('hub-acceptance'), `the MCP listener does not know ${method} ${route}`, `${answer.status}`);
    }
  }
  const profiles = await import('../lib/mcp/tool-profiles.mjs');
  t.check(JSON.stringify(profiles.PROFILE_TABLE).length > 500 && !/trust|acceptance/i.test(JSON.stringify(profiles.PROFILE_TABLE)), 'no profile serves a tool for it');

  // ---- the ACP agent and the Companion ------------------------------------------------------------------------------------------------------------
  for (const route of [TRUST, REVOKE]) t.check(FORBIDDEN_ROUTES.includes(route) && !ROUTES.some((entry) => entry.path === route) && !routeAllowed('POST', route) && !routeAllowed('POST', route, { owned: true }), `the ACP agent never calls ${route}`);
  t.check(!routeAllowed('GET', SHOW, { owned: true }) && !routeAllowed('GET', `/api/tasks/${task.id}/proof`, { owned: true }), 'nor the reading ones');
  const companion = { origin: `chrome-extension://${'a'.repeat(32)}`, 'content-type': 'application/json' };
  const code = (await hub.post('/api/browser/pair-code')).code;
  const paired = JSON.parse((await hub.rawRequest({ method: 'POST', route: '/api/browser/clients/pair', headers: companion, body: JSON.stringify({ code, clientId: '123e4567-e89b-42d3-a456-426614174000', extensionId: 'a'.repeat(32) }) })).text);
  t.check(/^[0-9a-f]{64}$/.test(paired.token ?? ''), '(premise) a Companion is paired');
  for (const token of [paired.token, 'd'.repeat(64)]) {
    const headers = { ...companion, authorization: `Bearer ${token}`, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': csrf };
    for (const route of [TRUST, REVOKE]) t.check([401, 403].includes((await hub.rawRequest({ method: 'POST', route, headers, body })).status), `the Companion's token opens no ${route}`);
    t.check([401, 403].includes((await hub.rawRequest({ route: SHOW, headers: { ...companion, authorization: `Bearer ${token}` } })).status), 'nor the file');
  }
  t.equal([trusted(), (await show()).trusted], [[], false], 'nothing is trusted at the end');
});
