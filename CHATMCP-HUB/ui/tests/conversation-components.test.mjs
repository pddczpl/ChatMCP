import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const result = await build({
  stdin: {
    contents: `import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { PhaseRibbon } from './src/components/layout/PhaseRibbon';
      import { StateBanner } from './src/components/conversation/StateBanner';
      import { ApprovalStack } from './src/components/approval/ApprovalStack';
      export const phase = props => renderToStaticMarkup(React.createElement(PhaseRibbon, props));
      export const banner = props => renderToStaticMarkup(React.createElement(StateBanner, props));
      export const approval = props => renderToStaticMarkup(React.createElement(ApprovalStack, props));`,
    resolveDir: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    loader: 'tsx',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  define: { 'process.env.NODE_ENV': '"production"' },
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { phase, banner, approval } = compiled.exports;

test('completed model response does not certify unobserved plan, edits or verification', () => {
  const html = phase({ task: { id: 'one', status: 'completed', messages: [] } });
  assert.doesNotMatch(html, /Chạy test &amp; lint/);
  assert.match(html, /phản hồi/i);
});

test('running state exposes Stop and does not display an error banner', () => {
  assert.match(phase({ task: { id: 'one', status: 'running', messages: [] }, onCancel() {} }), /Dừng agent/);
  assert.equal(banner({ status: 'running' }), '');
});

test('cancelled run can be continued in the same conversation', () => {
  const html = banner({ status: 'cancelled', onResume() {} });
  assert.match(html, /Tiếp tục/);
  assert.doesNotMatch(html, /Đã có lỗi xảy ra/);
});

test('approval review includes structured command, reason, expiry and tool identity', () => {
  const html = approval({ approvals: [{ id: 'a', taskId: 'one', tool: 'local.run_command', description: 'Verify project', risk: 'execute', reason: 'Host shell execution', command: 'npm test', expiresAt: '2099-01-01T00:00:00Z' }], onApprove() {}, onDeny() {} });
  assert.match(html, /local.run_command/);
  assert.match(html, /Host shell execution/);
  assert.match(html, /npm test/);
  assert.match(html, /Hết hạn/);
});

test('expired approval cannot be approved', () => {
  const html = approval({ approvals: [{ id: 'a', tool: 'local.write_file', description: 'Write file', risk: 'workspace_edit', expiresAt: '2000-01-01T00:00:00Z' }], onApprove() {}, onDeny() {} });
  assert.match(html, /Đã hết hạn/);
  assert.doesNotMatch(html, /<button[^>]*(?<!disabled="")>[^<]*Phê duyệt/);
  assert.match(html, /disabled=""/);
});
