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

// Only the temporary folder this helper made is ever removed.
async function dispose(scratch, prefix) {
  const resolved = await fs.realpath(scratch);
  const temp = await fs.realpath(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith(prefix)) throw new Error('Unsafe bundle cleanup path');
  await fs.rm(resolved, { recursive: true, force: true });
}
