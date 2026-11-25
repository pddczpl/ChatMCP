// The rig of the done-gate suites that run the real agent loop (verify-proof-gate-agent.mjs, verify-proof-gate-places.mjs): temporary projects, a real HubManager, a real
// AgentRunner with a scripted model, real check commands and hooks. Not a suite. One temporary folder and one count of checks per process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../../lib/manager.mjs';
import { assembleStudio } from '../../lib/assemble.mjs';
import { AgentRunner } from '../../lib/agent.mjs';
import { acceptanceSha256 } from '../../lib/proof/acceptance.mjs';
import { GATE_EVENT } from '../../lib/proof/gate.mjs';
import { ledgerPath } from '../../lib/proof/ledger.mjs';
import { readLedgerEntries } from '../../lib/proof/service.mjs';

const TESTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const bundleRoot = path.resolve(TESTS, '..');
const HOOK = path.join(TESTS, 'fixtures', 'hook-program.mjs');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
export const count = () => checks;
export const check = (condition, label) => { assert.ok(condition, label); checks += 1; };
export const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
setTimeout(() => { console.error('FAIL: the done-gate suite exceeded its own time budget'); process.exit(2); }, 172_000).unref();
// A goal the Hub decomposes into a plan with an edit, a verify and a review phase, so that it judges the completion.
export const GOAL = 'Read calc.js and find out why add() returns the wrong sum; then fix it with the smallest change and run the project tests; finally review the Git diff and report what is still limited.';

export const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-proof-gate-agent-')));
export function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
export const TEST = "const assert = require('node:assert');\nconst { add } = require('./calc.js');\nconsole.log('password=hunter2hunter2hunter2 running');\nassert.equal(add(2, 3), 5);\nassert.equal(add(1, 1), 2);\nconsole.log('OK 2 tests');\n";
export const WEAK = "const assert = require('node:assert');\nconst { add } = require('./calc.js');\nassert.ok(add);\nconsole.log('OK');\n";
export const ACCEPT = (runs = { tests: 'node calc.test.js' }) => `version: 1\ncriteria:\n${Object.entries(runs).map(([id, run]) => `  - id: ${id}\n    text: "The criterion ${id}."\n    checks:\n      - run: ${JSON.stringify(run)}\n`).join('')}`;
export async function project(name, { acceptance = ACCEPT(), repository = true, files = {} } = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.chatmcp'), { recursive: true });
  const all = { 'calc.js': 'exports.add = (a, b) => a - b;\n', 'calc.test.js': TEST, 'notes.txt': 'notes\n', '.gitignore': 'cache/\n', ...(acceptance === null ? {} : { '.chatmcp/acceptance.yml': acceptance }), ...files };
  for (const [file, text] of Object.entries(all)) await fs.writeFile(path.join(dir, file), text);
  if (repository) { git(dir, ['init', '-q', '-b', 'main']); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'initial']); }
  return dir;
}
export async function createHub(name) {
  const manager = new HubManager({ dataDirectory: path.join(root, `${name}-hub`), bundleRoot, log: () => {} });
  assembleStudio(manager, { bundleRoot });
  await manager.permissions.load();
  await manager.load();
  return manager;
}
export const trust = (manager, text) => manager.acceptanceTrustStore().trust(acceptanceSha256(text), { approvedBy: 'owner' });

export const say = (text) => ({ kind: 'say', text });
export const tool = (name, args = {}) => ({ kind: 'tool', name, args });
export const textsOf = (input) => input.filter((item) => item?.role === 'user').map((item) => item.content.map((part) => part.text ?? '').join(''));
export function scripted(steps) {
  let turn = 0;
  let counter = 0;
  const model = {
    seen: [], requests: [],
    snapshot: () => ({ model: 'scripted-1', provider: 'scripted' }),
    ready: () => true,
    redact: (text) => text,
    state: () => ({ provider: 'scripted', model: 'scripted-1', configured: true }),
    async respond({ input, instructions, signal }) {
      signal?.throwIfAborted();
      model.seen.push(JSON.stringify({ input, instructions }));
      model.requests.push(structuredClone(input));
      const outputs = input.filter((item) => item.type === 'function_call_output');
      const last = outputs.length ? JSON.parse(typeof outputs.at(-1).output === 'string' ? outputs.at(-1).output : outputs.at(-1).output[0].text) : null;
      const step = steps[turn];
      turn += 1;
      if (!step) throw new Error(`The script has no step ${turn}.`);
      const produced = await step({ last, input, users: textsOf(input) });
      return {
        status: 'completed', usage: { input_tokens: 10, output_tokens: 5 },
        output: produced.map((item) => item.kind === 'tool'
          ? { type: 'function_call', call_id: `call_${(counter += 1)}_${Math.random().toString(36).slice(2, 8)}`, name: item.name, arguments: JSON.stringify(item.args), status: 'completed' }
          : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }] }),
      };
    },
  };
  return model;
}
export function approver(manager) {
  const handled = new Set();
  const timer = setInterval(() => {
    for (const request of manager.permissions.state().pending) {
      if (handled.has(request.id)) continue;
      handled.add(request.id);
      try { manager.permissions.decide(request.id, true); } catch { /* already decided */ }
    }
  }, 10);
  return () => clearInterval(timer);
}
export async function until(test, label, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}
export async function section(title, body) {
  const before = checks;
  const started = Date.now();
  await body();
  console.log(`  ok  ${title} (${checks - before} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
export const read = () => [tool('read_file', { path: 'calc.js' })];
export const fix = ({ last }) => [tool('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', expected_sha256: last.structuredContent.sha256 })];
export const diff = () => [tool('git_diff', {})];
export const write = (file, content) => () => [tool('write_file', { path: file, content, overwrite: true })];
export const answer = (text) => () => [say(text)];
export const done = answer('Done.');

/**
 * The proof summary of the conversation `id` once its pack is there or is not coming, and no build of it goes on any more, not even one that was given up. The build of a pack
 * goes on behind the end of a run and writes below proof/gate and proof/packs: whoever removes or lists something there waits for this first.
 */
export const packSettled = (agent, id) => until(() => {
  const proof = agent.get(id).proof ?? null;
  return proof?.status !== 'building' && proof?.reason !== 'run_in_progress' && !agent.packs.busy(id) ? { proof } : null;
}, 'the proof to settle', 60_000).then(({ proof }) => proof);

/** One run of the real loop on `dir`: {agent, task, model, entries, gate events, view}. It waits for the pack of the run too, unless `settle` is false. */
export async function run(manager, dir, steps, { runner = null, id = null, prompt = GOAL, start = {}, mode = 'autonomous', status = 'completed', during = null, settle = true } = {}) {
  if (manager.workspace !== dir) await manager.selectWorkspace(dir);
  manager.permissions.configure({ mode, executionPolicy: 'host-review' });
  const model = scripted(steps);
  const agent = runner ?? new AgentRunner({ manager, provider: model, taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
  if (runner) agent.provider = model;
  if (!runner) await agent.load();
  const stop = approver(manager);
  try {
    const started = id ? await agent.continue({ id, prompt, ...start }) : await agent.start({ prompt, ...start });
    const before = agent.get(started.id).eventCount;
    if (during) await during({ agent, id: started.id, model });
    const view = await until(() => { const task = agent.get(started.id); return task.status !== 'running' && agent.state().activeTaskId === null ? task : null; }, 'the task to end', 90_000);
    if (settle) await packSettled(agent, started.id);
    equal(view.status, status, `the task ended ${status} (${view.error ?? ''})`);
    const { entries, report } = await readLedgerEntries(ledgerPath(manager.hubDirectory, view.id));
    check(report.ok, 'the ledger verifies');
    const events = view.events.filter((event) => event.type === GATE_EVENT && event.run === undefined);
    return { agent, id: view.id, model, entries, events, gates: events.map((event) => event.gate), view, before };
  } finally { stop(); }
}
export const checksOf = (entries) => entries.filter((entry) => entry.type === 'check').map((entry) => entry.record);
export const treeIds = (entries) => [...new Set(entries.flatMap(({ record }) => [record?.tree?.tree, record?.tree?.rawTree, record?.treeBefore?.tree, record?.treeBefore?.rawTree, record?.treeAfter?.tree, record?.treeAfter?.rawTree]).filter((value) => typeof value === 'string'))];
export const feedback = (request) => textsOf(request).filter((text) => text.startsWith('[Done-gate'));
export const hooksFile = (manager) => path.join(manager.hubDirectory, 'hooks.json');
export const handler = (spec) => ({ type: 'command', command: process.execPath, args: [HOOK, JSON.stringify(spec)] });
