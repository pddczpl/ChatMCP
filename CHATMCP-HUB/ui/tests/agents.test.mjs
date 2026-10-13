import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ui = fileURLToPath(new URL('../', import.meta.url));
const requireUi = createRequire(path.join(ui, 'package.json'));
const { build } = requireUi('esbuild');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-agents-'));
try {
  const bundle = path.join(scratch, 'agents.cjs');
  await build({
    stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { OrchestratorTab } from './src/components/inspector/OrchestratorTab';
      export function render(entries) {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        for (const [key, data] of entries) client.setQueryData(key, data);
        const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(OrchestratorTab)));
        client.clear();
        return html;
      }
    `, resolveDir: ui, loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    tsconfig: path.join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const { render } = createRequire(import.meta.url)(bundle);
  const base = [
    [['codingWorkers'], { activeRunId: null, jobs: [] }],
    [['coding-runs'], { activeRunId: null, jobs: [] }],
    [['delegates'], { last: null }],
  ];
  await test('an active analysis is visible and cannot start a second run after reopening Agents', () => {
    const html = render([...base, [['dynamic-delegates'], { activeRunId: 'run-1', last: { status: 'running', workers: [] } }]]);
    assert.match(html, /disabled="">Đang phân tích…<\/button>/);
    assert.match(html, /Dừng phân tích/);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /Bắt đầu phân tích/);
  });
  await test('failed analysis retains the actual error and understandable worker status', () => {
    const html = render([...base, [['dynamic-delegates'], { activeRunId: null, last: {
      status: 'needs_attention', error: 'Provider unavailable', workers: [{ id: 'audit-1', role: 'reviewer', status: 'failed', error: 'No evidence available' }],
    } }]]);
    assert.match(html, /Cần bạn kiểm tra/);
    assert.match(html, /Rà soát/);
    assert.match(html, /Không hoàn tất/);
    assert.match(html, /role="alert"[^>]*>Provider unavailable/);
    assert.match(html, /No evidence available/);
  });
  await test('plain-language coding results keep publishing locked until the diff is reviewed', () => {
    const jobs = [{ id: 'run-1', status: 'ready_for_review', workers: [{
      id: 'task-a', status: 'ready_for_review', branch: 'coding/task-a', changedFiles: ['calc.js'],
      verifyRequired: true, summary: 'AI says the task is complete.',
      verificationAttempts: [{ id: 'attempt-1', checkId: 'test-1', status: 'completed', exitCode: 0, testOutcomeVerified: false }],
    }] }];
    const html = render([
      [['codingWorkers'], { activeRunId: null, jobs }], [['coding-runs'], { activeRunId: null, jobs }],
      [['delegates'], { last: null }], [['dynamic-delegates'], { activeRunId: null, last: null }],
    ]);
    assert.match(html, /disabled="">Tạo bản nháp trên GitHub<\/button>/);
    assert.match(html, /disabled="">Gộp các công việc đã chọn<\/button>/);
    assert.match(html, /disabled="">Đưa bản gộp lên GitHub<\/button>/);
    assert.match(html, /AI báo hoàn tất chưa có nghĩa là kiểm thử đã đạt/);
    assert.match(html, /Chưa có bằng chứng xác minh kiểm thử đạt/);
    assert.doesNotMatch(html, /Kết quả kiểm thử đạt đã được xác minh/);
    assert.match(html, /Xem thay đổi/);
  });
} finally {
  const resolved = await fs.realpath(scratch);
  const temp = await fs.realpath(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('chatmcp-agents-')) throw new Error('Unsafe agents test cleanup path');
  await fs.rm(resolved, { recursive: true, force: true });
}
