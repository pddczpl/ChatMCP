import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPTED_STORAGE_KEY, MAX_ENTRIES, carryMarks, readMarks, writeMarks } from '../src/lib/review-accepted.ts';

// The marks a person makes with "accept" on the hunks of a file are local review state: kept in the browser (localStorage), keyed by the conversation, the file and the sha of the
// file as it was reviewed, so that a reload keeps them and any other change of the file starts again. Storage may be missing, full or broken (a private window): nothing here throws.

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const fp = (n) => n.toString(16).padStart(16, '0');
const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); } };
};
const stored = (store) => JSON.parse(store.data.get(ACCEPTED_STORAGE_KEY));

test('a store that has nothing, that is missing, or that breaks gives no marks and does not throw', () => {
  assert.deepEqual([...readMarks(memory(), 't1', 'a.js', SHA_A)], []);
  assert.deepEqual([...readMarks(null, 't1', 'a.js', SHA_A)], []);
  assert.deepEqual([...readMarks(undefined, 't1', 'a.js', SHA_A)], []);
  const broken = { getItem() { throw new Error('storage is blocked'); }, setItem() { throw new Error('storage is blocked'); } };
  assert.deepEqual([...readMarks(broken, 't1', 'a.js', SHA_A)], []);
  assert.equal(writeMarks(broken, 't1', 'a.js', SHA_A, new Set([fp(1)])), false);
  assert.equal(writeMarks(null, 't1', 'a.js', SHA_A, new Set([fp(1)])), false);
});

test('what is stored but is not in the shape that was written is read as nothing', () => {
  const key = ACCEPTED_STORAGE_KEY;
  for (const text of ['', 'not json', '[]', 'null', '{}', '{"v":2,"entries":[]}', '{"v":1}', '{"v":1,"entries":"x"}', '{"v":1,"entries":[null,1,"x",{}]}']) {
    assert.deepEqual([...readMarks(memory({ [key]: text }), 't1', 'a.js', SHA_A)], [], text);
  }
  const entry = { task: 't1', path: 'a.js', sha: SHA_A, at: 1, marks: [fp(1)] };
  for (const bad of [{ task: 1 }, { path: null }, { sha: 5 }, { marks: 'x' }, { marks: null }]) {
    const store = memory({ [key]: JSON.stringify({ v: 1, entries: [{ ...entry, ...bad }] }) });
    assert.deepEqual([...readMarks(store, 't1', 'a.js', SHA_A)], [], JSON.stringify(bad));
  }
});

test('marks are read back for the same conversation, file and sha, and for no other', () => {
  const store = memory();
  assert.equal(writeMarks(store, 't1', 'src/a.js', SHA_A, new Set([fp(1), fp(2)])), true);
  assert.deepEqual([...readMarks(store, 't1', 'src/a.js', SHA_A)].sort(), [fp(1), fp(2)]);
  assert.deepEqual([...readMarks(store, 't2', 'src/a.js', SHA_A)], [], 'another conversation');
  assert.deepEqual([...readMarks(store, 't1', 'src/b.js', SHA_A)], [], 'another file');
  assert.deepEqual([...readMarks(store, 't1', 'src/a.js', SHA_B)], [], 'the file has changed since: the marks start again');
  assert.deepEqual([...readMarks(store, 't1', 'src/A.js', SHA_A)], [], 'a path is compared as it is written');
});

test('the marks sit under one key, as a versioned list', () => {
  const store = memory();
  writeMarks(store, 't1', 'a.js', SHA_A, new Set([fp(3)]), 1234);
  assert.deepEqual([...store.data.keys()], [ACCEPTED_STORAGE_KEY]);
  assert.deepEqual(stored(store), { v: 1, entries: [{ task: 't1', path: 'a.js', sha: SHA_A, at: 1234, marks: [fp(3)] }] });
});

test('a file that changed has its old marks dropped when new ones are written, and the other files keep theirs', () => {
  const store = memory();
  writeMarks(store, 't1', 'a.js', SHA_A, new Set([fp(1)]), 1);
  writeMarks(store, 't1', 'b.js', SHA_A, new Set([fp(2)]), 2);
  writeMarks(store, 't2', 'a.js', SHA_A, new Set([fp(3)]), 3);
  writeMarks(store, 't1', 'a.js', SHA_B, new Set([fp(4)]), 4);
  assert.deepEqual([...readMarks(store, 't1', 'a.js', SHA_A)], [], 'the old sha of that file is gone');
  assert.deepEqual([...readMarks(store, 't1', 'a.js', SHA_B)], [fp(4)]);
  assert.deepEqual([...readMarks(store, 't1', 'b.js', SHA_A)], [fp(2)], 'another file is untouched');
  assert.deepEqual([...readMarks(store, 't2', 'a.js', SHA_A)], [fp(3)], 'the same path in another conversation is untouched');
  assert.equal(stored(store).entries.length, 3);
});

test('writing no marks takes the entry away, and a file without a sha (deleted) has nothing to remember', () => {
  const store = memory();
  writeMarks(store, 't1', 'a.js', SHA_A, new Set([fp(1)]), 1);
  writeMarks(store, 't1', 'b.js', SHA_A, new Set([fp(2)]), 2);
  assert.equal(writeMarks(store, 't1', 'a.js', SHA_A, new Set(), 3), true);
  assert.deepEqual([...readMarks(store, 't1', 'a.js', SHA_A)], []);
  assert.deepEqual([...readMarks(store, 't1', 'b.js', SHA_A)], [fp(2)]);
  assert.equal(stored(store).entries.length, 1);
  assert.equal(writeMarks(store, 't1', 'c.js', null, new Set([fp(5)]), 4), false);
  assert.deepEqual([...readMarks(store, 't1', 'c.js', null)], []);
  assert.equal(stored(store).entries.length, 1);
});

test('only things that look like a fingerprint are kept, on the way in and on the way out', () => {
  const store = memory();
  writeMarks(store, 't1', 'a.js', SHA_A, new Set([fp(1), 'not a fingerprint', 'ABCDEF0123456789', '0123456789abcde', '0123456789abcdef0']), 1);
  assert.deepEqual(stored(store).entries[0].marks, [fp(1)]);
  const hand = memory({ [ACCEPTED_STORAGE_KEY]: JSON.stringify({ v: 1, entries: [{ task: 't1', path: 'a.js', sha: SHA_A, at: 1, marks: [fp(1), 7, 'zz', fp(2)] }] }) });
  assert.deepEqual([...readMarks(hand, 't1', 'a.js', SHA_A)].sort(), [fp(1), fp(2)]);
});

test('the list is kept short: past the limit the oldest entries go', () => {
  const store = memory();
  for (let n = 0; n < MAX_ENTRIES + 5; n += 1) writeMarks(store, 't1', `file-${n}.js`, SHA_A, new Set([fp(n)]), 1000 + n);
  assert.equal(MAX_ENTRIES, 200);
  assert.equal(stored(store).entries.length, MAX_ENTRIES);
  for (let n = 0; n < 5; n += 1) assert.deepEqual([...readMarks(store, 't1', `file-${n}.js`, SHA_A)], [], `file-${n} was the oldest`);
  for (let n = 5; n < MAX_ENTRIES + 5; n += 1) assert.deepEqual([...readMarks(store, 't1', `file-${n}.js`, SHA_A)], [fp(n)], `file-${n} is kept`);
});

test('an entry that is written again moves to the newest place', () => {
  const store = memory();
  for (let n = 0; n < MAX_ENTRIES; n += 1) writeMarks(store, 't1', `file-${n}.js`, SHA_A, new Set([fp(n)]), 1000 + n);
  writeMarks(store, 't1', 'file-0.js', SHA_A, new Set([fp(0), fp(999)]), 5000);
  writeMarks(store, 't1', 'extra.js', SHA_A, new Set([fp(7)]), 5001);
  assert.deepEqual([...readMarks(store, 't1', 'file-0.js', SHA_A)].sort(), [fp(0), fp(999)], 'it was written again, so it is not the oldest');
  assert.deepEqual([...readMarks(store, 't1', 'file-1.js', SHA_A)], [], 'the oldest now is file-1');
});

test('a store that refuses the write leaves what was read before as it was', () => {
  const store = memory();
  writeMarks(store, 't1', 'a.js', SHA_A, new Set([fp(1)]), 1);
  const full = { getItem: store.getItem, setItem() { throw new Error('quota'); } };
  assert.equal(writeMarks(full, 't1', 'a.js', SHA_A, new Set([fp(1), fp(2)]), 2), false);
  assert.deepEqual([...readMarks(store, 't1', 'a.js', SHA_A)], [fp(1)]);
});

test('marks carry over only to hunks that are still there, by fingerprint', () => {
  const hunks = [{ fingerprint: fp(1) }, { fingerprint: fp(3) }];
  assert.deepEqual([...carryMarks(new Set([fp(1), fp(2), fp(3)]), hunks)].sort(), [fp(1), fp(3)]);
  assert.deepEqual([...carryMarks(new Set([fp(2)]), hunks)], []);
  assert.deepEqual([...carryMarks(new Set(), hunks)], []);
  assert.deepEqual([...carryMarks(new Set([fp(1)]), [])], []);
});

test('the key and the size are part of what is promised: marks already kept are found again after an update of the page', () => {
  assert.equal(ACCEPTED_STORAGE_KEY, 'chatmcp:review-accepted');
  assert.equal(MAX_ENTRIES, 200);
});

test('an entry that does not say when it was written is not read', () => {
  const entry = { task: 't1', path: 'a.js', sha: SHA_A, marks: [fp(1)] };
  for (const at of [undefined, null, '5', {}]) {
    const store = memory({ [ACCEPTED_STORAGE_KEY]: JSON.stringify({ v: 1, entries: [{ ...entry, at }] }) });
    assert.deepEqual([...readMarks(store, 't1', 'a.js', SHA_A)], [], JSON.stringify(at));
  }
  assert.deepEqual([...readMarks(memory({ [ACCEPTED_STORAGE_KEY]: JSON.stringify({ v: 1, entries: [{ ...entry, at: 0 }] }) }), 't1', 'a.js', SHA_A)], [fp(1)], 'zero is a time');
});

test('the marks of a file are written in a fixed order, whatever order they were made in', () => {
  const store = memory();
  writeMarks(store, 't1', 'a.js', SHA_A, new Set([fp(9), fp(2), fp(5)]), 1);
  assert.deepEqual(stored(store).entries[0].marks, [fp(2), fp(5), fp(9)]);
});

test('what cannot be read as an entry does not take the good ones with it, and is gone once the list is written again', () => {
  const good = { task: 't1', path: 'good.js', sha: SHA_A, at: 5, marks: [fp(1)] };
  const bad = [{ ...good, task: 7 }, { ...good, path: null }, { ...good, sha: 5 }, { ...good, at: 'x' }, { ...good, marks: 'x' }];
  const store = memory({ [ACCEPTED_STORAGE_KEY]: JSON.stringify({ v: 1, entries: [...bad, good] }) });
  assert.deepEqual([...readMarks(store, 't1', 'good.js', SHA_A)], [fp(1)]);
  writeMarks(store, 't1', 'new.js', SHA_A, new Set([fp(2)]), 9);
  assert.deepEqual(stored(store).entries.map((entry) => entry.path), ['good.js', 'new.js']);
});

test('when the list is full the entry that goes is the oldest by its time, even when it is the one that was just written', () => {
  const store = memory();
  for (let n = 0; n < MAX_ENTRIES; n += 1) writeMarks(store, 't1', `file-${n}.js`, SHA_A, new Set([fp(n)]), 1000 + n);
  writeMarks(store, 't1', 'late.js', SHA_A, new Set([fp(999)]), 5);
  assert.deepEqual([...readMarks(store, 't1', 'late.js', SHA_A)], [], 'it has the oldest time of all');
  assert.deepEqual([...readMarks(store, 't1', 'file-0.js', SHA_A)], [fp(0)]);
  assert.equal(stored(store).entries.length, MAX_ENTRIES);
});
