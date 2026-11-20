// Checks a staged MCP client runtime (stage.mjs) file by file: node verify.mjs <staged-runtime>
//
// Every file the manifest names must be there with its size and SHA-256, inside the folder, without a link on its way; no file may be
// there that the manifest does not name; the client must be the pinned version; every package must carry its licence text; and the
// vendored texts of what the client compiles in must be the ones of licenses/MANIFEST.json, byte for byte.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_FILE = 'mcp-runtime-manifest.json';
export const CLIENT_VERSION = '2.4.0';
export const REQUIRED_FILES = Object.freeze([
  'node_modules/@modelcontextprotocol/client/package.json',
  'node_modules/@modelcontextprotocol/client/dist/index.mjs',
  'node_modules/@modelcontextprotocol/client/dist/stdio.mjs',
  'node_modules/@modelcontextprotocol/client/LICENSE',
  'node_modules/@modelcontextprotocol/core/package.json',
  'node_modules/cross-spawn/package.json',
]);
const SAFE_PATH = /^[a-zA-Z0-9_@./+\-]+$/;

/** The vendored licence texts of licenses/MANIFEST.json, each checked against its SHA-256. */
export async function readBundledNotices(source = here) {
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'licenses', 'MANIFEST.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error('licenses/MANIFEST.json is not a list of packages');
  for (const notice of manifest.packages) {
    if (!SAFE_PATH.test(notice.file) || notice.file.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Bad vendored licence path: ${notice.file}`);
    const bytes = await fs.readFile(path.join(source, 'licenses', ...notice.file.split('/'))).catch(() => null);
    if (!bytes || bytes.length === 0) throw new Error(`Missing vendored licence text: licenses/${notice.file}`);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== notice.sha256) throw new Error(`Vendored licence text differs from its manifest entry: licenses/${notice.file}`);
  }
  return manifest.packages;
}

async function listFiles(root, relative = '') {
  const found = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Runtime link rejected: ${child}`);
    if (entry.isDirectory()) found.push(...await listFiles(root, child));
    else if (entry.isFile()) found.push(child);
    else throw new Error(`Unexpected runtime entry: ${child}`);
  }
  return found;
}

export async function verifyMcpRuntime(root, { source = here } = {}) {
  root = path.resolve(root);
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Runtime root must not be a link');
  const canonical = await fs.realpath(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_FILE), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.name !== 'datgold-mcp-runtime' || !Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.packages)) throw new Error('Invalid MCP runtime manifest');
  if (manifest.client !== CLIENT_VERSION) throw new Error(`The staged MCP client is ${manifest.client}, this build pins ${CLIENT_VERSION}`);
  const seen = new Map();
  let bytes = 0;
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !SAFE_PATH.test(entry.path) || entry.path.split('/').some((part) => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid manifest entry');
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate manifest path');
    seen.set(key, entry);
    let target = root;
    for (const segment of entry.path.split('/')) {
      target = path.join(target, segment);
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Runtime link rejected');
    }
    const real = await fs.realpath(target);
    const relative = path.relative(canonical, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime boundary escape');
    const content = await fs.readFile(real);
    if (content.length !== entry.size || crypto.createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error(`Runtime integrity mismatch: ${entry.path}`);
    bytes += content.length;
  }
  for (const file of await listFiles(root)) {
    if (file === MANIFEST_FILE) continue;
    if (!seen.has(file.toLowerCase())) throw new Error(`File not in the runtime manifest: ${file}`);
  }
  for (const required of REQUIRED_FILES) if (!seen.has(required.toLowerCase())) throw new Error(`Missing required MCP runtime file: ${required}`);
  const client = JSON.parse(await fs.readFile(path.join(root, 'node_modules', '@modelcontextprotocol', 'client', 'package.json'), 'utf8'));
  if (client.version !== CLIENT_VERSION) throw new Error(`The staged MCP client package is ${client.version}, this build pins ${CLIENT_VERSION}`);
  for (const item of manifest.packages) {
    if (!Array.isArray(item.notices) || item.notices.length === 0 || item.notices.some((name) => !seen.has(`${item.path}/${name}`.toLowerCase()))) throw new Error(`The staged package carries no licence text: ${item.path}`);
  }
  const bundled = await readBundledNotices(source);
  for (const notice of bundled) {
    const staged = seen.get(`licenses/bundled/${notice.file}`.toLowerCase());
    if (!staged || staged.sha256 !== notice.sha256) throw new Error(`Staged licence text of the bundled ${notice.name} ${notice.version} is missing or differs from the vendored one`);
  }
  return { verifiedFiles: seen.size, packages: manifest.packages.length, bundledNotices: bundled.length, bytes, client: client.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node verify.mjs <staged-runtime>');
  console.log(JSON.stringify(await verifyMcpRuntime(process.argv[2])));
}
