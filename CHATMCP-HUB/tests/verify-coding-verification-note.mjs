// The Hub's own sentences about how a worker's verification ended are a field of their own (verificationNote), not text appended to what the model
// said. The summary of a worker is the model's words and nothing else, so that a page can label the one as the AI's report and the other as the Hub's.
// Real orchestrator, real AgentRunner and real test broker; the model and the isolated backend are scripted (this is not OS isolation).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { CodingWorktreeOrchestrator } from '../lib/coding-orchestrator.mjs';
import { ExecutionBackend, validateCapabilityReport, validateExecutionReceipt } from '../lib/execution-contract.mjs';
import { BLACKBOX_KIND } from '../lib/native-blackbox-contract.mjs';

const bundleRoot = fileURLToPath(new URL('..', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-coding-note-'));
const ok = (message) => console.log('PASS: ' + message);
const withDeadline = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
};

/** A backend that never passes: every check it is asked to run comes back failed. */
class FailingBackend extends ExecutionBackend {
  constructor() { super('windows-sandbox'); this.executions = 0; }
  async probe() {
    return validateCapabilityReport({
      backend: this.id, available: true, osIsolated: true, platform: 'win32', networkPolicy: 'denied',
      writeScope: 'guest-ephemeral', concurrency: 1,
      enforcedLimits: ['timeoutSeconds', 'maxOutputBytes'], unsupportedLimits: ['maxMemoryMb', 'maxCpuCores', 'customEnv'],
      reasons: [], observedAt: new Date().toISOString(),
    });
  }
  async execute(request) {
    this.executions += 1;
    const stamp = new Date().toISOString();
    const receipt = validateExecutionReceipt({
      runId: request.runId, status: 'failed', exitCode: 1, stdout: 'Synthetic native comparison mismatch', stderr: '',
      startedAt: stamp, completedAt: stamp, durationMs: 1, backend: 'windows-sandbox', snapshotHash: request.snapshotHash,
      checkHash: request.checkHash, truncated: false, evidencePath: null, reasons: ['Assertion failed'],
      grader: { version: 1, kind: 'native-blackbox', manifestSha256: request.grader.manifestSha256, cases: 1, passed: 0, failed: 1, valid: false },
    });
    return Object.freeze({ ...receipt, publisherAuthenticated: true, provenance: 'publisher_authenticated', graderAuthenticated: true, publicationProtocol: 'system-sealed-exit-v1' });
  }
  async cancel() { return true; }
}

/** One project, one Hub, one orchestrator. `manifest` adds a declarative check the Hub can find; without it the project has a test file and no supported check. */
async function fixture(name, { manifest, provider, ...options }) {
  const base = path.join(root, name);
  const work = path.join(base, 'project');
  await fs.mkdir(work, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', timeout: 15000, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Note CI']);
  git(['config', 'user.email', 'note@example.invalid']);
  await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({ name: 'note-project', version: '0.0.1', type: 'module' }));
  if (manifest) {
    await fs.writeFile(path.join(work, 'adapter.mjs'), '// The scripted backend does not execute this adapter.\n');
    await fs.mkdir(path.join(work, 'chatmcp.checks'), { recursive: true });
    await fs.writeFile(path.join(work, 'chatmcp.checks', 'basic.json'), JSON.stringify({ version: 1, kind: BLACKBOX_KIND, adapter: 'adapter.mjs', cases: [{ id: 'basic', input: 1, expected: 2 }] }));
  } else {
    await fs.writeFile(path.join(work, 'test.js'), '// A Node test source, so that a check is looked for; package.json names none the Hub supports.\n');
  }
  git(['add', '.']);
  git(['commit', '-m', 'baseline']);
  const parent = new HubManager({ bundleRoot, dataDirectory: path.join(base, 'state'), backend: 'local', log: () => {} });
  await parent.load(work);
  assembleStudio(parent, { bundleRoot });
  parent.permissions.mode = 'autonomous';
  await parent.startLocal();
  const agent = new CodingWorktreeOrchestrator({ manager: parent, provider, bundleRoot, directory: path.join(base, 'coding-orchestrator'), ...options });
  const stop = async () => { agent.cancel(); await parent.shutdown().catch(() => {}); };
  return { parent, agent, work, stop };
}

/**
 * A model that edits one file per run of its own and then says it is finished. `files` are written in order, one for the first run and one for each
 * repair run the Hub starts; the answer is the same sentence every time, so that the summary can be compared with it exactly.
 */
const scriptedModel = (answer, files) => {
  const writes = [];
  const call = (tools, file) => {
    const content = 'export const value = 1;\n';
    return tools.some((tool) => tool.name === 'write_file')
      ? { type: 'function_call', call_id: 'note-' + file, name: 'write_file', arguments: JSON.stringify({ path: file, content }) }
      : { type: 'function_call', call_id: 'note-' + file, name: 'mcp_call', arguments: JSON.stringify({ name: 'local.write_file', arguments_json: JSON.stringify({ path: file, content }) }) };
  };
  return {
    writes,
    ready: () => true,
    snapshot: () => ({ provider: 'fake', model: 'fixture' }),
    async respond({ input, tools }) {
      const prompt = input.findLast((item) => item.role === 'user')?.content?.[0]?.text ?? '';
      const answered = input.some((item) => item.type === 'function_call_output' && input.indexOf(item) > input.findLastIndex((entry) => entry.role === 'user'));
      if (!answered) {
        // a task names its own file ("... add <file>"); a repair run (the Hub's prompt) takes the next file of the script
        const own = /add (\S+\.txt)/.exec(prompt)?.[1];
        const file = own ?? files[writes.length] ?? `extra-${writes.length}.js`;
        writes.push(file);
        return { status: 'completed', output: [call(tools, file)] };
      }
      return { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: answer }] }] };
    },
  };
};

const ANSWER = 'Edited the file; checking it is for the Hub.';
const NOTES = {
  no_checks: 'No supported pinned Node test definition was discovered.',
  grant_timeout: 'Owner did not approve all isolated test grants in the allotted window.',
  verified: 'All registered pinned Node checks have fresh signed TAP evidence.',
};
try {
  // 1. verification asked for, and the project has no check the Hub supports: the worker needs the owner, the Hub says why in its own field
  {
    const { agent, stop } = await fixture('no-checks', { manifest: false, provider: scriptedModel(ANSWER, []) });
    try {
      const job = await withDeadline(agent.run({
        tasks: [{ id: 'plain', prompt: 'PLAIN: add plain.txt' }, { id: 'wants', prompt: 'WANTS: add wants.txt', verify: true }],
        confirmation: 'CREATE WORKTREES', maxConcurrency: 1,
      }), 60_000, 'the run with no supported check did not end');
      const plain = job.workers.find((worker) => worker.id === 'plain');
      const wants = job.workers.find((worker) => worker.id === 'wants');
      assert.equal(plain.status, 'ready_for_review', JSON.stringify(plain));
      assert.ok(!('verificationNote' in plain), 'a worker that was not asked to verify has no note');
      assert.equal(plain.summary, ANSWER);
      assert.equal(wants.status, 'needs_attention', JSON.stringify(wants));
      assert.equal(wants.summary, ANSWER, 'the summary is what the model said: the Hub\'s sentence is not in it');
      assert.deepEqual(wants.verificationNote, { code: 'no_checks', text: NOTES.no_checks });
      assert.equal(job.status, 'partial_failure');
      const saved = JSON.parse(await fs.readFile(path.join(agent.directory, 'jobs.json'), 'utf8')).jobs.at(-1);
      assert.deepEqual(saved.workers.find((worker) => worker.id === 'wants').verificationNote, wants.verificationNote, 'what is saved is what is reported');
      ok('a worker asked to verify in a project with no supported check says so in verificationNote; its summary is the model\'s words');
    } finally { await stop(); }
  }

  // 2. a check exists, nobody allows it within the window: the Hub's note says so. The window is the Hub's 90 seconds unless a test shortens it.
  {
    const { agent, stop } = await fixture('grant-timeout', { manifest: true, provider: scriptedModel(ANSWER, []), grantWindowMs: 400 });
    try {
      assert.equal(agent.grantWindowMs, 400);
      const job = await withDeadline(agent.run({ tasks: [{ id: 'wants', prompt: 'WANTS: add wants.txt', verify: true }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 }),
        30_000, 'the worker kept waiting for a grant that nobody gives: the window is not the one given');
      const wants = job.workers[0];
      assert.equal(wants.status, 'needs_attention', JSON.stringify(wants));
      assert.equal(wants.summary, ANSWER);
      assert.deepEqual(wants.verificationNote, { code: 'grant_timeout', text: NOTES.grant_timeout });
      assert.equal(wants.verificationOutcome, undefined, 'no verification ran: there is no outcome to report');
      ok('an unanswered request for a test grant ends as needs_attention with a grant_timeout note');
    } finally { await stop(); }
    const defaults = new CodingWorktreeOrchestrator({ manager: {}, provider: {}, bundleRoot, directory: path.join(root, 'defaults') });
    assert.equal(defaults.grantWindowMs, 90_000, 'the window the owner is told about is unchanged');
    for (const bad of [0, -1, NaN, '90', null]) {
      assert.throws(() => new CodingWorktreeOrchestrator({ manager: {}, provider: {}, bundleRoot, directory: path.join(root, 'bad'), grantWindowMs: bad }), TypeError, String(bad));
    }
    ok('the window to allow a check is 90 seconds, and a window that is not a positive number is refused');
  }

  // 3. the check is allowed and fails every time, the repairs do not help: the loop gives up, and the Hub's reason is the note's detail
  {
    const model = scriptedModel(ANSWER, ['first.js', 'repair-1.js', 'repair-2.js']);
    const { parent, agent, stop } = await fixture('blocked', { manifest: true, provider: model });
    const backend = new FailingBackend();
    parent.executionRegistry.register(backend);
    try {
      const running = agent.run({ tasks: [{ id: 'wants', prompt: 'WANTS: fix it, then repair when the check fails', verify: true }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 });
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        waiting = [...agent.jobs.values()].at(-1)?.workers?.[0]?.status === 'awaiting_test_grant';
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(waiting, true, 'the worker asks for a test grant after editing');
      const checks = (await agent.discoverWorkerChecks({ workerId: 'wants' })).checks;
      assert.equal(checks.length, 1);
      await agent.grantCheck({ workerId: 'wants', checkId: checks[0].id, confirmation: 'AUTHORIZE ISOLATED CHECK' });
      const job = await withDeadline(running, 60_000, 'the verified loop did not end');
      const wants = job.workers[0];
      assert.equal(backend.executions, 3, 'three attempts at the check, two repairs between them');
      assert.equal(wants.status, 'needs_attention', JSON.stringify(wants));
      assert.equal(wants.summary, ANSWER, 'the model\'s own words');
      const reason = 'Repair/test retry budget exhausted.';
      assert.deepEqual(wants.verificationNote, { code: 'blocked', text: 'Verified coding blocked: ' + reason, detail: reason });
      assert.equal(wants.verificationOutcome.state, 'needs_attention', 'the loop\'s own record agrees with the note');
      assert.equal(wants.verificationOutcome.reason, reason);
      assert.equal(wants.verificationAttempts.length, 3);
      assert.ok(wants.verificationAttempts.every((attempt) => attempt.testOutcomeVerified !== true), 'and no attempt was verified');
      ok('a verification the loop gave up on ends as needs_attention with a blocked note that carries the loop\'s reason');
    } finally { await stop(); }
  }

  // The four sentences are the Hub's, in the source of the Hub, and each note code a page can be asked to translate is one the Hub can send.
  const source = await fs.readFile(path.join(bundleRoot, 'lib', 'coding-orchestrator.mjs'), 'utf8');
  for (const [code, text] of Object.entries(NOTES)) assert.ok(source.includes(`'${code}'`) && source.includes(text), code);
  assert.ok(source.includes("'blocked'") && source.includes('Verified coding blocked: '));
  ok('the notes named here are the ones lib/coding-orchestrator.mjs sends');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
