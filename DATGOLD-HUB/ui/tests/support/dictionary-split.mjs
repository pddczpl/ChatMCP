// For the tests that guard the split of the dictionary: lib/i18n.ts and lib/i18n-agents.ts load with the first screen, lib/i18n-models.ts loads with
// the model picker. What the first screen loads comes from a real bundler run, never from a list written by hand, and what a module asks for comes
// from its source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bundleTsx, ui } from './bundle.mjs';

/** The source without its comments: a comment may name a key, a string may not do so by accident. */
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/**
 * The dictionary keys a module's source asks for, given every key there is: a string that is a key (t('send'), a key held in a variable or in a
 * table), and, for a key built at run time (`agent_status_${status}`, 'agent_error_' + code), every key that starts with the fixed beginning.
 */
export function keysAsked(source, allKeys) {
  const keys = new Set(allKeys);
  const asked = new Set();
  for (const match of withoutComments(source).matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const text = match[2];
    if (keys.has(text)) asked.add(text);
    const cut = text.indexOf('${');
    const head = cut >= 0 ? text.slice(0, cut) : text;
    if ((cut >= 0 || head.endsWith('_')) && /^[a-z][a-z_0-9]{3,}$/.test(head)) for (const key of keys) if (key.startsWith(head)) asked.add(key);
  }
  return asked;
}

export const sourceOf = (file) => fs.readFileSync(path.join(ui, file), 'utf8');

/**
 * One bundler run with code splitting from src/App.tsx. `first` is every source module that loads with the first screen (what the entry reaches
 * by static imports, then what those reach), `later` the ones that only an import() reaches, `roots` the modules an import() names.
 */
export async function modulesByLoad() {
  const { build } = createRequire(path.join(ui, 'package.json'))('esbuild');
  const { metafile } = await build({
    absWorkingDir: ui, entryPoints: ['src/App.tsx'], bundle: true, splitting: true, format: 'esm', platform: 'browser', metafile: true, write: false,
    outdir: path.join(os.tmpdir(), 'chatmcp-split-never-written'), tsconfig: path.join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const edges = (file, kind) => (metafile.inputs[file]?.imports ?? []).filter((edge) => edge.kind === kind && edge.path.startsWith('src/')).map((edge) => edge.path);
  const closure = (roots) => {
    const seen = new Set(roots);
    for (const file of seen) for (const next of edges(file, 'import-statement')) seen.add(next);
    return seen;
  };
  const first = closure(['src/App.tsx']);
  const roots = [...first].flatMap((file) => edges(file, 'dynamic-import'));
  const later = new Set([...closure(roots)].filter((file) => !first.has(file)));
  return { first, later, roots };
}

/** A bundled snippet's Vietnamese and English dictionaries as plain copies: `pick` takes what the snippet exports and returns { vi, en }. */
export async function dictionaryOf(snippet, pick) {
  const { loaded, dispose } = await bundleTsx(snippet, 'chatmcp-dictionary-');
  try {
    const { vi, en } = pick(loaded);
    return { vi: { ...vi }, en: { ...en } };
  } finally {
    await dispose();
  }
}

/** What the first script holds: lib/i18n.ts and what it imports, with no section module evaluated. */
export const firstDictionary = () => dictionaryOf("export { translations } from './src/lib/i18n';", ({ translations }) => translations);
