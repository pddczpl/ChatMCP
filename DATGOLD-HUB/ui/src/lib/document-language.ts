// The language of the page. The screen speaks Vietnamese until the person chooses English: it is not taken from the browser, because the desktop app
// runs in WebView2 and the language of Windows must not turn a Vietnamese screen into an English one.
export type UiLanguage = 'vi' | 'en';

/** The language a saved or typed value means: English only when it is exactly "en"; anything else (nothing saved, a value that is not a language) is Vietnamese. */
export const languageOf = (value: unknown): UiLanguage => (value === 'en' ? 'en' : 'vi');

/** Declares the language on <html lang>, so that a screen reader reads the page in the right voice. With no page (a server render, a test) it does nothing. */
export function applyDocumentLanguage(value: unknown, root: { lang: string } | null | undefined = typeof document === 'undefined' ? undefined : document.documentElement): void {
  if (root) root.lang = languageOf(value);
}
