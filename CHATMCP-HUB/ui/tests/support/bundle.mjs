// Loads real components for a test: esbuild bundles a small snippet that imports from ./src (React, the components, the '@/...' aliases) and
// the result is loaded as CommonJS. Nothing is mocked; React Query and the store are the real ones.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ui = fileURLToPath(new URL('../../', import.meta.url));

export async function bundleTsx(contents, prefix = 'chatmcp-ui-') {
  const { build } = createRequire(path.join(ui, 'package.json'))('esbuild');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const outfile = path.join(scratch, 'bundle.cjs');
  try {
    await build({
      stdin: { contents, resolveDir: ui, loader: 'tsx' },
      bundle: true, platform: 'node', format: 'cjs', outfile,
      tsconfig: path.join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    });
  } catch (error) {
    await dispose(scratch, prefix);
    throw error;
  }
  const loaded = createRequire(import.meta.url)(outfile);
  return { loaded, dispose: () => dispose(scratch, prefix) };
}

/**
 * The start of a bundled snippet that renders components on the server with real React Query cache entries shaped like the Hub's answers.
 * renderWith(Component, props, entries, errors, store, drafts): `entries` seed the cache, `errors` are [key, message] pairs that put a
 * query in its error state, `store` overrides the app store (language, selected workspace ...) and `drafts` the Agents drafts. The server
 * render reads each store's initial state, so that is what is set; every call starts from the same defaults.
 */
export const renderPrelude = `
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { useAppStore } from './src/store/useAppStore';
  import { useAgentDrafts } from './src/store/useAgentDrafts';
  const appDefaults = { selectedTaskId: '', selectedWorkspacePath: '', lang: 'vi', activeTab: 'plan' };
  export async function renderWith(Component, props = {}, entries = [], errors = [], store = {}, drafts = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
    Object.assign(useAppStore.getInitialState(), appDefaults, store);
    Object.assign(useAgentDrafts.getInitialState(), useAgentDrafts.getInitialState().defaults(), drafts);
    for (const [key, data] of entries) client.setQueryData(key, data);
    for (const [key, message] of errors) {
      await client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => Promise.reject(new Error(message)) }).catch(() => {});
    }
    const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Component, props)));
    client.clear();
    return html;
  }
`;

// Only the temporary folder this helper made is ever removed.
async function dispose(scratch, prefix) {
  const resolved = await fs.realpath(scratch);
  const temp = await fs.realpath(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith(prefix)) throw new Error('Unsafe bundle cleanup path');
  await fs.rm(resolved, { recursive: true, force: true });
}
