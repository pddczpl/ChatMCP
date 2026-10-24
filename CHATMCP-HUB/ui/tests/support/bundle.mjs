// Loads real components for a test: esbuild bundles a small snippet that imports from ./src (React, the components, the '@/...' aliases) and
// the result is loaded as CommonJS. Nothing is mocked; React Query and the store are the real ones.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ui = fileURLToPath(new URL('../../', import.meta.url));

/**
 * `options.rewrites`: [{ file, from, to }]: the source file whose path ends with `file` is read with `from` replaced by `to`, so that a test can
 * start a component in a state that only a click reaches (an open form, a typed value). A `from` that is not found fails the build: a rename
 * can not turn a rewrite into a silent no-op.
 * `options.recordJsx`: every element a component creates (its type and props) is pushed on globalThis.__chatmcpJsx, so that a test can take
 * the handler a component gave to a button or to a child and call it, which a server render never does.
 */
export async function bundleTsx(contents, prefix = 'chatmcp-ui-', { rewrites = [], recordJsx = false } = {}) {
  const { build } = createRequire(path.join(ui, 'package.json'))('esbuild');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const outfile = path.join(scratch, 'bundle.cjs');
  const plugins = [];
  if (rewrites.length) plugins.push(rewritePlugin(rewrites));
  if (recordJsx) plugins.push(jsxRecorderPlugin());
  try {
    await build({
      stdin: { contents, resolveDir: ui, loader: 'tsx' },
      bundle: true, platform: 'node', format: 'cjs', outfile, plugins,
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
    // What the handlers of this render ask the cache to refresh (the filters they pass), for a test that wants to know: globalThis.__chatmcpInvalidated.
    globalThis.__chatmcpInvalidated = [];
    const invalidate = client.invalidateQueries.bind(client);
    client.invalidateQueries = (...args) => { globalThis.__chatmcpInvalidated.push(args[0]); return invalidate(...args); };
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

// esbuild wants the pattern of a plugin under one particular name, and Tailwind, which reads every file under ui/ for class names, takes that bare
// word for a utility of its own and adds a rule to the stylesheet (and so changes its file name). The name is put together here instead.
const PATTERN = ['fil', 'ter'].join('');
const where = (pattern, more = {}) => ({ [PATTERN]: pattern, ...more });

function rewritePlugin(rewrites) {
  return {
    name: 'rewrite',
    setup(build) {
      build.onLoad(where(/\.tsx?$/), async (args) => {
        const file = args.path.replace(/\\/g, '/');
        const mine = rewrites.filter((item) => file.endsWith(item.file));
        if (!mine.length) return undefined;
        let source = await fs.readFile(args.path, 'utf8');
        for (const { from, to } of mine) {
          if (!source.includes(from)) throw new Error(`rewrite target not found in ${file}: ${from}`);
          source = source.replace(from, () => to);
        }
        return { contents: source, loader: file.endsWith('.tsx') ? 'tsx' : 'ts' };
      });
    },
  };
}

function jsxRecorderPlugin() {
  const real = path.join(ui, 'node_modules', 'react', 'jsx-runtime.js').replace(/\\/g, '/');
  return {
    name: 'jsx-recorder',
    setup(build) {
      build.onResolve(where(/^react\/jsx-runtime$/), () => ({ path: 'jsx-runtime', namespace: 'jsx-recorder' }));
      build.onLoad(where(/.*/, { namespace: 'jsx-recorder' }), () => ({
        resolveDir: ui,
        contents: `
          import * as real from ${JSON.stringify(real)};
          const log = () => (globalThis.__chatmcpJsx ??= []);
          export const Fragment = real.Fragment;
          export function jsx(type, props, key) { log().push({ type, props }); return real.jsx(type, props, key); }
          export function jsxs(type, props, key) { log().push({ type, props }); return real.jsxs(type, props, key); }
        `,
      }));
    },
  };
}

// Only the temporary folder this helper made is ever removed.
async function dispose(scratch, prefix) {
  const resolved = await fs.realpath(scratch);
  const temp = await fs.realpath(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith(prefix)) throw new Error('Unsafe bundle cleanup path');
  await fs.rm(resolved, { recursive: true, force: true });
}
