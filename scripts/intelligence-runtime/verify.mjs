import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { requiredLicenseFiles } from './notices.mjs';

export const REQUIRED_COMPONENTS = Object.freeze([
  'runtimes/python/python.exe',
  'runtimes/python/python311.dll',
  'runtimes/python/python3.dll',
  'runtimes/python/python311.zip',
  'runtimes/python/python311._pth',
  'runtimes/ripgrep/rg.exe',
  'runtimes/lsp/node_modules/pyright/langserver.index.js',
  'runtimes/lsp/node_modules/typescript-language-server/lib/cli.mjs',
  'runtimes/lsp/node_modules/typescript/lib/typescript.js',
  'runtimes/lsp/node_modules/typescript/lib/tsserver.js',
  'runtimes/lsp/node_modules/web-tree-sitter/tree-sitter.js',
  'grammars/tree-sitter-javascript.wasm',
  'grammars/tree-sitter-typescript.wasm',
  'grammars/tree-sitter-tsx.wasm',
  'grammars/tree-sitter-python.wasm',
]);

export async function verifyRuntime(root) {
  root = path.resolve(root);
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Runtime root must not be a link');
  const canonical = await fs.realpath(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'runtime-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.target !== 'win-x64' || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid runtime manifest');
  const seen = new Set();
  const required = REQUIRED_COMPONENTS;
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !/^[a-zA-Z0-9_@./+\-]+$/.test(entry.path) || entry.path.split('/').some(p => !p || p === '.' || p === '..') || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid manifest entry');
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate manifest path');
    seen.add(key);
    let target = root;
    for (const segment of entry.path.split('/')) {
      target = path.join(target, segment);
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Runtime link rejected');
    }
    const real = await fs.realpath(target);
    const relative = path.relative(canonical, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime boundary escape');
    const bytes = await fs.readFile(real);
    if (bytes.length !== entry.size || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Runtime integrity mismatch: ${entry.path}`);
  }
  // Redistribution notices travel with the bundled code: CPython's LICENSE.txt, tree-sitter-wasms' LICENSE and the MIT notice of each
  // grammar project. A build that staged with CHATMCP_ALLOW_PENDING_NOTICES=1 lists the missing ones in `pendingNotices` and carries
  // licenses/PENDING-NOTICES.txt instead.
  const pendingNotices = Array.isArray(manifest.pendingNotices) ? manifest.pendingNotices : [];
  const licenseFiles = requiredLicenseFiles(pendingNotices);
  for (const file of [...required, ...licenseFiles]) {
    if (!seen.has(file.toLowerCase())) throw new Error('Missing required bundled component: ' + file);
  }
  return { verifiedFiles: seen.size, target: manifest.target, required: required.length + licenseFiles.length, pendingNotices };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node verify.mjs <staged-runtime>');
  console.log(JSON.stringify(await verifyRuntime(process.argv[2])));
}
