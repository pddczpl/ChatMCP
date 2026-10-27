// Full Access still stops for what cannot be taken back, and a context with nobody to ask refuses at once.
//
// v3.9.0: once the owner typed FULL ACCESS, PermissionGate.authorize returned "allowed" for every category, so a model could
// `git push`, merge a pull request, create or delete a release or repository, publish a package or delete files without any request.
//
//  1. under Full Access every always-ask operation produces a pending request (>= 5; 15 are checked), normal work does not
//  2. Read Only still wins over Full Access, and Review is unchanged
//  3. a non-interactive gate (coding-orchestrator worker) or a model-spawned background agent in Autonomous / Full Access refuses an
//     operation that needs approval in well under a second; it never waits for the approval timeout, and leaves no pending request
//  4. the same on the real stack: a ConcurrentApiAgent child spawned in Full Access is refused at once, while the conversation the
//     owner is looking at shows the pending request and honours the answer
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { delay } from '../lib/runtime.mjs';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { PermissionGate } from '../lib/permissions.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the always-ask suite exceeded its own time budget'); process.exit(2); }, 240_000).unref();
const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALWAYS_ASK = [
  ['local.github_pr_merge', { number: 7 }],
  ['local.github_release_create', { tag: 'v9.9.9' }],
  ['local.run_command', { command: 'git push origin main' }],
  ['local.run_command', { command: 'git -C . push --force origin main' }],
  ['local.run_command', { command: 'gh release delete v1.0.0 --yes' }],
  ['local.run_command', { command: 'gh repo delete owner/repo --yes' }],
  ['local.run_command', { command: 'gh pr merge 3 --squash' }],
  ['local.run_command', { command: 'gh -R owner/repo release create v2 --notes x' }],
  ['local.run_command', { command: 'gh api -X DELETE repos/owner/repo/git/refs/heads/x' }],
  ['local.run_command', { command: 'npm publish' }],
  ['local.run_command', { command: 'docker push registry.example.invalid/app:1' }],
  ['local.run_command', { command: 'kubectl delete pod web' }],
  ['local.run_command', { command: 'rm -rf build' }],
  ['local.delete_path', { path: 'victim.txt' }],
  ['desktop-commander.delete_file', { file: 'C:/outside/x.txt' }],
];
const NORMAL_IN_FULL_ACCESS = [
  ['local.run_command', { command: 'echo hello' }],
  ['local.run_command', { command: 'npm install left-pad' }],
  ['local.run_command', { command: 'curl https://example.invalid/file' }],
  ['local.run_command', { command: 'gh release list' }],
  ['local.run_command', { command: 'gh pr view 3' }],
  ['local.run_command', { command: 'gh api repos/owner/repo' }],
  ['local.write_file', { path: 'new-file.txt', content: 'x' }],
  ['desktop-commander.start_process', { command: 'example' }],
];

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-always-ask-'));
const work = path.join(root, 'work');
await fs.mkdir(work, { recursive: true });
await fs.writeFile(path.join(work, 'victim.txt'), 'keep me\n');
const manager = { workspace: work, secrets: [] };
const studio = new StudioWorkspace({ manager, directory: path.join(root, 'state', 'studio') });
const localTools = new LocalTools({ workspace: studio, stateDirectory: path.join(root, 'state') });
function newGate({ timeout = 60_000 } = {}) {
  const gate = new PermissionGate({ manager, workspace: studio, timeout });
  gate.attachLocalTools(localTools);
  return gate;
}

/** allowed unasked ('allow'), asked ('prompt', answered with `approve`), or refused ('policy' / 'blocked' / 'deny'), plus how long it took. */
async function outcome(gate, name, args, { approve = false } = {}) {
  const started = performance.now();
  const run = gate.authorize({ name, args, definition: {}, taskId: 'task-1' });
  let settled = null;
  run.then((value) => { settled = { value }; }, (thrown) => { settled = { thrown }; });
  for (let i = 0; i < 400 && !settled && gate.state().pending.length === 0; i += 1) await delay(5);
  if (settled?.thrown) return { kind: 'throw', error: settled.thrown, ms: performance.now() - started };
  if (settled) {
    const last = gate.state().recent.at(-1);
    const kind = settled.value.allowed ? 'allow' : last && last.toolName === name && ['blocked', 'policy'].includes(last.decision) ? last.decision : 'deny';
    return { kind, result: settled.value, ms: performance.now() - started };
  }
  const pending = gate.state().pending;
  assert.equal(pending.length, 1, `${name}: exactly one request`);
  gate.decide(pending[0].id, approve);
  return { kind: 'prompt', result: await run, request: pending[0], ms: performance.now() - started };
}

let pool;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-always-ask-stack-'));
try {
  // ---------------------------------------------------------------- 1. Full Access still asks for the always-ask list
  {
    const gate = newGate();
    gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });
    assert.equal(gate.state().fullAccess, true);
    for (const [name, args] of ALWAYS_ASK) {
      const result = await outcome(gate, name, args);
      assert.equal(result.kind, 'prompt', `${name} ${JSON.stringify(args)} must produce a pending request under Full Access (got ${result.kind})`);
      assert.equal(result.request.category, 'dangerous', `${name} is dangerous`);
      assert.equal(result.result.allowed, false, 'and a "no" is honoured');
    }
    ok(`${ALWAYS_ASK.length} always-ask operations (>= 5) each produce a pending request under Full Access and a "no" stops them`);

    const approved = await outcome(gate, 'local.github_pr_merge', { number: 7 }, { approve: true });
    assert.equal(approved.kind, 'prompt');
    assert.equal(approved.result.allowed, true, 'an approval is honoured too');

    for (const [name, args] of NORMAL_IN_FULL_ACCESS) {
      const result = await outcome(gate, name, args);
      assert.equal(result.kind, 'allow', `${name} ${JSON.stringify(args)} must still run unasked under Full Access (got ${result.kind})`);
    }
    ok(`Full Access still runs ${NORMAL_IN_FULL_ACCESS.length} ordinary operations (installs, network, shell, writes, gh reads) without asking`);
  }

  // ---------------------------------------------------------------- 2. Read Only wins, Review unchanged
  {
    const gate = newGate();
    gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });
    gate.configure({ mode: 'readonly' });
    assert.equal(gate.state().fullAccess, true);
    for (const [name, args] of ALWAYS_ASK.slice(0, 5)) {
      const result = await outcome(gate, name, args);
      assert.ok(['policy', 'blocked'].includes(result.kind), `${name}: Read Only refuses without a prompt (got ${result.kind})`);
    }
    const review = newGate();
    const asked = await outcome(review, 'local.run_command', { command: 'git push origin main' });
    assert.equal(asked.kind, 'prompt', 'Review asks as before');
    ok('Read Only still refuses them without a prompt, Review still asks');
  }

  // ---------------------------------------------------------------- 3. nobody to ask: refuse at once
  {
    for (const [label, configureGate] of [
      ['coding-orchestrator worker (interactive=false), Full Access', (gate) => { gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' }); gate.interactive = false; }],
      ['coding-orchestrator worker (interactive=false), Autonomous', (gate) => { gate.configure({ mode: 'autonomous' }); gate.interactive = false; }],
      ['coding-orchestrator worker (interactive=false), Review', (gate) => { gate.configure({ mode: 'review' }); gate.interactive = false; }],
      ['model-spawned background agent, Full Access', (gate) => { gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' }); gate.backgroundAgent = true; }],
      ['model-spawned background agent, Autonomous', (gate) => { gate.configure({ mode: 'autonomous' }); gate.backgroundAgent = true; }],
    ]) {
      const gate = newGate({ timeout: 10 * 60 * 1000 });
      configureGate(gate);
      assert.equal(gate.canAsk(), false, label);
      const probes = label.includes('Full Access') ? ALWAYS_ASK.slice(0, 5) : [['local.run_command', { command: 'npm install left-pad' }], ['local.run_command', { command: 'git push origin main' }]];
      for (const [name, args] of probes) {
        const result = await outcome(gate, name, args);
        assert.equal(result.kind, 'policy', `${label}: ${name} must be refused (got ${result.kind})`);
        assert.ok(result.ms < 1000, `${label}: refusal took ${result.ms.toFixed(0)} ms, must be < 1000 ms`);
        assert.match(result.result.reason, /nền|worker/i, 'and the reason says why');
        assert.equal(gate.state().pending.length, 0, 'no request is left waiting');
      }
    }
    const asking = newGate();
    asking.configure({ mode: 'review' });
    asking.backgroundAgent = true;
    assert.equal(asking.canAsk(), true, 'a background agent in Review can still ask: the owner sees and answers that request');
    assert.equal((await outcome(asking, 'local.run_command', { command: 'git push origin main' })).kind, 'prompt');
    const quiet = newGate();
    quiet.interactive = false;
    quiet.configure({ mode: 'autonomous' });
    assert.equal((await outcome(quiet, 'local.run_command', { command: 'echo hi' })).kind, 'allow', 'read-only work is not affected');
    ok('workers and background agents with nobody to ask refuse an operation that needs approval in < 1000 ms, with a clear reason and nothing left pending');
  }

  // ---------------------------------------------------------------- 4. the real stack
  {
    const repo = path.join(temp, 'project');
    await fs.mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'chatmcp-ci@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'ChatMCP CI'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
    const hub = new HubManager({ bundleRoot, dataDirectory: path.join(temp, 'hub'), log: () => {} });
    await hub.load(repo);
    assembleStudio(hub, { bundleRoot });
    await hub.permissions.load();
    await hub.startLocal(repo);

    const timeline = {};
    const provider = {
      ready: () => true,
      snapshot: () => ({ provider: 'fixture', model: 'wants-to-merge' }),
      async respond({ input }) {
        const user = input.filter((item) => item?.role === 'user' && Array.isArray(item.content)).map((item) => item.content.map((part) => part?.text || '').join(' '))
          .filter((text) => !text.startsWith('UNTRUSTED SKILL REFERENCES')).join(' ');
        const who = /Run (ROOT|CHILD):/.exec(user)?.[1] ?? 'OTHER';
        const outputs = input.filter((item) => item?.type === 'function_call_output');
        if (outputs.length) {
          timeline[who] = { ...timeline[who], answeredAt: performance.now(), output: String(outputs.at(-1).output) };
          return { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: `${who} done.` }] }] };
        }
        timeline[who] = { calledAt: performance.now() };
        return { status: 'completed', output: [{ type: 'function_call', status: 'completed', name: 'mcp_call', call_id: `merge-${who}`,
          arguments: JSON.stringify({ name: 'local.github_pr_merge', arguments_json: JSON.stringify({ number: 5 }) }) }] };
      },
    };
    const primary = new AgentRunner({ manager: hub, provider, taskDirectory: path.join(temp, 'hub', 'api-tasks'), log: () => {} });
    await primary.load();
    pool = new ConcurrentApiAgent({ primary, manager: hub, provider, bundleRoot, directory: path.join(temp, 'hub', 'api-conversations'), log: () => {} });
    hub.spawnBackgroundAgent = (parentId, request) => pool.spawnAgent(parentId, request);
    hub.spawnWorkflow = (parentId, request) => pool.spawnWorkflow(parentId, request);
    hub.permissions.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });

    // the conversation the owner is looking at: the request is shown and the answer is honoured
    const rootTask = await pool.start({ prompt: 'Run ROOT: merge the pull request' });
    for (let i = 0; i < 400 && hub.permissions.state().pending.length === 0; i += 1) await delay(25);
    const pending = hub.permissions.state().pending;
    assert.equal(pending.length, 1, 'the owner sees one pending request');
    assert.equal(pending[0].toolName, 'local.github_pr_merge');
    hub.permissions.decide(pending[0].id, false);
    for (let i = 0; i < 400 && !timeline.ROOT?.output; i += 1) await delay(25);
    assert.match(timeline.ROOT.output, /permission_denied|Permission denied/i, 'the model is told it was not approved');

    // a child that the model spawned: nobody is watching, so it is refused at once
    const child = await pool.spawnAgent(rootTask.id, { goal: 'Run CHILD: merge the pull request' });
    for (let i = 0; i < 400 && !timeline.CHILD?.output; i += 1) await delay(25);
    assert.ok(timeline.CHILD?.output, 'the child reached its answer without anyone approving anything');
    const elapsed = timeline.CHILD.answeredAt - timeline.CHILD.calledAt;
    assert.ok(elapsed < 1000, `the child's request was refused in ${elapsed.toFixed(0)} ms; it must not wait for an approval`);
    assert.match(timeline.CHILD.output, /nền|worker/i);
    assert.equal(pool.pendingApprovals().length, 0, 'and no request is left for the owner');
    assert.equal(pool.children.get(child.id).manager.permissions.backgroundAgent, true);
    assert.equal(hub.permissions.state().pending.length, 0);
    ok(`real stack: the owner's conversation shows and honours the request; the model-spawned child was refused in ${elapsed.toFixed(0)} ms and nothing is left pending`);
  }
} finally {
  try { await pool?.shutdown?.(); } catch { /* best effort */ }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(() => {});
}

console.log(`PASS: ${checks} always-ask checks`);
process.exit(0);
