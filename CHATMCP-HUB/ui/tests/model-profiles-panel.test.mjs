import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The real component, rendered with a React Query cache shaped like GET /api/ai/profiles.
const ui = fileURLToPath(new URL('../', import.meta.url));
const requireUi = createRequire(path.join(ui, 'package.json'));
const { build } = requireUi('esbuild');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-profiles-panel-'));
try {
  const bundle = path.join(scratch, 'panel.cjs');
  await build({
    stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { ModelProfilesPanel } from './src/components/inspector/ModelProfilesPanel';
      export function render(profiles) {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        client.setQueryData(['aiProfiles'], { profiles, defaultProfileId: profiles[0]?.id ?? null });
        const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(ModelProfilesPanel)));
        client.clear();
        return html;
      }
    `, resolveDir: ui, loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    tsconfig: path.join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const { render } = createRequire(import.meta.url)(bundle);
  const tenant = {
    id: 'tenant', name: 'Tenant', provider: 'anthropic', protocol: 'anthropic', model: 'claude-x', apiBaseUrl: 'https://gw.example.com',
    hasKey: true, isDefault: true, customPath: '/proxy/{model}/messages',
    customHeaders: [{ name: 'X-Tenant', source: 'protected' }, { name: 'X-Region', source: 'environment', envKeyName: 'CHATMCP_REGION' }],
  };

  await test('the form has a custom path and a custom headers field', () => {
    const html = render([]);
    assert.match(html, /aria-label="Model profile custom path"/);
    assert.match(html, /aria-label="Model profile custom headers JSON"/);
    assert.match(html, /aria-label="Model profile context window"/);
  });

  await test('a saved profile lists its path and the NAMES of its headers, with where each value comes from', () => {
    const html = render([tenant]);
    assert.match(html, /\/proxy\/\{model\}\/messages/);
    assert.match(html, /X-Tenant/);
    assert.match(html, /X-Region/);
    assert.match(html, /CHATMCP_REGION/);
    assert.match(html, /protected/i);
  });

  await test('the context window field says what is accepted', () => {
    const html = render([]);
    assert.match(html, /4,096/);
    assert.match(html, /2,000,000/);
  });
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
