// Plural forms. A string that depends on a count is a family in the dictionaries, spelled key_one and key_other; translate() in lib/i18n.ts asks which
// names to look up for a count. This file has no imports, so that it can be tested without the app around it.
const rules: Record<string, Intl.PluralRules> = {};

/** The plural category of a count in a language ("one", "other"), by the rules of that language: English has "one" and "other", Vietnamese only "other". */
export function pluralCategory(lang: string, count: number): string {
  const locale = lang === 'en' ? 'en-US' : 'vi-VN';
  return (rules[locale] ??= new Intl.PluralRules(locale)).select(count);
}

/**
 * The names to look up for a key asked with a count, best first: the form the language uses for that count (key_one), then key_other, then the key itself, so
 * that a plain string with a {count} placeholder keeps working. A count that is not a finite number chooses nothing: the key is the only name.
 */
export function pluralNames(lang: string, key: string, count: unknown): string[] {
  return typeof count === 'number' && Number.isFinite(count) ? [`${key}_${pluralCategory(lang, count)}`, `${key}_other`, key] : [key];
}
