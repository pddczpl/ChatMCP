// An approval request of the Hub, asked of the editor (lib/acp/permission-map.mjs, plan task ux-20): what session/request_permission carries, and what the answer of the editor means.
//
//   A. The request for a call that writes a file (a real one, fixtures/acp-approval-request.json): the call, the options, and the planned change as a diff.
//   B. The planned change in all its shapes: several hunks, a file that is not text, a refused call, private key material, rows that were left out, many files.
//   C. A call that is not a change of files, a request that is not what the Hub writes: still a request, never an exception.
//   D. The answer: one option allows, everything else refuses (also what cannot be read).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_ANSWER_MS, MAX_DIFF_FILES, MIN_ANSWER_MS, PERMISSION_OPTIONS, answerWindowMs, decisionFrom, permissionRequestFor } from '../lib/acp/permission-map.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const real = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-approval-request.json'), 'utf8')).request;
const CWD = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const inside = (...parts) => path.join(CWD, ...parts);
const withPreview = (files, extra = {}) => ({ ...real, toolName: 'local.edit_file', detail: { kind: 'edit', path: files[0]?.path ?? 'a.js', preview: { files, fileCount: files.length, hiddenFiles: 0, truncated: false, ...extra } } });
const row = (kind, text, extra = {}) => ({ kind, text, ...extra });
const hunk = (rows) => ({ baselineStart: 1, baselineEnd: 1, currentStart: 1, currentEnd: 1, removed: rows.filter((r) => r.kind === 'removed').length, added: rows.filter((r) => r.kind === 'added').length, invisibleOnly: false, rows });
const file = (filePath, hunks, extra = {}) => ({ path: filePath, action: 'edit', baseSha: 'x', additions: 1, deletions: 1, unchanged: false, hunks, shownRows: 3, hiddenRows: 0, truncated: false, ...extra });

// ---- A. a real request -----------------------------------------------------------------------------------------------------------------------------------------------
{
  assert.deepEqual(PERMISSION_OPTIONS, [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }]);
  const params = permissionRequestFor({ sessionId: 'session-1', request: real, callId: 'call_mock_3', cwd: CWD });
  assert.deepEqual(params, {
    sessionId: 'session-1',
    toolCall: {
      toolCallId: 'call_mock_3', title: 'Write out.txt', kind: 'edit', status: 'pending', locations: [{ path: inside('out.txt') }], rawInput: { path: 'out.txt' },
      content: [{ type: 'diff', path: inside('out.txt'), oldText: null, newText: 'from probe\n' }],
    },
    options: PERMISSION_OPTIONS,
  });
  params.options[0].name = 'changed';
  assert.equal(PERMISSION_OPTIONS[0].name, 'Allow', 'the options are a copy');
  assert.equal(permissionRequestFor({ sessionId: 's', request: real, cwd: CWD }).toolCall.toolCallId, `approval-${real.id}`, 'without the id of the call, the id of the request names it');
  const said = JSON.stringify(permissionRequestFor({ sessionId: 's', request: real, callId: 'c', cwd: CWD }));
  for (const own of ['Ghi file', 'Ghi out.txt', 'workspace_edit', real.taskId, '"head"', 'expiresAt', 'baseSha']) assert.ok(!said.includes(own), `${own} is the Hub's bookkeeping and is not sent`);
  ok('the approval of a real write: the call it is about, a title and a kind, the file it touches, the new file as a diff (no old text), and two options; nothing of the Hub\'s bookkeeping');
}

// ---- B. the planned change ---------------------------------------------------------------------------------------------------------------------------------------------
{
  const two = withPreview([file('src/a.js', [
    hunk([row('context', 'function add(a, b) {\n'), row('removed', '  return a - b;\n'), row('added', '  return a + b;\n'), row('context', '}\n')]),
    hunk([row('context', 'module.exports = {\n'), row('added', '  add,\n'), row('context', '};\n')]),
  ])]);
  const [diff] = permissionRequestFor({ sessionId: 's', request: two, callId: 'c', cwd: CWD }).toolCall.content;
  assert.equal(diff.type, 'diff');
  assert.equal(diff.path, inside('src', 'a.js'));
  assert.equal(diff.oldText, 'function add(a, b) {\n  return a - b;\n}\n\u2026\nmodule.exports = {\n};\n');
  assert.equal(diff.newText, 'function add(a, b) {\n  return a + b;\n}\n\u2026\nmodule.exports = {\n  add,\n};\n');
  ok('a change in two places: the old text and the new text of the hunks, with the lines around them, and a line of dots where the file goes on between them');

  const cut = withPreview([file('big.txt', [hunk([row('removed', `${'x'.repeat(400)}`, { omitted: 25 }), row('added', 'short\n')])], { hiddenRows: 40, truncated: true })]);
  const cutContent = permissionRequestFor({ sessionId: 's', request: cut, callId: 'c', cwd: CWD }).toolCall.content;
  assert.equal(cutContent[0].type, 'diff');
  assert.ok(cutContent[0].oldText.endsWith('\u2026'), 'a line that was cut says so');
  assert.ok(cutContent.some((c) => c.type === 'content' && /40 more rows are not shown/.test(c.content.text)), 'rows that were left out are counted in a note');

  const unreadable = withPreview([file('data.bin', [], { oldUnreadable: true, action: 'overwrite' })]);
  const unreadableContent = permissionRequestFor({ sessionId: 's', request: unreadable, callId: 'c', cwd: CWD }).toolCall.content;
  assert.ok(unreadableContent.some((c) => c.type === 'content' && /not text/.test(c.content.text)), 'an existing file that is not text is said to be');

  const refused = { ...real, detail: { kind: 'edit', path: 'a.js', preview: { files: [], fileCount: 0, hiddenFiles: 0, truncated: false, error: { code: 'ambiguous', message: 'old_string occurs twice' } } } };
  const refusedContent = permissionRequestFor({ sessionId: 's', request: refused, callId: 'c', cwd: CWD }).toolCall.content;
  assert.deepEqual(refusedContent, [{ type: 'content', content: { type: 'text', text: 'This call would be refused when it runs: old_string occurs twice' } }]);

  const keys = withPreview([file('deploy.pem', [hunk([row('context', '# keys\n')])], { hiddenKeyRows: 2 })], { privateKeys: true });
  const keyContent = permissionRequestFor({ sessionId: 's', request: keys, callId: 'c', cwd: CWD }).toolCall.content;
  assert.ok(keyContent.some((c) => c.type === 'content' && /private key/i.test(c.content.text)), 'private key material is said to be left out');
  assert.ok(!JSON.stringify(keyContent).includes('BEGIN'), 'and none of it is there');

  const invisible = withPreview([file('crlf.txt', [{ ...hunk([row('context', 'a\r\n'), row('removed', 'b\n'), row('added', 'b\r\n')]), invisibleOnly: true }])]);
  assert.ok(permissionRequestFor({ sessionId: 's', request: invisible, callId: 'c', cwd: CWD }).toolCall.content.some((c) => c.type === 'content' && /line endings/.test(c.content.text)), 'a change of line endings only is said to be');

  const many = withPreview(Array.from({ length: MAX_DIFF_FILES + 5 }, (_, i) => file(`f${i}.txt`, [hunk([row('added', `${i}\n`)])])), { hiddenFiles: 7, truncated: true });
  const manyContent = permissionRequestFor({ sessionId: 's', request: many, callId: 'c', cwd: CWD }).toolCall.content;
  assert.equal(manyContent.filter((c) => c.type === 'diff').length, MAX_DIFF_FILES, 'at most that many files are shown as diffs');
  assert.ok(manyContent.some((c) => c.type === 'content' && /12 more files are not shown/.test(c.content.text)), 'the files that are not shown are counted: the 5 over the limit and the 7 the Hub left out');

  const outsideName = path.join('..', '..', 'elsewhere.txt');
  const outside = withPreview([file(outsideName, [hunk([row('added', 'x\n')])])]);
  const outsidePath = permissionRequestFor({ sessionId: 's', request: outside, callId: 'c', cwd: CWD }).toolCall.content[0].path;
  assert.equal(outsidePath, outsideName, 'a path outside the folder is shown as the Hub gave it');
  ok('a change in several places, rows that were cut, a file that is not text, a call the Hub would refuse, private key material, a change of line endings only, many files, and a path outside the folder: each is said in words or as a diff, and bounded');
}

// ---- C. other calls, other requests ------------------------------------------------------------------------------------------------------------------------------------
{
  const command = { ...real, toolName: 'local.run_command', category: 'execute', reason: 'Lệnh', summary: 'Chạy npm test', detail: { kind: 'command', command: 'npm test' } };
  const params = permissionRequestFor({ sessionId: 's', request: command, callId: 'c', cwd: CWD });
  assert.equal(params.toolCall.title, 'Run npm test');
  assert.equal(params.toolCall.kind, 'execute');
  assert.deepEqual(params.toolCall.rawInput, { command: 'npm test' });
  assert.deepEqual(params.toolCall.content, [{ type: 'content', content: { type: 'text', text: 'Chạy npm test' } }], 'the Hub\'s own sentence for a call that is not a change of files');
  assert.equal(params.toolCall.locations, undefined);

  for (const odd of [null, undefined, 5, 'x', [], {}, { toolName: 5 }, { toolName: 'local.write_file', detail: 5 }, { toolName: 'local.write_file', detail: { preview: 5 } }, { toolName: 'local.write_file', detail: { preview: { files: 'x' } } },
    { toolName: 'local.write_file', detail: { preview: { files: [null, 5, {}, { path: 5 }, { path: 'a', hunks: 'x' }, { path: 'b', hunks: [null, { rows: 'x' }, { rows: [null, { kind: 'added', text: 5 }, { kind: 'nope', text: 'x' }] }] }] } } },
    { id: 7, toolName: 'local.run_command', detail: { command: 5 }, summary: {} }]) {
    const odder = permissionRequestFor({ sessionId: 's', request: odd, callId: undefined, cwd: CWD });
    assert.equal(odder.sessionId, 's');
    assert.ok(typeof odder.toolCall.toolCallId === 'string' && odder.toolCall.toolCallId !== '');
    assert.equal(odder.toolCall.status, 'pending');
    assert.ok(typeof odder.toolCall.title === 'string' && odder.toolCall.title !== '');
    assert.deepEqual(odder.options, PERMISSION_OPTIONS);
    JSON.stringify(odder);
  }
  ok('a call that is not a change of files (a command: its title, its command, the Hub\'s sentence) and thirteen kinds of request that are not what the Hub writes: always a request with a call, a title and the two options, never an exception');
}

// ---- D. the answer ----------------------------------------------------------------------------------------------------------------------------------------------------
{
  const selected = (optionId, extra = {}) => ({ outcome: { outcome: 'selected', optionId, ...extra } });
  assert.deepEqual(decisionFrom(selected('allow_once')), { approved: true, why: 'allowed' });
  assert.deepEqual(decisionFrom({ ...selected('allow_once'), _meta: { a: 1 } }), { approved: true, why: 'allowed' }, 'a field the protocol allows besides the outcome does not matter');
  assert.deepEqual(decisionFrom(selected('reject_once')), { approved: false, why: 'rejected' });
  assert.deepEqual(decisionFrom({ outcome: { outcome: 'cancelled' } }), { approved: false, why: 'cancelled' });
  for (const odd of [null, undefined, 5, 'allow_once', [], {}, { outcome: 'selected' }, { outcome: null }, { outcome: { outcome: 'selected' } }, selected('allow_always'), selected('ALLOW_ONCE'), selected(' allow_once'), selected(5), selected(['allow_once']),
    { outcome: { outcome: 'allowed', optionId: 'allow_once' } }, { outcome: { outcome: 'selected ', optionId: 'allow_once' } }, { outcome: [{ outcome: 'selected', optionId: 'allow_once' }] }, { optionId: 'allow_once' }, { outcome: { optionId: 'allow_once' } }]) {
    assert.deepEqual(decisionFrom(odd), { approved: false, why: 'unreadable' }, JSON.stringify(odd));
  }
  ok('only the option "allow_once" of a selected outcome allows; a rejection, a cancellation, an option nobody offered and every answer that cannot be read refuse');
}

// ---- E. the edges that the mutation work found (tests/mutation/acp-permissions.json) ----------------------------------------------------------------------------------
{
  const file = (filePath, hunks, extra = {}) => ({ path: filePath, action: 'edit', baseSha: 'x', additions: 1, deletions: 1, unchanged: false, hunks, shownRows: 3, hiddenRows: 0, truncated: false, ...extra });
  const ask = (request, cwd = CWD) => permissionRequestFor({ sessionId: 's', request, callId: 'c', cwd });
  const asked = (detail, extra = {}) => ({ ...real, toolName: 'local.edit_file', ...extra, detail });
  const diffs = (params) => (params.toolCall.content ?? []).filter((block) => block.type === 'diff');
  const notes = (params) => (params.toolCall.content ?? []).filter((block) => block.type === 'content').map((block) => block.content.text);
  const one = [file('y.js', [hunk([row('added', 'a\n')])])];
  const over = (files, extra = {}) => ask(asked({ kind: 'edit', path: 'a.js', preview: { files, ...extra } }));
  const sides = (hunks) => { const [block] = diffs(over([file('a.js', hunks)])); return block ? { old: block.oldText, new: block.newText } : null; };

  // the input of the call: the path the Hub names, the one file of the change, the list of files, a move
  assert.equal(ask(asked({ kind: 'edit', path: 'x.js', preview: { files: one } })).toolCall.rawInput.path, 'x.js', 'the path the Hub names is the path of the call');
  assert.equal(ask(asked({ kind: 'edit', preview: { files: one } })).toolCall.rawInput.path, 'y.js', 'without it the one file of the change names the call');
  assert.deepEqual(ask(asked({ kind: 'edit', path: 'x.js', preview: { files: [file('a.js', []), file('b.js', [])] } })).toolCall.rawInput, { path: 'x.js', paths: ['a.js', 'b.js'] }, 'two files are listed');
  assert.equal(ask(asked({ kind: 'edit', preview: { files: Array.from({ length: 25 }, (_, n) => file(`f${n}.js`, [])) } })).toolCall.rawInput.paths.length, MAX_DIFF_FILES, 'at most twenty paths are listed');
  assert.deepEqual(ask(asked({ kind: 'edit', preview: { files: [file('', []), file('b.js', [])] } })).toolCall.rawInput.paths, ['b.js'], 'a file without a path is not listed');
  const move = ask({ ...real, toolName: 'local.move_path', detail: { kind: 'move', source: 'a.txt', destination: 'b.txt' } });
  assert.deepEqual(move.toolCall.rawInput, { source: 'a.txt', destination: 'b.txt' });
  assert.equal(move.toolCall.title, 'Move a.txt to b.txt');
  assert.deepEqual(move.toolCall.locations, [{ path: inside('a.txt') }, { path: inside('b.txt') }]);
  ok('the input of a call: the path the Hub names before the one file of the change, a list of two files and its limit of twenty, a file without a path, and the source and destination of a move');

  // the two texts of a file
  assert.deepEqual(sides([hunk([row('context', 'c\n'), row('meta', 'ignored\n'), row('removed', 'r\n'), row('added', 'a\n')])]), { old: 'c\nr\n', new: 'c\na\n' }, 'a row of another kind is on neither side');
  assert.deepEqual(sides([hunk([row('added', 'x', { omitted: 0 }), row('added', 'y', { omitted: '5' }), row('added', 'z', { omitted: 4 })])]), { old: '', new: 'xyz…' }, 'only a row with a number above zero cut from it says so');
  assert.deepEqual(sides([hunk([row('added', 'a\n')]), hunk([]), hunk([row('added', 'b\n')])]), { old: '…\n', new: 'a\n…\nb\n' }, 'a hunk with no text is not a hunk: one separator between the two others');
  const huge = 'x'.repeat(200_000);
  assert.equal(sides([hunk([row('added', huge)])]).new, huge, 'a side of exactly the limit is whole');
  const cut = sides([hunk([row('added', `${huge}y`)])]).new;
  assert.ok(cut.length === 200_001 && cut.endsWith('…') && cut.startsWith('xxxx'), 'a longer side is cut at the limit and says so');
  assert.deepEqual(sides([{ ...hunk([]), rows: [row('added', 'a\n'), { kind: 'added', text: 42 }, { kind: 'added' }, null] }]), { old: '', new: 'a\n' }, 'a row without text is skipped');
  assert.equal(sides([]), null, 'a file with no hunks has no diff');
  assert.deepEqual(diffs(ask(asked({ kind: 'edit', path: 'a.js', preview: { files: [{ path: 'a.js', action: 'edit', hunks: null }] } }))), [], 'hunks that are not a list are no hunks');
  ok('the two texts of a file: a row of another kind, rows that were cut (0, a string, a number), a hunk with no text, the limit of a side to the character and its mark, a row without text, a file without hunks, hunks that are not a list');

  // where the file is
  assert.equal(diffs(ask(asked({ kind: 'edit', path: 'a.js', preview: { files: one } }), ''))[0].path, 'y.js', 'without the folder of the session the path stays as the Hub wrote it');
  assert.equal(diffs(ask(asked({ kind: 'edit', path: '.', preview: { files: [file('.', [hunk([row('added', 'a\n')])])] } })))[0].path, '.', 'the folder itself is not made a file');
  ok('where a file is: without the folder of the session, and the folder itself');

  // the content of the request
  assert.deepEqual(notes(ask({ ...real, detail: {}, summary: undefined, reason: 'because the model asked' })), ['because the model asked'], 'a call with no preview and no summary gives its reason');
  assert.deepEqual(notes(ask({ ...real, detail: { preview: 'not a preview' }, summary: 'The Hub says so' })), ['The Hub says so'], 'a preview that is not an object is no preview');
  assert.equal(diffs(over([{ hunks: [hunk([row('added', 'z\n')])] }, ...one])).length, 1, 'a file without a path is not shown');
  assert.deepEqual(notes(over([file('y.js', [hunk([row('added', 'a\n')])], { oldUnreadable: 'yes' })])), [], 'only the value true says the old file is not text');
  assert.deepEqual(notes(over([file('y.js', [hunk([row('added', 'a\n')])], { hiddenRows: 5 }), file('z.js', [hunk([row('added', 'a\n')])], { hiddenRows: -3 })])), ['5 more rows are not shown.'], 'a negative count of rows is not added');
  assert.ok(notes(over([file('y.js', [hunk([row('added', 'a\n')])], { hiddenKeyRows: 2 })])).some((words) => /private key material/.test(words)), 'rows of key material that were left out are mentioned');
  assert.ok(notes(over(one, { privateKeys: true })).some((words) => /private key material/.test(words)), 'and so is the flag of the Hub');
  assert.deepEqual(notes(over(one, { error: { code: 'outside_workspace' } })), ['This call would be refused when it runs: outside_workspace'], 'a refusal without words gives its code');
  assert.deepEqual(notes(over(one, { error: {} })), ['This call would be refused when it runs: the Hub gave no reason'], 'and one without either says so');
  ok('the content of a request: the reason of a call that has no preview, a preview that is not an object, a file without a path, a flag that is only truthy, counts that are negative, key material (the rows and the flag), and a refusal with a code only or with nothing');

  // the call that is named
  assert.equal(permissionRequestFor({ sessionId: 's', request: { ...real, id: 'r7' }, callId: '', cwd: CWD }).toolCall.toolCallId, 'approval-r7', 'an empty call id names nothing');
  assert.equal(permissionRequestFor({ sessionId: 's', request: { toolName: 'local.run_command', detail: { command: 'ls' } }, cwd: CWD }).toolCall.toolCallId, 'approval-unknown', 'a request without an id is still named');
  ok('the name of the call: an empty id falls back to the id of the request, and a request without an id is still named');
}

// ---- F. how long the editor is given to answer -------------------------------------------------------------------------------------------------------------------------
{
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const at = (ms) => ({ expiresAt: new Date(now + ms).toISOString() });
  assert.equal(MIN_ANSWER_MS, 1000);
  assert.equal(MAX_ANSWER_MS, 15 * 60 * 1000);
  assert.equal(answerWindowMs(at(600_000), now), 600_000, 'until the Hub drops the request');
  assert.equal(answerWindowMs(at(5_000), now), 5_000);
  assert.equal(answerWindowMs(at(1_000), now), 1_000, 'a second is a second');
  assert.equal(answerWindowMs(at(999), now), 1_000, 'at least a second');
  assert.equal(answerWindowMs(at(-5_000), now), 1_000, 'a request that has expired already still gets a second');
  assert.equal(answerWindowMs(at(MAX_ANSWER_MS), now), MAX_ANSWER_MS);
  assert.equal(answerWindowMs(at(MAX_ANSWER_MS + 1), now), MAX_ANSWER_MS, 'at most fifteen minutes');
  assert.equal(answerWindowMs(at(10 * 24 * 3600 * 1000), now), MAX_ANSWER_MS, 'also when the Hub says ten days');
  for (const odd of [{}, null, undefined, 'x', 7, [], { expiresAt: 'soon' }, { expiresAt: 5 }, { expiresAt: null }, { expiresAt: '' }, { expiresAt: ['2026-01-01T00:00:01Z'] }]) {
    assert.equal(answerWindowMs(odd, now), MAX_ANSWER_MS, `a request that says nothing usable (${JSON.stringify(odd)}) gets the longest time`);
  }
  const soon = answerWindowMs({ expiresAt: new Date(Date.now() + 600_000).toISOString() });
  assert.ok(soon <= 600_000 && soon > 590_000, `without a clock given, the clock of the system (${soon})`);
  ok('the time the editor is given to answer: until the request expires, never less than a second or more than fifteen minutes, and the longest for a request that says nothing usable');
}

console.log(`PASS: ${checks} checks (the approval request for a real write, the planned change in all its shapes, other calls and odd requests, the answer, and the edges the mutation work found)`);
