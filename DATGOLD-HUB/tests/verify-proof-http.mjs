// Proof packs over HTTP (plan task P5 pod-33, docs/PROOF-HUB-API.md): a real Hub process on a free port (never 3007) with its own state folder, the real command line
// `chatmcp verify`, real check commands, a scripted model behind the strict mock. What must hold:
//   1. a run that ends with a final answer under a trusted acceptance file leaves a pack that `chatmcp verify check` accepts; a run without one says why (a closed reason)
//   2. GET /api/tasks/:id/proof in json (receipts paged), md and html (vi, en), behind the bearer, Host and Origin like every route; what it refuses, and its headers
//   3. the summary of the task and of the list
//   4. the owner's acceptance of an objective: a stale receipt, one the ledger does not hold, or a ledger that does not verify is refused with 409
//   5. a pack edited or swapped on disk is an error, never shown; a pack goes with its task
//   6. a second chat in its own worktree; a Hub killed while a pack is built; a ledger of ten thousand receipts
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findNeedles, runScenario } from './e2e/harness.mjs';
import { HUB_ROOT, cleanEnvironment, connectModel, continueTask, setMode, startTask, waitFor, waitForState } from './e2e/hub-process.mjs';
import { call, say, shaOf } from './e2e/scenarios.mjs';
import { git, gitInit } from './e2e/fixtures.mjs';
import { ledgerPath } from '../lib/proof/ledger.mjs';
import { CSP } from '../lib/proof/render/html.mjs';
import { statementDigest } from '../lib/proof/pack.mjs';

const BUGGY = 'exports.add = (a, b) => a - b;\n';
const TEST = "const assert = require('node:assert');\nconst { add } = require('./calc.js');\nassert.equal(add(2, 3), 5);\nconsole.log('OK');\n";
// Waits for a file beside the project (a task that is busy while another one runs).
const HOLD = "const fs = require('node:fs'); const path = require('node:path'); const go = path.join(__dirname, '..', 'go'); const at = Date.now(); const look = () => (fs.existsSync(go) || Date.now() - at > 60000 ? process.exit(0) : setTimeout(look, 50)); look();\n";
// The criterion holds a secret the Hub knows (the key of the model connection) and markup.
const SECRET = 'zebraplumquartz0042';
const ACCEPT = `version: 1\ncriteria:\n  - id: tests\n    text: "The tests pass, not ${SECRET}, <img src=x onerror=alert(1)>."\n    checks:\n      - run: "node calc.test.js"\n`;
const GOAL = 'Read calc.js and find out why add() returns the wrong sum; then fix it with the smallest change and run the project tests; finally review the Git diff and report what is still limited.';
const has = (ctx, word) => ctx.users.some((text) => text.includes(word));
const latest = (ctx, word) => ctx.prompt.includes(word);
const fixSteps = (ctx) => {
  if (ctx.turn === 0) return call('read_file', { path: 'calc.js' });
  if (ctx.turn === 1) return call('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', expected_sha256: shaOf(ctx.last) });
  if (ctx.turn === 2) return call('git_diff', {});
  return say('Fixed add().');
};
const scenarios = {
  proof(ctx) {
    if (latest(ctx, '[ask]')) return say('It was the sign.');
    if (latest(ctx, '[hold]')) return ctx.turn === 0 ? call('run_command', { command: 'node hold.js', description: 'wait' }) : say('Waited.');
    if (has(ctx, '[passes]')) return fixSteps(ctx);
    return say('It is done.');
  },
};

await runScenario({
  name: 'proof-http', budgetMs: 172_000,
  summary: 'packs at the end of a run, the proof route in three formats, accept-criterion against the ledger, edited packs, a second chat, a killed Hub, a long ledger',
}, async (t) => {
  const project = path.join(t.scratch, 'calc-app');
  const reset = () => {
    fs.mkdirSync(path.join(project, '.chatmcp'), { recursive: true });
    fs.writeFileSync(path.join(project, 'calc.js'), BUGGY);
    fs.writeFileSync(path.join(project, 'calc.test.js'), TEST);
  };
  reset();
  fs.writeFileSync(path.join(project, 'hold.js'), HOLD);
  gitInit(project, t.scratch);
  const mock = await t.mock({ scenario: 'proof', scenarios });
  let hub = await t.hub({ project });
  t.check(hub.port !== 3007, 'the Hub is not on the owner\'s port');
  await connectModel(hub, mock);
  await hub.post('/api/ai/config', { preset: 'ollama', apiBaseUrl: mock.url, model: 'test-model', apiKey: SECRET });
  await setMode(hub, 'autonomous');
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(HUB_ROOT, 'bin', 'chatmcp.mjs'), 'verify', ...args, '--json'], { cwd: t.scratch, encoding: 'utf8', windowsHide: true, env: cleanEnvironment(t.scratch, { CHATMCP_STATE_DIR: path.join(t.scratch, 'cli-state') }) });
    return { code: result.status, json: JSON.parse(result.stdout) };
  };
  const proofOf = (id, query = '') => hub.rawRequest({ route: `/api/tasks/${id}/proof${query}`, headers: hub.authHeaders });
  const json = (answer) => JSON.parse(answer.text);
  const packs = (id, stateDir = hub.stateDir) => { try { return fs.readdirSync(path.join(stateDir, 'proof', 'packs', id)).map((name) => path.join(stateDir, 'proof', 'packs', id, name)); } catch { return []; } };
  const settled = (id) => waitFor(async () => { const task = await hub.task(id); return task.proof && !['building'].includes(task.proof.status) && task.proof.reason !== 'run_in_progress' ? task : null; }, { timeoutMs: 60_000, label: 'the proof of the task to settle' });
  async function play(prompt, { id = null } = {}) {
    const started = id ? await continueTask(hub, id, prompt) : await startTask(hub, prompt);
    await waitForState(hub, started.id, ['completed', 'failed', 'paused', 'cancelled'], { timeoutMs: 60_000 });
    return settled(started.id);
  }
  const accept = (body) => hub.request('POST', '/api/tasks/accept-criterion', body);

  // ---- no acceptance file -------------------------------------------------------------------------------------------------
  const none = await play('Say hello.');
  t.equal([none.proof.status, none.proof.reason, none.proof.run, none.proof.digest, none.proof.verdict], ['none', 'no_acceptance', 1, null, null], 'a run without an acceptance file: no pack, and why');
  const noPack = await proofOf(none.id);
  t.equal([noPack.status, json(noPack).code, json(noPack).reason], [404, 'no_pack', 'no_acceptance'], 'and the route says the same');
  t.equal(packs(none.id), [], 'nothing was written');

  // ---- a trusted file: a pack ------------------------------------------------------------------------------------------------
  fs.writeFileSync(path.join(project, '.chatmcp', 'acceptance.yml'), ACCEPT);
  git(project, t.scratch, ['add', '-A']);
  git(project, t.scratch, ['commit', '-q', '-m', 'acceptance']);
  const untrusted = await play('Say hello again.');
  t.equal([untrusted.proof.status, untrusted.proof.reason], ['none', 'acceptance_untrusted'], 'an acceptance file nobody trusted: no pack');
  const shown = (await hub.get('/api/proof/acceptance')).json;
  t.equal([shown.state, shown.trusted, shown.criteria[0].checks[0].run], ['present', false, 'node calc.test.js'], 'the acceptance file as the owner is shown it');
  t.equal((await hub.request('POST', '/api/proof/trust-acceptance', { sha256: shown.sha256 })).status, 200, 'the owner trusts it');

  const startedBusy = await startTask(hub, `[passes] ${GOAL}`);
  const during = [];
  await waitFor(async () => { const task = await hub.task(startedBusy.id); if (task.proof) during.push(`${task.proof.status}/${task.proof.reason}`); return task.proof?.status === 'ready' ? task : null; }, { timeoutMs: 60_000, intervalMs: 15, label: 'the pack' });
  const one = await hub.task(startedBusy.id);
  t.check(during.includes('none/run_in_progress'), 'while the run goes on the summary says so', [...new Set(during)].join(' '));
  t.equal([one.state, one.proofGate.status], ['completed', 'passed'], '(premise) the run passed its gate');
  t.equal([one.proof.status, one.proof.reason, one.proof.run, one.proof.verdict, one.proof.counts, one.proof.checksModified, one.proof.coverage, one.proof.earlier],
    ['ready', null, 1, 'evidenced', { evidenced: 1, owner_accepted: 0, unverified: 0, failed: 0, stale: 0, checks_modified: 0 }, false, 'task', null], 'the summary: verdict, counts by status, checks, coverage');
  t.check(/^[0-9a-f]{64}$/.test(one.proof.digest) && !Number.isNaN(Date.parse(one.proof.at)), 'with the digest and the time');
  const listed = (await hub.state()).agent.tasks.find((task) => task.id === one.id);
  t.equal(listed.proof, { status: 'ready', reason: null, run: 1, verdict: 'evidenced' }, 'the list shows a smaller summary');
  t.equal(one.events.filter((event) => event.type === 'proof_pack').map((event) => event.pack), ['ready'], 'one event says the pack is there');
  const [stored, ...more] = packs(one.id);
  t.equal([more, path.basename(stored)], [[], `${one.proof.digest.slice(0, 16)}.pack.json`], 'one file, under the Hub\'s proof folder, named by its digest');
  t.check(!fs.existsSync(path.join(project, '.chatmcp', 'packs')) && git(project, t.scratch, ['status', '--porcelain']).stdout.trim() === 'M calc.js', 'nothing was written into the workspace');
  if (process.platform !== 'win32') t.equal(fs.statSync(stored).mode & 0o777, 0o600, 'readable by its owner only');
  const checked = cli('check', stored);
  t.equal([checked.code, checked.json.code, checked.json.data.digest], [0, 'pack_verified', one.proof.digest], 'chatmcp verify check accepts the pack the Hub wrote');

  // ---- json ------------------------------------------------------------------------------------------------------------------
  const asJson = await proofOf(one.id);
  t.equal([asJson.status, asJson.headers['content-type'], asJson.headers['cache-control'], asJson.headers['x-content-type-options']], [200, 'application/json; charset=utf-8', 'no-store', 'nosniff'], 'json is the default');
  const page = json(asJson);
  const pack = JSON.parse(fs.readFileSync(stored, 'utf8'));
  const ledgerEnd = fs.readFileSync(ledgerPath(hub.stateDir, one.id), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).findLast((entry) => entry.type === 'tree' && entry.record.event === 'task_end').record.tree;
  t.equal([page.taskId, page.run, page.digest, page.proof], [one.id, 1, one.proof.digest, one.proof], 'the task, the run, the digest and the summary');
  t.equal(page.statement.subject.find((subject) => subject.name === 'workspace-tree-after').digest.gitTree, ledgerEnd.tree, 'the pack\'s final tree is the tree the run ended on');
  t.equal([page.statement.predicate.agent.name, page.statement.predicate.model.id, page.statement.predicate.cost], ['DatGold', 'test-model', 'unknown'], 'the agent, the model, a cost that is not known');
  t.check(!('receipts' in page.statement.predicate), 'the receipts are not in the statement of the answer');
  t.equal([page.receipts.total, page.receipts.from, page.receipts.items.length, page.receipts.next, page.receipts.omitted], [pack.statement.predicate.receipts.length, 0, pack.statement.predicate.receipts.length, null, 0], 'they are a page beside it');
  t.equal(statementDigest({ ...page.statement, predicate: { ...page.statement.predicate, receipts: page.receipts.items } }), one.proof.digest, 'statement and receipts together are the statement of the digest');
  t.equal(page.files.map((file) => file.name), ['acceptance.yml', 'change.diff', 'ledger.jsonl'], 'the files of the pack by name, size and sha256, not their bytes');
  t.check(!asJson.text.includes(SECRET), 'no registered secret in the answer');

  // ---- md and html -----------------------------------------------------------------------------------------------------------
  const md = await proofOf(one.id, '?format=md&lang=vi');
  const mdEn = await proofOf(one.id, '?format=md&lang=en');
  t.equal([md.status, md.headers['content-type'], md.headers['content-disposition']], [200, 'text/markdown; charset=utf-8', `attachment; filename="DATGOLD-PROOF-${one.id}.md"`], 'md is a download');
  t.check(md.text.includes(one.proof.digest) && mdEn.text.includes(one.proof.digest) && md.text !== mdEn.text, 'in Vietnamese and in English, with the digest');
  t.check(mdEn.text.includes('The pack file was checked') || /pack file was checked/i.test(mdEn.text), 'it says the pack was checked', mdEn.text.slice(0, 600));
  const html = await proofOf(one.id, '?format=html&lang=en');
  t.equal([html.status, html.headers['content-type'], html.headers['content-disposition'], html.headers['x-content-type-options'], html.headers['cache-control'], html.headers['referrer-policy']],
    [200, 'text/html; charset=utf-8', `attachment; filename="DATGOLD-PROOF-${one.id}.html"`, 'nosniff', 'no-store', 'no-referrer'], 'html is a download that nothing sniffs or caches');
  t.equal(html.headers['content-security-policy'], `sandbox; ${CSP}`, 'with a policy of its own: sandboxed, no script, nothing loaded');
  t.equal(html.headers['cross-origin-resource-policy'], 'same-origin', 'no other origin can embed it');
  t.check(html.text.startsWith('<!doctype html>\n<html lang="en">') && !html.text.includes('<img') && html.text.includes('&lt;img src=x'), 'a text of the pack is text, not markup');
  for (const [name, answer] of [['md', md], ['md en', mdEn], ['html', html]]) t.check(!answer.text.includes(SECRET) && answer.text.includes('REDACTED'), `no registered secret in the ${name} answer`);
  t.equal((await proofOf(one.id, '?format=html')).text.includes('<html lang="vi">'), true, 'Vietnamese is the default language');

  // ---- who may read it, and what is refused ----------------------------------------------------------------------------------------
  const bare = await hub.rawRequest({ route: `/api/tasks/${one.id}/proof` });
  t.equal([bare.status, json(bare).code], [401, 'hub_auth_required'], '401 without the bearer');
  t.equal((await hub.rawRequest({ route: `/api/tasks/${one.id}/proof?format=html`, headers: { authorization: `Bearer ${'a'.repeat(64)}` } })).status, 401, 'and with a wrong one');
  t.equal((await hub.rawRequest({ route: `/api/tasks/${one.id}/proof`, headers: { ...hub.authHeaders, host: 'evil.example' } })).status, 403, 'another Host is refused');
  t.equal((await hub.rawRequest({ route: `/api/tasks/${one.id}/proof`, headers: { ...hub.authHeaders, origin: 'https://evil.example' } })).status, 403, 'another Origin is refused');
  t.equal((await hub.rawRequest({ route: `/api/tasks/${one.id}/proof`, headers: { ...hub.authHeaders, origin: `chrome-extension://${'a'.repeat(32)}` } })).status, 403, 'the Companion\'s origin is refused');
  t.equal((await hub.request('POST', `/api/tasks/${one.id}/proof`, {})).status, 404, 'there is no POST of it');
  const BAD = ['format=pdf', 'format=', 'format=json&format=md', 'lang=fr', 'lang=EN', 'from=-1', 'from=1.5', 'from=1e3', 'from=99999999999999999999', 'from=', 'limit=0', 'limit=201', 'limit=abc', 'limit=0x10', 'run=0', 'run=-1', 'run=x',
    'format=md&from=0', 'format=html&limit=5', 'path=..%2f..%2f', 'id=1', 'Format=json', '__proto__=1', 'format=json%00'];
  const answers = [];
  for (const query of BAD) { const answer = await proofOf(one.id, `?${query}`); answers.push(`${query}:${answer.status}:${answer.status === 400 ? json(answer).code : ''}`); }
  t.equal(answers, BAD.map((query) => `${query}:400:bad_query`), 'unknown formats, languages, keys and numbers are 400');
  t.equal([(await proofOf(one.id, '?from=999999999')).status, json(await proofOf(one.id, '?from=999999999')).receipts], [200, { total: page.receipts.total, omitted: 0, from: 999999999, limit: 50, next: null, items: [] }], 'a page past the end is empty');
  const HOSTILE = ['00000000-0000-4000-8000-000000000000', '-'.repeat(36), '..%2f..%2f..%2f..%2f..%2f..%2f..%2fsecret', '..\\..\\x', 'CON', `${one.id}%00`, `${one.id}.pack.json`, one.id.toUpperCase(), `${one.id}/../${none.id}`];
  for (const id of HOSTILE) { const answer = await proofOf(id); t.check([404, 400].includes(answer.status) && !answer.text.includes('statement'), `no pack under the id ${JSON.stringify(id.slice(0, 24))}`, `${answer.status} ${answer.text.slice(0, 80)}`); }
  t.equal(json(await proofOf(HOSTILE[0])).code, 'task_not_found', 'an unknown task says so');

  // ---- accept-criterion: the receipts are held to the ledger -----------------------------------------------------------------------
  const objective = one.goalPlan.objectives[0];
  const receipt = (task, kind) => task.objectiveReceipts.find((item) => item.kind === kind);
  t.check(objective && receipt(one, 'edit') && receipt(one, 'verify') && receipt(one, 'review'), '(premise) fresh receipts of an edit, a check and a review', JSON.stringify(one.objectiveReceipts));
  const criterionOf = (kind) => objective.acceptanceCriteria.findIndex((text) => text.startsWith({ inspect: 'Observe', edit: 'If code', verify: 'Run required' }[kind]));
  const bodyFor = (task, kind) => ({ id: task.id, objectiveId: objective.id, criterionIndex: criterionOf(kind), receiptId: receipt(task, kind).receiptId, confirmed: true });
  const ledgerFile = ledgerPath(hub.stateDir, one.id);
  const ledgerBytes = fs.readFileSync(ledgerFile);
  fs.writeFileSync(ledgerFile, ledgerBytes.subarray(0, ledgerBytes.length - 200));
  const torn = await accept(bodyFor(one, 'edit'));
  t.equal([torn.status, torn.json.code], [409, 'acceptance_ledger_unreadable'], 'a ledger that does not verify: nothing is accepted');
  fs.rmSync(ledgerFile);
  t.equal([(await accept(bodyFor(one, 'edit'))).json.code, (await accept(bodyFor(one, 'verify'))).status], ['acceptance_ledger_unreadable', 409], 'no ledger: nothing is accepted');
  // a ledger that verifies and holds no record of these receipts (its first records only)
  const firstLines = ledgerBytes.toString('utf8').split('\n').slice(0, 2).join('\n') + '\n';
  fs.writeFileSync(ledgerFile, firstLines);
  t.equal([(await accept(bodyFor(one, 'edit'))).json.code, (await accept(bodyFor(one, 'verify'))).json.code], ['stale_acceptance_receipt', 'stale_acceptance_receipt'], 'the ledger\'s last tree is another one: the receipt is stale for it');
  fs.writeFileSync(ledgerFile, ledgerBytes);
  t.equal((await hub.task(one.id)).goalPlan.objectives[0].evidence ?? [], [], 'none of the refused acceptances left anything');
  const [okEdit, okVerify] = [await accept(bodyFor(one, 'edit')), await accept(bodyFor(one, 'verify'))];
  t.equal([okEdit.status, okVerify.status, okVerify.json.task.goalPlan.objectives[0].evidence.length], [200, 200, 2], 'a current receipt of the ledger is accepted, as before');

  // ---- later runs of the conversation ----------------------------------------------------------------------------------------------
  await setMode(hub, 'readonly');
  const asked = await play('[ask] What was it?', { id: one.id });
  t.equal([asked.proof.status, asked.proof.reason, asked.proof.run, asked.proof.digest], ['none', 'readonly', 2, null], 'a Read Only run has no pack');
  t.equal([asked.proof.earlier.run, asked.proof.earlier.digest, asked.proof.earlier.verdict], [1, one.proof.digest, 'evidenced'], 'the pack of the earlier run is kept and named as that');
  const gone = await proofOf(one.id);
  t.equal([gone.status, json(gone).reason, json(gone).earlierRun], [404, 'readonly', 1], 'it is not served as the pack of the last run');
  t.equal([(await proofOf(one.id, '?run=1')).status, json(await proofOf(one.id, '?run=1')).run, (await proofOf(one.id, '?run=2')).status, (await proofOf(one.id, '?run=7')).status], [200, 1, 404, 404], 'it is served when asked for by its run');
  await setMode(hub, 'autonomous');
  fs.writeFileSync(path.join(project, 'notes.txt'), 'edited by the person\n');
  const late = await play('[ask] And now?', { id: one.id });
  t.equal([late.proof.status, late.proof.run, late.proof.verdict, late.proof.earlier], ['ready', 3, 'evidenced', null], 'the next run that is judged has a pack of its own');
  t.equal(packs(one.id).map((file) => path.basename(file)), [`${late.proof.digest.slice(0, 16)}.pack.json`], 'which replaces the earlier one');
  t.check(late.proof.digest !== one.proof.digest, '(premise) another tree, another pack');
  const stale = await accept(bodyFor(one, 'edit'));
  t.equal([stale.status, stale.json.code], [409, 'stale_acceptance_receipt'], 'a receipt of the tree that is gone is refused');

  // ---- a failed run --------------------------------------------------------------------------------------------------------------------
  reset();
  const failed = await play('It is done, says the model.');
  t.equal([failed.proof.status, failed.proof.verdict, failed.proof.counts.failed, failed.completionOutcome.requirements], ['ready', 'failed', 1, 'failed'], 'a run whose checks failed has a pack that says so');
  const failedFile = packs(failed.id)[0];
  t.equal([cli('check', failedFile).code, cli('check', failedFile).json.code], [1, 'pack_not_evidenced'], 'chatmcp verify check reads it too');

  // ---- a pack edited or swapped on disk ------------------------------------------------------------------------------------------------
  const good = fs.readFileSync(failedFile);
  const flipped = Buffer.from(good);
  const at = flipped.indexOf('"failed"');
  flipped.write('"passed"', at);
  const tampered = [['one word changed', flipped], ['cut short', good.subarray(0, good.length - 100)], ['empty', Buffer.alloc(0)], ['not JSON', Buffer.from('<script>alert(1)</script>')], ['the pack of another task', fs.readFileSync(packs(one.id)[0])]];
  for (const [label, bytes] of tampered) {
    fs.writeFileSync(failedFile, bytes);
    const got = [];
    for (const format of ['json', 'md', 'html']) { const answer = await proofOf(failed.id, `?format=${format}`); got.push(answer.status, json(answer).code, answer.headers['content-type']); t.check(!answer.text.includes('<script>') && !answer.text.includes('predicate'), `${label}: nothing of it is shown (${format})`); }
    t.equal(got, ['json', 'md', 'html'].flatMap(() => [409, 'pack_not_verified', 'application/json; charset=utf-8']), `${label}: an error, in every format`);
  }
  fs.rmSync(failedFile);
  t.equal([(await proofOf(failed.id)).status, json(await proofOf(failed.id)).reason], [404, 'pack_missing'], 'a pack that was removed is not there');
  fs.mkdirSync(failedFile);
  t.equal([(await proofOf(failed.id)).status, json(await proofOf(failed.id)).code], [409, 'pack_not_verified'], 'a folder in its place is no pack');
  fs.rmdirSync(failedFile);
  fs.writeFileSync(failedFile, good);
  t.equal((await proofOf(failed.id)).status, 200, 'the right bytes are served again');

  // ---- two tasks at once: the second chat has its own worktree -------------------------------------------------------------------------
  reset();
  git(project, t.scratch, ['checkout', '-q', '--', '.']);
  const holding = await startTask(hub, '[hold] Wait for me.');
  await waitFor(async () => (await hub.task(holding.id)).pendingCall, { timeoutMs: 30_000, label: 'the first task to be busy' });
  const second = await play(`[passes] ${GOAL}`);
  t.check(second.worktree && second.id !== holding.id, '(premise) the second chat has its own worktree');
  t.equal([second.proof.status, second.proof.verdict, second.proofGate.status], ['ready', 'evidenced', 'passed'], 'the second chat has a pack');
  t.equal([(await proofOf(second.id)).status, packs(second.id).length, cli('check', packs(second.id)[0]).code], [200, 1, 0], 'the route finds it, in the Hub\'s own folder, and the command line accepts it');
  fs.writeFileSync(path.join(t.scratch, 'go'), '1');
  await waitForState(hub, holding.id, ['completed'], { timeoutMs: 30_000 });
  const held = await settled(holding.id);
  t.equal([held.proof.status, held.proof.verdict], ['ready', 'failed'], 'and so has the first, of its own checkout');

  // ---- a pack goes with its task -----------------------------------------------------------------------------------------------------------
  await hub.post('/api/tasks/delete', { id: failed.id });
  await hub.post('/api/tasks/delete', { id: second.id });
  t.equal([packs(failed.id), packs(second.id), (await proofOf(failed.id)).status, (await proofOf(second.id)).status], [[], [], 404, 404], 'deleting a task removes its pack');

  // ---- a Hub killed while a pack is built; a long ledger ----------------------------------------------------------------------------------------
  const killed = await startTask(hub, 'It is done, says the model again.');
  await waitFor(async () => (await hub.task(killed.id)).proof?.status === 'building', { timeoutMs: 60_000, intervalMs: 5, label: 'the pack to be built' });
  hub.killTree();
  await hub.exited;
  // ten thousand more receipts in the ledger of the killed task (as a long task would have), chained as the Hub chains them
  const file = ledgerPath(hub.stateDir, killed.id);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let { seq, hash } = JSON.parse(lines.at(-1));
  const sample = lines.map((line) => JSON.parse(line)).find((entry) => entry.type === 'check').record;
  const extra = [];
  for (let n = 0; n < 10_000; n += 1) {
    const record = { ...sample, command: `node other-${n}.js`, commandSha256: createHash('sha256').update(`node other-${n}.js`).digest('hex') };
    const text = JSON.stringify({ v: 2, seq: (seq += 1), prev: hash, ts: '2026-11-25T00:00:00.000Z', type: 'check', record });
    hash = createHash('sha256').update(text).digest('hex');
    extra.push(`${text.slice(0, -1)},"hash":"${hash}"}`);
  }
  fs.appendFileSync(file, `${extra.join('\n')}\n`);
  hub = await t.hub({ project, stateDir: hub.stateDir });
  const after = await hub.task(killed.id);
  t.equal([after.state, after.proof.status, after.proof.reason, after.proof.digest], ['completed', 'none', 'interrupted', null], 'a Hub killed while a pack was built: no pack, and it says why');
  t.check(!packs(killed.id).some((name) => name.endsWith('.pack.json')) || (await proofOf(killed.id)).status === 404, 'nothing half-written is served');
  await setMode(hub, 'autonomous');
  const long = await play('It is done, once more.', { id: killed.id });
  t.equal([long.proof.status, long.proof.verdict], ['ready', 'failed'], 'the next run has its pack, over a ledger of ten thousand receipts');
  const began = Date.now();
  const first = json(await proofOf(killed.id, '?limit=200'));
  t.check(first.receipts.items.length === 200 && first.receipts.next === 200 && first.receipts.total > 1000 && first.receipts.omitted >= 9000, 'its receipts come in pages', JSON.stringify({ ...first.receipts, items: first.receipts.items.length }));
  const walked = [...first.receipts.items];
  for (let from = first.receipts.next; from !== null;) { const next = json(await proofOf(killed.id, `?from=${from}&limit=200`)).receipts; walked.push(...next.items); from = next.next; }
  t.equal([walked.length, new Set(walked.map((item) => item.seq)).size], [first.receipts.total, first.receipts.total], 'each receipt once');
  t.note(`all pages of ${first.receipts.total} receipts: ${Date.now() - began} ms`);
  t.equal([(await proofOf(killed.id, '?format=html&lang=en')).status, cli('check', packs(killed.id)[0]).json.code], [200, 'pack_not_evidenced'], 'the report and the command line read it');
  t.equal((await hub.get('/api/health')).status, 200, 'the Hub is well');
  const leaks = findNeedles(path.join(hub.stateDir, 'proof', 'packs'), [SECRET]);
  t.note(`pack files that hold the secret in their raw files (the acceptance bytes of the project): ${leaks.hits.length} of ${leaks.scanned}`);
  const stopping = Date.now();
  await hub.stop();
  t.check(Date.now() - stopping < 8000, 'a Hub stops without waiting for packs');
});
