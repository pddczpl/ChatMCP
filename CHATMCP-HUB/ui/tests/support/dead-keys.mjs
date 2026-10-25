// Which keys of the base dictionary (src/lib/i18n.ts) does nothing ask for? A key nobody asks for still travels to every person in the first script of the page.
//
// A key is used when its name stands as a quoted string in a module outside the dictionaries, or is written `.name` (a property read), or when a string that
// ends with an underscore (the start of a key that is made at run time: `agent_status_${state}`, 'agent_role_' + role) is the start of the key, or when one of
// the other dictionary (lib/i18n-agents.ts) asks for it. The test of the same name keeps the list empty.
import fs from 'node:fs';
import path from 'node:path';

const DICTIONARIES = ['i18n.ts', 'i18n-agents.ts'];

/** Every module under src/ except the two dictionaries that load with the first screen, as one text. */
export function sourceTextOf(uiDirectory) {
  const src = path.join(uiDirectory, 'src');
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(tsx?|mjs|js)$/.test(entry.name) && !(path.basename(path.dirname(full)) === 'lib' && DICTIONARIES.includes(entry.name)) ? [full] : [];
  });
  return walk(src).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

/** The keys of each language of the base dictionary, in the order they stand, from its text. */
export function baseKeys(dictionaryText) {
  const lines = dictionaryText.split(/\r?\n/);
  const viStart = lines.findIndex((line) => /^ {2}vi: \{/.test(line));
  const enStart = lines.findIndex((line) => /^ {2}en: \{/.test(line));
  const end = lines.findIndex((line, index) => index > enStart && /^ {2}\},?$/.test(line));
  if (viStart < 0 || enStart < viStart || end < enStart) throw new Error('the base dictionary does not have the shape this reader knows: vi, then en');
  const keysOf = (from, to) => lines.slice(from + 1, to).map((line) => /^ {4}([A-Za-z0-9_]+):\s*['"`]/.exec(line)?.[1]).filter(Boolean);
  return { vi: keysOf(viStart, enStart), en: keysOf(enStart, end) };
}

/** The keys of the base dictionary that nothing asks for, for each language. */
export function deadKeys({ dictionaryText, sourceText, otherDictionariesText = '' }) {
  const prefixes = new Set();
  for (const pattern of [/['"`]([a-z][a-z0-9_]*_)['"`]/g, /`([a-z][a-z0-9_]*_)\$\{/g]) for (const match of sourceText.matchAll(pattern)) prefixes.add(match[1]);
  const asked = (key, text) => new RegExp(`['"\`]${key}['"\`]`).test(text) || new RegExp(`\\.${key}\\b`).test(text);
  const used = (key) => asked(key, sourceText) || asked(key, otherDictionariesText) || [...prefixes].some((prefix) => key.startsWith(prefix));
  const keys = baseKeys(dictionaryText);
  return { vi: keys.vi.filter((key) => !used(key)), en: keys.en.filter((key) => !used(key)) };
}

export function otherDictionariesTextOf(uiDirectory) {
  return DICTIONARIES.filter((name) => name !== 'i18n.ts').map((name) => fs.readFileSync(path.join(uiDirectory, 'src', 'lib', name), 'utf8')).join('\n');
}
