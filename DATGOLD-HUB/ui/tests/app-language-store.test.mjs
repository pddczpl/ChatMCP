import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx } from './support/bundle.mjs';

// The app store and the language: which one the screen starts in, and what choosing one does to the page (tests/document-language.test.mjs has the rules).
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
