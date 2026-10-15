import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Parser, Language } from 'web-tree-sitter';

const here = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(process.argv[2] || path.join(here, '../../deploy/.generated/intelligence-runtime'));
const dependencies = JSON.parse(await fs.readFile(path.join(here, 'package.json'), 'utf8')).dependencies;
const lock = JSON.parse(await fs.readFile(path.join(here, 'package-lock.json'), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// A new destination is mandatory: never merge with stale or untrusted staged files.
await fs.mkdir(destination, { recursive: false });
const files = [];
async function copy(source, relative) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${relative}`);
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(source)).sort()) await copy(path.join(source, name), `${relative}/${name}`);
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported artifact: ${relative}`);
  const bytes = await fs.readFile(source);
  const target = path.join(destination, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: 'wx' });
  files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
}
// Only packages present in the lockfile are eligible for distribution.
// This includes transitive dependencies instead of copying an arbitrary
// developer node_modules directory or relying on globally installed tools.
const packages = [];
for (const [packagePath, entry] of Object.entries(lock.packages)) {
  if (!packagePath.startsWith('node_modules/')) continue;
  if (!entry.version || !entry.integrity ||
      !entry.resolved?.startsWith('https://registry.npmjs.org/')) {
    throw new Error('Unpinned runtime dependency: ' + packagePath);
  }
  const directory = path.join(here, packagePath);
  try { await fs.lstat(directory); }
  catch (error) {
    if (entry.optional && Array.isArray(entry.os) && !entry.os.includes('win32')) continue;
    throw error;
  }
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.version !== entry.version) throw new Error('Runtime package version mismatch: ' + packagePath);
  const noticeFiles = (await fs.readdir(directory)).filter(n => /^(license|copying|notice)/i.test(n));
  if (!metadata.license && !entry.license && noticeFiles.length === 0) {
    throw new Error('Missing redistribution license metadata: ' + packagePath);
  }
  packages.push({
    path: packagePath, name: metadata.name, version: entry.version,
    source: entry.resolved, integrity: entry.integrity,
    license: metadata.license || entry.license || 'see packaged notices',
  });
  if (packagePath === 'node_modules/tree-sitter-wasms') {
    for (const language of ['javascript', 'typescript', 'tsx', 'python']) {
      await copy(path.join(directory, 'out', 'tree-sitter-' + language + '.wasm'),
        'grammars/tree-sitter-' + language + '.wasm');
    }
    for (const notice of noticeFiles) {
      await copy(path.join(directory, notice), 'licenses/tree-sitter-wasms/' + notice);
    }
  } else {
    await copy(directory, 'runtimes/lsp/' + packagePath.replaceAll('\\', '/'));
  }
}
for (const name of Object.keys(dependencies)) {
  if (!packages.some(p => p.path === 'node_modules/' + name)) {
    throw new Error('Required bundled dependency missing: ' + name);
  }
}
await Parser.init();
const grammars = [];
for (const name of ['javascript', 'typescript', 'tsx', 'python']) {
  const language = await Language.load(path.join(destination, 'grammars', `tree-sitter-${name}.wasm`));
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(name === 'python' ? 'def probe():\n  return 1\n' : name === 'tsx' ? 'const Probe = () => <div />;' : 'function probe() { return 1; }');
    try {
      if (tree.rootNode.hasError) throw new Error(`Grammar probe failed: ${name}`);
      grammars.push({ name, abi: language.abiVersion, tested: true });
    } finally { tree.delete(); }
  } finally { parser.delete(); }
}
// Python is staged from a fixed official artifact, not a system interpreter.
if (process.platform !== 'win32') throw new Error('win-x64 embedded Python staging requires Windows.');
const pythonOutput = path.join(destination, 'runtimes', 'python');
const pythonResult = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(here, 'stage-python.ps1'), '-Destination', pythonOutput,
], { cwd: here, stdio: 'inherit', windowsHide: true, timeout: 180000 });
if (pythonResult.error || pythonResult.status !== 0) {
  throw pythonResult.error || new Error('Embedded CPython staging failed: ' + pythonResult.status);
}
async function recordStaged(dir, relative) {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    const target = relative + '/' + entry.name;
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) throw new Error('Embedded Python staging contains a link: ' + target);
    if (stat.isDirectory()) await recordStaged(child, target);
    else if (stat.isFile()) {
      const bytes = await fs.readFile(child);
      files.push({ path: target.replaceAll('\\', '/'), size: bytes.length, sha256: hash(bytes) });
    } else throw new Error('Unexpected Python runtime entry: ' + target);
  }
}
await recordStaged(pythonOutput, 'runtimes/python');
files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
await fs.writeFile(path.join(destination, 'runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, target: 'win-x64', packages, grammars, files }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, files: files.length, grammars, note: 'Runtime integrity checked; installer builder must copy this staged payload and the bundled Node executable' }, null, 2));
