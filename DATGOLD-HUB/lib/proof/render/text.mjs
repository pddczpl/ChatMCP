// The texts and numbers of a report (docs/PROOF-RENDER.md): how a text of a pack is made visible, and how numbers, money and durations are
// written. Nothing here asks the system for a locale, a clock or a time zone: the same value gives the same characters everywhere.

/** What a renderer refuses: an input it cannot read (`render_bad_input`). It never guesses. */
export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderError';
    this.code = 'render_bad_input';
  }
}

// ------------------------------------------------------------------------------------------------------------- making a text visible
// A character that a reader would not see as what it is: control characters (a line end and a tab too: a text of a pack is one line of
// a report), format characters (bidi controls, zero-width ones, tags), every default-ignorable code point, line and paragraph separators,
// spaces that are not the space, noncharacters and lone surrogates. Two more, whose NFC form is ASCII punctuation (U+1FEF becomes a
// backtick, U+037E a semicolon), would become markup if something on the way normalised the bytes. U+27E6 and U+27E7 are the marks of the
// marker itself. A combining mark at the very start would join the markup before it (and could be composed with it: `>` and U+0338).
const HIDDEN = /\p{Cc}|\p{Cf}|\p{Default_Ignorable_Code_Point}|\p{Zl}|\p{Zp}|(?! )\p{Zs}|\p{Noncharacter_Code_Point}|\p{Cs}|[\u037E\u1FEF⟦⟧]|^\p{M}/gu;
const marker = (char) => `⟦U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`;

/**
 * `value` with every hidden character written as a marker, `⟦U+202E⟧`; nothing else changes (no Unicode normalisation: a command
 * or a path is evidence, and its composed and decomposed spellings are two different texts). Two texts never give the same one.
 */
export const visible = (value) => String(value).replace(HIDDEN, marker);

/** The first `max` characters (code points) of `value`: {text, length (of the whole), cut}. */
export function cutText(value, max) {
  const points = [...value];
  return points.length <= max ? { text: value, length: points.length, cut: false } : { text: points.slice(0, max).join(''), length: points.length, cut: true };
}

/** The first twelve digits of a tree id or a digest. */
export const shortId = (id) => id.slice(0, 12);

// -------------------------------------------------------------------------------------------------------------------------- numbers
const SEPARATORS = Object.freeze({ en: { group: ',', point: '.' }, vi: { group: '.', point: ',' } });
const grouped = (digits, lang) => digits.replace(/\B(?=(?:[0-9]{3})+$)/g, SEPARATORS[lang].group);

/** A whole number from 0 (a number or a BigInt) with its thousands grouped: 1,234,567 in English, 1.234.567 in Vietnamese. */
export const formatInteger = (value, lang) => grouped(String(value), lang);

/** The exact decimal digits of a finite number from 0, as ECMAScript prints it: {digits (a BigInt), scale}; 1.25e-9 is {125n, 11}. */
function decimalOf(value) {
  const [, whole, fraction = '', exponent = '0'] = /^([0-9]+)(?:\.([0-9]+))?(?:e([+-][0-9]+))?$/.exec(String(value));
  const scale = fraction.length - Number(exponent);
  return scale >= 0 ? { digits: BigInt(whole + fraction), scale } : { digits: BigInt(whole + fraction) * 10n ** BigInt(-scale), scale: 0 };
}

/** A finite number from 0, every digit of it (never rounded, never an exponent), in the spelling of `lang`. */
export function formatDecimal(value, lang) {
  const { digits, scale } = decimalOf(value);
  const padded = String(digits).padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale);
  const fraction = padded.slice(padded.length - scale);
  return grouped(whole, lang) + (scale ? SEPARATORS[lang].point + fraction : '');
}

/** A duration in milliseconds: `999 ms`, or seconds with three decimals from 1,000 ms (`61.007 s`; nothing is rounded). */
export function formatDuration(ms, lang) {
  if (ms < 1000) return `${ms} ms`;
  return `${formatInteger(Math.floor(ms / 1000), lang)}${SEPARATORS[lang].point}${String(ms % 1000).padStart(3, '0')} s`;
}

// ----------------------------------------------------------------------------------------------------------------------------- money
const RATE = /^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,4})?$/;
const DATE = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

/** True for a date of the calendar written YYYY-MM-DD. */
function isDate(value) {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** What each part of a rate is (the CLI refuses a wrong one with the same words). */
export const RATE_RULES = Object.freeze({
  rate: { holds: (value) => RATE.test(value) && /[1-9]/.test(value), expected: 'dong per US dollar, above 0 and below 100000000, with at most four decimals (25400)' },
  date: { holds: isDate, expected: 'the day of the rate, YYYY-MM-DD' },
  source: { holds: (value) => value.trim() !== '' && value.length <= 200, expected: 'where the rate comes from, in 1 to 200 characters' },
});

/**
 * The rate of the caller, or null when there is none: {rate (decimal text), date, source}, all three and nothing else. There is no built-in
 * rate and none is ever fetched; a rate without its date and source is refused.
 */
export function readRate(vnd) {
  if (vnd === null || vnd === undefined) return null;
  if (typeof vnd !== 'object' || Object.keys(vnd).sort().join(',') !== Object.keys(RATE_RULES).sort().join(',')) throw new RenderError('vnd is {rate, date, source}');
  for (const [name, rule] of Object.entries(RATE_RULES)) {
    if (typeof vnd[name] !== 'string' || !rule.holds(vnd[name])) throw new RenderError(`vnd.${name} is ${rule.expected}`);
  }
  return { rate: vnd.rate, date: vnd.date, source: vnd.source };
}

/** `usd` (a finite number from 0) at `rate` (decimal text) in whole dong, half up, exactly; null for an amount above 0 that rounds to 0. */
export function vndOf(usd, rate, lang) {
  const amount = decimalOf(usd);
  const per = decimalOf(rate);
  const unit = 10n ** BigInt(amount.scale + per.scale);
  const product = amount.digits * per.digits;
  const dong = (product * 2n + unit) / (unit * 2n);
  return dong === 0n && product > 0n ? null : formatInteger(dong, lang);
}
