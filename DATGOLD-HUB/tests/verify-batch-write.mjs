// files_write_batch on the REAL StudioWorkspace + LocalTools + file system.
//
// v3.9.0 let files_write_batch replace any existing file without expected_sha256 (write_file refuses that), re-encoded every file as
// plain UTF-8 (a UTF-8 BOM file lost its BOM, a UTF-16LE file became UTF-8, CRLF became LF), never re-checked a file between the
// preflight and the write, and returned no per-file previous hash, so the host could not mint edit receipts.
//
//  1. an existing file without expected_sha256 / overwrite:true is refused, and NOTHING of the batch is written
//  2. expected_sha256 and per-item overwrite work; a wrong sha refuses the whole batch
//  3. CRLF + UTF-8 BOM, UTF-16LE (+CRLF), plain CRLF and LF files keep their encoding, byte for byte identical to write_file
//  4. a file edited (or created) between the preflight and the write is detected, the batch is rolled back and the newer edit survives
//  5. per-file path / sha256 / previousSha, and the host mints an edit receipt for each file; the progress tracker treats a batch as a mutation
//  6. the model-facing schema and system prompt describe the rules
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { verifyHostEvidence } from '../lib/agent-autonomy.mjs';
import { createTaskProgress, observeTaskTool } from '../lib/agent-progress.mjs';
import { createLocalAgentInstructions } from '../lib/agent.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-batch-'));
const work = path.join(root, 'work');
const state = path.join(root, 'state');
await fs.mkdir(work, { recursive: true });
const manager = { workspace: work, secrets: [] };
const studio = new StudioWorkspace({ manager, directory: path.join(state, 'studio') });
const local = new LocalTools({ workspace: studio, stateDirectory: state });
const batch = (files) => local.call('files_write_batch', { files });
const put = async (name, data) => { await fs.mkdir(path.dirname(path.join(work, name)), { recursive: true }); await fs.writeFile(path.join(work, name), data); return Buffer.isBuffer(data) ? data : Buffer.from(data); };
const bytes = (name) => fs.readFile(path.join(work, name));
const missing = (name) => fs.access(path.join(work, name)).then(() => false, () => true);
const errorCode = (result) => result.structuredContent?.error?.code;

try {
  // ---------------------------------------------------------------- 1. refusal, nothing written
  {
    const original = await put('exists.txt', 'original\n');
    const result = await batch([{ path: 'brand-new.txt', content: 'new\n' }, { path: 'exists.txt', content: 'clobber\n' }]);
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), 'file_exists', JSON.stringify(result).slice(0, 300));
    assert.match(result.content[0].text, /exists\.txt/);
    assert.equal(await missing('brand-new.txt'), true, 'a refused batch must not write the other items');
    assert.deepEqual(await bytes('exists.txt'), original);
    // write_file refuses the same way: the two tools now share one rule
    const single = await local.call('write_file', { path: 'exists.txt', content: 'clobber\n' });
    assert.equal(errorCode(single), 'file_exists');
    ok('an existing file without expected_sha256 / overwrite is refused, and no other item of the batch is written');
  }

  // ---------------------------------------------------------------- 2. sha / overwrite
  {
    const a = await put('a.txt', 'a-old\n');
    const b = await put('b.txt', 'b-old\n');
    const wrong = await batch([{ path: 'a.txt', content: 'a-new\n', expected_sha256: sha(a) }, { path: 'b.txt', content: 'b-new\n', expected_sha256: 'f'.repeat(64) }]);
    assert.equal(errorCode(wrong), 'stale_revision');
    assert.deepEqual(await bytes('a.txt'), a, 'a wrong sha on one item writes nothing');
    assert.deepEqual(await bytes('b.txt'), b);

    const half = await batch([{ path: 'a.txt', content: 'a-new\n', expected_sha256: sha(a) }, { path: 'b.txt', content: 'b-new\n' }]);
    assert.equal(errorCode(half), 'file_exists', 'overwrite is per item: the second item still needs a sha');
    assert.deepEqual(await bytes('a.txt'), a);

    const good = await batch([{ path: 'a.txt', content: 'a-new\n', expected_sha256: sha(a) }, { path: 'b.txt', content: 'b-new\n', overwrite: true }, { path: 'deep/er/c.txt', content: 'c\n' }]);
    assert.equal(good.isError, false, JSON.stringify(good).slice(0, 400));
    assert.equal((await bytes('a.txt')).toString(), 'a-new\n');
    assert.equal((await bytes('b.txt')).toString(), 'b-new\n');
    assert.equal((await bytes('deep/er/c.txt')).toString(), 'c\n');
    const unchanged = await batch([{ path: 'a.txt', content: 'a-new\n', overwrite: true }]);
    assert.equal(unchanged.structuredContent.files[0].unchanged, true, 'identical content is reported, not rewritten');
    for (const name of ['../escape.txt', '.env', '.git/config']) {
      const refused = await batch([{ path: 'fine.txt', content: 'x' }, { path: name, content: 'x' }]);
      assert.equal(refused.isError, true, `${name} must be refused`);
      assert.equal(await missing('fine.txt'), true, 'and nothing else is written');
    }
    ok('expected_sha256 and per-item overwrite work; a stale or missing sha refuses the whole batch; protected paths and escapes are refused');
  }

  // ---------------------------------------------------------------- 3. encodings survive, identical to write_file
  {
    const fixtures = {
      'bom-crlf.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line one\r\nline two\r\n', 'utf8')]),
      'utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('xin chào\r\nthế giới\r\n', 'utf16le')]),
      'crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8'),
      'lf.txt': Buffer.from('one\ntwo\n', 'utf8'),
    };
    const replacement = 'alpha\nbeta — tiếng Việt\ngamma\n';
    for (const [name, content] of Object.entries(fixtures)) {
      await put(name, content);
      await put(`twin-${name}`, content);
    }
    const result = await batch(Object.entries(fixtures).map(([name, content]) => ({ path: name, content: replacement, expected_sha256: sha(content) })));
    assert.equal(result.isError, false, JSON.stringify(result).slice(0, 400));
    for (const [name, content] of Object.entries(fixtures)) {
      const twin = await local.call('write_file', { path: `twin-${name}`, content: replacement, expected_sha256: sha(content) });
      assert.equal(twin.isError, false);
      assert.deepEqual(await bytes(name), await bytes(`twin-${name}`), `${name}: batch and write_file must produce identical bytes`);
    }
    const bom = await bytes('bom-crlf.txt');
    assert.deepEqual([...bom.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM kept');
    assert.equal(bom.subarray(3).toString('utf8'), 'alpha\r\nbeta — tiếng Việt\r\ngamma\r\n', 'CRLF kept');
    const utf16 = await bytes('utf16.txt');
    assert.deepEqual([...utf16.subarray(0, 2)], [0xff, 0xfe], 'UTF-16LE BOM kept');
    assert.equal(utf16.subarray(2).toString('utf16le'), 'alpha\r\nbeta — tiếng Việt\r\ngamma\r\n', 'UTF-16LE text with CRLF kept');
    assert.equal((await bytes('crlf.txt')).toString(), 'alpha\r\nbeta — tiếng Việt\r\ngamma\r\n');
    assert.equal((await bytes('lf.txt')).toString(), replacement, 'an LF file stays LF');
    ok('CRLF + UTF-8 BOM, UTF-16LE + CRLF, CRLF and LF files keep their encoding and are byte-identical to what write_file writes');
  }

  // ---------------------------------------------------------------- 4. a race between preflight and write
  {
    const first = await put('race-a.txt', 'a-before\n');
    const second = await put('race-b.txt', 'b-before\n');
    const realMkdir = fs.mkdir;
    let fired = false;
    // The batch calls mkdir at the start of its write loop, after the preflight: edit the second file at exactly that moment.
    fs.mkdir = async (...args) => {
      if (!fired) { fired = true; await fs.writeFile(path.join(work, 'race-b.txt'), 'b-edited-by-someone-else\n'); }
      return realMkdir(...args);
    };
    let result;
    try {
      result = await batch([{ path: 'race-a.txt', content: 'a-after\n', expected_sha256: sha(first) }, { path: 'race-b.txt', content: 'b-after\n', expected_sha256: sha(second) }]);
    } finally { fs.mkdir = realMkdir; }
    assert.equal(fired, true);
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), 'stale_revision', JSON.stringify(result).slice(0, 400));
    assert.equal((await bytes('race-b.txt')).toString(), 'b-edited-by-someone-else\n', 'the newer edit is never overwritten');
    assert.deepEqual(await bytes('race-a.txt'), first, 'the earlier item is rolled back');
    assert.match(result.content[0].text, /race-a\.txt/);

    // the same for a file that did not exist at preflight and was created meanwhile
    let created = false;
    fs.mkdir = async (...args) => {
      if (!created) { created = true; await fs.writeFile(path.join(work, 'race-new.txt'), 'created-by-someone-else\n'); }
      return realMkdir(...args);
    };
    try {
      result = await batch([{ path: 'race-new.txt', content: 'mine\n' }]);
    } finally { fs.mkdir = realMkdir; }
    assert.equal(errorCode(result), 'stale_revision', JSON.stringify(result).slice(0, 400));
    assert.equal((await bytes('race-new.txt')).toString(), 'created-by-someone-else\n');
    const leftovers = (await fs.readdir(work)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'no temporary files are left behind');
    ok('a file edited or created between preflight and write is detected: batch refused, earlier items rolled back, the newer edit survives');
  }

  // ---------------------------------------------------------------- 5. per-file results and host receipts
  {
    const one = await put('r1.txt', 'r1-old\n');
    const two = await put('r2.txt', 'r2-old\n');
    const result = await batch([{ path: 'r1.txt', content: 'r1-new\n', expected_sha256: sha(one) }, { path: 'r2.txt', content: 'r2-new\n', expected_sha256: sha(two) }, { path: 'r3.txt', content: 'r3-new\n' }]);
    assert.equal(result.isError, false);
    const files = result.structuredContent.files;
    assert.deepEqual(files.map((f) => f.path), ['r1.txt', 'r2.txt', 'r3.txt']);
    assert.deepEqual(files.map((f) => f.previousSha), [sha(one), sha(two), null]);
    assert.deepEqual(files.map((f) => f.created), [false, false, true]);
    for (const file of files) assert.equal(file.sha256, sha(await bytes(file.path)), `${file.path}: sha256 is the hash of what is on disk`);

    const evidence = await verifyHostEvidence({ manager: { backend: 'local', studio }, name: 'local.files_write_batch', result, step: 3 });
    assert.equal(evidence.kind, 'edit');
    assert.equal(evidence.more.length, 2);
    let progress = createTaskProgress();
    progress = observeTaskTool(progress, { call: { name: 'mcp_call', arguments: JSON.stringify({ name: 'local.run_command', arguments_json: '{}' }) }, result: { isError: false }, step: 2, verified: { kind: 'verify', id: 'check-1', step: 2 } }).progress;
    assert.equal(progress.verifiedChecks.length, 1);
    const observed = observeTaskTool(progress, { call: { name: 'mcp_call', arguments: JSON.stringify({ name: 'local.files_write_batch', arguments_json: '{}' }) }, result, step: 3, verified: evidence });
    assert.equal(observed.progress.verifiedFiles.length, 3, 'one edit receipt per written file');
    assert.deepEqual(observed.progress.verifiedFiles.map((r) => r.path), ['r1.txt', 'r2.txt', 'r3.txt']);
    assert.equal(observed.progress.verifiedChecks.length, 0, 'a batch write invalidates an earlier passing check, like any other file mutation');
    assert.equal(await verifyHostEvidence({ manager: { backend: 'local', studio }, name: 'local.files_write_batch', result: { isError: false, structuredContent: { files: [{ path: 'r1.txt', sha256: 'a'.repeat(64), previousSha: null }] } } }), null, 'a hash that does not match the disk is no evidence');
    ok('per-file path/sha256/previousSha are returned; the host mints one verified edit receipt per file and a batch invalidates stale checks');
  }

  // ---------------------------------------------------------------- 6. what the model is told
  {
    const tool = local.tools.get('files_write_batch');
    const item = tool.schema.properties.files.items;
    assert.ok(item.properties.overwrite && item.properties.expected_sha256, 'schema offers expected_sha256 and overwrite per item');
    assert.match(tool.description, /expected_sha256/);
    assert.match(tool.description, /none is written|nothing is written/);
    const prompt = createLocalAgentInstructions({ tools: [] }, 'F:\\project');
    assert.match(prompt, /files_write_batch[^.]*same rules/);
    assert.match(prompt, /expected_sha256/);
    const invalid = await local.call('files_write_batch', { files: [{ path: 'x.txt', content: 'x', overwrite: 'yes' }] });
    assert.equal(errorCode(invalid), 'invalid_arguments');
    ok('tool schema and the agent system prompt describe expected_sha256 / overwrite / all-or-nothing');
  }
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

console.log(`PASS: ${checks} batch write checks`);
