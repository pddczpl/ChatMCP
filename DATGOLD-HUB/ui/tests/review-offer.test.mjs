import test from 'node:test';
import assert from 'node:assert/strict';
import { editedPaths, findReviewFile, receiptTarget } from '../src/lib/review-offer.ts';

// When a turn changed files the conversation offers the Review tab, and a receipt of an edit links to it. Both are read from the tool calls the Hub recorded, never from what the model said.

const call = (name, args, extra = {}) => ({ name, args, status: 'success', checkpointId: 'cp1', ...extra });

test('the files a conversation changed are the paths of its edits that went through, once each, in the order they came', () => {
  const calls = [
    call('local.read_file', { path: 'README.md' }),
    call('local.edit_file', { path: 'src/a.js' }),
    call('local.write_file', { path: 'src/b.js' }),
    call('local.edit_file', { path: 'src/a.js' }),
    call('local.run_command', { command: 'npm test' }),
    call('local.files_write_batch', { paths: ['src/c.js', 'src/b.js', 'src/d.js'] }),
    call('local.move_path', { source: 'old.txt', destination: 'new.txt' }),
    call('local.delete_path', { path: 'gone.txt' }),
  ];
  assert.deepEqual(editedPaths(calls), ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'old.txt', 'new.txt', 'gone.txt']);
});

test('an edit that did not go through, is still running, or names no file is not an edit of the conversation', () => {
  const calls = [
    call('local.edit_file', { path: 'a.js' }, { status: 'error' }),
    call('local.edit_file', { path: 'b.js' }, { status: 'running' }),
    call('local.edit_file', { path: 'c.js' }, { status: 'unknown' }),
    call('local.edit_file', { path: 'd.js' }, { status: undefined }),
    call('local.edit_file', {}),
    call('local.edit_file', undefined),
    call('local.edit_file', { path: '' }),
    call('local.edit_file', { path: 7 }),
    call('local.edit_file', { paths: 'x.js' }),
    call('local.edit_file', { paths: [null, '', 5, 'ok.js'] }),
  ];
  assert.deepEqual(editedPaths(calls), ['ok.js']);
});

test('nothing in, nothing out', () => {
  assert.deepEqual(editedPaths(undefined), []);
  assert.deepEqual(editedPaths([]), []);
  assert.deepEqual(editedPaths(null), []);
});

test('a receipt of an edit links to the file it changed, when the Hub made a checkpoint for that very call', () => {
  assert.deepEqual(receiptTarget(call('local.edit_file', { path: 'src/a.js' })), { path: 'src/a.js' });
  assert.deepEqual(receiptTarget(call('local.write_file', { path: 'src/a.js' })), { path: 'src/a.js' });
  assert.deepEqual(receiptTarget(call('local.files_write_batch', { paths: ['x.js', 'y.js'] })), { path: 'x.js' });
  assert.deepEqual(receiptTarget(call('local.move_path', { source: 'old.txt', destination: 'new.txt' })), { path: 'new.txt' }, 'the file that is there to be reviewed');
  assert.deepEqual(receiptTarget(call('local.delete_path', { path: 'gone.txt' })), { path: 'gone.txt' });
  assert.deepEqual(receiptTarget(call('local.edit_file', { path: 'p.js', paths: ['q.js'], destination: 'd.js' })), { path: 'p.js' }, 'path first, then destination, then the first of paths');
  assert.deepEqual(receiptTarget(call('local.edit_file', { destination: 'd.js', paths: ['q.js'] })), { path: 'd.js' });
});

test('no link where there is nothing to review: no checkpoint, no success, not an edit, no file', () => {
  assert.equal(receiptTarget(call('local.edit_file', { path: 'a.js' }, { checkpointId: undefined })), null);
  assert.equal(receiptTarget(call('local.edit_file', { path: 'a.js' }, { checkpointId: '' })), null);
  assert.equal(receiptTarget(call('local.edit_file', { path: 'a.js' }, { status: 'error' })), null);
  assert.equal(receiptTarget(call('local.edit_file', { path: 'a.js' }, { status: 'running' })), null);
  assert.equal(receiptTarget(call('local.read_file', { path: 'a.js' })), null);
  assert.equal(receiptTarget(call('local.run_command', { command: 'rm a.js' })), null);
  assert.equal(receiptTarget(call('local.git_push', { path: 'a.js' })), null);
  assert.equal(receiptTarget(call('local.edit_file', {})), null);
  assert.equal(receiptTarget(call('local.edit_file', undefined)), null);
  assert.equal(receiptTarget(undefined), null);
});

test('a path the model wrote finds the file of the review: as it is, with the other slash, behind ./, in another case, or as an absolute path', () => {
  const files = [{ path: 'src/a.js' }, { path: 'src/b.js' }, { path: 'a.js' }, { path: 'README.md' }];
  assert.equal(findReviewFile(files, 'src/a.js'), files[0]);
  assert.equal(findReviewFile(files, 'src\\a.js'), files[0]);
  assert.equal(findReviewFile(files, './src/a.js'), files[0]);
  assert.equal(findReviewFile(files, 'a.js'), files[2], 'the whole path, not a file that ends the same way');
  assert.equal(findReviewFile(files, 'readme.md'), files[3], 'a Windows file system does not tell the case');
  assert.equal(findReviewFile(files, 'F:\\work\\project\\src\\b.js'), files[1], 'an absolute path ends with the path of the file');
  assert.equal(findReviewFile(files, '/home/me/project/a.js'), files[2]);
  assert.equal(findReviewFile(files, '/home/me/project/src/a.js'), files[0], 'the longest path that it ends with');
  assert.equal(findReviewFile(files, 'src/c.js'), undefined);
  assert.equal(findReviewFile(files, 'src/xa.js'), undefined, 'a name that only ends the same way is not the file');
  assert.equal(findReviewFile(files, 'rc/a.js'), files[2], 'a path from a folder the review does not know ends with the path of a.js: it is the best that can be said');
  assert.equal(findReviewFile(files, ''), undefined);
  assert.equal(findReviewFile([], 'a.js'), undefined);
  const cases = [{ path: 'A.js' }, { path: 'a.js' }];
  assert.equal(findReviewFile(cases, 'a.js'), cases[1], 'where two files differ only in case, the case that was written wins');
  assert.equal(findReviewFile(cases, 'A.js'), cases[0]);
});
