// Stages the MCP SDK runtime (the client, and the server with its Node adapter for the Hub's MCP server) for the installer: node stage.mjs <new-destination>
//
// Run after `npm ci --ignore-scripts` in this folder (Build-Installer.ps1 does both). Copies every package of package-lock.json (and only
// those: never an arbitrary developer node_modules, never another tool's copy) from ./node_modules into <destination>/node_modules, the
// vendored licence texts of what the client compiles in (licenses/) into <destination>/licenses/bundled, and writes
// <destination>/mcp-runtime-manifest.json with the size and SHA-256 of every file. The installer copies the destination to
// DATGOLD-HUB/runtimes/mcp, where lib/mcp/sdk.mjs (client) and lib/mcp/server-sdk.mjs (server) find it. verify.mjs checks a staged copy against the manifest.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MANIFEST_FILE, REQUIRED_FILES, readBundledNotices } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export async function stageMcpRuntime(destination, { source = here } = {}) {
  destination = path.resolve(destination);
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(source, 'package-lock.json'), 'utf8'));
  // A new destination is mandatory: never merge with stale or untrusted staged files.
  await fs.mkdir(destination, { recursive: false });
  const files = [];
  async function copy(from, relative) {
    const stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(from)).sort()) await copy(path.join(from, name), `${relative}/${name}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported artifact: ${relative}`);
    const bytes = await fs.readFile(from);
    const target = path.join(destination, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
    files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
  }
  const packages = [];
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath) continue;
    if (!packagePath.startsWith('node_modules/') || entry.dev || entry.link) throw new Error(`Unexpected lockfile entry: ${packagePath}`);
    if (!entry.version || !entry.integrity || !entry.resolved?.startsWith('https://registry.npmjs.org/')) throw new Error(`Unpinned runtime dependency: ${packagePath}`);
    if (!entry.license) throw new Error(`Missing licence in the lockfile: ${packagePath}`);
    const folder = path.join(source, ...packagePath.split('/'));
    const metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
    if (metadata.version !== entry.version) throw new Error(`Runtime package version mismatch: ${packagePath} is ${metadata.version}, the lockfile says ${entry.version}`);
    const notices = (await fs.readdir(folder)).filter((name) => /^(licen[cs]e|copying|notice)/i.test(name));
    if (notices.length === 0) throw new Error(`The package ships no licence text: ${packagePath}`);
    packages.push({ path: packagePath, name: metadata.name, version: entry.version, license: entry.license, integrity: entry.integrity, notices });
    await copy(folder, packagePath);
  }
  for (const name of Object.keys(manifest.dependencies)) {
    if (!packages.some((item) => item.path === `node_modules/${name}`)) throw new Error(`Required runtime dependency missing: ${name}`);
  }
  const bundled = await readBundledNotices(source);
  for (const notice of bundled) await copy(path.join(source, 'licenses', ...notice.file.split('/')), `licenses/bundled/${notice.file}`);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const required of REQUIRED_FILES) if (!files.some((file) => file.path === required)) throw new Error(`Staged runtime lacks ${required}`);
  const record = {
    schemaVersion: 1,
    name: 'datgold-mcp-runtime',
    client: manifest.dependencies['@modelcontextprotocol/client'],
    server: manifest.dependencies['@modelcontextprotocol/server'],
    node: manifest.dependencies['@modelcontextprotocol/node'],
    packages,
    bundled: bundled.map(({ name, version, license, file, sha256 }) => ({ name, version, license, file: `licenses/bundled/${file}`, sha256 })),
    files,
  };
  await fs.writeFile(path.join(destination, MANIFEST_FILE), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  return { destination, packages: packages.length, bundled: bundled.length, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node stage.mjs <new-destination>');
  console.log(JSON.stringify(await stageMcpRuntime(process.argv[2])));
}
