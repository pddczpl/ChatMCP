// The proof ledger of Proof-of-Done (plan task pod-16, docs/PROOF-LEDGER.md): receipt v2 lines in an append-only, hash-chained JSONL
// file per task (lib/proof/ledger.mjs), and the hashes of a command and of its output that run_command, tasks_run, test_run and
// build_run report.
//
// What it proves:
//   1. real commands through ShellRunner: the output hashes equal the sha256 of the bytes the command wrote (empty, binary and not
//      UTF-8, more than the capture keeps, more than the preview, a timeout), with the byte counts and the truncation flags, and the
//      four tools report the command hash and the output hashes;
//   2. a check receipt never holds the output: only its hashes and a redacted preview of at most 2 KiB, and the ledger refuses a check
//      record with any other field; a secret in the command line or in the output (by pattern or registered) does not reach the
//      ledger file, while the command hash is of the exact text that ran;
//   3. verifyChain: a flip of ANY single byte of a ledger is reported at the seq of the line that holds it; a line rewritten with its
//      own hash recomputed is reported at the next line; a deleted, a swapped and an unknown-type line; a crash that tore the last line
//      is reported as torn_tail, and the next append repairs it with an `uncertain` record;
//   4. concurrent appends from two ledger objects on one file keep one gap-free chain; a refused record writes nothing; a broken
//      ledger refuses every append;
//   5. treeBefore/treeAfter come from the pod-15 snapshot engine; the toolchain versions are probed once per workspace, with absolute
//      program paths only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GENESIS, LEDGER_VERSION, PREVIEW_BYTES, ProofLedger, RECORD_TYPES, ToolchainProbe, argsSha256, checkReceipt, commandSha256,
  ledgerPath, recordCheck, validateRecord, verifyChain,
} from '../lib/proof/ledger.mjs';
import { BoundedCapture, ShellRunner } from '../lib/shell-runner.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { TreeSnapshotter } from '../lib/proof/tree-snapshot.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EMPTY = sha(Buffer.alloc(0));
const HEX64 = /^[0-9a-f]{64}$/;
const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-proof-ledger-')));
let passed = 0;
const ok = (message) => { passed += 1; console.log(`PASS ${message}`); };
const rejection = async (promise) => {
  try { await promise; } catch (error) { return error.code; }
  return assert.fail('expected a rejection');
};
/** The line format of docs/PROOF-LEDGER.md, written again here so the suite does not trust the module for it. */
const lineFor = (entry) => {
  const body = JSON.stringify({ v: entry.v, seq: entry.seq, prev: entry.prev, ts: entry.ts, type: entry.type, record: entry.record });
  return `${body.slice(0, -1)},"hash":"${sha(Buffer.from(body, 'utf8'))}"}`;
};
const linesOf = (bytes) => bytes.toString('utf8').split('\n').filter(Boolean);
const entriesOf = (bytes) => linesOf(bytes).map((line) => JSON.parse(line));

const work = path.join(tmp, 'work');
const state = path.join(tmp, 'state');
const hub = path.join(tmp, 'hub');
await fs.mkdir(work, { recursive: true });
await fs.mkdir(state, { recursive: true });
await fs.writeFile(path.join(work, 'emit.cjs'), [
  "const mode = process.argv[2];",
  "if (mode === 'text') { process.stdout.write('hello ledger\\n'); process.stderr.write('warn: careful\\n'); }",
  "if (mode === 'binary') process.stdout.write(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41, 0xc3, 0x28, 0x0a]));",
  "if (mode === 'big') { const b = Buffer.alloc(50000); for (let i = 0; i < b.length; i += 1) b[i] = 97 + (i % 26); process.stdout.write(b); }",
  "if (mode === 'wide') process.stdout.write('ệ'.repeat(1500));",
  "if (mode === 'secret') { process.stdout.write('the key is sk-' + 'abcdefghijklmnopqrstuvwx' + ' and ' + process.argv[3] + '\\n'); }",
  '',
].join('\n'));
await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({ name: 'ledger-fixture', version: '1.0.0', scripts: { build: 'node emit.cjs text' } }));
await fs.writeFile(path.join(work, 'ledger.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
const bigBytes = Buffer.alloc(50000);
for (let i = 0; i < bigBytes.length; i += 1) bigBytes[i] = 97 + (i % 26);
const binaryBytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41, 0xc3, 0x28, 0x0a]);
const wideText = String.fromCodePoint(0x1ec7).repeat(1500);
const REGISTERED = 'hunter2-registered-value';
const PATTERN_KEY = 'sk-zyxwvutsrqponmlkjihgfe';

const workspace = new StudioWorkspace({ manager: { workspace: work }, directory: state });
const runner = new ShellRunner({ workspace, stateDirectory: state, secrets: () => [REGISTERED] });

try {
  // ---------------------------------------------------------------- 1. the output hashes of real commands
  {
    const capture = new BoundedCapture(1000);
    const stream = Buffer.from('x'.repeat(5000));
    for (let i = 0; i < stream.length; i += 700) capture.push(stream.subarray(i, i + 700));
    const first = capture.result();
    assert.equal(first.truncated, true);
    assert.equal(first.sha256, sha(stream), 'the hash covers every byte, also the middle the capture dropped');
    assert.equal(capture.result().sha256, first.sha256, 'result() can be asked twice');
    assert.equal(new BoundedCapture(1000).result().sha256, EMPTY);
    ok('BoundedCapture hashes the whole stream, the dropped middle included, and can report twice');
  }

  const textRun = await runner.run({ command: 'node emit.cjs text' });
  assert.equal(textRun.exitCode, 0, textRun.stderr);
  assert.deepEqual(textRun.outputSha256, { stdout: sha(Buffer.from('hello ledger\n')), stderr: sha(Buffer.from('warn: careful\n')) });
  assert.deepEqual(textRun.outputBytes, { stdout: 13, stderr: 14 });
  const emptyRun = await runner.run({ command: 'node -e "0"' });
  assert.deepEqual(emptyRun.outputSha256, { stdout: EMPTY, stderr: EMPTY });
  assert.deepEqual(emptyRun.outputBytes, { stdout: 0, stderr: 0 });
  const binaryRun = await runner.run({ command: 'node emit.cjs binary' });
  assert.equal(binaryRun.outputSha256.stdout, sha(binaryBytes), 'the hash is of the bytes, not of the lossy text');
  assert.notEqual(sha(Buffer.from(binaryRun.stdout, 'utf8')), sha(binaryBytes), 'control: the text is not the bytes');
  const bigRun = await runner.run({ command: 'node emit.cjs big', maxOutputBytes: 1000 });
  assert.equal(bigRun.truncated.stdout, true);
  assert.equal(bigRun.outputBytes.stdout, 50000);
  assert.equal(bigRun.outputSha256.stdout, sha(bigBytes), 'over the capture limit the hash is still of all 50,000 bytes');
  const wideRun = await runner.run({ command: 'node emit.cjs wide' });
  assert.equal(wideRun.outputSha256.stdout, sha(Buffer.from(wideText, 'utf8')));
  assert.equal(wideRun.outputBytes.stdout, 4500);
  ok('ShellRunner: stdout and stderr sha256 equal the sha256 of the bytes written: text, empty, binary, 50,000 bytes over a 1,000-byte capture, multibyte');

  const tools = new LocalTools({ workspace, stateDirectory: state, secrets: () => [REGISTERED] });
  {
    const run = await tools.call('run_command', { command: 'node emit.cjs text' });
    assert.equal(run.isError, false);
    assert.equal(run.structuredContent.commandSha256, sha(Buffer.from('node emit.cjs text')));
    assert.equal(run.structuredContent.commandSha256, commandSha256('node emit.cjs text'));
    assert.deepEqual(run.structuredContent.outputSha256, textRun.outputSha256);
    assert.deepEqual(run.structuredContent.outputBytes, { stdout: 13, stderr: 14 });
    assert.deepEqual(run.structuredContent.truncated, { stdout: false, stderr: false });
    const binary = await tools.call('run_command', { command: 'node emit.cjs binary' });
    assert.equal(binary.structuredContent.outputSha256.stdout, sha(binaryBytes));
    const failed = await tools.call('run_command', { command: 'node -e "process.exit(3)"' });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.exitCode, 3);
    assert.deepEqual(failed.structuredContent.outputSha256, { stdout: EMPTY, stderr: EMPTY });

    const started = await tools.call('tasks_run', { command: 'node emit.cjs text' });
    assert.equal(started.structuredContent.commandSha256, sha(Buffer.from('node emit.cjs text')));
    let status;
    for (const until = Date.now() + 30_000; Date.now() < until;) {
      status = await tools.call('tasks_status', { taskId: started.structuredContent.taskId });
      if (status.structuredContent.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.structuredContent.status, 'completed');
    assert.deepEqual(status.structuredContent.outputSha256, textRun.outputSha256);
    assert.deepEqual(status.structuredContent.outputBytes, { stdout: 13, stderr: 14 });
    assert.deepEqual(status.structuredContent.truncated, { stdout: false, stderr: false });

    const tested = await tools.call('test_run', { framework: 'node' }, { taskId: 'ledger-test-run' });
    assert.equal(tested.isError, false, tested.content[0].text);
    assert.equal(tested.structuredContent.commandSha256, sha(Buffer.from('node --test')));
    const results = (await tools.call('test_results', {}, { taskId: 'ledger-test-run' })).structuredContent;
    assert.equal(tested.structuredContent.outputSha256.stdout, sha(Buffer.from(results.stdout, 'utf8')));
    assert.equal(tested.structuredContent.outputBytes.stdout, Buffer.byteLength(results.stdout));
    assert.deepEqual(results.outputSha256, tested.structuredContent.outputSha256, 'test_results keeps the hashes too');

    const built = await tools.call('build_run', { runner: 'npm' });
    assert.equal(built.isError, false, built.content[0].text);
    assert.equal(built.structuredContent.commandSha256, sha(Buffer.from('npm run build')));
    const text = built.content[0].text;
    const stdout = text.slice(text.indexOf('\n') + 1).slice(0, built.structuredContent.outputBytes.stdout);
    assert.ok(stdout.includes('hello ledger'), stdout);
    assert.equal(built.structuredContent.outputSha256.stdout, sha(Buffer.from(stdout, 'utf8')));
    ok('run_command, tasks_run/tasks_status, test_run/test_results and build_run report the command hash and the output hashes with byte counts');
  }

  // ---------------------------------------------------------------- 2. the check receipt
  const RECEIPT_KEYS = ['argsSha256', 'cancelled', 'command', 'commandSha256', 'commandTruncated', 'cwd', 'durationMs', 'exit', 'lingering',
    'shell', 'signal', 'stderr', 'stdout', 'timedOut', 'toolchain', 'treeAfter', 'treeBefore'];
  const STREAM_KEYS = ['bytes', 'preview', 'previewTruncated', 'sha256', 'truncated'];
  {
    const receipt = checkReceipt({ command: 'node emit.cjs text', result: textRun });
    assert.deepEqual(Object.keys(receipt).sort(), RECEIPT_KEYS);
    assert.deepEqual(Object.keys(receipt.stdout).sort(), STREAM_KEYS);
    assert.equal(receipt.command, 'node emit.cjs text');
    assert.equal(receipt.commandSha256, sha(Buffer.from('node emit.cjs text')));
    assert.equal(receipt.argsSha256, sha(Buffer.from(JSON.stringify({ command: 'node emit.cjs text', cwd: '.', shell: textRun.shell }))));
    assert.equal(receipt.argsSha256, argsSha256({ command: 'node emit.cjs text', cwd: '.', shell: textRun.shell }));
    assert.deepEqual([receipt.cwd, receipt.shell, receipt.exit, receipt.signal, receipt.timedOut, receipt.cancelled, receipt.lingering],
      ['.', textRun.shell, 0, null, false, false, false]);
    assert.deepEqual(receipt.stdout, { sha256: sha(Buffer.from('hello ledger\n')), bytes: 13, truncated: false, preview: 'hello ledger\n', previewTruncated: false });
    assert.deepEqual(receipt.stderr, { sha256: sha(Buffer.from('warn: careful\n')), bytes: 14, truncated: false, preview: 'warn: careful\n', previewTruncated: false });
    assert.deepEqual([receipt.toolchain, receipt.treeBefore, receipt.treeAfter], [null, null, null]);
    assert.equal(receipt.durationMs, textRun.durationMs);
    assert.equal(validateRecord('check', receipt), null);

    const empty = checkReceipt({ command: 'node -e "0"', result: emptyRun });
    assert.deepEqual(empty.stdout, { sha256: EMPTY, bytes: 0, truncated: false, preview: '', previewTruncated: false });
    const binary = checkReceipt({ command: 'node emit.cjs binary', result: binaryRun });
    assert.equal(binary.stdout.sha256, sha(binaryBytes));
    assert.ok(binary.stdout.preview.includes(String.fromCodePoint(0xfffd)), 'the preview of bytes that are not UTF-8 is lossy, the hash is not');
    const big = checkReceipt({ command: 'node emit.cjs big', result: bigRun });
    assert.deepEqual([big.stdout.bytes, big.stdout.truncated, big.stdout.sha256], [50000, true, sha(bigBytes)], 'the capture dropped a middle');
    assert.equal(big.stdout.preview, bigRun.stdout, 'a capture of 1,000 bytes fits the preview whole');
    const headRun = await runner.run({ command: 'node emit.cjs big' });
    const head = checkReceipt({ command: 'node emit.cjs big', result: headRun });
    assert.deepEqual([head.stdout.bytes, head.stdout.truncated, head.stdout.previewTruncated, head.stdout.sha256], [50000, false, true, sha(bigBytes)]);
    assert.equal(head.stdout.preview, bigBytes.subarray(0, PREVIEW_BYTES).toString('latin1'), 'the preview is the first 2 KiB of the output');
    const wide = checkReceipt({ command: 'node emit.cjs wide', result: wideRun });
    assert.equal(PREVIEW_BYTES, 2048);
    assert.equal(Buffer.byteLength(wide.stdout.preview), 2046, '682 whole characters of 3 bytes: cut on a character boundary');
    assert.ok(!wide.stdout.preview.includes(String.fromCodePoint(0xfffd)));
    assert.equal(wide.stdout.previewTruncated, true);
    const timedOut = await runner.run({ command: 'node -e "setTimeout(()=>{},30000)"', timeoutMs: 1000 });
    const late = checkReceipt({ command: 'node -e "setTimeout(()=>{},30000)"', result: timedOut });
    assert.equal(late.timedOut, true);
    assert.equal(validateRecord('check', late), null);
    const long = checkReceipt({ command: `echo ${'y'.repeat(6000)}`, result: emptyRun });
    assert.equal(long.commandTruncated, true);
    assert.ok(long.command.length <= 4096);
    assert.equal(long.commandSha256, sha(Buffer.from(`echo ${'y'.repeat(6000)}`)), 'the hash is of the whole command');
    ok('checkReceipt: hashes, byte counts and flags of the run, a preview of at most 2 KiB cut on a character boundary, lossy only for bytes that are not UTF-8, a timeout, a long command');

    const secretCommand = `node emit.cjs secret ${REGISTERED} ${PATTERN_KEY}`;
    const secretRun = await runner.run({ command: secretCommand });
    assert.ok(secretRun.stdout.includes(REGISTERED) && secretRun.stdout.includes('sk-abcdefghijklmnopqrstuvwx'), 'control: the output holds both secrets');
    const masked = checkReceipt({ command: secretCommand, result: secretRun, secrets: [REGISTERED] });
    assert.equal(masked.commandSha256, sha(Buffer.from(secretCommand)), 'the hash is of the exact command');
    assert.equal(masked.stdout.sha256, sha(Buffer.from(secretRun.stdout, 'utf8')));
    const ledger = ProofLedger.forTask(hub, 'task_secret', { secrets: () => [REGISTERED] });
    await ledger.append('check', masked);
    await ledger.append('call', { tool: 'run_command', args: { command: `curl -H "Authorization: Bearer abcdefghijklmnop1234" https://example.com ${REGISTERED}` } });
    const written = await fs.readFile(ledgerPath(hub, 'task_secret'), 'utf8');
    for (const secret of [REGISTERED, PATTERN_KEY, 'sk-abcdefghijklmnopqrstuvwx', 'abcdefghijklmnop1234']) assert.ok(!written.includes(secret), `${secret} reached the ledger`);
    assert.ok(written.includes('[REDACTED]'));
    assert.equal(verifyChain(Buffer.from(written)).ok, true);
    ok('a secret in the command line and in the output, by pattern or registered, never reaches the ledger file; the command hash is of the exact text');

    for (const [label, bad] of [
      ['stdout text', { ...receipt, stdoutText: 'hello ledger\n' }],
      ['output in the stream object', { ...receipt, stdout: { ...receipt.stdout, text: 'hello ledger\n' } }],
      ['a preview over 2 KiB', { ...receipt, stdout: { ...receipt.stdout, preview: 'z'.repeat(PREVIEW_BYTES + 1) } }],
      ['a hash that is not sha256', { ...receipt, stdout: { ...receipt.stdout, sha256: 'xyz' } }],
      ['no command hash', (({ commandSha256: _drop, ...rest }) => rest)(receipt)],
      ['negative bytes', { ...receipt, stderr: { ...receipt.stderr, bytes: -1 } }],
      ['exit as text', { ...receipt, exit: '0' }],
      ['an array', [receipt]],
    ]) assert.notEqual(validateRecord('check', bad), null, label);
    const strict = ProofLedger.forTask(hub, 'task_strict');
    assert.equal(await rejection(strict.append('check', { ...receipt, stdoutText: 'hello ledger\n' })), 'ledger_bad_record');
    await assert.rejects(fs.stat(ledgerPath(hub, 'task_strict')), { code: 'ENOENT' }, 'a refused record writes nothing');
    ok('the ledger refuses a check record that carries anything but hashes, counts, flags and a 2 KiB preview');
  }

  // ---------------------------------------------------------------- 3. the chain
  assert.equal(ledgerPath(hub, 'task_1'), path.join(hub, 'proof', 'task_1.jsonl'));
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'C:x', 'x'.repeat(129), 'nul', 'CON', 'com1', 'a\0b', ' x', null, 7]) {
    assert.throws(() => ledgerPath(hub, bad), { code: 'ledger_bad_task' }, String(bad));
  }
  assert.deepEqual([...RECORD_TYPES], ['task_start', 'tree', 'call', 'check', 'permission', 'outbound', 'uncertain', 'task_end']);
  assert.equal(LEDGER_VERSION, 2);
  assert.equal(GENESIS, '0'.repeat(64));
  ok('ledgerPath: <hubDir>/proof/<taskId>.jsonl, and a task id that could leave the folder or name a device is refused');

  const mainFile = ledgerPath(hub, 'task_main');
  {
    let tick = Date.parse('2026-11-21T10:00:00.000Z');
    const ledger = ProofLedger.forTask(hub, 'task_main', { now: () => new Date((tick += 1000)) });
    const entries = [];
    entries.push(await ledger.append('task_start', { taskId: 'task_main' }));
    entries.push(await ledger.append('check', checkReceipt({ command: 'node emit.cjs text', result: textRun })));
    entries.push(await ledger.append('call', { tool: 'read_file', args: { path: 'emit.cjs' } }));
    entries.push(await ledger.append('permission', { tool: 'run_command', decision: 'allow' }));
    entries.push(await ledger.append('task_end', { status: 'completed' }));
    assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3, 4, 5]);
    assert.equal(entries[0].prev, GENESIS);
    for (let i = 1; i < entries.length; i += 1) assert.equal(entries[i].prev, entries[i - 1].hash);
    const bytes = await fs.readFile(mainFile);
    const lines = linesOf(bytes);
    assert.equal(lines.length, 5);
    assert.ok(bytes.toString('utf8').endsWith('\n'));
    for (const [i, line] of lines.entries()) {
      const entry = JSON.parse(line);
      assert.deepEqual(Object.keys(entry), ['v', 'seq', 'prev', 'ts', 'type', 'record', 'hash']);
      assert.equal(line, lineFor(entry), `line ${i + 1} follows the documented format`);
      assert.equal(entry.hash, entries[i].hash);
      assert.equal(entry.ts, new Date(Date.parse('2026-11-21T10:00:00.000Z') + 1000 * (i + 1)).toISOString());
    }
    const report = verifyChain(bytes);
    assert.deepEqual(report, { ok: true, records: 5, lastSeq: 5, lastHash: entries[4].hash, brokenAt: null, reason: null, detail: null, verifiedBytes: bytes.length, torn: null });
    assert.deepEqual(await ledger.verify(), report);
    assert.deepEqual(verifyChain(Buffer.alloc(0)), { ok: true, records: 0, lastSeq: 0, lastHash: GENESIS, brokenAt: null, reason: null, detail: null, verifiedBytes: 0, torn: null });
    assert.equal(verifyChain(bytes.toString('utf8')).ok, true, 'a string is read as its UTF-8 bytes');
    ok('five records: seq 1..5, prev = the hash of the line before (GENESIS first), each line in the documented format, verifyChain ok');

    const lineAt = [];
    let line = 1;
    for (let i = 0; i < bytes.length; i += 1) { lineAt.push(line); if (bytes[i] === 0x0a) line += 1; }
    for (let i = 0; i < bytes.length; i += 1) {
      const copy = Buffer.from(bytes);
      copy[i] ^= 0x01;
      const flipped = verifyChain(copy);
      assert.equal(flipped.ok, false, `a flip at byte ${i} went unnoticed`);
      assert.equal(flipped.brokenAt, lineAt[i], `a flip at byte ${i} (line ${lineAt[i]}) was reported at ${flipped.brokenAt} (${flipped.reason})`);
      assert.equal(flipped.records, lineAt[i] - 1);
    }
    ok(`a flip of any one of the ${bytes.length} bytes is reported at the seq of its own line`);

    const parsed = lines.map((text) => JSON.parse(text));
    const forged = { ...parsed[1], record: { ...parsed[1].record, exit: 1 } };
    const rewritten = [lines[0], lineFor(forged), ...lines.slice(2)].join('\n') + '\n';
    const afterForge = verifyChain(Buffer.from(rewritten));
    assert.deepEqual([afterForge.ok, afterForge.brokenAt, afterForge.reason, afterForge.records], [false, 3, 'prev_mismatch', 2]);
    const deleted = verifyChain(Buffer.from([lines[0], ...lines.slice(2)].join('\n') + '\n'));
    assert.deepEqual([deleted.brokenAt, deleted.reason], [2, 'seq_mismatch']);
    const swapped = verifyChain(Buffer.from([lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n') + '\n'));
    assert.deepEqual([swapped.brokenAt, swapped.reason], [2, 'seq_mismatch']);
    const crlf = verifyChain(Buffer.from(lines.join('\r\n') + '\r\n'));
    assert.deepEqual([crlf.brokenAt, crlf.reason], [1, 'bad_envelope']);
    const blank = verifyChain(Buffer.from([lines[0], '', ...lines.slice(1)].join('\n') + '\n'));
    assert.deepEqual([blank.brokenAt, blank.reason], [2, 'bad_envelope']);
    const unknown = lineFor({ v: 2, seq: 6, prev: parsed[4].hash, ts: '2026-11-21T10:00:06.000Z', type: 'nonsense', record: {} });
    const withUnknown = verifyChain(Buffer.concat([bytes, Buffer.from(`${unknown}\n`)]));
    assert.deepEqual([withUnknown.ok, withUnknown.brokenAt, withUnknown.reason, withUnknown.records], [false, 6, 'unknown_type', 5]);
    const badVersion = lineFor({ v: 3, seq: 6, prev: parsed[4].hash, ts: '2026-11-21T10:00:06.000Z', type: 'call', record: {} });
    assert.equal(verifyChain(Buffer.concat([bytes, Buffer.from(`${badVersion}\n`)])).reason, 'bad_version');
    const badCheck = lineFor({ v: 2, seq: 6, prev: parsed[4].hash, ts: '2026-11-21T10:00:06.000Z', type: 'check', record: { exit: 0 } });
    assert.equal(verifyChain(Buffer.concat([bytes, Buffer.from(`${badCheck}\n`)])).reason, 'bad_record');
    const badTime = lineFor({ v: 2, seq: 6, prev: parsed[4].hash, ts: 'yesterday', type: 'call', record: {} });
    assert.equal(verifyChain(Buffer.concat([bytes, Buffer.from(`${badTime}\n`)])).reason, 'bad_envelope');
    const notUtf8 = Buffer.concat([bytes, Buffer.from('{"v":2,"seq":6,'), Buffer.from([0xc3, 0x28]), Buffer.from('}\n')]);
    assert.deepEqual([verifyChain(notUtf8).brokenAt, verifyChain(notUtf8).reason], [6, 'not_utf8']);
    const huge = verifyChain(Buffer.concat([bytes, Buffer.from(`${'x'.repeat(70_000)}\n`)]));
    assert.deepEqual([huge.brokenAt, huge.reason], [6, 'line_too_long']);
    ok('a line rewritten with its own hash recomputed shows at the next line; a deleted, swapped, blank, CRLF, unknown-type, other-version, bad-check, bad-time, non-UTF-8 and over-long line at its own seq');
  }

  {
    const torn = ProofLedger.forTask(hub, 'task_torn');
    for (let i = 0; i < 3; i += 1) await torn.append('call', { tool: 'read_file', n: i });
    const file = ledgerPath(hub, 'task_torn');
    const bytes = await fs.readFile(file);
    const lines = linesOf(bytes);
    const third = bytes.length - Buffer.byteLength(lines[2]) - 1;
    const cut = bytes.subarray(0, third + 10);
    const report = verifyChain(cut);
    assert.deepEqual(report, {
      ok: false, records: 2, lastSeq: 2, lastHash: JSON.parse(lines[1]).hash, brokenAt: 3, reason: 'torn_tail',
      detail: 'the last line has no line end: a write that did not finish', verifiedBytes: third, torn: { bytes: 10, sha256: sha(cut.subarray(third)) },
    });
    const whole = verifyChain(bytes.subarray(0, bytes.length - 1));
    assert.deepEqual([whole.reason, whole.brokenAt, whole.records, whole.torn.bytes], ['torn_tail', 3, 2, Buffer.byteLength(lines[2])], 'a line is committed only with its line end');
    await fs.writeFile(file, cut);
    const again = ProofLedger.forTask(hub, 'task_torn');
    const next = await again.append('call', { tool: 'read_file', n: 'after' });
    assert.equal(next.seq, 4);
    const repaired = await fs.readFile(file);
    assert.equal(verifyChain(repaired).ok, true);
    const entries = entriesOf(repaired);
    assert.deepEqual(entries.map((entry) => entry.type), ['call', 'call', 'uncertain', 'call']);
    assert.deepEqual(entries[2].record, { reason: 'torn_tail', bytes: 10, sha256: sha(cut.subarray(third)) });
    assert.equal(repaired.subarray(0, third).equals(bytes.subarray(0, third)), true, 'the committed lines are kept byte for byte');
    ok('a crash that tore the last line: verifyChain reports torn_tail at that seq with the verified prefix; the next append drops only the uncommitted bytes and records them as uncertain');
  }

  {
    const one = ProofLedger.forTask(hub, 'task_conc');
    const two = ProofLedger.forTask(hub, 'task_conc');
    const results = await Promise.all(Array.from({ length: 40 }, (_, n) => (n % 2 ? one : two).append('call', { tool: 'grep', n })));
    assert.deepEqual(results.map((entry) => entry.seq).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1));
    const bytes = await fs.readFile(ledgerPath(hub, 'task_conc'));
    assert.equal(verifyChain(bytes).ok, true);
    assert.deepEqual(entriesOf(bytes).map((entry) => entry.record.n).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
    ok('40 concurrent appends from two ledger objects on one file: one chain, seq 1..40 without a gap or a repeat');
  }

  {
    const ledger = ProofLedger.forTask(hub, 'task_refuse');
    await ledger.append('task_start', { taskId: 'task_refuse' });
    const file = ledgerPath(hub, 'task_refuse');
    const before = await fs.readFile(file);
    assert.equal(await rejection(ledger.append('nonsense', {})), 'ledger_bad_record');
    assert.equal(await rejection(ledger.append('call', 'text')), 'ledger_bad_record');
    assert.equal(await rejection(ledger.append('call', [1, 2])), 'ledger_bad_record');
    assert.equal(await rejection(ledger.append('call', null)), 'ledger_bad_record');
    assert.equal(await rejection(ledger.append('call', { big: 10n })), 'ledger_bad_record');
    assert.equal(await rejection(ledger.append('call', { blob: 'x'.repeat(70_000) })), 'ledger_record_too_large');
    assert.equal((await fs.readFile(file)).equals(before), true, 'refused records write nothing');
    assert.equal((await ledger.append('call', { tool: 'grep' })).seq, 2, 'and the chain goes on after them');

    const broken = Buffer.from(await fs.readFile(file));
    broken[5] ^= 0x01;
    await fs.writeFile(file, broken);
    assert.equal(await rejection(ProofLedger.forTask(hub, 'task_refuse').append('call', { tool: 'grep' })), 'ledger_broken');
    assert.equal((await fs.readFile(file)).equals(broken), true, 'nothing is appended to a broken ledger');
    ok('an unknown type, a record that is not an object or not JSON, a record over 64 KiB are refused and write nothing; a broken ledger refuses every append');
  }

  // ---------------------------------------------------------------- 5. trees and toolchain
  {
    const calls = [];
    const fakeBin = path.join(tmp, 'fake-bin');
    const relBin = path.join(tmp, 'rel');
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.mkdir(relBin, { recursive: true });
    const exe = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['node', 'python', 'dotnet', 'git']) {
      await fs.writeFile(path.join(fakeBin, `${name}${exe}`), '#!/bin/sh\n', { mode: 0o755 });
      await fs.writeFile(path.join(relBin, `${name}${exe}`), '#!/bin/sh\n', { mode: 0o755 });
    }
    const outputs = {
      node: { stdout: 'v24.11.1\n' },
      python: { stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store.\n', code: 9009 },
      dotnet: { stdout: 'Welcome to .NET!\n---------------------\n10.0.100\n' },
      git: { stdout: 'git version 2.55.0.windows.1\n' },
    };
    const exec = async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      const output = outputs[path.basename(file, exe)];
      if (output.code) throw Object.assign(new Error('exit'), { code: output.code, stdout: output.stdout, stderr: output.stderr });
      return { stdout: output.stdout, stderr: '' };
    };
    const previous = process.cwd();
    process.chdir(tmp);
    try {
      const probe = new ToolchainProbe({ env: { PATH: ['rel', '', fakeBin].join(path.delimiter) }, exec });
      const first = await probe.versions(work);
      assert.deepEqual(first, { node: '24.11.1', python: null, dotnet: '10.0.100', git: '2.55.0.windows.1' });
      assert.equal(calls.length, 4);
      for (const call of calls) {
        assert.ok(path.isAbsolute(call.file) && path.dirname(call.file) === fakeBin, `${call.file} must come from an absolute PATH entry`);
        assert.deepEqual(call.args, ['--version']);
        assert.equal(call.cwd, work);
      }
      assert.deepEqual(await probe.versions(work), first);
      assert.equal(calls.length, 4, 'cached per workspace');
      await probe.versions(state);
      assert.equal(calls.length, 8, 'another workspace is probed again');
      const missing = new ToolchainProbe({ env: { PATH: path.join(tmp, 'nothing-here') }, exec });
      assert.deepEqual(await missing.versions(work), { node: null, python: null, dotnet: null, git: null });
      assert.equal(calls.length, 8, 'a program that is not on PATH is not run');
    } finally { process.chdir(previous); }

    const real = await new ToolchainProbe().versions(work);
    const nodeVersion = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^v/, '');
    assert.equal(real.node, nodeVersion);
    const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^git version /, '');
    assert.equal(real.git, gitVersion);
    for (const name of ['python', 'dotnet']) assert.ok(real[name] === null || /^\d+\.\d+/.test(real[name]), `${name}: ${real[name]}`);
    ok(`toolchain versions: parsed from --version, absolute PATH entries only, once per workspace; on this machine node ${real.node}, git ${real.git}, python ${real.python}, dotnet ${real.dotnet}`);
  }

  {
    const repo = path.join(tmp, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'user.name=Ledger', '-c', 'user.email=ledger@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git('init', '-q');
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'one');
    const repoSpace = new StudioWorkspace({ manager: { workspace: repo }, directory: path.join(tmp, 'repo-state') });
    const repoRunner = new ShellRunner({ workspace: repoSpace, stateDirectory: path.join(tmp, 'repo-state') });
    const snapshotter = new TreeSnapshotter({ root: repo, stateDir: path.join(tmp, 'snapshots') });
    const toolchain = { versions: async () => ({ node: '1.2.3', python: null, dotnet: null, git: '2.0.0' }) };
    const ledger = ProofLedger.forTask(hub, 'task_tree');
    const touch = await recordCheck({ ledger, runner: repoRunner, snapshotter, toolchain, command: `node -e "require('fs').writeFileSync('made.txt','x')"` });
    assert.equal(touch.result.exitCode, 0, touch.result.stderr);
    const TREE_KEYS = ['bytes', 'engineReason', 'files', 'full', 'limitations', 'objectFormat', 'rawTree', 'status', 'takenAt', 'tree', 'treeAlgorithm', 'unbounded'];
    assert.deepEqual(Object.keys(touch.receipt.treeBefore).sort(), TREE_KEYS);
    assert.equal(touch.receipt.treeBefore.status, 'ok');
    assert.match(touch.receipt.treeBefore.tree, /^[0-9a-f]{40}$/);
    assert.notEqual(touch.receipt.treeAfter.tree, touch.receipt.treeBefore.tree, 'the command added a file');
    assert.equal(touch.receipt.treeAfter.treeAlgorithm, touch.receipt.treeBefore.treeAlgorithm);
    assert.deepEqual(touch.receipt.toolchain, { node: '1.2.3', python: null, dotnet: null, git: '2.0.0' });
    const quiet = await recordCheck({ ledger, runner: repoRunner, snapshotter, toolchain, command: 'node -e "0"' });
    assert.equal(quiet.receipt.treeBefore.tree, touch.receipt.treeAfter.tree);
    assert.equal(quiet.receipt.treeAfter.tree, quiet.receipt.treeBefore.tree, 'nothing changed');
    assert.equal(quiet.entry.seq, 2);
    const bare = await recordCheck({ ledger, runner: repoRunner, command: 'node -e "0"' });
    assert.deepEqual([bare.receipt.treeBefore, bare.receipt.treeAfter, bare.receipt.toolchain], [null, null, null]);
    const bytes = await fs.readFile(ledgerPath(hub, 'task_tree'));
    assert.equal(verifyChain(bytes).ok, true);
    assert.deepEqual(entriesOf(bytes).map((entry) => entry.record.treeAfter?.tree ?? null), [touch.receipt.treeAfter.tree, quiet.receipt.treeAfter.tree, null]);
    for (const entry of entriesOf(bytes)) assert.match(entry.record.stdout.sha256, HEX64);
    ok('recordCheck: treeBefore/treeAfter from the pod-15 snapshot engine (a new file changes the tree, a quiet command does not), toolchain, one check line each');
  }

  console.log(`verify-proof-ledger: ${passed} checks passed`);
} finally {
  await runner.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
