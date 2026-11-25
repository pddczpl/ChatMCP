// The words, the numbers and the refusals of the benchmark's report (plan task P7 pod-39, corpus/REPORT.md).
//
// The words are corpus/templates/en.json and vi.json. As in the proof pack's report (docs/PROOF-RENDER.md), a text of the data is never a
// word of the report: what stands in a {placeholder} is a whole number or a node, and a text of the data is a `code` or `word` node, which a
// writer shows as a text and never reads as markup. Nothing here asks the system for a locale, a clock or a time zone.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, formatDecimal, formatInteger, text } from './render.mjs';

export { LANGS } from './render.mjs';

/** A refusal of the report: `code` names why (corpus/REPORT.md, "Refusals"). */
export class ReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
  }
}
export const refuse = (code, message) => { throw new ReportError(code, message); };

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
/** A file of corpus/templates/. */
export const template = (name) => readFileSync(path.join(TEMPLATES, name), 'utf8');
/** The words by language and key. */
export const WORDS = Object.freeze(Object.fromEntries(LANGS.map((lang) => [lang, Object.freeze(JSON.parse(template(`${lang}.json`)))])));

/** A link of the report: `target` is a path from the report's folder, with / between its parts, and may end with an anchor. */
export const link = (target, value) => ({ type: 'link', target, value });
/** Between the items of one cell. */
export const BREAK = Object.freeze({ type: 'break' });

const NODES = new Set(['text', 'code', 'word', 'chip', 'link', 'break']);
const isNode = (value) => value !== null && typeof value === 'object' && NODES.has(value.type);

/** The nodes of one value of a placeholder: a whole number from 0, a node, or a list of nodes. Anything else is a mistake of the caller. */
function nodesOf(value, lang, where) {
  if (Number.isSafeInteger(value) && value >= 0) return [text(formatInteger(value, lang))];
  const list = Array.isArray(value) ? value : [value];
  if (!list.every(isNode)) throw new TypeError(`${where} takes a whole number or nodes`);
  return list;
}

/** The text of `key` in `lang` as nodes, every `{name}` replaced by `params.name` (a whole number from 0, a node or a list of nodes). */
export function translate(lang, key, params = {}) {
  const value = Object.hasOwn(WORDS, lang) && Object.hasOwn(WORDS[lang], key) ? WORDS[lang][key] : null;
  if (value === null) throw new TypeError(`no text ${key} in ${lang}`);
  const nodes = [];
  for (const [index, part] of value.split(/\{([a-zA-Z]+)\}/).entries()) {
    if (index % 2 === 0) { if (part) nodes.push(text(part)); } else nodes.push(...nodesOf(params[part], lang, `${key} {${part}}`));
  }
  return nodes;
}

// ---- numbers ------------------------------------------------------------------------------------------------------------------------

/** A share from 0 to 1 as a percentage with one decimal. Only exactly 0 is 0% and only exactly 1 is 100%. */
export function percent(value, lang) {
  if (value === 0 || value === 1) return `${value * 100}%`;
  const shown = (value * 100).toFixed(1);
  if (shown === '0.0') return `<${formatDecimal('0.1', lang)}%`;
  if (shown === '100.0') return `>${formatDecimal('99.9', lang)}%`;
  return `${formatDecimal(shown, lang)}%`;
}

/** A number from 0 rounded to `digits` decimals; one above 0 that would be shown as 0 is `<0.0001`. */
export function fixed(value, digits, lang) {
  const shown = value.toFixed(digits);
  return value > 0 && !/[1-9]/.test(shown) ? `<${formatDecimal(`0.${'0'.repeat(digits - 1)}1`, lang)}` : formatDecimal(shown, lang);
}

/** A rate of metrics.mjs, always as k/n with its value and its interval; n = 0 has none. */
export function rateNodes({ k, n, rate, low, high }, lang) {
  if (n === 0) return translate(lang, 'rate.none');
  return translate(lang, 'rate.value', { k, n, rate: text(percent(rate, lang)), low: text(percent(low, lang)), high: text(percent(high, lang)) });
}
