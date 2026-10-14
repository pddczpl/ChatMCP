import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
const packages = [];
for (const [name, version] of Object.entries(dependencies)) {
  const entry = lock.packages[`node_modules/${name}`];
  if (entry?.version !== version || !entry.integrity || !entry.resolved?.startsWith('https://registry.npmjs.org/')) throw new Error(`Invalid lock: ${name}`);
  const directory = path.join(here, 'node_modules', name);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.version !== version) throw new Error(`Installed version mismatch: ${name}`);
  // Grammar package contributes only inert WASM, never its Node entrypoint.
  if (name !== 'tree-sitter-wasms' && Object.keys(metadata.dependencies || {}).length) throw new Error(`Review transitive runtime closure before adding ${name}`);
  const notices = (await fs.readdir(directory)).filter(name => /^(license|copying|notice)/i.test(name));
  if (!notices.length) throw new Error(`Missing license: ${name}`);
  packages.push({ name, version, source: entry.resolved, integrity: entry.integrity, license: metadata.license });
  if (name === 'tree-sitter-wasms') {
    for (const language of ['javascript', 'typescript', 'tsx', 'python']) await copy(path.join(directory, 'out', `tree-sitter-${language}.wasm`), `grammars/tree-sitter-${language}.wasm`);
    for (const notice of notices) await copy(path.join(directory, notice), `licenses/${name}/${notice}`);
  } else {
    await copy(directory, `runtimes/lsp/node_modules/${name}`);
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
files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
await fs.writeFile(path.join(destination, 'runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, target: 'win-x64', packages, grammars, files }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, files: files.length, grammars, note: 'Node and embedded CPython must still be staged and verified before installer integration' }, null, 2));
