import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime, formatDuration, formatNumber, formatRelative, formatTime, formatTokens } from '../src/lib/format.ts';
import { describeTool, riskInfo, summarizeTools, toolKind, toolTarget } from '../src/lib/tool-labels.ts';

const at = new Date(2026, 9, 20, 14, 47, 31); // local time: 20 Oct 2026 14:47:31

test('times and dates follow the interface language and use a 24-hour clock', () => {
  assert.equal(formatTime(at, 'vi'), '14:47');
  assert.equal(formatTime(at, 'en'), '14:47');
  assert.equal(formatDateTime(at, 'vi'), '20/10/2026 14:47');
  assert.equal(formatDateTime(at, 'en'), 'Oct 20, 2026, 14:47');
  assert.equal(formatTime('not a date', 'vi'), '');
  assert.equal(formatDateTime(undefined, 'vi'), '');
});

test('relative times are in words and round sensibly', () => {
  const now = at.getTime();
  assert.equal(formatRelative(now - 5_000, 'vi', now), 'vừa xong');
  assert.equal(formatRelative(now - 5_000, 'en', now), 'just now');
  assert.match(formatRelative(now - 5 * 60_000, 'vi', now), /5 phút trước/);
  assert.match(formatRelative(now - 3 * 3_600_000, 'en', now), /3 hours ago/);
  assert.match(formatRelative(now - 86_400_000, 'en', now), /yesterday/i);
});

test('numbers, durations and token counts are compact and never invent a value', () => {
  assert.equal(formatDuration(842), '842 ms');
  assert.equal(formatDuration(1200), '1.2 s');
  assert.equal(formatDuration(125_000), '2 m 05 s');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatTokens(840), '840');
  assert.equal(formatTokens(12_400), '12k');
  assert.equal(formatTokens(1_250_000), '1.3M');
  assert.equal(formatTokens(undefined), '–');
  assert.equal(formatNumber(NaN, 'vi'), '–');
  assert.notEqual(formatNumber(32768, 'vi'), '–');
});

test('tool names become words: the verb, the target, and the kind of work', () => {
  assert.deepEqual(describeTool({ name: 'local.edit_file', args: { path: 'calc.js' } }, 'vi'), { kind: 'edit', verb: 'Sửa tệp', target: 'calc.js' });
  assert.deepEqual(describeTool({ name: 'local.run_command', args: { command: 'node test.js' } }, 'en'), { kind: 'run', verb: 'Run', target: 'node test.js' });
  assert.equal(describeTool({ name: 'local.list_directory', args: {} }, 'vi').verb, 'Xem thư mục');
  assert.equal(describeTool({ name: 'local.read_file', args: { path: 'README.md' } }, 'vi').verb, 'Đọc tệp');
  assert.equal(describeTool({ name: 'vendor.do_something_odd' }, 'vi').verb, 'do_something_odd');
  assert.equal(toolKind('local.update_plan'), 'plan');
  assert.equal(toolKind('local.spawn_workflow'), 'agent');
  assert.equal(toolKind('local.git_status'), 'git');
});

test('a run of tool calls is summarised in one line in either language', () => {
  const items = [{ name: 'local.list_directory' }, { name: 'local.read_file' }, { name: 'local.edit_file' }, { name: 'local.run_command' }, { name: 'local.update_plan' }];
  assert.equal(summarizeTools(items, 'vi'), 'Đọc 2 tệp · sửa 1 tệp · chạy 1 lệnh · 1 thao tác khác');
  assert.equal(summarizeTools(items, 'en'), 'Read 2 · edited 1 · ran 1 command · 1 other');
  assert.equal(summarizeTools([], 'vi'), '0 thao tác');
});

test('approval categories are worded and graded; an unknown category is high risk, never low', () => {
  assert.deepEqual(riskInfo('workspace_edit', 'vi'), { label: 'Sửa tệp trong workspace', level: 'medium', levelLabel: 'Rủi ro trung bình' });
  assert.equal(riskInfo('dangerous', 'en').level, 'high');
  assert.equal(riskInfo('read', 'en').level, 'low');
  assert.equal(riskInfo('something-new', 'en').level, 'high');
  assert.equal(riskInfo('something-new', 'en').label, 'something-new');
});

test('a receipt names what the Hub put in the structured input of the call; the sentence of the event is the last resort', () => {
  const sentence = 'Đang gọi local.move_path.\nTham số: {"source":"a.js","destination":"b.js"}';
  assert.equal(toolTarget({ args: { path: 'src/a.js' }, summary: sentence }), 'src/a.js');
  assert.equal(toolTarget({ args: { command: 'npm test' }, summary: sentence }), 'npm test');
  assert.equal(toolTarget({ args: { source: 'a.js', destination: 'b.js' }, summary: sentence }), 'a.js → b.js', 'a move names both ends');
  assert.equal(toolTarget({ args: { source: 'a.js' }, summary: sentence }), 'a.js');
  assert.equal(toolTarget({ args: { destination: 'b.js' }, summary: sentence }), 'b.js');
  assert.equal(toolTarget({ args: { paths: ['a.js', 'b.js', 'c.js'] }, summary: sentence }), 'a.js, b.js, c.js', 'a batch names its files');
  assert.equal(toolTarget({ args: { path: 'a.js', command: 'node a.js', paths: ['b.js'] }, summary: sentence }), 'a.js', 'a path is named before a command, and a command before a list');
  assert.equal(toolTarget({ args: { command: 'node a.js', source: 'a.js', destination: 'b.js' }, summary: sentence }), 'node a.js');
  assert.equal(toolTarget({ args: { paths: ['a.js'], source: 'x.js', destination: 'y.js' }, summary: sentence }), 'x.js → y.js');
  assert.equal(toolTarget({ args: { path: 'a.js', truncated: true }, summary: sentence }), 'a.js…', 'what the Hub cut is marked as cut');
  assert.equal(toolTarget({ args: { paths: ['a.js', 'b.js'], truncated: true }, summary: sentence }), 'a.js, b.js…');
  assert.equal(toolTarget({ args: { paths: [] }, summary: sentence }), sentence, 'an empty list names nothing');
  assert.equal(toolTarget({ args: {}, summary: sentence }), sentence, 'a call with nothing to announce shows its sentence, as it always did');
  assert.equal(toolTarget({ summary: sentence }), sentence);
  assert.equal(toolTarget({ args: { path: 7 } }), '', 'a path that is not text is no target');
  assert.equal(toolTarget({ args: { cmd: 'ls', query: 'x' }, summary: sentence }), 'ls', 'the keys of older records are still read');
});

test('describeTool puts the structured target next to the verb', () => {
  assert.deepEqual(describeTool({ name: 'local.move_path', args: { source: 'a.js', destination: 'b.js' } }, 'en'), { kind: 'edit', verb: 'Edit file', target: 'a.js → b.js' });
  assert.deepEqual(describeTool({ name: 'local.files_write_batch', args: { paths: ['a.js', 'b.js'] } }, 'vi'), { kind: 'edit', verb: 'Ghi tệp', target: 'a.js, b.js' });
});
