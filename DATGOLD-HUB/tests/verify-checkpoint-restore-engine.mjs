// The engine under a checkpoint restore (lib/checkpoint-restore.mjs): which entries a request names, what each would do, which are conflicts, and the
// all-or-nothing write. Nothing here knows a Hub; the file system is a temp folder, and a failing file system is a wrapper around the real one.
//
// Every expectation is written out by hand from the fixture below, never derived from the code under test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyRestore, chooseEntries, classify, planOutcome } from '../lib/checkpoint-restore.mjs';

let checks = 0;
const equal = (actual, expected, label) => { assert.deepStrictEqual(actual, expected, label); checks += 1; };
const check = (condition, label) => { assert.ok(condition, label); checks += 1; };
const sha = (data) => createHash('sha256').update(data).digest('hex');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function raises(promise, code, label) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  check(caught !== null, `${label}: it throws`);
  equal(caught?.code, code, `${label}: with the code ${code}`);
  return caught;
}

// ------------------------------------------------------------------ which entries a request names
const held = [
  { kind: 'copy', path: 'a.txt', sha256: sha('a-then'), checkpointId: 'cp1' },
  { kind: 'copy', path: 'dir/b.txt', sha256: sha('b-then'), checkpointId: 'cp1' },
  { kind: 'absent', path: 'made.txt', checkpointId: 'cp1' },
];
const names = (entries) => entries.map((entry) => entry.path);

{
  const all = chooseEntries(held, null);
  equal([names(all.entries), all.unknown], [['a.txt', 'dir/b.txt', 'made.txt'], []], 'no request for a subset: every entry, in the order the checkpoint holds them');
  equal(names(chooseEntries(held, undefined).entries), ['a.txt', 'dir/b.txt', 'made.txt'], 'a request that does not mention a subset is a request for everything');
  const some = chooseEntries(held, ['made.txt', 'a.txt']);
  equal([names(some.entries), some.unknown], [['made.txt', 'a.txt'], []], 'a subset comes back in the order it was asked for');
  const twice = chooseEntries(held, ['a.txt', 'a.txt', 'dir/b.txt', 'a.txt']);
  equal(names(twice.entries), ['a.txt', 'dir/b.txt'], 'a path named twice is one entry');
  const unknown = chooseEntries(held, ['a.txt', 'nope.txt', 'dir', 'also/missing.md']);
  equal([names(unknown.entries), unknown.unknown], [['a.txt'], ['nope.txt', 'dir', 'also/missing.md']], 'a path the checkpoint does not hold is named, never skipped silently (and a folder is not a file of it)');
  const none = chooseEntries(held, []);
  equal([names(none.entries), none.unknown], [[], []], 'an empty subset selects nothing (the caller refuses it)');
  const folded = chooseEntries(held, ['A.TXT', 'DIR/B.TXT'], (value) => value.toLowerCase());
  equal(names(folded.entries), ['a.txt', 'dir/b.txt'], 'with a case-folding comparison (Windows) the entry keeps the spelling the checkpoint has');
  const foldedUnknown = chooseEntries(held, ['A.TXT', 'NOPE.TXT'], (value) => value.toLowerCase());
  equal([names(foldedUnknown.entries), foldedUnknown.unknown], [['a.txt'], ['NOPE.TXT']], 'a path that is not held is named as it was asked for, not as it was compared');
  const mixed = chooseEntries([{ kind: 'copy', path: 'Src/App.JS', sha256: sha('x'), checkpointId: 'cp1' }], ['src/app.js'], (value) => value.toLowerCase());
  equal(names(mixed.entries), ['Src/App.JS'], 'the paths a checkpoint holds are compared folded too, so a path spelled in lower case finds one spelled with capitals');
  const strict = chooseEntries(held, ['A.TXT']);
  equal([names(strict.entries), strict.unknown], [[], ['A.TXT']], 'and without it the case matters');
  const kept = chooseEntries(held, null).entries[0];
  kept.path = 'changed';
  equal(held[0].path, 'a.txt', 'the entries handed out are copies: changing one does not change what the checkpoint holds');
}

// ------------------------------------------------------------------ what each entry would do
const S = { aThen: sha('a-then'), aNow: sha('a-now'), aLater: sha('a-later'), bThen: sha('b-then'), madeNow: sha('made-now'), other: sha('other') };
const entries = [
  { kind: 'copy', path: 'a.txt', sha256: S.aThen, checkpointId: 'cp1' },
  { kind: 'copy', path: 'b.txt', sha256: S.bThen, checkpointId: 'cp1' },
  { kind: 'absent', path: 'made.txt', checkpointId: 'cp2' },
  { kind: 'absent', path: 'never.txt', checkpointId: 'cp2' },
];
const row = (rows, file) => rows.find((entry) => entry.path === file);

{
  const observed = new Map([['a.txt', S.aNow], ['b.txt', null], ['made.txt', S.madeNow], ['never.txt', null]]);
  const rows = classify(entries, observed, { 'a.txt': S.aNow, 'b.txt': null, 'made.txt': S.madeNow, 'never.txt': null });
  equal(rows.map((entry) => [entry.path, entry.action, entry.conflict]), [['a.txt', 'overwrite', false], ['b.txt', 'recreate', false], ['made.txt', 'remove', false], ['never.txt', 'unchanged', false]], 'a changed file is overwritten, a deleted one comes back, a created one goes, one that is not there stays away');
  equal([row(rows, 'a.txt').targetSha, row(rows, 'a.txt').currentSha, row(rows, 'a.txt').expectedSha], [S.aThen, S.aNow, S.aNow], 'each row says the sha it would leave, the sha now and the sha that was expected');
  equal([row(rows, 'made.txt').targetSha, row(rows, 'made.txt').kind, row(rows, 'made.txt').checkpointId], [null, 'absent', 'cp2'], 'a file that must be absent has no target sha, and keeps the checkpoint it came from');
  check(rows.every((entry) => entry.missingExpected === false), 'every expectation was given');

  const stale = classify(entries, observed, { 'a.txt': S.aLater, 'b.txt': S.bThen, 'made.txt': null, 'never.txt': null });
  equal(stale.map((entry) => [entry.path, entry.conflict]), [['a.txt', true], ['b.txt', true], ['made.txt', true], ['never.txt', false]], 'a file whose sha is not the expected one is a conflict, also when it was expected to be missing and is not, or expected to be there and is not');

  const already = classify([entries[0]], new Map([['a.txt', S.aThen]]), { 'a.txt': S.other });
  equal([already[0].action, already[0].conflict], ['unchanged', false], 'a file that is already what the checkpoint holds is not a conflict, whatever was expected of it');
  const gone = classify([entries[2]], new Map([['made.txt', null]]), { 'made.txt': S.madeNow });
  equal([gone[0].action, gone[0].conflict], ['unchanged', false], 'nor is a created file that is already gone');

  const upper = classify([entries[0]], new Map([['a.txt', S.aNow]]), { 'a.txt': S.aNow.toUpperCase() });
  equal(upper[0].conflict, false, 'a sha written in capitals is the same sha');

  const unseen = classify([entries[0], entries[2]], new Map(), null);
  equal(unseen.map((entry) => [entry.currentSha, entry.action]), [[null, 'recreate'], [null, 'unchanged']], 'a file that nobody looked at is a file that is not there');

  equal(classify(entries, observed, undefined).map((entry) => [entry.conflict, entry.missingExpected]), [[false, false], [false, false], [false, false], [false, false]], 'a request without any expectation is a preview too');

  const preview = classify(entries, observed, null);
  check(preview.every((entry) => entry.conflict === false && entry.missingExpected === false && entry.expectedSha === undefined), 'a preview expects nothing, so nothing conflicts and nothing is missing');
  equal(preview.map((entry) => entry.action), ['overwrite', 'recreate', 'remove', 'unchanged'], 'and it classifies the same');

  const partial = classify(entries, observed, { 'a.txt': S.aNow, 'made.txt': S.madeNow });
  equal(partial.map((entry) => [entry.path, entry.missingExpected]), [['a.txt', false], ['b.txt', true], ['made.txt', false], ['never.txt', true]], 'an entry without an expectation is marked, so that the caller can refuse the whole request');
  equal(partial.map((entry) => entry.conflict), [false, false, false, false], 'and a missing expectation is not by itself a conflict');
  const inherited = classify([entries[0]], new Map([['a.txt', S.aNow]]), Object.create({ 'a.txt': S.aNow }));
  equal(inherited[0].missingExpected, true, 'an expectation must be the request\'s own, not one that the object inherits');
}

// ------------------------------------------------------------------ what happens to the conflicts
{
  const observed = new Map([['a.txt', S.aNow], ['b.txt', null], ['made.txt', S.madeNow], ['never.txt', null]]);
  const rows = classify(entries, observed, { 'a.txt': S.aLater, 'b.txt': null, 'made.txt': S.madeNow, 'never.txt': null });
  const skipped = planOutcome(rows, 'skip');
  equal([names(skipped.apply), names(skipped.unchanged), names(skipped.conflicts), skipped.abort], [['b.txt', 'made.txt'], ['never.txt'], ['a.txt'], false], 'skip: the conflict is left alone and listed, the rest goes on');
  const aborted = planOutcome(rows, 'abort');
  equal([names(aborted.conflicts), aborted.abort], [['a.txt'], true], 'abort: one conflict stops the whole request');
  const byDefault = planOutcome(rows);
  equal(byDefault.abort, true, 'abort is the default');
  const nonsense = planOutcome(rows, 'overwrite');
  equal(nonsense.abort, true, 'and a mode nobody defined is not a way to overwrite');
  const clean = planOutcome(classify(entries, observed, { 'a.txt': S.aNow, 'b.txt': null, 'made.txt': S.madeNow, 'never.txt': null }), 'abort');
  equal([names(clean.apply), names(clean.conflicts), clean.abort], [['a.txt', 'b.txt', 'made.txt'], [], false], 'without conflicts every file that has something to do is done, in order');
  const everything = planOutcome(classify(entries, observed, { 'a.txt': S.other, 'b.txt': S.other, 'made.txt': S.other, 'never.txt': null }), 'skip');
  equal([names(everything.apply), names(everything.conflicts)], [[], ['a.txt', 'b.txt', 'made.txt']], 'when every file conflicts there is nothing to do');
}

// ------------------------------------------------------------------ the write: all or nothing, and checked afterwards
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-restore-engine-')));
let counter = 0;
const A_OLD = Buffer.from('old line\r\nsecond\r\n');
const A_NEW = Buffer.from('new line\nsecond\n');
const B_NEW = Buffer.concat([BOM, Buffer.from('bom file\n')]);
const N_OLD = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x10]);

async function world() {
  const dir = path.join(root, `w${counter += 1}`);
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a.txt'), A_OLD);
  await fs.writeFile(path.join(dir, 'n.bin'), N_OLD);
  const at = (relative) => path.join(dir, relative);
  const ops = [
    { path: 'a.txt', absolute: at('a.txt'), action: 'overwrite', previous: A_OLD, next: A_NEW },
    { path: 'sub/b.txt', absolute: at('sub/b.txt'), action: 'recreate', previous: null, next: B_NEW },
    { path: 'n.bin', absolute: at('n.bin'), action: 'remove', previous: N_OLD, next: null },
  ];
  const read = (relative) => fs.readFile(at(relative)).catch(() => null);
  return { dir, at, ops, read };
}

/** The real file system, except that the first call of `name` whose arguments `match` does something else (it is given the real function and the arguments). */
function faulty(name, match, replacement) {
  let hit = false;
  const io = { readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename, unlink: fs.unlink, mkdir: fs.mkdir };
  const real = io[name];
  io[name] = async (...args) => {
    if (!hit && match(args)) { hit = true; return replacement(real, ...args); }
    return real(...args);
  };
  return io;
}
const touching = (file) => (args) => args.some((argument) => String(argument).replaceAll('\\', '/').endsWith(`/${file}`));
const refuse = (message) => async () => { throw Object.assign(new Error(message), { code: 'EPERM' }); };
const isTemp = (relative) => /\.tmp$|\.rollback$/.test(relative);
const leftovers = async (dir) => (await fs.readdir(dir, { recursive: true })).filter(isTemp);

{
  const w = await world();
  const done = await applyRestore(w.ops);
  equal([await w.read('a.txt'), await w.read('sub/b.txt'), await w.read('n.bin')], [A_NEW, B_NEW, null], 'every file is what the operations say, byte for byte (line endings, a BOM, a missing file)');
  equal(done, [
    { path: 'a.txt', action: 'overwrite', sha256: sha(A_NEW) },
    { path: 'sub/b.txt', action: 'recreate', sha256: sha(B_NEW) },
    { path: 'n.bin', action: 'remove', sha256: null },
  ], 'the answer says, in order, what was done and the sha each file has now (none for a removed one)');
  equal(await leftovers(w.dir), [], 'no temporary file is left behind');
}

{
  const w = await world();
  const error = await raises(applyRestore(w.ops, faulty('rename', touching('b.txt'), refuse('disk said no'))), 'restore_failed_rolled_back', 'the second write fails');
  equal([await w.read('a.txt'), await w.read('sub/b.txt'), await w.read('n.bin')], [A_OLD, null, N_OLD], 'the first file is back as it was, the second was never made, the third was never touched');
  equal(error.rolledBack, ['a.txt'], 'the error says which file it put back');
  check(error.message.includes('disk said no'), 'and why it stopped');
  equal(error.statusCode, 500, 'it is a server error');
  equal(await leftovers(w.dir), [], 'no temporary file is left behind');
}

{
  const w = await world();
  const error = await raises(applyRestore(w.ops, faulty('unlink', touching('n.bin'), refuse('cannot remove'))), 'restore_failed_rolled_back', 'the removal fails');
  equal([await w.read('a.txt'), await w.read('sub/b.txt'), await w.read('n.bin')], [A_OLD, null, N_OLD], 'the files written before it are put back, and the file that could not be removed is as it was');
  equal(error.rolledBack, ['sub/b.txt', 'a.txt'], 'they are put back in the opposite order');
}

{
  const w = await world();
  await fs.writeFile(w.at('a.txt'), 'someone else was here\n');
  const error = await raises(applyRestore(w.ops), 'stale_state', 'the first file changed after it was read');
  equal([await w.read('a.txt'), await w.read('sub/b.txt'), await w.read('n.bin')], [Buffer.from('someone else was here\n'), null, N_OLD], 'nothing is written over it, and nothing else is done');
  check(error.message.includes('a.txt'), 'the message names the file');
  equal(error.statusCode, 409, 'it is a conflict');
}

{
  const w = await world();
  const sameLength = Buffer.from('OLD LINE\r\nSECOND\r\n');
  check(sameLength.length === A_OLD.length, 'the fixture: a text as long as the one that was read');
  await fs.writeFile(w.at('a.txt'), sameLength);
  await raises(applyRestore(w.ops), 'stale_state', 'a file changed to something as long as it was');
  equal([await w.read('a.txt'), await w.read('sub/b.txt')], [sameLength, null], 'it is not written over');
}

{
  const w = await world();
  await fs.writeFile(w.at('sub/b.txt'), 'somebody made this file meanwhile\n');
  const error = await raises(applyRestore(w.ops), 'stale_state', 'a file that should be missing is there');
  equal([await w.read('a.txt'), await w.read('sub/b.txt')], [A_OLD, Buffer.from('somebody made this file meanwhile\n')], 'the first file is put back, and the one that appeared is left alone');
  equal(error.rolledBack, ['a.txt'], 'and the error says so');
}

{
  const w = await world();
  await fs.rm(w.at('n.bin'));
  const error = await raises(applyRestore(w.ops), 'stale_state', 'a file that should be there is missing');
  equal([await w.read('a.txt'), await w.read('sub/b.txt'), await w.read('n.bin')], [A_OLD, null, null], 'the files done before it are put back');
  equal(error.rolledBack, ['sub/b.txt', 'a.txt'], 'and the error says which');
}

{
  const w = await world();
  const stalled = faulty('readFile', touching('n.bin'), async (real, ...args) => { await fs.writeFile(w.at('n.bin'), 'changed meanwhile'); return real(...args); });
  const error = await raises(applyRestore(w.ops, stalled), 'stale_state', 'the third file changes while the second is written');
  equal([await w.read('a.txt'), await w.read('sub/b.txt'), await w.read('n.bin')], [A_OLD, null, Buffer.from('changed meanwhile')], 'the first two are put back, and the one that changed is left as it changed');
  equal(error.rolledBack, ['sub/b.txt', 'a.txt'], 'and the error says what it put back');
}

{
  const w = await world();
  const spoiled = faulty('rename', touching('a.txt'), async (real, from, to) => { await real(from, to); await fs.writeFile(to, 'not what was written'); });
  const error = await raises(applyRestore(w.ops, spoiled), 'restore_verify_failed', 'a file is not what was written when it is read back');
  equal([await w.read('a.txt'), await w.read('sub/b.txt'), await w.read('n.bin')], [Buffer.from('not what was written'), null, N_OLD], 'the files that are what was written are put back; the one that is neither what was written nor what it was is not touched');
  equal(error.rolledBack, ['n.bin', 'sub/b.txt'], 'the error names what it put back, last first');
  equal(error.failedRollback.map((entry) => entry.path), ['a.txt'], 'and the file it left alone');
}

{
  const w = await world();
  // The second write fails, and meanwhile somebody changes the first file: it must not be overwritten by the rollback.
  const meddling = faulty('rename', touching('b.txt'), async () => { await fs.writeFile(w.at('a.txt'), 'edited while we were busy\n'); throw Object.assign(new Error('disk said no'), { code: 'EPERM' }); });
  const error = await raises(applyRestore(w.ops, meddling), 'restore_partial_failure', 'the rollback finds a file that changed');
  equal(await w.read('a.txt'), Buffer.from('edited while we were busy\n'), 'that file is left exactly as it now is');
  equal(error.failedRollback.map((entry) => entry.path), ['a.txt'], 'and is named as one that could not be put back');
  equal(error.rolledBack, [], 'nothing else had to be put back');
}

{
  const w = await world();
  const error = await raises(applyRestore(w.ops, faulty('readFile', touching('a.txt'), refuse('locked by another program'))), 'restore_failed_rolled_back', 'a file cannot be read for a reason other than being missing');
  check(error.message.includes('locked by another program'), 'the reason is in the message');
  equal([await w.read('a.txt'), await w.read('sub/b.txt'), await w.read('n.bin')], [A_OLD, null, N_OLD], 'nothing was changed: an unreadable file is not a missing file');
}

{
  const w = await world();
  const deep = [{ path: 'x/y/z.txt', absolute: w.at('x/y/z.txt'), action: 'recreate', previous: null, next: Buffer.from('deep\n') }];
  await applyRestore(deep);
  equal(await w.read('x/y/z.txt'), Buffer.from('deep\n'), 'a file comes back in folders that are gone too');
}

{
  const w = await world();
  const done = await applyRestore([], undefined);
  equal(done, [], 'no operations is not an error');
  equal(await w.read('a.txt'), A_OLD, 'and changes nothing');
}

await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
console.log(`PASS: ${checks} restore engine checks`);
