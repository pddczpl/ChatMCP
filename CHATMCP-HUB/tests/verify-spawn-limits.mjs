// Spawn limits on the REAL ConcurrentApiAgent + AgentRunner + HubManager + a temporary Git repository (real worktrees).
//
// v3.9.0 let every agent that a model spawned spawn again: a model that always delegates grew an unbounded tree of worktrees and model
// calls. The scripted model below ALWAYS spawns - even when the tool is not offered to it.
//
//  1. default limits (depth 2, 16 descendants): the tree stops at depth 2, the agent at the cap is not offered spawn_agent /
//     spawn_workflow, and its attempt to call spawn_agent anyway creates nothing
//  2. the enforcement point: spawnAgent / spawnWorkflow on an agent at the cap reject with a structured spawn_depth_exceeded
//  3. the model sees a structured spawn_depth_exceeded error when the cap drops after the tool was offered
//  4. the tree-size limit (descendants per root conversation) refuses the spawns beyond it with spawn_descendants_exceeded, also for
//     spawn calls made in parallel
//  5. the limits are configurable, validated, persisted in the Hub's conversation state, and re-sync the tools of running children
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-spawn-limits-'));
const repo = path.join(temp, 'project');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (test, label, tries = 400) => {
  for (let i = 0; i < tries; i += 1) { if (await test()) return; await wait(50); }
  throw new Error(`Timed out: ${label}`);
};
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'paused', 'uncertain', 'limit', 'interrupted']);
setTimeout(() => { console.error('FAIL: the spawn-limit suite exceeded its own time budget'); process.exit(2); }, 240_000).unref();

// ---- what the scripted model saw: per run, the tools it was offered and what its spawn calls returned
const runs = [];
let hook = null;
const provider = {
  ready: () => true,
  snapshot: () => ({ provider: 'fixture', model: 'always-spawns' }),
  async respond({ input, tools = [] }) {
    const user = input.filter((item) => item?.role === 'user' && Array.isArray(item.content))
      .map((item) => item.content.map((part) => part?.text || '').join(' ')).filter((text) => !text.startsWith('UNTRUSTED SKILL REFERENCES')).join(' ');
    const tag = /Run ([A-Za-z0-9-]+):/.exec(user)?.[1] ?? 'unknown';
    const outputs = input.filter((item) => item?.type === 'function_call_output').map((item) => String(item.output));
    let run = runs.find((entry) => entry.tag === tag);
    if (!run) { run = { tag, toolNames: tools.map((tool) => tool.name), outputs: [], spawned: 0 }; runs.push(run); }
    if (outputs.length) {
      run.outputs = outputs;
      return { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: `Run ${tag} done.` }] }] };
    }
    await hook?.(tag, run);
    if (/leaf/.test(user)) return { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: `Run ${tag} done.` }] }] };
    // "always spawns": it calls spawn_agent whether or not the tool was offered; `breadth` asks for several calls in one answer
    const count = /breadth (\d+)/.exec(user)?.[1] ?? '1';
    if (!run.toolNames.includes('spawn_agent')) {
      // not offered the tool: try every other way to reach it - the bare name, and the same name through the mcp_call router
      const goal = JSON.stringify({ goal: `Run ${tag}0: always spawn again` });
      const viaRouter = (name) => ({ type: 'function_call', status: 'completed', name: 'mcp_call', call_id: `router-${tag}-${name}`,
        arguments: JSON.stringify({ name, arguments_json: goal }) });
      return { status: 'completed', output: [
        { type: 'function_call', status: 'completed', name: 'spawn_agent', call_id: `spawn-${tag}-direct`, arguments: goal },
        viaRouter('spawn_agent'), viaRouter('chatmcp.spawn_agent'), viaRouter('local.spawn_agent'),
      ] };
    }
    return { status: 'completed', output: Array.from({ length: Number(count) }, (_, index) => ({
      type: 'function_call', status: 'completed', name: 'spawn_agent', call_id: `spawn-${tag}-${index}`,
      arguments: JSON.stringify({ goal: `Run ${tag}${index}: ${/breadth/.test(user) ? 'leaf worker' : 'always spawn again'}` }),
    })) };
  },
};

let pool;
try {
  await fs.mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'chatmcp-ci@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'ChatMCP CI'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'README.md'), '# Spawn limit fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  const manager = new HubManager({ bundleRoot, dataDirectory: path.join(temp, 'hub'), log: () => {} });
  await manager.load(repo);
  assembleStudio(manager, { bundleRoot });
  await manager.permissions.load();
  manager.permissions.mode = 'autonomous';
  await manager.startLocal(repo);
  const primary = new AgentRunner({ manager, provider, taskDirectory: path.join(temp, 'hub', 'api-tasks'), log: () => {} });
  await primary.load();
  pool = new ConcurrentApiAgent({ primary, manager, provider, bundleRoot, directory: path.join(temp, 'hub', 'api-conversations'), log: () => {} });
  manager.spawnBackgroundAgent = (parentId, request) => pool.spawnAgent(parentId, request);
  manager.spawnWorkflow = (parentId, request) => pool.spawnWorkflow(parentId, request);
  const settled = () => pool.state().tasks.every((task) => TERMINAL.has(task.status ?? task.state));
  const recordsOf = () => [...pool.records.values()];
  assert.deepEqual(pool.spawnLimits(), { maxSpawnDepth: 2, maxSpawnDescendants: 16 }, 'defaults');

  // ---------------------------------------------------------------- 1. default limits
  {
    const root = await pool.start({ prompt: 'Run L0: always spawn again' });
    await until(() => recordsOf().length >= 2 && settled(), 'the tree built by the always-spawning model settles');
    await wait(300);
    assert.ok(settled());
    const depths = recordsOf().map((record) => record.depth).sort();
    assert.deepEqual(depths, [1, 2], `the tree stops at depth 2 (records: ${JSON.stringify(depths)})`);
    assert.equal(Math.max(...depths), pool.spawnLimits().maxSpawnDepth, 'the deepest depth equals the cap');
    const level = (n) => runs.find((run) => run.tag === ['L0', 'L00', 'L000'][n]);
    assert.ok(level(0) && level(1) && level(2), `three runs happened: ${runs.map((run) => run.tag)}`);
    for (const n of [0, 1]) {
      assert.ok(level(n).toolNames.includes('spawn_agent') && level(n).toolNames.includes('spawn_workflow'), `depth ${n} is offered the spawn tools`);
    }
    assert.equal(level(2).toolNames.some((name) => /^spawn_/.test(name)), false, 'the agent at the cap is offered no spawn tool');
    assert.equal(recordsOf().some((record) => record.depth > 2), false);
    assert.equal(level(2).outputs.length, 4, 'the agent at the cap tried spawn_agent directly and three ways through the mcp_call router');
    for (const output of level(2).outputs) {
      assert.doesNotMatch(output, /"taskId"/, `no attempt may start an agent: ${output.slice(0, 200)}`);
      assert.match(output, /unknown_function|Không có hàm|unknown|không|not found|Unknown/i, `each attempt is refused as an unknown tool: ${output.slice(0, 200)}`);
    }
    assert.equal(recordsOf().length, 2, 'those calls created nothing');
    assert.equal(pool.get(root.id).status, 'completed');
    ok('default limits: the always-spawning model builds depth 1 and 2 and stops; the agent at the cap is not offered spawn tools and its stray call creates nothing');
  }

  // ---------------------------------------------------------------- 2. the enforcement point
  {
    const deepest = recordsOf().find((record) => record.depth === 2);
    const before = recordsOf().length;
    await assert.rejects(pool.spawnAgent(deepest.id, { goal: 'one more level' }), (error) => {
      assert.equal(error.code, 'spawn_depth_exceeded');
      assert.equal(error.structured.depth, 2);
      assert.equal(error.structured.maxSpawnDepth, 2);
      assert.equal(error.structured.requestedDepth, 3);
      return true;
    });
    await assert.rejects(pool.spawnWorkflow(deepest.id, { name: 'too deep', phases: [{ name: 'Review', agents: [{ goal: 'review' }] }] }), { code: 'spawn_depth_exceeded' });
    assert.equal(recordsOf().length, before, 'nothing was created');
    assert.equal(pool.spawnAllowed(deepest.id), false);
    assert.equal(pool.spawnAllowed(recordsOf().find((record) => record.depth === 1).id), true);
    assert.equal(pool.children.get(deepest.id)?.manager.spawnBackgroundAgent, undefined, 'the child at the cap has no spawn function at all');
    ok('spawnAgent / spawnWorkflow at the cap reject with a structured spawn_depth_exceeded and create nothing');
  }

  // ---------------------------------------------------------------- 3. the model sees the structured error
  {
    runs.length = 0;
    hook = async (tag) => { if (tag === 'S00') { await pool.configureSpawnLimits({ maxSpawnDepth: 1 }); hook = null; } };
    await pool.start({ prompt: 'Run S0: always spawn again' });
    await until(() => runs.some((run) => run.tag === 'S00' && run.outputs.length) && settled(), 'the child ran with the cap lowered under it');
    const child = runs.find((run) => run.tag === 'S00');
    assert.ok(child.toolNames.includes('spawn_agent'), 'it was offered the tool before the cap dropped');
    const seen = JSON.parse(child.outputs[0]).structuredContent;
    assert.equal(seen.error.code, 'spawn_depth_exceeded');
    assert.equal(seen.executed, false);
    assert.match(seen.error.message, /no longer allowed|limit/i);
    assert.equal(runs.some((run) => run.tag === 'S000'), false, 'no grandchild ran');
    await pool.configureSpawnLimits({ maxSpawnDepth: 2 });
    ok('a spawn refused at the cap reaches the model as a structured spawn_depth_exceeded tool error');
  }

  // ---------------------------------------------------------------- 4. tree size, also for parallel spawns
  {
    runs.length = 0;
    await pool.configureSpawnLimits({ maxSpawnDepth: 3, maxSpawnDescendants: 3 });
    const before = recordsOf().length;
    await pool.start({ prompt: 'Run B0: breadth 6 spawn at once' });
    await until(() => runs.some((run) => run.tag === 'B0' && run.outputs.length) && settled(), 'the breadth run settles');
    const root = runs.find((run) => run.tag === 'B0');
    const parsed = root.outputs.map((output) => { try { return JSON.parse(output).structuredContent; } catch { return null; } });
    const accepted = parsed.filter((entry) => entry?.taskId).length;
    const refused = parsed.filter((entry) => entry?.error?.code === 'spawn_descendants_exceeded');
    assert.equal(accepted, 3, `exactly 3 of 6 parallel spawns fit (outputs: ${root.outputs.map((o) => o.slice(0, 80)).join(' | ')})`);
    assert.equal(refused.length, 3);
    assert.equal(refused[0].error.maxSpawnDescendants, 3);
    assert.equal(recordsOf().length - before, 3, 'and exactly 3 agents exist');
    assert.equal(pool.spawnAllowed(recordsOf().at(-1).parentTaskId), false, 'a full tree is no longer offered the tools');
    // the same cap applied to workflows: 2 agents do not fit into a tree that is already full
    await assert.rejects(pool.spawnWorkflow(recordsOf().at(-1).parentTaskId, { name: 'late', phases: [{ name: 'P', agents: [{ goal: 'a' }, { goal: 'b' }] }] }), { code: 'spawn_descendants_exceeded' });
    ok('the tree-size limit admits exactly 3 of 6 parallel spawns, reports spawn_descendants_exceeded for the rest, and applies to workflows');
  }

  // ---------------------------------------------------------------- 5. configuration
  {
    for (const bad of [{ maxSpawnDepth: -1 }, { maxSpawnDepth: 1.5 }, { maxSpawnDepth: 99 }, { maxSpawnDescendants: 'many' }, { maxSpawnDescendants: 1000 }]) {
      await assert.rejects(pool.configureSpawnLimits(bad), { code: 'invalid_spawn_limits' }, JSON.stringify(bad));
    }
    assert.deepEqual(pool.spawnLimits(), { maxSpawnDepth: 3, maxSpawnDescendants: 3 }, 'a rejected change changes nothing');
    await pool.configureSpawnLimits({ maxSpawnDepth: 1, maxSpawnDescendants: 5 });
    assert.deepEqual(pool.state().spawnLimits, { maxSpawnDepth: 1, maxSpawnDescendants: 5 }, 'visible in the Hub state');
    await pool.configureSpawnLimits({}); // flush
    const saved = JSON.parse(await fs.readFile(path.join(temp, 'hub', 'api-conversations', 'sessions.json'), 'utf8'));
    assert.deepEqual(saved.spawnLimits, { maxSpawnDepth: 1, maxSpawnDescendants: 5 }, 'persisted with the conversation state');
    const depthOne = recordsOf().find((record) => record.depth === 1 && pool.children.get(record.id));
    assert.ok(depthOne, 'a running child exists');
    assert.equal(pool.children.get(depthOne.id).manager.spawnBackgroundAgent, undefined, 'lowering the cap removes the tools of children already at the new cap');
    await pool.configureSpawnLimits({ maxSpawnDepth: 2 });
    assert.equal(typeof pool.children.get(depthOne.id).manager.spawnBackgroundAgent, 'function', 'raising it gives them back');
    const reloaded = new ConcurrentApiAgent({ primary, manager, provider, bundleRoot, directory: path.join(temp, 'hub', 'reload-check'), log: () => {}, maxSpawnDepth: 1 });
    assert.deepEqual(reloaded.spawnLimits(), { maxSpawnDepth: 1, maxSpawnDescendants: 16 }, 'constructor options set the limits');
    manager.spawnAllowed = (taskId) => pool.spawnAllowed(taskId);
    ok('limits are validated, shown in state, persisted in sessions.json, configurable at construction and re-sync the tools of running children');
  }
} finally {
  try { await pool?.close?.(); } catch { /* best effort */ }
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(() => {});
}

console.log(`PASS: ${checks} spawn limit checks`);
process.exit(0);
