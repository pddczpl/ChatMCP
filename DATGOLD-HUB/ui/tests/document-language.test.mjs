import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDocumentLanguage, languageOf } from '../src/lib/document-language.ts';

// The language of the page: the screen speaks Vietnamese until the person chooses English (the desktop app runs in WebView2, and the language of Windows
// must not decide it), and <html lang> says which one it is, so that a screen reader uses the right voice. tests/app-language-store.test.mjs has the store.

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
  const sources = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
  const files = sources(fileURLToPath(new URL('../src', import.meta.url)));
  assert.ok(files.length > 100, `read ${files.length} files of src`);
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /navigator\.languages?\b/, `${file} must not choose the language from the browser`);
});
