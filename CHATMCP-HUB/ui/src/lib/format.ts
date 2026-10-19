// Date, time and number formatting that follows the interface language, not the machine's English default
// ("10/20/2026, 2:47:31 AM" in a Vietnamese screen is a bug, not a style).
export type FormatLang = 'vi' | 'en';

const localeOf = (lang: FormatLang) => (lang === 'en' ? 'en-US' : 'vi-VN');
const toDate = (value: string | number | Date | undefined | null): Date | null => {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** 14:47 */
export function formatTime(value: string | number | Date | undefined | null, lang: FormatLang = 'vi'): string {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(localeOf(lang), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
}

/** vi: 20/10/2026 14:47, en: Oct 20, 2026, 14:47 */
export function formatDateTime(value: string | number | Date | undefined | null, lang: FormatLang = 'vi'): string {
  const date = toDate(value);
  if (!date) return '';
  const time = formatTime(date, lang);
  return lang === 'en'
    ? `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${time}`
    : `${date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${time}`;
}

/** "5 phút trước", "hôm qua", "just now" */
export function formatRelative(value: string | number | Date | undefined | null, lang: FormatLang = 'vi', now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return lang === 'en' ? 'just now' : 'vừa xong';
  const formatter = new Intl.RelativeTimeFormat(localeOf(lang), { numeric: 'auto' });
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 7) return formatter.format(Math.round(seconds / 86400), 'day');
  return formatDateTime(date, lang).split(' ')[0];
}

export function formatNumber(value: number | undefined | null, lang: FormatLang = 'vi'): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(localeOf(lang)) : '–';
}

/** 842 ms, 1.2 s, 2 m 05 s */
export function formatDuration(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
}

/** Compact token counts: 840, 12.4k, 1.2M */
export function formatTokens(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
