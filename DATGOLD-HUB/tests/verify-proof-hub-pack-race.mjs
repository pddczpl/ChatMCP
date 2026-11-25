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
import { workTreeSide } from '../lib/proof/tamper.mjs';
import { ACCEPT, check, count, createHub, done, equal, project, root, run, scripted, section, sleep, trust, until } from './support/proof-gate-rig.mjs';

const settled = (agent, id) => until(() => { const { proof } = agent.get(id); return proof && proof.status !== 'building' && proof.reason !== 'run_in_progress' && !agent.packs.running.has(id) ? proof : null; }, 'the proof to settle');
const files = (manager, id) => { try { return fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'packs', id)).map((name) => path.join(manager.hubDirectory, 'proof', 'packs', id, name)); } catch { return []; } };
/** A project whose checks pass as it is. */
const good = (name, { files: more = {}, ...options } = {}) => project(name, { ...options, files: { 'calc.js': 'exports.add = (a, b) => a + b;\n', ...more } });
const taskFile = (manager, id) => path.join(manager.hubDirectory, 'api-tasks', id, 'task.json');

try {
  const manager = await createHub('main');
  await trust(manager, ACCEPT());

  await section('what removes a baseline and a build that reads it: the lock of the workspace, and the end of a build that was given up', async () => {
    const baselines = path.join(manager.hubDirectory, 'proof', 'gate', 'proof', 'baselines');
    const folderOf = (dir) => path.join(baselines, workspaceKey(dir));
    const listing = (dir) => { try { return fsSync.readdirSync(folderOf(dir)).sort(); } catch { return []; } };
    const baselineOf = (id) => JSON.parse(fsSync.readFileSync(taskFile(manager, id), 'utf8')).proofBaseline.id;
    const runner = async (prepare) => { const agent = new AgentRunner({ manager, provider: scripted([]), taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} }); await agent.load(); prepare(agent); return agent; };
    // the report on the checks reads the baseline's store: under the lock, and it stops when the build is given up
    const seen = [];
    const locked = await good('locked');
    const watched = await runner((agent) => {
      const { checkChanges } = agent.doneGate.deps;
      agent.doneGate.deps.checkChanges = (options) => { if (options.scratchDir) seen.push({ lock: listing(locked).includes('lock'), signal: options.signal instanceof AbortSignal }); return checkChanges(options); };
    });
    const held = await run(manager, locked, [done], { runner: watched, prompt: 'Look around.' });
    equal((await settled(held.agent, held.id)).status, 'ready');
    equal(seen, [{ lock: true, signal: true }], 'the build holds the lock of the workspace while it reads the store, and hands its signal on');
    equal(listing(locked).filter((name) => name === 'lock' || name.startsWith('tmp-')), [], 'and gives it back');
    const stopped = AbortSignal.abort(Object.assign(new Error('stop'), { code: 'stop' }));
    await assert.rejects(workTreeSide({ root: locked, stateDir: path.join(root, 'side'), signal: stopped }), { code: 'stop' });
    const { entries, record } = await loadBaseline({ hubDir: path.join(manager.hubDirectory, 'proof', 'gate'), root: locked, id: baselineOf(held.id) });
    const side = await storeSide({ git: await findGit(), storeDir: path.join(folderOf(locked), record.store.directory), entries, objectFormat: record.objectFormat, scratch: path.join(root, 'store-side'), signal: stopped });
    await assert.rejects(side.read(['calc.js']), { code: 'stop' });

    // a delete waits for the lock: whoever holds it reads or writes there
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

    // a build that was given up comes to its end a moment later: a delete and a stop of the Hub wait for that moment
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

    // the real build, deleted in the middle: while it makes the report, while it makes the patch, at once
    for (const [label, sign] of [['at once', () => true], ['in the report', () => fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'packs', 'scratch')).length > 0], ['in the patch', (dir) => listing(dir).some((name) => name.startsWith('tmp-'))]]) {
      for (let turn = 0; turn < 3; turn += 1) {
        const dir = await good(`middle-${label.replaceAll(' ', '-')}-${turn}`, { files: Object.fromEntries(Array.from({ length: 120 }, (_, n) => [`f${n}.txt`, `file ${n}\n`.repeat(50)])) });
        const gone = await run(manager, dir, [done], { prompt: 'Look around.' });
        const until2 = Date.now() + 2000;
        while (!sign(dir) && Date.now() < until2) await new Promise((resolve) => { setImmediate(resolve); });
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
