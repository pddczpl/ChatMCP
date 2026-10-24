// The Hub's own sentences about how a worker's verification ended are a field of their own (verificationNote), not text appended to what the model
// said. The summary of a worker is the model's words and nothing else, so that a page can label the one as the AI's report and the other as the Hub's.
// The same holds for a worker whose run fails: the AgentRunner's own error is the field `runnerError`, and a model that said nothing leaves the summary empty.
// And for a worker that completed: the sentence the AgentRunner ends the model's final text with when the Hub's evidence does not back the run's plan is the field `runnerNotice`.
// The code the AgentRunner ended a failed run with comes with its sentence as `runnerErrorCode`: it is what a page translates, so only a short plain code is passed on.
// Real orchestrator, real AgentRunner and real test broker; the model and the isolated backend are scripted (this is not OS isolation).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { CodingWorktreeOrchestrator, runnerCodeOf, splitRunnerNotice, workerWords } from '../lib/coding-orchestrator.mjs';
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

/** A backend that passes every check it is asked to run. */
class PassingBackend extends FailingBackend {
  async execute(request) {
    this.executions += 1;
    const stamp = new Date().toISOString();
    const receipt = validateExecutionReceipt({
      runId: request.runId, status: 'completed', exitCode: 0, stdout: 'Synthetic native comparison matched', stderr: '',
      startedAt: stamp, completedAt: stamp, durationMs: 1, backend: 'windows-sandbox', snapshotHash: request.snapshotHash,
      checkHash: request.checkHash, truncated: false, evidencePath: null, reasons: [],
      grader: { version: 1, kind: 'native-blackbox', manifestSha256: request.grader.manifestSha256, cases: 1, passed: 1, failed: 0, valid: true },
    });
    return Object.freeze({ ...receipt, publisherAuthenticated: true, provenance: 'publisher_authenticated', graderAuthenticated: true, publicationProtocol: 'system-sealed-exit-v1' });
  }
}

/** What the owner does in the Agents tab: wait until the worker asks for its check to be allowed, and allow the one check the Hub found. */
async function allowChecks(agent, workerId) {
  let waiting = false;
  for (let i = 0; i < 200 && !waiting; i++) {
    waiting = [...agent.jobs.values()].at(-1)?.workers?.find((worker) => worker.id === workerId)?.status === 'awaiting_test_grant';
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(waiting, true, 'the worker asks for a test grant after editing');
  const checks = (await agent.discoverWorkerChecks({ workerId })).checks;
  assert.equal(checks.length, 1);
  await agent.grantCheck({ workerId, checkId: checks[0].id, confirmation: 'AUTHORIZE ISOLATED CHECK' });
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

/** A model that ends its turn without a word: no text and no tool call. The AgentRunner turns that into an error of its own. */
const silentModel = () => ({
  ready: () => true,
  snapshot: () => ({ provider: 'fake', model: 'fixture' }),
  async respond() { return { status: 'completed', output: [] }; },
});
/** A model that refuses, in as many words as it likes: the refusal is its own text, which the AgentRunner puts inside an error sentence of its own. */
const refusingModel = (refusal) => ({
  ready: () => true,
  snapshot: () => ({ provider: 'fake', model: 'fixture' }),
  async respond() { return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal }] }] }; },
});
/** A model whose request fails: the provider (or the system, or a bug) throws an error that carries whatever `code` it likes. */
const failingModel = (error) => ({
  ready: () => true,
  snapshot: () => ({ provider: 'fake', model: 'fixture' }),
  async respond() { throw error; },
});
/** A model that is still thinking when the owner stops the run: it answers only when it is aborted, and then with the abort. */
const waitingModel = (onAsked) => ({
  ready: () => true,
  snapshot: () => ({ provider: 'fake', model: 'fixture' }),
  async respond({ signal }) {
    onAsked();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  },
});
/** What the AgentRunner records when a model ends without any text (the `empty_final` fault of lib/agent.mjs), and when the owner stops a run (`user_cancelled`). */
const EMPTY_FINAL = 'Model kết thúc nhưng không đưa ra kết quả văn bản cuối cùng. Thông báo tiến độ không được coi là kết quả hoàn tất.';
const USER_CANCELLED = 'Đã dừng theo yêu cầu. Tác vụ chưa được xác nhận hoàn tất.';
const REFUSAL_PREFIX = 'Model không thể thực hiện yêu cầu: ';
const RUNNER_ERROR_MAX = 2000;

const ANSWER = 'Edited the file; checking it is for the Hub.';
/**
 * What the AgentRunner puts after the model's final text when the goal plan of the run has evidence the Hub did not record ("[Verification notice]" in lib/agent.mjs).
 * The scripted model runs no check and reads no diff, so a task that is planned in phases always ends this way.
 */
const NOTICE_MARK = '\n\n[Verification notice] ';
const NOTICE = 'DatGold has NOT independently verified full completion: No verified successful project check; No independently recorded Git diff review.';
/** The same sentence as a Hub wrote it before the product was renamed: a task saved by that Hub still ends with it. */
const SAVED_NOTICE = 'ChatMCP has NOT independently verified full completion: No verified successful project check; No independently recorded Git diff review.';
/** A task the Hub plans in phases (decomposeCodingTask: 160+ characters and 2+ clauses). The scripted model writes the file named in its "add <file>". */
const longTask = (file) => `Add the file ${file} to the project root with one line of text. Then update the tests so that the whole suite still passes, and verify that the new file is listed by the README. add ${file}`;
/** A task of the repair scenario: long enough to be planned, with no "add <file>" in it, so the scripted model takes the next file of its script. */
const REPAIR_TASK = 'WANTS: fix it. Then repair when the check fails, and keep repairing until the registered check passes or the retry budget is used up. Do not touch anything else in the project.';
assert.ok(longTask('x.txt').length >= 160 && REPAIR_TASK.length >= 160, '(premise) both tasks are long enough to be planned in phases');
const NOTES = {
  no_checks: 'No supported pinned Node test definition was discovered.',
  grant_timeout: 'Owner did not approve all isolated test grants in the allotted window.',
  verified: 'All registered pinned Node checks have fresh signed TAP evidence.',
};
try {
  // 0. the split on its own. The runner's sentence is rebuilt from the outcome the runner recorded for the run, so that only what the runner appended can be taken for
  // it; the model's words are everything before the last place it stands, and what follows it (the runner appends to the end of the text) is the runner's as well
  {
    const missing = ['No verified successful project check', 'No independently recorded Git diff review'];
    const outcome = { ready: false, missing, reason: 'Some required evidence is missing; task completion is not certified' };
    assert.deepEqual(splitRunnerNotice(ANSWER + NOTICE_MARK + NOTICE, outcome), { answer: ANSWER, notice: NOTICE });
    assert.deepEqual(splitRunnerNotice(ANSWER + NOTICE_MARK + NOTICE, { ...outcome, missing: [missing[0]] }),
      { answer: ANSWER + NOTICE_MARK + NOTICE, notice: '' }, 'a record that lists other gaps is not the sentence that stands there');
    const hooked = NOTICE + '\n\n[Hook notice] A hook objected.';
    assert.deepEqual(splitRunnerNotice(ANSWER + NOTICE_MARK + hooked, outcome), { answer: ANSWER, notice: hooked }, 'whatever the runner appends after its sentence is not the model\'s either');
    // the model's trailing white space is its own, and so is a copy of the sentence it wrote: the last one is the runner's
    assert.deepEqual(splitRunnerNotice(ANSWER + ' \n' + NOTICE_MARK + NOTICE, outcome), { answer: ANSWER + ' \n', notice: NOTICE });
    const quoted = ANSWER + NOTICE_MARK + NOTICE;
    assert.deepEqual(splitRunnerNotice(quoted + NOTICE_MARK + NOTICE, outcome), { answer: quoted, notice: NOTICE });
    assert.deepEqual(splitRunnerNotice(NOTICE_MARK + NOTICE, outcome), { answer: '', notice: NOTICE });
    // no sentence in the text, or no record that the runner wrote one: every word is the model's
    assert.deepEqual(splitRunnerNotice(ANSWER, outcome), { answer: ANSWER, notice: '' });
    assert.deepEqual(splitRunnerNotice(quoted, { ready: true, missing: [], reason: 'No complex task graph required' }), { answer: quoted, notice: '' });
    assert.deepEqual(splitRunnerNotice(quoted, { ready: true, missing }), { answer: quoted, notice: '' }, 'a run the runner called ready has no sentence of its own');
    for (const bad of [undefined, null, 'ready', 7, [], { missing }, { ready: 'no', missing }, { ready: false }, { ready: false, missing: 'No check' }]) {
      assert.deepEqual(splitRunnerNotice(quoted, bad), { answer: quoted, notice: '' }, JSON.stringify(bad));
    }
    for (const bad of [undefined, null, 7, {}, ['x']]) assert.deepEqual(splitRunnerNotice(bad, outcome), { answer: '', notice: '' }, String(bad));
    // the words of a worker: the model's, cut at 12,000 characters, and the Hub's, cut at 2,000, each cut AFTER the split (a long answer must not cut the sentence off)
    assert.deepEqual(workerWords({ finalText: ANSWER + NOTICE_MARK + NOTICE, verificationOutcome: outcome }), { summary: ANSWER, notice: NOTICE });
    assert.deepEqual(workerWords({ finalText: ANSWER, verificationOutcome: { ready: true, missing: [] } }), { summary: ANSWER, notice: '' });
    const big = 'word '.repeat(2600);
    assert.deepEqual(workerWords({ finalText: big + NOTICE_MARK + NOTICE, verificationOutcome: outcome }), { summary: big.slice(0, 12000), notice: NOTICE }, 'a long answer does not cut the Hub\'s sentence off');
    const tail = NOTICE + '\n\n[Hook notice] ' + 'y'.repeat(5000);
    assert.deepEqual(workerWords({ finalText: ANSWER + NOTICE_MARK + tail, verificationOutcome: outcome }), { summary: ANSWER, notice: tail.slice(0, 2000) }, 'and what the Hub says is cut at 2,000');
    for (const bad of [undefined, null, {}, { finalText: 7 }, 'text']) assert.deepEqual(workerWords(bad), { summary: '', notice: '' }, JSON.stringify(bad));
    ok('the runner\'s verification notice is split off the end of a final text only where the runner\'s own record says it wrote one');
    // a task saved before the product was renamed ends with the sentence as that Hub wrote it ("ChatMCP ..."): the same split, and the notice is the sentence as it stands
    assert.deepEqual(splitRunnerNotice(ANSWER + NOTICE_MARK + SAVED_NOTICE, outcome), { answer: ANSWER, notice: SAVED_NOTICE });
    assert.deepEqual(workerWords({ finalText: ANSWER + NOTICE_MARK + SAVED_NOTICE, verificationOutcome: outcome }), { summary: ANSWER, notice: SAVED_NOTICE });
    assert.deepEqual(splitRunnerNotice(ANSWER + NOTICE_MARK + SAVED_NOTICE + '\n\n[Hook notice] A hook objected.', outcome),
      { answer: ANSWER, notice: SAVED_NOTICE + '\n\n[Hook notice] A hook objected.' }, 'and what that runner appended after its sentence is its own');
    // whichever wording stands last is the runner's; a copy of the other one before it is the model's
    assert.deepEqual(splitRunnerNotice(ANSWER + NOTICE_MARK + SAVED_NOTICE + NOTICE_MARK + NOTICE, outcome), { answer: ANSWER + NOTICE_MARK + SAVED_NOTICE, notice: NOTICE });
    assert.deepEqual(splitRunnerNotice(ANSWER + NOTICE_MARK + NOTICE + NOTICE_MARK + SAVED_NOTICE, outcome), { answer: ANSWER + NOTICE_MARK + NOTICE, notice: SAVED_NOTICE });
    // the record lists other gaps: neither wording is the sentence that stands there
    assert.deepEqual(splitRunnerNotice(ANSWER + NOTICE_MARK + SAVED_NOTICE, { ...outcome, missing: [missing[0]] }), { answer: ANSWER + NOTICE_MARK + SAVED_NOTICE, notice: '' });
    ok('a task saved before the rename is split the same way: its sentence says ChatMCP, and it is still the Hub\'s');
  }

  // 0b. the code on its own. The AgentRunner records the `code` of the error that ended a run as it came: a provider's, the system's (`ECONNRESET`), a bug's, a number. A page looks
  // a sentence up by it, so the Hub passes on only a short plain code (lowercase letters, digits and underscores, starting with a letter, 64 characters at most)
  {
    for (const good of ['empty_final', 'user_cancelled', 'gateway_rate_limit', 'a', 'a1', 'a_', 'x'.repeat(64)]) assert.equal(runnerCodeOf(good), good, good);
    const notCodes = [undefined, null, '', 'ECONNRESET', 'Gateway_auth', 'gateway_Auth', 'gatewayAuth', 'gateway-auth', 'gateway auth', ' gateway_auth', '_leading', '1digit', 'trailing\n', 'x'.repeat(65), 'kém', '../agent_status_failed',
      'a.b', 429, 0, true, {}, ['gateway_auth'], { toString: () => 'gateway_auth' }];
    for (const bad of notCodes) assert.equal(runnerCodeOf(bad), '', typeof bad === 'object' ? JSON.stringify(bad) ?? 'object' : String(bad));
    ok('only a short plain code is passed on as the code of a run that ended with an error');
  }

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
      assert.ok(!('runnerError' in plain) && !('runnerError' in wants), 'a run that ended normally has no error of the runner to report');
      assert.ok(!('runnerErrorCode' in plain) && !('runnerErrorCode' in wants), 'and so no code of one');
      assert.ok(!('runnerNotice' in plain) && !('runnerNotice' in wants), 'and tasks too short to be planned have no sentence of the runner either');
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
      const job = await withDeadline(agent.run({ tasks: [{ id: 'wants', prompt: longTask('wants.txt'), verify: true }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 }),
        30_000, 'the worker kept waiting for a grant that nobody gives: the window is not the one given');
      const wants = job.workers[0];
      assert.equal(wants.status, 'needs_attention', JSON.stringify(wants));
      assert.equal(wants.summary, ANSWER);
      assert.equal(wants.runnerNotice, NOTICE, 'a long task: the same first run, the same split, whatever the Hub did after it');
      assert.deepEqual(wants.verificationNote, { code: 'grant_timeout', text: NOTES.grant_timeout });
      assert.ok(!('runnerError' in wants) && !('runnerErrorCode' in wants), 'the run itself ended normally');
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
      const running = agent.run({ tasks: [{ id: 'wants', prompt: REPAIR_TASK, verify: true }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 });
      await allowChecks(agent, 'wants');
      const job = await withDeadline(running, 60_000, 'the verified loop did not end');
      const wants = job.workers[0];
      assert.equal(backend.executions, 3, 'three attempts at the check, two repairs between them');
      assert.equal(wants.status, 'needs_attention', JSON.stringify(wants));
      assert.equal(wants.summary, ANSWER, 'the model\'s own words');
      assert.equal(wants.runnerNotice, NOTICE, 'the runner\'s sentence on the first run, which the repairs after it do not touch');
      const reason = 'Repair/test retry budget exhausted.';
      assert.deepEqual(wants.verificationNote, { code: 'blocked', text: 'Verified coding blocked: ' + reason, detail: reason });
      assert.ok(!('runnerError' in wants) && !('runnerErrorCode' in wants), 'the Hub\'s reason for stopping the loop is the note\'s, not an error of the runner');
      assert.equal(wants.verificationOutcome.state, 'needs_attention', 'the loop\'s own record agrees with the note');
      assert.equal(wants.verificationOutcome.reason, reason);
      assert.equal(wants.verificationAttempts.length, 3);
      assert.ok(wants.verificationAttempts.every((attempt) => attempt.testOutcomeVerified !== true), 'and no attempt was verified');
      ok('a verification the loop gave up on ends as needs_attention with a blocked note that carries the loop\'s reason');
    } finally { await stop(); }
  }

  // 4. the model says nothing at all: the AgentRunner fails the run with a sentence of its own. That sentence is the Hub's, so it is the worker's runnerError,
  // and the summary stays what the model said, which is nothing (it used to be that sentence, and a page labelled it "AI report")
  {
    const { agent, stop } = await fixture('silent', { manifest: false, provider: silentModel() });
    try {
      const job = await withDeadline(agent.run({ tasks: [{ id: 'quiet', prompt: 'QUIET: add quiet.txt' }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 }),
        60_000, 'the run of a model that says nothing did not end');
      const quiet = job.workers[0];
      assert.equal(quiet.status, 'failed', JSON.stringify(quiet));
      assert.equal(quiet.summary, '', 'the model said nothing: the summary is empty, and the runner\'s sentence is not put in its place');
      assert.equal(quiet.runnerError, EMPTY_FINAL, 'the runner\'s own sentence, exactly');
      assert.equal(quiet.runnerErrorCode, 'empty_final', 'and the code it carries, which is what a page translates');
      assert.ok(!('verificationNote' in quiet), 'it is an error of the run, not a note about a verification');
      assert.ok(!('runnerNotice' in quiet), 'and a run with no final text has no notice appended to it');
      assert.equal(job.workers.length, 1);
      const saved = JSON.parse(await fs.readFile(path.join(agent.directory, 'jobs.json'), 'utf8')).jobs.at(-1).workers[0];
      assert.equal(saved.summary, '');
      assert.equal(saved.runnerError, quiet.runnerError, 'what is saved is what is reported');
      assert.equal(saved.runnerErrorCode, 'empty_final', 'the code too');
      assert.equal(agent.state().jobs.at(-1).workers[0].runnerError, EMPTY_FINAL, 'and it is what GET /api/studio/coding sends to a page');
      assert.equal(agent.state().jobs.at(-1).workers[0].runnerErrorCode, 'empty_final', 'with its code');
      ok('a worker whose model said nothing fails with an empty summary and the runner\'s sentence as its own runnerError, with its code');
    } finally { await stop(); }
  }

  // 5. a refusal is the model's own words, wrapped in the runner's sentence. It is still the runner's record of why the run stopped, kept apart from the
  // summary, and cut at the bound however long the model went on
  {
    const refusal = 'I will not do that, because it is not a good idea. '.repeat(100);
    assert.ok(REFUSAL_PREFIX.length + refusal.length > RUNNER_ERROR_MAX, '(premise) the refusal is longer than the bound');
    const { agent, stop } = await fixture('refusing', { manifest: false, provider: refusingModel(refusal) });
    try {
      const job = await withDeadline(agent.run({ tasks: [{ id: 'no', prompt: 'NO: add no.txt' }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 }),
        60_000, 'the run of a model that refuses did not end');
      const refused = job.workers[0];
      assert.equal(refused.status, 'failed', JSON.stringify({ status: refused.status, error: refused.error }));
      assert.equal(refused.summary, '', 'a refusal is not a report of work');
      assert.equal(refused.runnerError.length, RUNNER_ERROR_MAX, 'cut at the bound');
      assert.equal(refused.runnerError, (REFUSAL_PREFIX + refusal).slice(0, RUNNER_ERROR_MAX), 'the runner\'s sentence and the beginning of the refusal, in that order');
      assert.equal(refused.runnerErrorCode, 'model_refusal', 'the code says it was a refusal whatever the model wrote and however much of it was kept');
      assert.ok(!('runnerNotice' in refused));
      ok('a long refusal is the runnerError of the worker, cut at ' + RUNNER_ERROR_MAX + ' characters, and not its summary');
    } finally { await stop(); }
  }

  // 6. the owner stops the run while the model is still working: the runner's sentence about it is the runnerError of the worker that was stopped
  {
    let asked;
    const reached = new Promise((resolve) => { asked = resolve; });
    const { agent, stop } = await fixture('stopped', { manifest: false, provider: waitingModel(() => asked()) });
    try {
      const running = agent.run({ tasks: [{ id: 'slow', prompt: 'SLOW: add slow.txt' }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 });
      await withDeadline(reached, 30_000, 'the model was never asked');
      assert.equal(agent.cancel().cancelled, true);
      const job = await withDeadline(running, 30_000, 'the run did not end after it was stopped');
      const slow = job.workers[0];
      assert.equal(slow.status, 'cancelled', JSON.stringify(slow));
      assert.equal(slow.summary, '');
      assert.equal(slow.runnerError, USER_CANCELLED);
      assert.equal(slow.runnerErrorCode, 'user_cancelled', 'a stopped run is told by its code even though its status is cancelled and not failed');
      assert.ok(!('runnerNotice' in slow));
      ok('a worker the owner stopped carries the runner\'s sentence about it as runnerError, with an empty summary');
    } finally { await stop(); }
  }

  // 7. a task long enough to be planned in phases: the Hub's evidence cannot back the plan (the scripted model runs no check and reads no diff), so the AgentRunner ends the
  // model's final text with a sentence of its own. The main chat shows that as one text, on purpose. For a worker the model's words are the summary and the sentence is the
  // Hub's, a field of its own: a page labels the one as the AI's report and the other as the Hub's. It used to be in the summary, under "AI report".
  {
    const { agent, stop } = await fixture('notice', { manifest: false, provider: scriptedModel(ANSWER, []) });
    try {
      const job = await withDeadline(agent.run({
        tasks: [{ id: 'short', prompt: 'SHORT: add short.txt' }, { id: 'long', prompt: longTask('long.txt') }, { id: 'wants', prompt: longTask('wants.txt'), verify: true }],
        confirmation: 'CREATE WORKTREES', maxConcurrency: 1,
      }), 120_000, 'the run of the long tasks did not end');
      const [short, long, wants] = ['short', 'long', 'wants'].map((id) => job.workers.find((worker) => worker.id === id));
      assert.equal(short.status, 'ready_for_review', JSON.stringify(short));
      assert.equal(long.status, 'ready_for_review', JSON.stringify(long));
      assert.equal(short.summary, ANSWER);
      assert.ok(!('runnerNotice' in short), 'a task too short to be planned has nothing for the runner to say');
      assert.equal(long.summary, ANSWER, 'the summary is what the model said: the runner\'s sentence is not in it');
      assert.equal(long.runnerNotice, NOTICE, 'the runner\'s sentence, exactly, as a field of its own');
      assert.ok(!('runnerError' in long) && !('runnerErrorCode' in long) && !('verificationNote' in long), 'the run ended normally, and nobody was asked to verify it');
      // the runner keeps what it always kept: its final text is the model's words, the separator and the sentence, which is what the main chat shows
      const held = JSON.parse(await fs.readFile(path.join(agent.directory, 'runs', job.id, 'state', 'long', 'tasks', long.agentTaskId, 'task.json'), 'utf8'));
      assert.equal(held.finalText, ANSWER + NOTICE_MARK + NOTICE, 'the text of the runner is unchanged: only the worker\'s record of it is split');
      assert.equal(held.verificationOutcome.ready, false, '(premise) the runner says the evidence is missing');
      // a worker that was asked to verify has the same split: the first run's final text is the same text, whatever the Hub did after it
      assert.equal(wants.status, 'needs_attention', JSON.stringify(wants));
      assert.equal(wants.summary, ANSWER);
      assert.equal(wants.runnerNotice, NOTICE);
      assert.equal(wants.verificationNote.code, 'no_checks', 'and its verification note is still its own');
      const saved = JSON.parse(await fs.readFile(path.join(agent.directory, 'jobs.json'), 'utf8')).jobs.at(-1);
      assert.equal(saved.workers.find((worker) => worker.id === 'long').runnerNotice, NOTICE, 'what is saved is what is reported');
      assert.equal(saved.workers.find((worker) => worker.id === 'long').summary, ANSWER);
      assert.equal(agent.state().jobs.at(-1).workers.find((worker) => worker.id === 'long').runnerNotice, NOTICE, 'and it is what GET /api/studio/coding sends to a page');
      // and a Hub that is started again reads it back: a second orchestrator on the same folder reports the same
      const restarted = new CodingWorktreeOrchestrator({ manager: {}, provider: {}, bundleRoot, directory: agent.directory });
      await restarted.load();
      assert.equal(restarted.recoveryFault, null);
      assert.equal(restarted.state().jobs.at(-1).workers.find((worker) => worker.id === 'long').runnerNotice, NOTICE, 'after a restart');
      ok('a worker whose final text the runner ended with its verification notice has the model\'s words as summary and the sentence as runnerNotice');
    } finally { await stop(); }
  }

  // 8. only what the runner appended after the model's words is the runner's. A model that writes the very same sentence keeps it in its summary: when the runner did not
  // append one (a task too short to be planned) all of the text is the model's, and when it did, the runner's is the last one
  {
    const quoting = 'Done.' + NOTICE_MARK + NOTICE;
    const { agent, stop } = await fixture('quote', { manifest: false, provider: scriptedModel(quoting, []) });
    try {
      const job = await withDeadline(agent.run({
        tasks: [{ id: 'short', prompt: 'SHORT: add short.txt' }, { id: 'long', prompt: longTask('long.txt') }],
        confirmation: 'CREATE WORKTREES', maxConcurrency: 1,
      }), 90_000, 'the run of a model that quotes the notice did not end');
      const [short, long] = ['short', 'long'].map((id) => job.workers.find((worker) => worker.id === id));
      assert.equal(short.summary, quoting, 'nothing was appended: every word is the model\'s, the sentence included');
      assert.ok(!('runnerNotice' in short), 'and the Hub said nothing');
      assert.equal(long.summary, quoting, 'the model\'s sentence stays in its summary');
      assert.equal(long.runnerNotice, NOTICE, 'and the runner\'s, which comes after it, is the runner\'s');
      ok('a model that writes the Hub\'s sentence itself keeps it in its summary; the runner\'s own is the one after it');
    } finally { await stop(); }
  }

  // 9. the model's words are cut at 12,000 characters AFTER the runner's sentence is split off: a long answer must not cut the Hub's sentence off the end of the text first
  {
    const answer = 'word '.repeat(2600);
    assert.ok(answer.length > 12_000, '(premise) the answer is longer than the bound');
    const { agent, stop } = await fixture('big-answer', { manifest: false, provider: scriptedModel(answer, []) });
    try {
      const job = await withDeadline(agent.run({ tasks: [{ id: 'big', prompt: longTask('big.txt') }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 }),
        90_000, 'the run of a model with a long answer did not end');
      const big = job.workers[0];
      assert.equal(big.status, 'ready_for_review', JSON.stringify(big).slice(0, 300));
      assert.equal(big.summary, answer.slice(0, 12_000), 'the summary is the model\'s words, cut at the bound');
      assert.equal(big.runnerNotice, NOTICE, 'and the Hub\'s sentence, which came last, is whole');
      ok('a model answer longer than the bound is cut, and the Hub\'s sentence after it is not');
    } finally { await stop(); }
  }

  // 10. the check is allowed and passes: the worker is verified. The first run's final text is the same text, so it is split the same way, and the Hub's sentence on it
  // is a field of its own beside the Hub's note that every check has evidence
  {
    const { parent, agent, stop } = await fixture('verified', { manifest: true, provider: scriptedModel(ANSWER, []) });
    const backend = new PassingBackend();
    parent.executionRegistry.register(backend);
    try {
      const running = agent.run({ tasks: [{ id: 'wants', prompt: longTask('wants.txt'), verify: true }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 });
      await allowChecks(agent, 'wants');
      const job = await withDeadline(running, 60_000, 'the verified loop did not end');
      const wants = job.workers[0];
      assert.equal(backend.executions, 1, 'the check passed at the first attempt');
      assert.equal(wants.status, 'ready_for_review', JSON.stringify(wants).slice(0, 400));
      assert.equal(wants.verificationAttempts.at(-1).testOutcomeVerified, true, '(premise) the Hub verified the check itself');
      assert.deepEqual(wants.verificationNote, { code: 'verified', text: NOTES.verified });
      assert.equal(wants.summary, ANSWER);
      assert.equal(wants.runnerNotice, NOTICE, 'the runner\'s sentence on the first run stays the Hub\'s, beside the note that the checks the Hub ran have evidence');
      ok('a worker the Hub verified keeps the model\'s words as summary and the runner\'s sentence on them as runnerNotice');
    } finally { await stop(); }
  }

  // 11. the code of a run that ended with an error is whatever `code` the error carried: a model adapter's, the system's, a bug's, a number. The real runner keeps it as it came (checked
  // here, so this goes through the real runner and not through the function of 0b alone); the Hub passes on only a short plain code, and only with the sentence it belongs to
  {
    const failure = (message, code) => Object.assign(new Error(message), { code });
    const cases = [
      // [what the error carries, the error, the code the worker reports ('' = none)]
      ['a code of the model adapters', failure('Gateway HTTP 429: slow down', 'gateway_rate_limit'), 'gateway_rate_limit'],
      ['the longest plain code', failure('edge', 'x'.repeat(64)), 'x'.repeat(64)],
      ['no code at all: the runner calls it task_failed', new Error('plain failure'), 'task_failed'],
      ['a code of the system', failure('read ECONNRESET', 'ECONNRESET'), ''],
      ['a code with a capital letter in it', failure('mixed', 'gateway_Auth'), ''],
      ['a code one character too long', failure('long', 'x'.repeat(65)), ''],
      ['a code that starts with an underscore', failure('underscore', '_leading'), ''],
      ['a code that starts with a digit', failure('digit', '1digit'), ''],
      ['a code with a space in it', failure('space', 'has space'), ''],
      ['a number', failure('number', 429), ''],
      ['a list that reads as a code', failure('list', ['gateway_auth']), ''],
      ['an empty code', failure('empty code', ''), ''],
      ['a plain code and no words: the runner has no sentence, so there is nothing for the code to belong to', failure('', 'gateway_auth'), ''],
    ];
    for (const [index, [label, error, expected]] of cases.entries()) {
      const { agent, stop } = await fixture('code-' + index, { manifest: false, provider: failingModel(error) });
      try {
        const job = await withDeadline(agent.run({ tasks: [{ id: 'w', prompt: 'W: add w.txt' }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 }),
          60_000, `the run of a model that fails (${label}) did not end`);
        const failed = job.workers[0];
        assert.equal(failed.status, 'failed', `${label}: ${JSON.stringify(failed).slice(0, 300)}`);
        assert.equal(failed.summary, '', label);
        if (error.message) assert.equal(failed.runnerError, error.message, `${label}: the sentence is the error's own`);
        else assert.ok(!('runnerError' in failed), `${label}: the runner recorded no sentence`);
        if (expected) assert.equal(failed.runnerErrorCode, expected, label);
        else assert.ok(!('runnerErrorCode' in failed), `${label}: no code is passed on, and this one is ${JSON.stringify(failed.runnerErrorCode)}`);
        // (premise) the runner kept the code exactly as the error carried it, so a filter in the Hub is what stands between a page and an odd code
        const held = JSON.parse(await fs.readFile(path.join(agent.directory, 'runs', job.id, 'state', 'w', 'tasks', failed.agentTaskId, 'task.json'), 'utf8'));
        assert.deepEqual(held.errorCode, error.code ?? 'task_failed', `(premise) ${label}: the runner's own record of the code`);
        const saved = JSON.parse(await fs.readFile(path.join(agent.directory, 'jobs.json'), 'utf8')).jobs.at(-1).workers[0];
        assert.equal(saved.runnerErrorCode, failed.runnerErrorCode, `${label}: what is saved is what is reported`);
      } finally { await stop(); }
    }
    ok('a run that ended with an error reports its code when it is a short plain one with a sentence, and no other, through the real runner');
  }

  // The four sentences are the Hub's, in the source of the Hub, and each note code a page can be asked to translate is one the Hub can send.
  const source = await fs.readFile(path.join(bundleRoot, 'lib', 'coding-orchestrator.mjs'), 'utf8');
  for (const [code, text] of Object.entries(NOTES)) assert.ok(source.includes(`'${code}'`) && source.includes(text), code);
  assert.ok(source.includes("'blocked'") && source.includes('Verified coding blocked: '));
  ok('the notes named here are the ones lib/coding-orchestrator.mjs sends');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
