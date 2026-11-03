import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyDocumentLanguage, languageOf } from '../src/lib/document-language.ts';
import { bundleTsx } from './support/bundle.mjs';

// The language of the page: the screen speaks Vietnamese until the person chooses English (the desktop app runs in WebView2, and the language of Windows
// must not decide it), and <html lang> says which one it is, so that a screen reader uses the right voice.

test('the language is English only when it was chosen; anything else is Vietnamese', () => {
  assert.equal(languageOf('en'), 'en');
  assert.equal(languageOf('vi'), 'vi');
  for (const value of ['fr', 'EN', 'en-US', '', null, undefined, 7, {}]) assert.equal(languageOf(value), 'vi', String(value));
});

test('the page declares the language it speaks', () => {
  const root = { lang: '' };
  applyDocumentLanguage('en', root);
  assert.equal(root.lang, 'en');
  applyDocumentLanguage('vi', root);
  assert.equal(root.lang, 'vi');
  applyDocumentLanguage('klingon', root);
  assert.equal(root.lang, 'vi', 'a value that is not a language does not become the language of the page');
});

test('with no page to declare it on (a server render, a test) nothing happens and nothing throws', () => {
  assert.doesNotThrow(() => applyDocumentLanguage('en'));
  assert.doesNotThrow(() => applyDocumentLanguage('en', null));
});

test('the page is Vietnamese before any script runs, and the language is not taken from the browser', () => {
  assert.match(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /<html lang="vi"/);
  for (const file of ['../src/store/useAppStore.ts', '../src/lib/document-language.ts', '../src/lib/i18n.ts', '../src/main.tsx', '../src/App.tsx']) {
    assert.doesNotMatch(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), /navigator\.language/, `${file} must not choose the language from the browser`);
  }
});

// ---- the store: the language it starts with, and what choosing one does to the page ------------------------------------------------------------------

const scratch = [];
after(() => { for (const dispose of scratch) dispose(); for (const name of ['window', 'localStorage', 'document']) delete globalThis[name]; });

/** The app store as the page creates it: the saved language is read when the module is evaluated, so each call evaluates a new copy with its own page. */
async function pageWith(saved) {
  const html = { lang: 'vi', setAttribute() {} };
  const written = {};
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.localStorage = { getItem: (key) => (key === 'chatmcp:language' ? saved : null), setItem: (key, value) => { written[key] = value; }, removeItem() {} };
  globalThis.document = { documentElement: html };
  const { loaded, dispose } = await bundleTsx("export { useAppStore } from './src/store/useAppStore';", 'chatmcp-lang-');
  scratch.push(dispose);
  return { store: loaded.useAppStore, html, written };
}

test('with nothing saved the screen starts in Vietnamese and says so', async () => {
  const { store, html } = await pageWith(null);
  assert.equal(store.getState().lang, 'vi');
  assert.equal(html.lang, 'vi');
});

test('a saved English is the language the screen starts in, and the page declares it before anything renders', async () => {
  const { store, html } = await pageWith('en');
  assert.equal(store.getState().lang, 'en');
  assert.equal(html.lang, 'en');
});

test('a saved value that is not a language is ignored: the screen is Vietnamese', async () => {
  const { store, html } = await pageWith('fr');
  assert.equal(store.getState().lang, 'vi');
  assert.equal(html.lang, 'vi');
});

test('choosing a language saves it and changes the language of the page with it', async () => {
  const { store, html, written } = await pageWith(null);
  store.getState().setLang('en');
  assert.deepEqual([store.getState().lang, html.lang, written['chatmcp:language']], ['en', 'en', 'en']);
  store.getState().setLang('vi');
  assert.deepEqual([store.getState().lang, html.lang, written['chatmcp:language']], ['vi', 'vi', 'vi']);
});
