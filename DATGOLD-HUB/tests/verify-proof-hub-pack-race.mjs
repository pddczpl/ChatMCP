// What removes a baseline of the done-gate, against a build of a proof pack that reads there (plan task P5 pod-33, docs/PROOF-HUB-API.md, "Baselines and builds"), with the rig of
// verify-proof-gate-agent.mjs: the real HubManager, AgentRunner, done-gate, baseline store and pack builder on temporary projects; only the model is scripted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { acquireWorkspaceLock, loadBaseline, workspaceKey } from '../lib/proof/baseline.mjs';
import { storeSide } from '../lib/proof/cli/store-side.mjs';
import { findGit } from '../lib/proof/git-plumbing.mjs';
import { buildHubPack, giveWay, HubPacks } from '../lib/proof/hub-pack.mjs';
import { workTreeSide } from '../lib/proof/tamper.mjs';
import { ACCEPT, check, count, createHub, done, equal, packSettled, project, root, run as runOnly, scripted, section, sleep, TEST, trust, until, write } from './support/proof-gate-rig.mjs';

const settled = packSettled;
/** A run that does not wait for its pack: what goes on behind it is what these tests look at. */
const run = (manager, dir, steps, options = {}) => runOnly(manager, dir, steps, { settle: false, ...options });
const files = (manager, id) => { try { return fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'packs', id)).map((name) => path.join(manager.hubDirectory, 'proof', 'packs', id, name)); } catch { return []; } };
/** A project whose checks pass as it is. */
const good = (name, { files: more = {}, ...options } = {}) => project(name, { ...options, files: { 'calc.js': 'exports.add = (a, b) => a + b;\n', ...more } });
const taskFile = (manager, id) => path.join(manager.hubDirectory, 'api-tasks', id, 'task.json');

try {
  const manager = await createHub('main');
  await trust(manager, ACCEPT());

  const baselines = path.join(manager.hubDirectory, 'proof', 'gate', 'proof', 'baselines');
  const folderOf = (dir) => path.join(baselines, workspaceKey(dir));
  const listing = (dir) => { try { return fsSync.readdirSync(folderOf(dir)).sort(); } catch { return []; } };
  const baselineOf = (id) => JSON.parse(fsSync.readFileSync(taskFile(manager, id), 'utf8')).proofBaseline.id;
  const runner = async (prepare) => { const agent = new AgentRunner({ manager, provider: scripted([]), taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} }); await agent.load(); prepare(agent); return agent; };

  const locked = await good('locked');
  let held;
  await section('1. the report of a pack reads the store of the baseline under the lock of the workspace, and stops when the build is given up', async () => {
    const seen = [];
    const asked = new Set();
    let reporting = false; // (the patch is made with the same signal, after the report)
    const spy = (signal) => {
      for (const name of ['addEventListener', 'throwIfAborted']) {
        const own = signal[name].bind(signal);
        signal[name] = (...args) => { for (const file of ['store-side.mjs', 'tree-snapshot.mjs']) if (reporting && new Error().stack.includes(file)) asked.add(file); return own(...args); };
      }
    };
    const watched = await runner((agent) => {
      const { checkChanges } = agent.doneGate.deps;
      agent.doneGate.deps.checkChanges = async (options) => {
        if (!options.scratchDir) return checkChanges(options);
        seen.push({ lock: listing(locked).includes('lock'), signal: options.signal instanceof AbortSignal });
        if (options.signal) spy(options.signal);
        reporting = true;
        try { return await checkChanges(options); } finally { reporting = false; }
      };
    });
    held = await run(manager, locked, [write('calc.test.js', `${TEST}// more\n`), done], { runner: watched, prompt: 'Look around.' });
    equal((await settled(held.agent, held.id)).status, 'ready');
    equal(seen, [{ lock: true, signal: true }], 'the build holds the lock of the workspace while it reads the store, and hands its signal on');
    equal([...asked].sort(), ['store-side.mjs', 'tree-snapshot.mjs'], 'the store and the pass over the workspace ask it');
    equal(listing(locked).filter((name) => name === 'lock' || name.startsWith('tmp-')), [], 'and gives it back');
    const stopped = AbortSignal.abort(Object.assign(new Error('stop'), { code: 'stop' }));
    await assert.rejects(workTreeSide({ root: locked, stateDir: path.join(root, 'side'), signal: stopped }), { code: 'stop' });
    const later = new AbortController();
    const tree = await workTreeSide({ root: locked, stateDir: path.join(root, 'side'), signal: later.signal });
    later.abort(Object.assign(new Error('stop'), { code: 'stop' }));
    await assert.rejects(tree.read(['calc.js']), { code: 'stop' });
    const { entries, record } = await loadBaseline({ hubDir: path.join(manager.hubDirectory, 'proof', 'gate'), root: locked, id: baselineOf(held.id) });
    const side = await storeSide({ git: await findGit(), storeDir: path.join(folderOf(locked), record.store.directory), entries, objectFormat: record.objectFormat, scratch: path.join(root, 'store-side'), signal: stopped });
    await assert.rejects(side.read(['calc.js']), { code: 'stop' });
  });

  await section('2. the delete of a conversation takes the lock: whoever holds it reads or writes there', async () => {
    const lock = await acquireWorkspaceLock({ hubDir: path.join(manager.hubDirectory, 'proof', 'gate'), root: locked, purpose: 'test' });
    const id = baselineOf(held.id);
    const deleting = held.agent.delete(held.id);
    await sleep(500);
    equal(listing(locked).filter((name) => name.startsWith(id)), [`${id}.git`, `${id}.json`], 'nothing is removed while somebody holds it');
    await lock.release();
    await deleting;
    equal(listing(locked), [], 'then the baseline goes');
    // but not for ever
    const busy = await good('busy');
    const kept = await run(manager, busy, [done], { runner: await runner((agent) => { agent.doneGate.forgetWaitMs = 300; }), prompt: 'Look around.' });
    await settled(kept.agent, kept.id);
    const other = await acquireWorkspaceLock({ hubDir: path.join(manager.hubDirectory, 'proof', 'gate'), root: busy, purpose: 'test' });
    const began = Date.now();
    await kept.agent.delete(kept.id);
    check(Date.now() - began < 5000, 'a delete does not wait for ever');
    equal(listing(busy), ['lock'], 'and takes its own baseline all the same');
    await other.release();
    // a workspace whose baselines somebody removed by hand
    const bare = await run(manager, await good('bare'), [done], { prompt: 'Look around.' });
    await settled(bare.agent, bare.id);
    await fs.rm(folderOf(manager.workspace), { recursive: true });
    await bare.agent.delete(bare.id);
    check(!fsSync.existsSync(folderOf(manager.workspace)), 'a delete makes no folder there');
  });

  await section('3. a build that was given up comes to its end a moment later: who waits for that, and who does not', async () => {
    const late = (ended) => (agent) => { agent.packs.deps = { ...agent.packs.deps, build: async ({ signal }) => { await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); }); await sleep(700); ended.push('build'); throw signal.reason; } }; };
    const [inDelete, inStop] = [[], []];
    const one = await run(manager, await good('late-delete'), [done], { runner: await runner(late(inDelete)), prompt: 'Look around.' });
    await one.agent.delete(one.id);
    inDelete.push('deleted');
    equal(inDelete, ['build', 'deleted'], 'a delete waits for the end of the build');
    const two = await run(manager, await good('late-stop'), [done], { runner: await runner(late(inStop)), prompt: 'Look around.' });
    await two.agent.shutdown();
    inStop.push('stopped');
    equal(inStop, ['build', 'stopped'], 'and so does a stop of the Hub');
    // a run that takes a baseline in the same workspace waits too
    const inBaseline = [];
    const three = await run(manager, await good('late-baseline'), [done], { runner: await runner((agent) => { late(inBaseline)(agent); agent.packs.limits = { ...agent.packs.limits, giveWayMs: 2000 }; }), prompt: 'Look around.' });
    const taking = await runner((agent) => { const { snapshotBaseline } = agent.doneGate.deps; agent.doneGate.deps.snapshotBaseline = (options) => { inBaseline.push('baseline'); return snapshotBaseline(options); }; });
    const four = await run(manager, manager.workspace, [done], { runner: taking, prompt: 'Look around.' });
    equal([inBaseline, (await settled(three.agent, three.id)).reason, (await settled(four.agent, four.id)).status], [['build', 'baseline'], 'superseded', 'ready']);
    // a later run of the same conversation does not: its baseline is taken, and the lock orders the two builds
    let end;
    const again = await run(manager, await good('late-again'), [done], { runner: await runner((agent) => { agent.packs.limits = { ...agent.packs.limits, stopMs: 60_000 }; agent.packs.deps = { ...agent.packs.deps, build: () => new Promise((resolve) => { end = resolve; }) }; }), prompt: 'Look around.' });
    again.agent.packs.deps = { ...again.agent.packs.deps, build: buildHubPack };
    const ran = await Promise.race([run(manager, manager.workspace, [done], { runner: again.agent, id: again.id, prompt: 'Again.' }), sleep(30_000)]);
    check(ran, 'the end of a run does not wait for the end of the build of an earlier one');
    const late2 = await until(() => { const { proof } = again.agent.get(again.id); return proof.status === 'ready' ? proof : null; }, 'the pack of the later run');
    equal([late2.run, again.agent.packs.busy(again.id)], [2, true], 'it has its pack, and the build that was given up is not forgotten');
    end();
    await until(() => !again.agent.packs.busy(again.id), 'the end of it');
  });

  await section('4. giving way: the builds of the workspace, at most twice the limit, and none when the run that asks was stopped', async () => {
    const dir = await good('way');
    const results = {};
    const ended = [];
    const packs = new HubPacks({ manager, gate: null, log: () => {}, limits: { giveWayMs: 300 }, deps: { build: async ({ taskId, signal }) => {
      if (taskId === 'written') return { bytes: Buffer.alloc(0), facts: { digest: 'ab'.repeat(32) } };
      await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
      if (taskId === 'stuck') await new Promise((resolve) => { release = resolve; });
      else await sleep(150);
      ended.push(taskId);
      throw signal.reason;
    } } });
    let release;
    Object.defineProperty(packs, 'store', { value: { write: () => sleep(1500) } });
    const start = (taskId, root) => packs.start({ taskId, inputs: { root } }, async (result) => { results[taskId] = result.reason ?? 'ready'; });
    const before = new AbortController();
    const during = new AbortController();
    void start('late', dir);
    before.abort();
    await giveWay(dir, { signal: before.signal });
    setTimeout(() => during.abort(), 100);
    await giveWay(dir, { signal: during.signal });
    await giveWay(path.join(root, 'elsewhere'));
    await sleep(400);
    equal([ended, results], [[], {}], 'a run that was stopped gives up nothing, and a run elsewhere neither');
    const written = start('written', dir);
    await giveWay(dir);
    equal([ended, results.late], [['late'], 'superseded'], 'a build that goes on is given up, and has ended');
    await written;
    equal(results.written, 'ready', 'one that has its bytes is not: it needs the workspace no more');
    void start('stuck', dir);
    const began = Date.now();
    await giveWay(dir);
    check(Date.now() - began < 5000 && packs.busy('stuck'), 'a build that does not end is not waited for');
    equal(results.stuck, 'superseded');
    release();
    await until(() => !packs.busy('stuck'), 'its end');
  });

  await section('5. the real build, deleted in the middle: at once, while it makes the report, while it makes the patch', async () => {
    for (const [label, sign] of [['at once', () => true], ['in the report', () => fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'packs', 'scratch')).length > 0], ['in the patch', (dir) => listing(dir).some((name) => name.startsWith('tmp-'))]]) {
      for (let turn = 0; turn < 2; turn += 1) {
        const dir = await good(`middle-${label.replaceAll(' ', '-')}-${turn}`, { files: Object.fromEntries(Array.from({ length: 60 }, (_, n) => [`f${n}.txt`, `file ${n}\n`.repeat(50)])) });
        const gone = await run(manager, dir, [done], { prompt: 'Look around.' });
        const end = Date.now() + 2000;
        while (!sign(dir) && Date.now() < end) await new Promise((resolve) => { setImmediate(resolve); });
        await gone.agent.delete(gone.id);
        equal([listing(dir), fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'packs', 'scratch')), files(manager, gone.id)], [[], [], []], `deleted ${label}: nothing is left of the baseline, the build or the pack (${turn})`);
      }
    }
  });

  await manager.shutdown();
  console.log(`PASS: baselines and builds (${count()} checks)`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
