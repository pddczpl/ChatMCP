import test from 'node:test';
import assert from 'node:assert/strict';
import { formatToolOutput } from '../src/lib/tool-output.ts';

test('MCP results display and copy readable text including Vietnamese and line breaks', () => {
  const result = { isError: false, content: [{ type: 'text', text: 'Báo cáo\nDòng thứ hai' }, { type: 'text', text: 'Hoàn tất' }] };
  assert.equal(formatToolOutput(result), 'Báo cáo\nDòng thứ hai\n\nHoàn tất');
  assert.equal(formatToolOutput(JSON.stringify(result)), formatToolOutput(result));
});

test('plain output, falsey values and non-text payloads retain their content', () => {
  assert.equal(formatToolOutput('plain text'), 'plain text');
  assert.equal(formatToolOutput(0), '0');
  assert.equal(formatToolOutput(false), 'false');
  assert.equal(formatToolOutput(undefined), '');
  const mixed = { content: [{ type: 'text', text: 'Screenshot' }, { type: 'image', data: 'fixture' }] };
  assert.equal(formatToolOutput(mixed), JSON.stringify(mixed, null, 2));
});
