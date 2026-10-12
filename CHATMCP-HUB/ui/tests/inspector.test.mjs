import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Render the current TypeScript components, with real React Query cache entries
// shaped like the Hub APIs. This deliberately does not load the legacy web UI.
const ui = fileURLToPath(new URL('../', import.meta.url));
const requireUi = createRequire(path.join(ui, 'package.json'));
const { build } = requireUi('esbuild');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-inspector-'));
try {
  const bundle = path.join(scratch, 'inspector.cjs');
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { useAppStore } from './src/store/useAppStore';
        import { InspectorPanel } from './src/components/inspector/InspectorPanel';
        import { PlanTab } from './src/components/inspector/PlanTab';
        import { ActivityTab } from './src/components/inspector/ActivityTab';
        import { FilesTab } from './src/components/inspector/FilesTab';
        import { GitTab } from './src/components/inspector/GitTab';
        import { TerminalTab } from './src/components/inspector/TerminalTab';
        import { SettingsTab } from './src/components/inspector/SettingsTab';
        import { Header } from './src/components/layout/Header';
        const components = { InspectorPanel, PlanTab, ActivityTab, FilesTab, GitTab, TerminalTab, Header, SettingsTab };
        export async function render(name, entries, errors = [], store = {}) {
          const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
          Object.assign(useAppStore.getInitialState(), { selectedTaskId: 'task-1', lang: 'en', activeTab: 'activity', ...store });
          for (const [key, data] of entries) client.setQueryData(key, data);
          for (const [key, message] of errors) {
            await client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => Promise.reject(new Error(message)) }).catch(() => {});
          }
          const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(components[name])));
          client.clear();
          return html;
        }
      `,
      resolveDir: ui,
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    tsconfig: path.join(ui, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const { render } = createRequire(import.meta.url)(bundle);
  const hub = { workspace: { path: '/fixture' }, tasks: [], logs: ['Hub connected'], agent: { tasks: [] } };
  const base = [[['hubState'], hub]];
  await test('empty plan never invents completed work', async () => {
    const html = await render('PlanTab', [...base, [['plan', 'task-1'], { title: '', items: [] }]]);
    assert.match(html, /No plan yet/);
    assert.doesNotMatch(html, /100%|Read &amp; analyze|Safely execute/);
  });
  await test('plan progress and evidence come from the plan endpoint', async () => {
    const html = await render('PlanTab', [...base, [['plan', 'task-1'], { title: 'Repair calculator', items: [
      { text: 'Inspect calculator', status: 'done', evidence: 'Read calc.js' },
      { text: 'Repair addition', status: 'doing' },
      { text: 'Verify tests', status: 'blocked', evidence: 'One test fails' },
    ] }]]);
    assert.match(html, /Repair calculator/);
    assert.match(html, /33%/);
    assert.match(html, /Read calc.js/);
    assert.match(html, /One test fails/);
  });
  await test('plan request failure is visible', async () => {
    const html = await render('PlanTab', base, [[['plan', 'task-1'], 'Plan unavailable']]);
    assert.match(html, /role="alert"/);
    assert.match(html, /Plan unavailable/);
    assert.doesNotMatch(html, /100%/);
  });
  await test('agent-reported done without evidence is not verified plan progress', async () => {
    const html = await render('PlanTab', [...base, [['plan', 'task-1'], { title: 'Verify project', items: [
      { text: 'Run tests', status: 'done', evidence: '' },
      { text: 'Review change', status: 'done', evidence: '   ' },
    ] }]]);
    assert.doesNotMatch(html, /100%|text-emerald-400/);
    assert.match(html, /0%/);
    assert.match(html, /Agent reports done.*no evidence/i);
    assert.match(html, /2.*agent-reported/i);
  });
  await test('a new conversation does not display another task plan', async () => {
    const html = await render('PlanTab', [...base, [['plan', 'task-1'], { title: 'Older plan', items: [{ text: 'Older work', status: 'done' }] }]], [], { selectedTaskId: '' });
    assert.match(html, /No plan yet/);
    assert.doesNotMatch(html, /Older work|100%/);
  });

  await test('verification UI separates command exit zero from test assertion evidence', async () => {
    const html = await render('PlanTab', [
      ...base,
      [['plan', 'task-1'], { title: '', items: [] }],
      [['verification-evidence', 'task-1'], { runs: [{
        id: 'e1', command: 'npm test', status: 'completed', exitCode: 0, testOutcomeVerified: false, snapshotHash: 'a'.repeat(64),
      }] }],
    ]);
    assert.match(html, /Command succeeded.*tests unverified/i);
    assert.doesNotMatch(html, /Verified check evidence/);
  });
  await test('no isolated worker test grants appear without a running managed worker', async () => {
    const html = await render('PlanTab', [
      ...base,
      [['plan','task-1'],{title:'Review safe changes',items:[]}],
      [['coding-runs'],{activeRunId:null,jobs:[]}],
    ]);
    assert.doesNotMatch(html,/Owner-approved isolated checks/);
  });
  await test('activity displays actual selected task events', async () => {
    const html = await render('ActivityTab', [...base, [['task', 'task-1'], { id: 'task-1', events: [
      { type: 'tool_error', toolName: 'run_command', status: 'error', message: 'Test exited 1', at: '2026-10-12T10:00:00Z' },
    ] }]]);
    assert.match(html, /run_command/);
    assert.match(html, /Test exited 1/);
  });
  await test('files displays actual Git changes', async () => {
    const html = await render('FilesTab', [...base, [['gitStatus', '/fixture'], { branch: 'main', dirty: true, entries: [' M src/calc.js', '?? test.js'] }]]);
    assert.match(html, /calc.js/);
    assert.match(html, /test.js/);
  });
  await test('Git failures cannot be reported as a clean workspace', async () => {
    const html = await render('GitTab', [...base, [['checkpointsList', '/fixture'], []]], [[['gitStatus', '/fixture'], 'Not a Git repository']]);
    assert.match(html, /Not a Git repository/);
    assert.doesNotMatch(html, /Working tree clean/);
  });
  await test('Git displays actual working tree diff', async () => {
    const html = await render('GitTab', [...base,
      [['gitStatus', '/fixture'], { branch: 'fix/calc', dirty: true, entries: [' M calc.js'] }],
      [['checkpointsList', '/fixture'], []],
      [['gitDiff', '/fixture', false], { diff: '-return a-b;\n+return a+b;', staged: false }],
    ]);
    assert.match(html, /return a\+b/);
    assert.match(html, /fix\/calc/);
  });
  await test('terminal displays session output and exit status, not Hub logs', async () => {
    const html = await render('TerminalTab', [...base, [['terminals', '/fixture'], [{ id: 'term-1', command: 'npm test', status: 'failed', exitCode: 1, logs: [{ seq: 1, type: 'stderr', message: 'Expected 5, received -1' }] }]]]);
    assert.match(html, /npm test/);
    assert.match(html, /Expected 5, received -1/);
    assert.match(html, /Exit: 1/);
    assert.doesNotMatch(html, /Hub connected/);
  });
  for (const [component, key, message] of [
    ['FilesTab', ['gitStatus', '/fixture'], 'Git access denied'],
    ['TerminalTab', ['terminals', '/fixture'], 'Terminal unavailable'],
    ['ActivityTab', ['task', 'task-1'], 'Task not found'],
    ['GitTab', ['checkpointsList', '/fixture'], 'Checkpoint storage unavailable'],
  ]) {
    await test(`${component} shows its API error instead of an empty success`, async () => {
      const html = await render(component, base, [[key, message]]);
      assert.match(html, /role="alert"/);
      assert.ok(html.includes(message));
    });
  }
  await test('Skills tab renders the connected registry UI', async () => {
    const html = await render('InspectorPanel', base, [], { activeTab: 'skills' });
    assert.match(html, /GitHub Agent Skills Hub/);
  });
  await test('Header does not claim a disconnected Hub is connected', async () => {
    const html = await render('Header', [], [[['hubState'], 'Connection refused']]);
    assert.match(html, /Hub disconnected/i);
    assert.doesNotMatch(html, />Hub connected</i);
  });
  await test('SettingsTab renders honest unisolated host backend without false safe badge', async () => {
    const sandboxReport = {
      mode: 'host',
      backend: 'host',
      available: true,
      osIsolated: false,
      platform: 'win32',
      workspaceRoot: '/fixture',
      enforcedLimits: ['timeoutSeconds', 'maxOutputBytes'],
      unsupportedLimits: ['maxMemoryMb', 'maxCpuCores'],
      reasons: ['Host execution shares the host OS kernel and user account credentials'],
    };
    const html = await render('SettingsTab', [...base, [['sandboxStatus'], sandboxReport]]);
    assert.match(html, /Host Unisolated|Không cách ly OS/);
    assert.match(html, /timeoutSeconds, maxOutputBytes/);
    assert.match(html, /maxMemoryMb, maxCpuCores/);
    assert.doesNotMatch(html, /OS Isolated|Đã cách ly OS/);
  });
  await test('SettingsTab renders probing state when sandbox status is loading', async () => {
    const html = await render('SettingsTab', base);
    assert.match(html, /Probing\.\.\.|Đang kiểm tra\.\.\./);
  });
  await test('SettingsTab renders unavailable state when backend reports unavailable', async () => {
    const unavailableReport = {
      mode: 'windows-sandbox',
      backend: 'windows-sandbox',
      available: false,
      osIsolated: true,
      platform: 'win32',
      enforcedLimits: [],
      unsupportedLimits: [],
      reasons: ['Windows Sandbox provider is unavailable'],
    };
    const html = await render('SettingsTab', [...base, [['sandboxStatus'], unavailableReport]]);
    assert.match(html, /Unavailable|Không khả dụng/);
    assert.doesNotMatch(html, /OS Isolated|Đã cách ly OS/);
  });
  await test('SettingsTab renders verified state only when osIsolated and available are both true', async () => {
    const verifiedReport = {
      mode: 'windows-sandbox',
      backend: 'windows-sandbox',
      available: true,
      osIsolated: true,
      platform: 'win32',
      enforcedLimits: ['timeoutSeconds', 'maxMemoryMb'],
      unsupportedLimits: [],
      reasons: [],
    };
    const html = await render('SettingsTab', [...base, [['sandboxStatus'], verifiedReport]]);
    assert.match(html, /OS Isolated|Đã cách ly OS/);
    assert.doesNotMatch(html, /Host Unisolated|Không cách ly OS/);
  });
} finally {
  const resolved = await fs.realpath(scratch);
  const temp = await fs.realpath(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('chatmcp-inspector-')) throw new Error('Unsafe inspector test cleanup path');
  await fs.rm(resolved, { recursive: true, force: true });
}
