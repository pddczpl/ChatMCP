import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The real component that ConversationView shows under a task, rendered for each source of the context budget.
const ui = fileURLToPath(new URL('../', import.meta.url));
const requireUi = createRequire(path.join(ui, 'package.json'));
const { build } = requireUi('esbuild');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-context-notice-'));
try {
  const bundle = path.join(scratch, 'notice.cjs');
  await build({
    stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { ContextPolicyNotice } from './src/components/conversation/ContextPolicyNotice';
      export const render = policy => renderToStaticMarkup(React.createElement(ContextPolicyNotice, { policy }));
    `, resolveDir: ui, loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    tsconfig: path.join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const { render } = createRequire(import.meta.url)(bundle);
  const fallback = { source: 'conservative_fallback', capacityTokens: 32768, maxHistoryTokens: 15274, compactAtTokens: 12524, reservedOutputTokens: 16384, plannedOutputTokens: 8192, approximate: true };

  await test('an unknown context window is a visible warning that names the fix, not a muted "estimated"', () => {
    const html = render(fallback);
    assert.match(html, /data-testid="context-window-warning"/);
    assert.match(html, /role="status"/);
    assert.match(html, /Context window unknown/);
    assert.match(html, /32,768/);
    assert.match(html, /AI Model tab/, 'it names where the fix is');
    assert.match(html, /context window/i);
    assert.match(html, /text-amber-/, 'it is styled as a warning');
    assert.doesNotMatch(html, /\(estimated\)/, 'the old muted chip is gone');
  });

  await test('a configured window shows its size and where it came from, without a warning', () => {
    const html = render({ ...fallback, source: 'provider_configuration', capacityTokens: 200000, reservedOutputTokens: 16384, plannedOutputTokens: 16384 });
    assert.match(html, /200,000/);
    assert.match(html, /configured/);
    assert.doesNotMatch(html, /context-window-warning|unknown/i);
  });

  await test('a window from model metadata is labelled as such', () => {
    const html = render({ ...fallback, source: 'trusted_model_metadata', capacityTokens: 128000 });
    assert.match(html, /128,000/);
    assert.match(html, /model metadata/);
    assert.doesNotMatch(html, /context-window-warning/);
  });

  await test('the tooltip tells the output cap from the history plan', () => {
    const html = render(fallback);
    assert.match(html, /16,384/);
    assert.match(html, /8,192/);
  });
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
