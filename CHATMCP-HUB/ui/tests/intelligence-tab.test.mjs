import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The Model settings tab (global connection), rendered with a React Query cache shaped like GET /api/state.
const ui = fileURLToPath(new URL('../', import.meta.url));
const requireUi = createRequire(path.join(ui, 'package.json'));
const { build } = requireUi('esbuild');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-intelligence-tab-'));
try {
  const bundle = path.join(scratch, 'tab.cjs');
  await build({
    stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { useAppStore } from './src/store/useAppStore';
      import { IntelligenceTab } from './src/components/inspector/IntelligenceTab';
      export function render(ai) {
        Object.assign(useAppStore.getInitialState(), { lang: 'en' });
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        client.setQueryData(['hubState'], { ai, agent: { tasks: [] } });
        client.setQueryData(['aiProfiles'], { profiles: [], defaultProfileId: null });
        const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(IntelligenceTab)));
        client.clear();
        return html;
      }
    `, resolveDir: ui, loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    tsconfig: path.join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const { render } = createRequire(import.meta.url)(bundle);
  const connection = { preset: 'custom-openai', provider: 'gateway', protocol: 'openai-chat', model: 'local-model', apiBaseUrl: 'https://gw.example/v1', configured: true, customHeaders: [] };

  await test('the global connection form has a context window field', () => {
    const html = render({ ...connection, contextWindowTokens: null });
    assert.match(html, /aria-label="Context window tokens"/);
    assert.match(html, /4,096 - 2,000,000/);
  });

  const hint = (html) => /data-testid="context-window-hint"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';

  await test('an unknown window is said to be unknown and what that costs', () => {
    const text = hint(render({ ...connection, contextWindowTokens: null }));
    assert.match(text, /unknown/i);
    assert.match(text, /conservative estimate/i);
    assert.match(text, /warning/i);
  });

  await test('a known window does not claim to be unknown', () => {
    assert.doesNotMatch(hint(render({ ...connection, contextWindowTokens: 64000 })), /unknown/i);
  });

  await test('a saved window is shown in the field', () => {
    const html = render({ ...connection, contextWindowTokens: 64000 });
    assert.match(html, /value="64000"/);
  });
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
