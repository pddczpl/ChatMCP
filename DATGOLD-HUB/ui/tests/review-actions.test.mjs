import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptAllOf, acceptFileOf, rejectAllOf, rejectFileOf, rejectHunkOf, summarizeBatch } from '../src/lib/review-actions.ts';
import { diffFile, rejectHunk } from '../src/lib/review-hunks.ts';

// What the Review tab does with a file, against a source of review that is told exactly what to write. Nothing here knows the Hub: the source is a recorder.

const sha = (letter) => letter.repeat(64);
const NEW_SHA = sha('9');
const lines = (count, label = 'L') => Array.from({ length: count }, (_, at) => `${label}${at + 1}\r\n`);
const edited = (list, ...changes) => list.map((line, at) => (changes.some(([index]) => index === at) ? `${changes.find(([index]) => index === at)[1]}\r\n` : line));

const FILE = (extra = {}) => ({
  path: 'src/a.js', status: 'modified', change: 'modified', baselineText: lines(30).join(''), currentText: edited(lines(30), [3, 'X'], [14, 'Y'], [26, 'Z']).join(''),
  baselineSha: sha('a'), currentSha: sha('b'), partial: false, accepted: false, rejectable: false, baselineSource: 'checkpoint', checkpointId: 'cp1', ...extra,
});
const CREATED = (extra = {}) => FILE({ path: 'new.txt', status: 'created', change: 'created', baselineText: null, baselineSha: null, currentText: 'a\nb\n', rejectable: true, ...extra });
const DELETED = (extra = {}) => FILE({ path: 'gone.txt', status: 'deleted', change: 'deleted', currentText: null, currentSha: null, ...extra });
const BINARY = (extra = {}) => FILE({ path: 'logo.bin', status: 'binary', baselineText: null, currentText: null, textUnavailable: 'binary', ...extra });
const diffOf = (file) => diffFile(file.baselineText ?? '', file.currentText ?? '');
const item = (file) => ({ file, diff: file.baselineText !== null || file.currentText !== null ? diffOf(file) : null, accepted: new Set() });
const failure = (status, code) => Object.assign(new Error('x'), { status, ...(code ? { code } : {}) });

function recorder(overrides = {}) {
  const calls = [];
  let inFlight = 0;
  let overlapped = false;
  const guard = async (call) => {
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
    calls.push(call);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
  };
  const source = {
    kind: 'task-checkpoint',
    async load() { return { files: [], truncated: false, omitted: { protected: 0 }, limitations: [] }; },
    async saveText(path, content, expectedSha) { await guard(['saveText', path, content, expectedSha]); return { sha256: NEW_SHA }; },
    async accept(file) { await guard(['accept', file.path, file.checkpointId, file.currentSha]); },
    async rejectCreated(file) { await guard(['rejectCreated', file.path, file.currentSha]); },
    ...overrides,
  };
  return { source, calls, get overlapped() { return overlapped; } };
}

test('putting one hunk back saves the current text with exactly that hunk undone, guarded by the sha that was reviewed', async () => {
  const file = FILE();
  const diff = diffOf(file);
  assert.equal(diff.hunks.length, 3);
  for (const index of [0, 1, 2]) {
    const { source, calls } = recorder();
    const outcome = await rejectHunkOf(source, file, diff, index);
    const expected = rejectHunk(diff, index);
    assert.deepEqual(calls, [['saveText', 'src/a.js', expected, sha('b')]], `hunk ${index}`);
    assert.deepEqual(outcome, { ok: true, sha: NEW_SHA, text: expected });
    assert.ok(!/[^\r]\n/.test(expected), 'the Windows line endings of the file are all still there');
    assert.notEqual(expected, file.currentText);
  }
});

test('a hunk that is not there, a source that cannot write, and a file with no sha write nothing', async () => {
  const file = FILE();
  const diff = diffOf(file);
  for (const index of [-1, 3, 99, 1.5, Number.NaN]) {
    const { source, calls } = recorder();
    assert.deepEqual(await rejectHunkOf(source, file, diff, index), { ok: false, kind: 'other' }, String(index));
    assert.deepEqual(calls, []);
  }
  const { source: readOnly, calls: none } = recorder({ saveText: undefined });
  assert.deepEqual(await rejectHunkOf(readOnly, file, diff, 0), { ok: false, kind: 'other' });
  assert.deepEqual(none, []);
  const { source, calls } = recorder();
  assert.deepEqual(await rejectHunkOf(source, FILE({ currentSha: null }), diff, 0), { ok: false, kind: 'other' });
  assert.deepEqual(calls, []);
});

test('what the Hub answers is told by kind: a file that changed, a task that runs, sandbox-only, a locked file, a text too long, a file that is not text', async () => {
  const file = FILE();
  const diff = diffOf(file);
  const cases = [[failure(409, 'stale_revision'), 'stale'], [failure(409), 'busy'], [failure(403), 'policy'], [failure(423, 'file_locked'), 'locked'], [failure(413, 'too_large'), 'too_large'], [failure(415, 'not_utf8'), 'unsupported'], [new Error('boom'), 'other']];
  for (const [thrown, kind] of cases) {
    const { source } = recorder({ async saveText() { throw thrown; } });
    assert.deepEqual(await rejectHunkOf(source, file, diff, 1), { ok: false, kind });
    assert.deepEqual(await rejectFileOf(source, file, diff), { ok: false, kind });
  }
});

test('putting a whole file back saves the text the file had before the task, byte for byte', async () => {
  const file = FILE({ baselineText: `${String.fromCharCode(0xfeff)}${lines(30).join('')}`, currentText: `${String.fromCharCode(0xfeff)}${edited(lines(30), [3, 'X'], [14, 'Y']).join('')}` });
  const { source, calls } = recorder();
  const outcome = await rejectFileOf(source, file, diffOf(file));
  assert.deepEqual(calls, [['saveText', 'src/a.js', file.baselineText, sha('b')]]);
  assert.deepEqual(outcome, { ok: true, sha: NEW_SHA, text: file.baselineText });
});

test('a new file is moved away instead; nothing else can be put back as a whole', async () => {
  const created = CREATED();
  const { source, calls } = recorder();
  assert.deepEqual(await rejectFileOf(source, created, diffOf(created)), { ok: true, sha: null, text: null });
  assert.deepEqual(calls, [['rejectCreated', 'new.txt', sha('b')]]);

  const stray = recorder();
  for (const file of [CREATED({ rejectable: false }), DELETED(), BINARY(), FILE({ baselineText: null, currentText: null, textUnavailable: 'too_large' }), FILE({ currentText: FILE().baselineText })]) {
    assert.deepEqual(await rejectFileOf(stray.source, file, file.baselineText !== null || file.currentText !== null ? diffOf(file) : null), { ok: false, kind: 'other' }, file.path);
  }
  assert.deepEqual(stray.calls, [], 'a file with no hunk to put back, a deleted one, a binary one, one with no text and a new one that is not the task\'s write nothing');
  const { source: noMove, calls: nothing } = recorder({ rejectCreated: undefined });
  assert.deepEqual(await rejectFileOf(noMove, created, diffOf(created)), { ok: false, kind: 'other' });
  assert.deepEqual(nothing, []);
});

test('accepting a file records it with its checkpoint and the sha that was reviewed', async () => {
  const { source, calls } = recorder();
  assert.deepEqual(await acceptFileOf(source, FILE()), { ok: true, sha: null, text: null });
  assert.deepEqual(calls, [['accept', 'src/a.js', 'cp1', sha('b')]]);
  const blocked = recorder();
  assert.deepEqual(await acceptFileOf(blocked.source, FILE({ currentSha: null })), { ok: false, kind: 'other' });
  assert.deepEqual(await acceptFileOf(blocked.source, FILE({ checkpointId: '' })), { ok: false, kind: 'other' });
  assert.deepEqual(blocked.calls, []);
  const { source: noAccept } = recorder({ accept: undefined });
  assert.deepEqual(await acceptFileOf(noAccept, FILE()), { ok: false, kind: 'other' });
  const { source: refusing } = recorder({ async accept() { throw failure(409, 'stale_review'); } });
  assert.deepEqual(await acceptFileOf(refusing, FILE()), { ok: false, kind: 'stale' });
});

test('"put everything back" goes file by file, one at a time, and goes on past a file that fails', async () => {
  const a = FILE({ path: 'a.js' });
  const b = FILE({ path: 'b.js', currentSha: sha('c') });
  const c = CREATED({ path: 'c.txt' });
  const d = CREATED({ path: 'd.txt', rejectable: false });
  const items = [item(a), item(b), item(c), item(d), item(DELETED({ path: 'e.txt' })), item(BINARY({ path: 'f.bin' }))];
  const run = recorder({
    async saveText(path, content, expectedSha) {
      if (path === 'a.js') throw failure(409, 'stale_revision');
      await new Promise((resolve) => setTimeout(resolve, 1));
      run.calls.push(['saveText', path, content, expectedSha]);
      return { sha256: NEW_SHA };
    },
  });
  const result = await rejectAllOf(run.source, items, 'ok');
  assert.deepEqual(result, { done: ['b.js', 'c.txt'], failed: [{ path: 'a.js', kind: 'stale' }], skipped: 3 });
  assert.deepEqual(run.calls, [['saveText', 'b.js', b.baselineText, sha('c')], ['rejectCreated', 'c.txt', sha('b')]]);
});

test('"put everything back" does nothing at all when writing is not allowed, and never overlaps two writes', async () => {
  const items = [item(FILE({ path: 'a.js' })), item(FILE({ path: 'b.js' })), item(CREATED({ path: 'c.txt' }))];
  for (const state of ['running', 'policy']) {
    const { source, calls } = recorder();
    assert.deepEqual(await rejectAllOf(source, items, state), { done: [], failed: [], skipped: 3 }, state);
    assert.deepEqual(calls, []);
  }
  const run = recorder();
  assert.deepEqual((await rejectAllOf(run.source, items, 'ok')).done, ['a.js', 'b.js', 'c.txt']);
  assert.equal(run.overlapped, false, 'the writes were made one after the other');
  assert.deepEqual(await rejectAllOf(recorder().source, [], 'ok'), { done: [], failed: [], skipped: 0 });
});

test('"accept everything" records every file the Hub can record that is not recorded yet, and says which failed', async () => {
  const items = [item(FILE({ path: 'a.js' })), item(FILE({ path: 'b.js', accepted: true })), item(CREATED({ path: 'c.txt' })), item(DELETED({ path: 'd.txt' })), item(BINARY({ path: 'e.bin' })), item(FILE({ path: 'f.js', currentSha: null }))];
  const asked = [];
  const { source } = recorder({ async accept(file) { asked.push(file.path); if (file.path === 'c.txt') throw failure(409, 'stale_review'); } });
  const result = await acceptAllOf(source, items, 'ok');
  assert.deepEqual(result, { done: ['a.js', 'e.bin'], failed: [{ path: 'c.txt', kind: 'stale' }], skipped: 3 });
  assert.deepEqual(asked, ['a.js', 'c.txt', 'e.bin'], 'in order; the file that is accepted already, the deleted one and the one with no sha were not asked');
  const sandbox = recorder();
  assert.deepEqual(await acceptAllOf(sandbox.source, items, 'policy'), { done: [], failed: [], skipped: 6 });
  assert.deepEqual(sandbox.calls, []);
  const running = recorder();
  assert.deepEqual((await acceptAllOf(running.source, items, 'running')).done, ['a.js', 'c.txt', 'e.bin'], 'accepting is not writing');
});

test('a hunk, a whole file or a move is not made for a file that is not reviewed as that, whatever the file says about itself', async () => {
  const created = CREATED();
  const deleted = DELETED({ currentSha: sha('c') });
  const run = recorder();
  assert.deepEqual(await rejectHunkOf(run.source, created, diffOf(created), 0), { ok: false, kind: 'other' }, 'a new file has no hunk to put back: that would write an empty file');
  assert.deepEqual(await rejectHunkOf(run.source, deleted, diffOf(deleted), 0), { ok: false, kind: 'other' });
  assert.deepEqual(await rejectFileOf(run.source, deleted, diffOf(deleted)), { ok: false, kind: 'other' }, 'a deleted file cannot be written');
  assert.deepEqual(await rejectFileOf(run.source, CREATED({ currentSha: null }), diffOf(created)), { ok: false, kind: 'other' }, 'a new file with no sha to guard the move');
  assert.deepEqual(run.calls, []);
});

test('"put everything back" leaves a text file with nothing to put back alone: it is skipped, it did not fail', async () => {
  const same = FILE({ path: 'same.js', currentText: FILE().baselineText });
  const result = await rejectAllOf(recorder().source, [item(same), item(FILE({ path: 'b.js' }))], 'ok');
  assert.deepEqual(result, { done: ['b.js'], failed: [], skipped: 1 });
});

test('the status after a batch gives the counts, then names the files that are still different after being saved and the files that could not be done', () => {
  const clean = summarizeBatch({ done: ['a.txt', 'b.txt'], failed: [], skipped: 1 }, []);
  assert.deepEqual(clean, { tone: 'ok', lines: [{ key: 'review_result_all', values: { done: 2, failed: 0, skipped: 1 } }] });
  const kept = summarizeBatch({ done: ['a.txt', 'b.txt'], failed: [], skipped: 0 }, ['b.txt']);
  assert.equal(kept.tone, 'warn');
  assert.deepEqual(kept.lines.map((line) => line.key), ['review_result_all', 'review_result_all_kept']);
  assert.deepEqual(kept.lines[1].values, { kept: 'b.txt' });
  const failed = summarizeBatch({ done: ['a.txt', 'c.txt'], failed: [{ path: 'b.txt', kind: 'stale' }], skipped: 0 }, []);
  assert.equal(failed.tone, 'warn');
  assert.deepEqual(failed.lines.map((line) => line.key), ['review_result_all', 'review_result_all_failed_files']);
  assert.deepEqual(failed.lines[0].values, { done: 2, failed: 1, skipped: 0 });
  assert.deepEqual(failed.lines[1].values, { paths: 'b.txt' });
  const both = summarizeBatch({ done: ['a'], failed: ['x1', 'x2', 'x3', 'x4'].map((path) => ({ path, kind: 'other' })), skipped: 0 }, ['a']);
  assert.deepEqual(both.lines.map((line) => line.key), ['review_result_all', 'review_result_all_kept', 'review_result_all_failed_files']);
  assert.equal(both.lines[2].values.paths, 'x1, x2, x3, …', 'the first few are named, and the rest are said to be more');
});

test('the status after a batch names at most three of the files that are still different and at most three of the files that could not be done, and says that there are more', () => {
  const kept = ['k1.txt', 'k2.txt', 'k3.txt', 'k4.txt'];
  const failed = ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt'].map((path) => ({ path, kind: 'stale' }));
  const summary = summarizeBatch({ done: kept, failed, skipped: 0 }, kept);
  assert.equal(summary.tone, 'warn');
  assert.deepEqual(summary.lines.map((line) => line.key), ['review_result_all', 'review_result_all_kept', 'review_result_all_failed_files']);
  assert.deepEqual(summary.lines[0].values, { done: 4, failed: 5, skipped: 0 });
  assert.equal(summary.lines[1].values.kept, 'k1.txt, k2.txt, k3.txt, …', 'four files that are still different: the first three, and the mark');
  assert.equal(summary.lines[2].values.paths, 'f1.txt, f2.txt, f3.txt, …', 'five files that could not be done: the first three, and the mark');
  // Exactly three is not "more".
  const three = summarizeBatch({ done: kept.slice(0, 3), failed: [], skipped: 0 }, kept.slice(0, 3));
  assert.equal(three.lines[1].values.kept, 'k1.txt, k2.txt, k3.txt');
});
