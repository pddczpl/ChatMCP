import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DICTIONARY_FILES, RULES, findViolations, fingerprint, initBaseline, lintProject, selfTest, selfTestReport, shrinkBaseline } from '../scripts/lint-i18n.mjs';

// The lint that keeps hard-coded words out of the components (scripts/lint-i18n.mjs): what it flags, what it leaves alone, how a violation is told apart
// from another (file, rule, hash of the string), how the frozen baseline and the allowlist gate a project, and the gate on this very project.
const ui = fileURLToPath(new URL('..', import.meta.url));
const rulesOf = (source, file = 'fixture.tsx') => findViolations(source, file).map((violation) => violation.rule);

// ---- what it flags --------------------------------------------------------------------------------------------------------------------------------

test('JSX text that has letters is flagged, in either language, one violation per piece of text', () => {
  assert.deepEqual(rulesOf('const A = () => <p>Nothing to show here</p>;'), ['jsx-text']);
  assert.deepEqual(rulesOf('const A = () => <span>Đã lưu</span>;'), ['jsx-text']);
  assert.deepEqual(rulesOf('const A = () => <p>Saved {count} files</p>;'), ['jsx-text', 'jsx-text'], 'the words before and after the {count} are two pieces');
});

test('a string written inside braces among JSX children is flagged like JSX text, through a condition and a template too', () => {
  assert.deepEqual(rulesOf("const A = () => <p>{'Hello world'}</p>;"), ['jsx-text']);
  assert.deepEqual(rulesOf("const A = () => <p>{ok ? 'Done' : 'Failed'}</p>;"), ['jsx-text', 'jsx-text']);
  assert.deepEqual(rulesOf('const A = () => <p>{`Hello ${name}`}</p>;'), ['jsx-text']);
  assert.deepEqual(rulesOf("const A = () => <p>{busy && 'Working'}</p>;"), ['jsx-text']);
});

test('title, aria-label, placeholder, alt and label with a literal are flagged, in quotes or in braces, and through a condition', () => {
  for (const name of ['title', 'aria-label', 'placeholder', 'alt', 'label']) {
    assert.deepEqual(rulesOf(`const A = () => <x ${name}="Close it" />;`), ['jsx-attribute'], `${name} in quotes`);
    assert.deepEqual(rulesOf(`const A = () => <x ${name}={'Close it'} />;`), ['jsx-attribute'], `${name} in braces`);
  }
  assert.deepEqual(rulesOf("const A = () => <x title={ok ? 'Open' : 'Shut'} />;"), ['jsx-attribute', 'jsx-attribute']);
  assert.deepEqual(rulesOf('const A = () => <x title="Đóng" />;'), ['jsx-attribute']);
});

test('the words of a toast, a confirm, an alert, a prompt or an Error are flagged, but only the message', () => {
  assert.deepEqual(rulesOf("showToast('Saved');"), ['call-argument']);
  assert.deepEqual(rulesOf("showToast('Saved', 'success');"), ['call-argument'], 'the kind of toast is not a message');
  assert.deepEqual(rulesOf("if (!window.confirm('Are you sure')) return;"), ['call-argument']);
  assert.deepEqual(rulesOf("confirm('Are you sure');"), ['call-argument']);
  assert.deepEqual(rulesOf("alert('Something broke');"), ['call-argument']);
  assert.deepEqual(rulesOf("prompt('Type the name', 'default value');"), ['call-argument'], 'the suggested answer is not a message');
  assert.deepEqual(rulesOf("useAppStore.getState().showToast('Done');"), ['call-argument']);
  assert.deepEqual(rulesOf("throw new Error('Cannot continue');"), ['call-argument']);
  assert.deepEqual(rulesOf("throw new TypeError('Bad value');"), ['call-argument']);
  assert.deepEqual(rulesOf('showToast(`Restored ${n} files`);'), ['call-argument']);
  assert.deepEqual(rulesOf("window.confirm('Delete profile '+id+'? It cannot be undone.');"), ['call-argument', 'call-argument'], 'both pieces of the sentence');
});

test('a language ternary is flagged once, with the strings in its branches counted in it and not again as something else', () => {
  assert.deepEqual(rulesOf("const s = lang === 'vi' ? 'Xin chào' : 'Hello';"), ['lang-ternary']);
  assert.deepEqual(rulesOf("const s = props.lang !== 'en' ? 'Xin chào' : 'Hello';"), ['lang-ternary']);
  assert.deepEqual(rulesOf("const s = language == 'vi' ? 'Tạm biệt' : 'Bye bye';"), ['lang-ternary']);
  assert.deepEqual(rulesOf("const s = isVi ? 'Tạm biệt' : 'Bye bye';"), ['lang-ternary']);
  assert.deepEqual(rulesOf("const A = () => <p>{lang === 'vi' ? 'Đang tải' : 'Loading'}</p>;"), ['lang-ternary'], 'in JSX children: not also JSX text');
  assert.deepEqual(rulesOf("const A = () => <x title={lang === 'vi' ? 'Đóng' : 'Close'} />;"), ['lang-ternary'], 'in an attribute: not also an attribute');
  assert.deepEqual(rulesOf("showToast(lang === 'vi' ? 'Đã xong' : 'Done');"), ['lang-ternary'], 'in a toast: not also a toast');
  assert.deepEqual(rulesOf("const A = () => <p>{ok ? (lang === 'vi' ? 'Đã stage' : 'Staged') : (lang === 'vi' ? 'Chưa stage' : 'Unstaged')}</p>;"), ['lang-ternary', 'lang-ternary'], 'two ternaries inside an ordinary one');
});

test('an object whose values are words in Vietnamese, or an English sentence, is flagged value by value', () => {
  assert.deepEqual(rulesOf("const LABELS = { running: 'Đang chạy', idle: 'Rảnh' };"), ['label-map', 'label-map']);
  assert.deepEqual(rulesOf("const TEXT = { empty: 'Nothing was changed in this run' };"), ['label-map']);
});

test('Vietnamese anywhere else in a string is flagged, so a helper that takes both languages does not hide it', () => {
  assert.deepEqual(rulesOf("const message = 'Không tìm thấy';"), ['vietnamese-literal']);
  assert.deepEqual(rulesOf('function f(n) { return `Đã xóa ${n} tệp`; }'), ['vietnamese-literal']);
  assert.deepEqual(rulesOf("prompt(copy('Nhập REMOVE để gỡ', 'Type REMOVE to remove'));"), ['vietnamese-literal'], 'the Vietnamese half of the pair; the call is not a toast, a confirm or an alert');
});

test('letters that are not ASCII count as letters, upper case Vietnamese included', () => {
  assert.deepEqual(rulesOf('const A = () => <p>Đã</p>;'), ['jsx-text'], 'a text of Vietnamese letters only');
  assert.deepEqual(rulesOf("const s = 'ĐỒNG Ý';"), ['vietnamese-literal'], 'capitals only');
  assert.deepEqual(rulesOf("const s = 'ăâđêôơư';"), ['vietnamese-literal']);
});

test('the other attributes a screen reader speaks are flagged too', () => {
  for (const name of ['aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext']) assert.deepEqual(rulesOf(`const A = () => <x ${name}="Close it" />;`), ['jsx-attribute'], name);
});

test('Error is flagged called as well as constructed, and only its message', () => {
  for (const name of ['Error', 'TypeError', 'RangeError', 'SyntaxError']) assert.deepEqual(rulesOf(`throw ${name}('Cannot continue');`), ['call-argument'], `${name}(...)`);
  assert.deepEqual(rulesOf("throw new Error('Cannot continue', { cause: 'the other words' });"), ['call-argument'], 'not the options');
  assert.deepEqual(findViolations("showToast('Saved', 'success');").map((violation) => violation.text), ['Saved'], 'the first argument is the message, not the second');
  assert.deepEqual(rulesOf('class Failure extends Error {} const f = failure("Bad value");'), [], 'a call of something else is not an Error');
});

test('every way the code asks which language it is in is a language ternary', () => {
  for (const condition of ["lang === 'vi'", "lang == 'vi'", "lang !== 'en'", "lang != 'en'", "'vi' === lang", "locale === 'vi'", "props.language === 'en'", "lang === 'en-US'", 'isEn', 'isVietnamese', 'isEnglish', 'vi', 'en', '!isVi', "(lang === 'vi')"]) {
    assert.deepEqual(rulesOf(`const s = ${condition} ? 'Xin chào bạn' : 'Hello there';`), ['lang-ternary'], condition);
  }
  for (const condition of ["mode === 'vi'", "lang === 'fr'", "lang === other", 'ready', "lang.startsWith('vi')"]) assert.deepEqual(rulesOf(`const s = ${condition} ? 'Hello there' : 'Hello again';`), [], `${condition} does not ask which language it is`);
});

test('the words of a language ternary are one violation whose text is the whole ternary', () => {
  assert.deepEqual(findViolations("const s = lang === 'vi' ? 'Đã lưu' : 'Saved';").map((violation) => violation.text), ["lang === 'vi' ? 'Đã lưu' : 'Saved'"]);
  assert.deepEqual(rulesOf("const s = lang === 'vi' ? 'Đã lưu' : lang === 'en' ? 'Saved' : 'Gespeichert';"), ['lang-ternary', 'lang-ternary'], 'a ternary in the else branch has its own words');
  assert.deepEqual(rulesOf("const s = lang === 'vi' ? vi : 'English only';"), ['lang-ternary'], 'one branch with words is enough');
  assert.deepEqual(rulesOf("const s = lang === 'vi' ? 'vi-VN' : t('x');"), [], 'a locale tag beside a call is not words');
});

test('words can come from a default, a fallback, a cast or a parenthesis', () => {
  assert.deepEqual(rulesOf("const A = () => <p>{name || 'Untitled thing'}</p>;"), ['jsx-text']);
  assert.deepEqual(rulesOf("const A = () => <p>{name ?? 'Untitled thing'}</p>;"), ['jsx-text']);
  assert.deepEqual(rulesOf("const A = () => <p>{('Hello world' as string)}</p>;"), ['jsx-text']);
  assert.deepEqual(rulesOf("const A = () => <p>{'Hello world' satisfies string}</p>;"), ['jsx-text']);
  assert.deepEqual(rulesOf("const A = () => <p>{<b>{'Hello world'}</b>}</p>;"), ['jsx-text'], 'once, through the inner element');
  assert.deepEqual(rulesOf("const A = () => <>{'Hello world'}</>;"), ['jsx-text'], 'a fragment has children too');
  assert.deepEqual(rulesOf("showToast(ok ? 'Saved it' : 'Lost it');"), ['call-argument', 'call-argument']);
  assert.deepEqual(rulesOf("showToast(name ?? 'Nothing');"), ['call-argument']);
  assert.deepEqual(rulesOf("showToast(name || 'Nothing');"), ['call-argument']);
  assert.deepEqual(rulesOf("showToast(count > 1 && 'Many');"), ['call-argument']);
});

test('a value with a number or a call in it is not words just because it sits among words', () => {
  assert.deepEqual(rulesOf('const A = () => <p>{count * 2}{count - 1}{a < b}</p>;'), []);
  assert.deepEqual(rulesOf("const A = () => <p>{cond ? t('a') : t('b')}</p>;"), []);
  assert.deepEqual(rulesOf("const A = () => <p>{items.map((item) => item.name)}</p>;"), []);
});

test('the words of an object are flagged when they are Vietnamese or a sentence, wherever the object is', () => {
  assert.deepEqual(rulesOf("const f = () => ({ ready: ok ? 'Sẵn sàng' : 'Chưa sẵn sàng' });"), ['label-map', 'label-map']);
  assert.deepEqual(rulesOf("call({ nested: { deeper: 'Nothing was changed in this run' } });"), ['label-map']);
  assert.deepEqual(rulesOf("const f = { a: `Nothing was changed in ${where}` };"), ['label-map'], 'a template');
  assert.deepEqual(rulesOf("const f = { a: 'Nothing was changed in this run' as const };"), ['label-map'], 'through a cast');
});

test('what a cast or a non-null mark wraps is still the words', () => {
  assert.deepEqual(rulesOf("showToast('Saved it'!);"), ['call-argument']);
  assert.deepEqual(rulesOf("showToast(<string>'Saved it');", 'a.ts'), ['call-argument'], 'an angle-bracket cast in a TS file');
  assert.deepEqual(rulesOf("const f = { a: ' Nothing was changed in this run ' };"), ['label-map'], 'blanks around the sentence');
});

test('a language ternary needs words in a branch: digits, signs and locale tags are not words', () => {
  assert.deepEqual(rulesOf("const s = lang === 'vi' ? '1,5' : '1.5';"), []);
  assert.deepEqual(rulesOf("const s = lang === 'vi' ? 'vi-VN' : 'Hello there';"), ['lang-ternary'], 'a locale tag beside real words');
  assert.deepEqual(rulesOf("const s = lang === 'vi' ? 'yes' : 'hello';"), ['lang-ternary'], 'a short word beside a longer one is words, not a locale tag');
});

test('a string that a rule has taken is not taken again by the catch-all', () => {
  assert.deepEqual(rulesOf("showToast('Không tìm thấy');"), ['call-argument']);
  assert.deepEqual(rulesOf('showToast(`Đã xóa ${n} tệp`);'), ['call-argument']);
  assert.deepEqual(rulesOf("const A = () => <x title=\"Đóng lại\" />;"), ['jsx-attribute']);
  assert.deepEqual(rulesOf("const A = () => <p>{'Đã xong'}</p>;"), ['jsx-text']);
});

test('a label of Title Case words is not taken for a sentence', () => {
  assert.deepEqual(rulesOf("const f = { a: 'Save As', b: 'Open A B', c: 'Ctrl K', d: 'GitHub Actions', e: 'Hello', f: 'a sentence in lower case', g: 'Version 3.11.2' };"), []);
  assert.deepEqual(rulesOf("const f = { a: 'Hello, my friend' };"), ['label-map'], 'a capital, a comma, then words');
  assert.deepEqual(rulesOf("const f = { a: \"Don't stop now\" };"), ['label-map'], 'an apostrophe');
  assert.deepEqual(rulesOf("const f = { a: 'ChatGPT Web: risks to know' };"), ['label-map'], 'a title with a colon, whose first word is not a plain capitalised word');
  assert.deepEqual(rulesOf("const f = { a: 'A new session started' };"), ['label-map'], 'a one-letter first word');
  assert.deepEqual(rulesOf("const f = { a: 'Context: the agent plans ahead' };"), ['label-map'], 'a colon after the first word');
});

// ---- what it leaves alone -------------------------------------------------------------------------------------------------------------------------

test('words that are looked up, not written, are not flagged', () => {
  assert.deepEqual(rulesOf("const A = () => <p title={t('close')} aria-label={t('close')}>{t('saved')}</p>;"), []);
  assert.deepEqual(rulesOf("showToast(t('saved'), 'success'); showToast(message); throw new Error(message);"), []);
  assert.deepEqual(rulesOf('const A = () => <p>{name}</p>;'), []);
});

test('text without letters is not flagged: signs, digits, entities, empty strings', () => {
  assert.deepEqual(rulesOf('const A = () => <p><span>·</span><i>—</i><b>{n}</b><u>&nbsp;</u><s>1,000</s></p>;'), []);
  assert.deepEqual(rulesOf('const A = () => <img alt="" />;'), []);
  assert.deepEqual(rulesOf("showToast(''); throw new Error('');"), []);
});

test('attributes that are not text for a person are not flagged', () => {
  assert.deepEqual(rulesOf('const A = () => <p className="Hello world" data-testid="Hello world" id="Hello world" />;'), []);
  assert.deepEqual(rulesOf("const A = () => <p className={clsx('flex items-center', ok && 'text-primary')} />;"), []);
});

test('comments, types and imports are not flagged, whatever language they are in', () => {
  assert.deepEqual(rulesOf("// Đã xong: chuyển ngôn ngữ\n/* Không tìm thấy */\nconst a = 1;\n"), []);
  assert.deepEqual(rulesOf("type Label = 'Đã xong' | 'Chưa xong'; const x = y as 'Không';"), []);
  assert.deepEqual(rulesOf("import { a } from './Đã.ts'; export * from './Không.ts';"), []);
  assert.deepEqual(rulesOf("import e = require('./Đây');", 'a.ts'), []);
});

test('things that have no message do not fail the lint: an attribute with no value, a throw with no argument, an empty expression', () => {
  assert.deepEqual(rulesOf('const A = () => <x title alt aria-label />;'), []);
  assert.deepEqual(rulesOf('throw new Error;'), []);
  assert.deepEqual(rulesOf('showToast();'), []);
  assert.deepEqual(rulesOf('const A = () => <p>{/* a comment */}{}</p>;'), []);
  assert.deepEqual(rulesOf("const A = () => <x title={} />;"), []);
});

test('a string in an attribute that is not read by a person is not flagged, in quotes or in braces', () => {
  assert.deepEqual(rulesOf("const A = () => <p data-label={'Hello world'} className={'Hello world'} />;"), []);
});

test('a language ternary that only chooses a locale, or chooses between two variables, is not a hard-coded string', () => {
  assert.deepEqual(rulesOf("const locale = lang === 'en' ? 'en-US' : 'vi-VN';"), []);
  assert.deepEqual(rulesOf("const pick = (vi, en) => (lang === 'vi' ? vi : en);"), []);
});

test('a label that is one word, a class list, an id or a URL is not flagged as a sentence', () => {
  assert.deepEqual(rulesOf("const A = { high: 'High', cls: 'flex items-center gap-2', id: 'agents-view-groups', brand: 'OpenAI', url: 'https://example.com/a b' };"), []);
});

test('the Vietnamese rule needs a letter with a diacritic: an English or an ASCII string is not flagged by it', () => {
  assert.deepEqual(rulesOf("const a = 'plain words here'; const b = `template ${x} text`; const c = 'Hello';"), []);
});

// ---- how a violation is identified ----------------------------------------------------------------------------------------------------------------

test('a violation says where it is, what rule found it, and the hash of the string', () => {
  const [violation] = findViolations('const A = () => (\n  <p>Nothing to show here</p>\n);', 'src/components/A.tsx');
  assert.equal(violation.file, 'src/components/A.tsx');
  assert.equal(violation.rule, 'jsx-text');
  assert.equal(violation.line, 2);
  assert.equal(violation.column, 6);
  assert.equal(violation.text, 'Nothing to show here');
  assert.match(violation.hash, /^[0-9a-f]{16}$/);
  assert.equal(fingerprint(violation), `src/components/A.tsx|jsx-text|${violation.hash}`);
});

test('the hash follows the words, not where they stand or how they are wrapped', () => {
  const key = (source) => findViolations(source, 'a.tsx').map(fingerprint);
  const original = key('const A = () => <p>Nothing to show here</p>;');
  assert.deepEqual(key('\n\n// moved down\nconst A = () => <p>Nothing to show here</p>;'), original, 'a line that moved');
  assert.deepEqual(key('const A = () => (\n  <p>\n    Nothing   to show\n    here\n  </p>\n);'), original, 'the same words wrapped over lines');
  assert.notDeepEqual(key('const A = () => <p>Nothing to show there</p>;'), original, 'other words');
  assert.notEqual(findViolations('const A = () => <p>Nothing to show here</p>;', 'b.tsx').map(fingerprint)[0], original[0], 'the same words in another file');
  assert.notEqual(findViolations("const A = () => <x title='Nothing to show here' />;", 'a.tsx').map(fingerprint)[0], original[0], 'the same words under another rule');
});

test('the hash is the first 16 hex digits of the SHA-256 of the words as the lint shows them', () => {
  const [violation] = findViolations('const A = () => <p>Nothing to show here</p>;', 'a.tsx');
  assert.equal(violation.hash, crypto.createHash('sha256').update('Nothing to show here', 'utf8').digest('hex').slice(0, 16));
  const [vietnamese] = findViolations("const s = 'Đã lưu';", 'a.ts');
  assert.equal(vietnamese.hash, crypto.createHash('sha256').update('Đã lưu', 'utf8').digest('hex').slice(0, 16), 'UTF-8, not a code page');
});

test('a template is judged by its written parts, with {} where a value goes', () => {
  assert.deepEqual(findViolations("showToast(`Restored ${n} files`);").map((violation) => violation.text), ['Restored {} files']);
  assert.deepEqual(findViolations("const s = `Đã xóa ${n} tệp`;").map((violation) => violation.text), ['Đã xóa {} tệp']);
  assert.deepEqual(rulesOf('showToast(`${a}${b}`);'), [], 'nothing written, nothing to flag');
  assert.deepEqual(rulesOf('const s = `${a} ${b}`;'), []);
});

test('the same words twice are two violations with one key', () => {
  const found = findViolations('const A = () => <div><p>Try again</p><p>Try again</p></div>;', 'a.tsx');
  assert.equal(found.length, 2);
  assert.equal(fingerprint(found[0]), fingerprint(found[1]));
});

test('a TypeScript file with no JSX is read too', () => {
  assert.deepEqual(rulesOf("export const label = (n: number): string => (n > 1 ? 'Nhiều' : 'Một');", 'src/lib/x.ts'), ['vietnamese-literal', 'vietnamese-literal']);
});

// ---- the project gate: scan, allowlist, frozen baseline -------------------------------------------------------------------------------------------

const scratch = [];
after(() => { for (const root of scratch) fs.rmSync(root, { recursive: true, force: true }); });
const write = (root, name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
/** A small UI folder in the temp folder: { 'src/x.tsx': 'text', 'i18n-baseline.json': 'text' }. */
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-i18n-lint-'));
  scratch.push(root);
  for (const [name, text] of Object.entries(files)) write(root, name, text);
  return root;
}
const CLEAN = "export const Clean = () => <p>{t('saved')}</p>;\n";
const ONE = 'export const One = () => <p>Nothing to show here</p>;\n';
const TWO = 'export const Two = () => <p>Nothing to show here</p>;\nexport const Three = () => <p>Try again later</p>;\n';

test('a project with no hard-coded string passes with an empty baseline', () => {
  const root = project({ 'src/components/Clean.tsx': CLEAN });
  const result = lintProject(root);
  assert.equal(result.files, 1);
  assert.deepEqual([result.found.length, result.fresh.length, result.stale.length, result.staleAllow.length], [0, 0, 0, 0]);
});

test('a string added to a component is a new violation, until the baseline was frozen with it', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  const before = lintProject(root);
  assert.equal(before.fresh.length, 1);
  assert.equal(before.fresh[0].file, 'src/components/One.tsx');
  initBaseline(root);
  const frozen = lintProject(root);
  assert.deepEqual([frozen.found.length, frozen.baselined.length, frozen.fresh.length], [1, 1, 0]);
});

test('once frozen, a second string is the only new one, and a moved string is still the old one', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  initBaseline(root);
  write(root, 'src/components/One.tsx', `// a comment that moves everything down\n\n${TWO}`);
  const result = lintProject(root);
  assert.deepEqual([result.baselined.length, result.fresh.length], [1, 1]);
  assert.equal(result.fresh[0].text, 'Try again later');
});

test('the same string once more than the baseline holds is new', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  initBaseline(root);
  write(root, 'src/components/One.tsx', `${ONE}export const Again = () => <p>Nothing to show here</p>;\n`);
  const result = lintProject(root);
  assert.deepEqual([result.baselined.length, result.fresh.length], [1, 1]);
});

test('a string that was fixed leaves a stale baseline entry, which fails until the entry is removed', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  initBaseline(root);
  write(root, 'src/components/One.tsx', CLEAN);
  const result = lintProject(root);
  assert.deepEqual([result.fresh.length, result.stale.length], [0, 1]);
  assert.equal(result.stale[0].file, 'src/components/One.tsx');
  shrinkBaseline(root);
  const after = lintProject(root);
  assert.deepEqual([after.fresh.length, after.stale.length], [0, 0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'i18n-baseline.json'), 'utf8')).entries, []);
});

test('the baseline can be started once and can only shrink: it never takes in a new violation', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  initBaseline(root);
  assert.throws(() => initBaseline(root), /already/, 'a second start would be a way to forget what is new');
  write(root, 'src/components/One.tsx', TWO);
  assert.throws(() => shrinkBaseline(root), /new violation/, 'shrinking with a new string in the project is refused');
  const entries = JSON.parse(fs.readFileSync(path.join(root, 'i18n-baseline.json'), 'utf8')).entries;
  assert.equal(entries.length, 1, 'and the file is left as it was');
});

const hashOfWords = (words) => crypto.createHash('sha256').update(words, 'utf8').digest('hex').slice(0, 16);
const keyOfEntry = (entry) => `${entry.file}|${entry.rule}|${entry.hash}`;
const ascending = (a, b) => (keyOfEntry(a) < keyOfEntry(b) ? -1 : keyOfEntry(a) > keyOfEntry(b) ? 1 : 0);

test('the baseline file lists one entry per violation, with the file, the rule and the hash and nothing of the text', () => {
  // four sentences written into the file with the largest hash first, so that the order of the entries is the lint's doing and not the file's
  const sentences = ['Nothing to show here', 'Try again later', 'Open the settings', 'Choose a folder'].sort((a, b) => (hashOfWords(a) < hashOfWords(b) ? 1 : -1));
  const root = project({ 'src/components/Many.tsx': `${sentences.map((words, index) => `export const A${index} = () => <p>${words}</p>;`).join('\n')}\n` });
  initBaseline(root);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'i18n-baseline.json'), 'utf8'));
  assert.equal(file.entries.length, 4);
  for (const entry of file.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['file', 'hash', 'rule']);
    assert.equal(entry.file, 'src/components/Many.tsx');
    assert.equal(entry.rule, 'jsx-text');
  }
  assert.deepEqual(file.entries, [...file.entries].sort(ascending), 'sorted, so that a change to it reads as a change');
  assert.equal(fs.readFileSync(path.join(root, 'i18n-baseline.json'), 'utf8').split('\n').filter((line) => line.includes('"hash"')).length, 4, 'one line per entry');
});

test('the entries that are stale are listed in order, once for each time the string was frozen', () => {
  const root = project({ 'src/components/Clean.tsx': CLEAN });
  const entries = [{ file: 'src/b.tsx', rule: 'jsx-text', hash: 'ffffffffffffffff' }, { file: 'src/a.tsx', rule: 'label-map', hash: '0000000000000001' }, { file: 'src/a.tsx', rule: 'jsx-text', hash: '0000000000000002' }, { file: 'src/a.tsx', rule: 'jsx-text', hash: '0000000000000002' }];
  write(root, 'i18n-baseline.json', JSON.stringify({ version: 1, entries }));
  const result = lintProject(root);
  assert.equal(result.stale.length, 4, 'two entries for one string are two stale entries');
  assert.deepEqual(result.stale, [...result.stale].sort(ascending), 'and they come sorted');
  assert.deepEqual(result.stale.map(keyOfEntry), ['src/a.tsx|jsx-text|0000000000000002', 'src/a.tsx|jsx-text|0000000000000002', 'src/a.tsx|label-map|0000000000000001', 'src/b.tsx|jsx-text|ffffffffffffffff']);
});

test('a baseline that shrank to nothing is written as an empty list', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  initBaseline(root);
  write(root, 'src/components/One.tsx', CLEAN);
  shrinkBaseline(root);
  assert.equal(fs.readFileSync(path.join(root, 'i18n-baseline.json'), 'utf8').replace(/\r\n/g, '\n'), '{\n  "version": 1,\n  "entries": []\n}\n');
});

test('what the allowlist lets through is not written into the baseline, and shrinking keeps exactly the rest', () => {
  const root = project({ 'src/components/Two.tsx': TWO });
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ text: 'Try again later', reason: 'a made-up deliberate exception' }] }));
  initBaseline(root);
  const entries = JSON.parse(fs.readFileSync(path.join(root, 'i18n-baseline.json'), 'utf8')).entries;
  assert.equal(entries.length, 1, 'only the string that is not allowed is frozen');
  write(root, 'src/components/Two.tsx', `${CLEAN}export const Three = () => <p>Try again later</p>;\n`);
  shrinkBaseline(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'i18n-baseline.json'), 'utf8')).entries, [], 'its string is gone: the entry goes');
});

test('the project can have no src and no files: nothing is found', () => {
  const root = project({ 'readme.txt': 'x' });
  const result = lintProject(root);
  assert.deepEqual([result.files, result.found.length, result.fresh.length, result.stale.length], [0, 0, 0, 0]);
});

test('the dictionaries are the one place for words: exactly these three files are not scanned', () => {
  const vietnamese = "export const viWords = { saved: 'Đã lưu', empty: 'Nothing was changed in this run' };\n";
  const root = project({ ...Object.fromEntries(DICTIONARY_FILES.map((name) => [name, vietnamese])), 'src/lib/i18n-other.ts': vietnamese });
  const result = lintProject(root);
  assert.equal(result.files, 1, 'one file was read for violations');
  assert.deepEqual(result.skipped, [...DICTIONARY_FILES].sort(), 'and the three dictionaries were left out, by name');
  assert.deepEqual([...new Set(result.found.map((violation) => violation.file))], ['src/lib/i18n-other.ts'], 'only the file that is not a dictionary has violations');
  assert.deepEqual(DICTIONARY_FILES, ['src/lib/i18n.ts', 'src/lib/i18n-agents.ts', 'src/lib/i18n-models.ts']);
});

test('files that are not source are not scanned: declaration files and anything outside src', () => {
  const root = project({ 'src/types.d.ts': "export const a = 'Không tìm thấy';\n", 'scripts/tool.ts': "export const a = 'Không tìm thấy';\n", 'tests/x.tsx': ONE, 'src/readme.md': 'Không tìm thấy' });
  assert.equal(lintProject(root).found.length, 0);
});

test('an allowlist entry lets one deliberate string through, and says why', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ text: 'Nothing to show here', reason: 'a made-up example of a deliberate exception' }] }));
  const result = lintProject(root);
  assert.deepEqual([result.found.length, result.allowlisted.length, result.baselined.length, result.fresh.length], [1, 1, 0, 0]);
});

test('an allowlist entry matches the words however they are spaced, and the baseline counts each of two equal strings', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ text: '  Nothing   to show\nhere ', reason: 'spaced out on purpose in this test' }] }));
  assert.equal(lintProject(root).allowlisted.length, 1);
  const twice = project({ 'src/components/Twice.tsx': 'export const A = () => <div><p>Try again</p><p>Try again</p></div>;\n' });
  initBaseline(twice);
  assert.equal(JSON.parse(fs.readFileSync(path.join(twice, 'i18n-baseline.json'), 'utf8')).entries.length, 2, 'one entry per violation');
  const result = lintProject(twice);
  assert.deepEqual([result.baselined.length, result.fresh.length, result.stale.length], [2, 0, 0]);
});

test('an allowlist entry can be limited to a file and a rule, and then lets nothing else through', () => {
  const root = project({ 'src/components/One.tsx': ONE, 'src/components/Other.tsx': ONE });
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ file: 'src/components/One.tsx', rule: 'jsx-text', text: 'Nothing to show here', reason: 'only this file may say it' }] }));
  const result = lintProject(root);
  assert.deepEqual(result.allowlisted.map((violation) => violation.file), ['src/components/One.tsx']);
  assert.deepEqual(result.fresh.map((violation) => violation.file), ['src/components/Other.tsx']);
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ file: 'src/components/One.tsx', rule: 'jsx-attribute', text: 'Nothing to show here', reason: 'the wrong rule' }] }));
  assert.equal(lintProject(root).fresh.length, 2, 'another rule is not let through');
});

test('an allowlist entry without a reason is refused, and one that matches nothing is reported', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ text: 'Nothing to show here' }] }));
  assert.throws(() => lintProject(root), /reason/);
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ text: 'Nothing to show here', reason: 'x' }] }));
  assert.throws(() => lintProject(root), /reason/, 'a reason of one letter is no reason');
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ text: 'A string that is not there', reason: 'a leftover from a string that was fixed' }] }));
  const result = lintProject(root);
  assert.equal(result.staleAllow.length, 1);
  assert.equal(result.fresh.length, 1);
});

test('a baseline or an allowlist that is not the shape the lint reads is refused, not read as empty', () => {
  const root = project({ 'src/components/Clean.tsx': CLEAN });
  const entry = '{"file": "src/a.tsx", "rule": "jsx-text", "hash": "0123456789abcdef"}';
  write(root, 'i18n-baseline.json', '{"version": 1}');
  assert.throws(() => lintProject(root), /baseline/);
  write(root, 'i18n-baseline.json', '{"version": 1, "entries": [{"file": "a"}]}');
  assert.throws(() => lintProject(root), /baseline/);
  write(root, 'i18n-baseline.json', 'not json');
  assert.throws(() => lintProject(root), /baseline/);
  write(root, 'i18n-baseline.json', `{"version": 2, "entries": [${entry}]}`);
  assert.throws(() => lintProject(root), /baseline/, 'another version');
  write(root, 'i18n-baseline.json', `{"entries": [${entry}]}`);
  assert.throws(() => lintProject(root), /baseline/, 'no version');
  write(root, 'i18n-baseline.json', '{"version": 1, "entries": [{"file": "src/a.tsx", "rule": "no-such-rule", "hash": "0123456789abcdef"}]}');
  assert.throws(() => lintProject(root), /baseline/, 'a rule that does not exist');
  write(root, 'i18n-baseline.json', '{"version": 1, "entries": [{"file": "src/a.tsx", "rule": "jsx-text", "hash": "xyz"}]}');
  assert.throws(() => lintProject(root), /baseline/, 'a hash that is not 16 hex digits');
  write(root, 'i18n-baseline.json', '{"version": 1, "entries": [{"file": 7, "rule": "jsx-text", "hash": "0123456789abcdef"}]}');
  assert.throws(() => lintProject(root), /baseline/, 'a file that is not a name');
  write(root, 'i18n-baseline.json', '{"version": 1, "entries": [null]}');
  assert.throws(() => lintProject(root), /baseline/, 'an entry that is nothing');
  write(root, 'i18n-baseline.json', '{"version": 1, "entries": []}');
  write(root, 'i18n-allow.json', '{"version": 1}');
  assert.throws(() => lintProject(root), /allowlist/);
  write(root, 'i18n-allow.json', '{"entries": []}');
  assert.throws(() => lintProject(root), /allowlist/, 'no version');
  write(root, 'i18n-allow.json', '{"version": 3, "entries": []}');
  assert.throws(() => lintProject(root), /allowlist/, 'another version');
  write(root, 'i18n-allow.json', '{"version": 1, "entries": [{"reason": "a reason that is long enough"}]}');
  assert.throws(() => lintProject(root), /allowlist entry/, 'an entry with no text');
  write(root, 'i18n-allow.json', '{"version": 1, "entries": [{"text": "   ", "reason": "a reason that is long enough"}]}');
  assert.throws(() => lintProject(root), /allowlist entry/, 'an entry with blank text');
  write(root, 'i18n-allow.json', '{"version": 1, "entries": [{"text": "x y", "rule": "no-such-rule", "reason": "a reason that is long enough"}]}');
  assert.throws(() => lintProject(root), /rule that does not exist/);
  write(root, 'i18n-allow.json', '{"version": 1, "entries": [null]}');
  assert.throws(() => lintProject(root), /allowlist entry/, 'an entry that is nothing');
  write(root, 'i18n-allow.json', 'not json');
  assert.throws(() => lintProject(root), /allowlist/);
});

// ---- the self-test --------------------------------------------------------------------------------------------------------------------------------

test('the self-test seeds one violation of each shape and catches them all, and stays quiet on the clean fixtures', () => {
  const result = selfTest();
  assert.equal(result.ok, true, JSON.stringify(result.cases.filter((c) => !c.ok)));
  const caught = new Set(result.cases.filter((c) => c.seeded && c.ok).map((c) => c.rule));
  assert.deepEqual([...caught].sort(), [...RULES].sort(), 'every rule has a fixture that it catches');
  assert.ok(result.cases.some((c) => !c.seeded && c.ok), 'and clean fixtures that it does not flag');
});

test('the self-test can fail: a lint that finds nothing, or flags everything, does not pass it', () => {
  const blind = selfTest(() => []);
  assert.equal(blind.ok, false);
  assert.ok(blind.cases.filter((c) => c.seeded).every((c) => !c.ok), 'every seeded shape is reported as missed');
  const noisy = selfTest((text, file) => findViolations(`${text}\nconst Extra = () => <p>Another hard-coded sentence</p>;`, file));
  assert.equal(noisy.ok, false, 'a violation that is found where none was seeded fails the clean fixtures');
  assert.ok(noisy.cases.filter((c) => !c.seeded).length >= 2 && noisy.cases.filter((c) => !c.seeded).every((c) => !c.ok), 'every clean fixture that is flagged fails');
  assert.ok(noisy.cases.filter((c) => c.seeded).every((c) => !c.ok), 'and a seeded shape that is found together with another violation is not clean either');
  const confused = selfTest((text, file) => findViolations(text, file).map((violation) => ({ ...violation, rule: 'jsx-text' })));
  assert.equal(confused.ok, false, 'a detector that finds the violations under the wrong rule does not pass');
  assert.deepEqual(confused.cases.filter((c) => c.ok && c.seeded).map((c) => c.rule), ['jsx-text'], 'only the fixture of the rule it names passes');
});

test('the self-test report names each fixture, and its exit code is 1 as soon as one is wrong', () => {
  const good = selfTestReport();
  assert.equal(good.code, 0);
  for (const rule of RULES) assert.ok(good.lines.some((line) => new RegExp(`^caught +${rule} `).test(line)), `a line for ${rule}`);
  assert.ok(good.lines.some((line) => /^clean +- /.test(line)), 'and for the clean fixtures');
  assert.match(good.lines.at(-1), /every seeded shape is caught/);
  const blind = selfTestReport(() => []);
  assert.equal(blind.code, 1);
  assert.ok(blind.lines.some((line) => /^WRONG +jsx-text .*\(found: nothing\)$/.test(line)), 'what a shape was found as, when it was not found');
  const confused = selfTestReport((text, file) => findViolations(text, file).map((violation) => ({ ...violation, rule: 'label-map' })));
  assert.ok(confused.lines.some((line) => /^WRONG +jsx-text .*\(found: label-map\)$/.test(line)), 'and what it was found as, when it was found as another');
  assert.match(blind.lines.at(-1), /self-test: FAILED/);
});

test('the command runs the self-test and says what it caught', () => {
  const run = spawnSync(process.execPath, [path.join(ui, 'scripts', 'lint-i18n.mjs'), '--self-test'], { cwd: ui, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  for (const rule of RULES) assert.match(run.stdout, new RegExp(`caught +${rule}`), `the output names ${rule}`);
});

test('the command exits 1 on a new violation, names where it is, and says how to fix it', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  const run = spawnSync(process.execPath, [path.join(ui, 'scripts', 'lint-i18n.mjs'), '--root', root], { cwd: ui, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout + run.stderr, /src\/components\/One\.tsx:1:\d+ +jsx-text +"Nothing to show here"/);
  assert.match(run.stdout + run.stderr, /t\('key'\)/, 'the way out is named: put the words in the dictionaries and ask for them with t');
});

test('the command exits 0 on a project with no new violation and prints the numbers', () => {
  const root = project({ 'src/components/One.tsx': ONE });
  initBaseline(root);
  const run = spawnSync(process.execPath, [path.join(ui, 'scripts', 'lint-i18n.mjs'), '--root', root], { cwd: ui, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /1 found, 0 allowlisted, 1 in the baseline, 0 new/);
});

const lintCommand = (...args) => spawnSync(process.execPath, [path.join(ui, 'scripts', 'lint-i18n.mjs'), ...args], { cwd: ui, encoding: 'utf8' });

test('the command starts the baseline once, and shrinks it, and says so', () => {
  const root = project({ 'src/components/Two.tsx': TWO });
  const started = lintCommand('--root', root, '--init-baseline');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(started.stdout, /wrote i18n-baseline\.json/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'i18n-baseline.json'), 'utf8')).entries.length, 2);
  const again = lintCommand('--root', root, '--init-baseline');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  write(root, 'src/components/Two.tsx', ONE);
  const stale = lintCommand('--root', root);
  assert.equal(stale.status, 1, 'a baseline entry whose string is gone fails');
  assert.match(stale.stdout, /Baseline entries whose string is gone \(1\)/);
  const shrunk = lintCommand('--root', root, '--shrink-baseline');
  assert.equal(shrunk.status, 0, shrunk.stdout + shrunk.stderr);
  assert.match(shrunk.stdout, /shrank i18n-baseline\.json/);
  assert.equal(lintCommand('--root', root).status, 0);
  write(root, 'src/components/Two.tsx', TWO);
  const refused = lintCommand('--root', root, '--shrink-baseline');
  assert.equal(refused.status, 1, 'with a new violation in the project the baseline is not shrunk');
  assert.match(refused.stderr, /new violation/);
});

test('the command says which allowlist entries match nothing', () => {
  const root = project({ 'src/components/Clean.tsx': CLEAN });
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ text: 'Gone words', reason: 'a leftover from a string that was fixed' }] }));
  const run = lintCommand('--root', root);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Allowlist entries that match nothing \(1\)/);
  assert.match(run.stdout, /"Gone words"/);
});

test('the command prints the numbers per rule with --report', () => {
  const root = project({ 'src/components/One.tsx': 'export const A = () => <p title="Close the panel">Nothing to show here</p>;\n' });
  initBaseline(root);
  const run = lintCommand('--root', root, '--report');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  for (const rule of RULES) assert.match(run.stdout, new RegExp(`${rule} +found +\\d+ +allowlisted +\\d+ +baselined +\\d+ +new +\\d+`), rule);
  assert.match(run.stdout, /jsx-text +found +1 +allowlisted +0 +baselined +1 +new +0/);
  assert.match(run.stdout, /jsx-attribute +found +1 +allowlisted +0 +baselined +1 +new +0/);
  assert.match(run.stdout, /call-argument +found +0 +allowlisted +0 +baselined +0 +new +0/);
});

test('the command lists every violation with where it is and what became of it, with --list', () => {
  const root = project({ 'src/components/Many.tsx': 'export const A = () => <p title="Close the panel">Nothing to show here<b>Try again</b></p>;\n' });
  write(root, 'i18n-allow.json', JSON.stringify({ version: 1, entries: [{ text: 'Try again', reason: 'a made-up deliberate exception' }] }));
  initBaseline(root);
  const source = 'export const A = () => <p title="Close the panel">Nothing to show here<b>Try again</b><i>Brand new words</i></p>;\n';
  write(root, 'src/components/Many.tsx', source);
  const run = lintCommand('--root', root, '--list');
  assert.equal(run.status, 1, 'the new one still fails the command');
  const at = (words) => `src/components/Many.tsx:1:${source.indexOf(words) + 1}`;
  const rows = run.stdout.split('\n').filter((line) => /^(new|baselined|allowlisted) /.test(line)).map((line) => line.replace(/\s+/g, ' '));
  assert.deepEqual(rows, [
    `baselined ${at('"Close the panel"')} jsx-attribute "Close the panel"`,
    `baselined ${at('Nothing to show here')} jsx-text "Nothing to show here"`,
    `allowlisted ${at('Try again')} jsx-text "Try again"`,
    `new ${at('Brand new words')} jsx-text "Brand new words"`,
  ]);
  const quiet = lintCommand('--root', root);
  assert.equal(quiet.stdout.split('\n').filter((line) => /^(new|baselined|allowlisted) /.test(line)).length, 0, 'without --list only the new ones are named');
});

test('the command exits 1 and says why when the baseline is not readable', () => {
  const root = project({ 'src/components/Clean.tsx': CLEAN, 'i18n-baseline.json': 'not json' });
  const run = lintCommand('--root', root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /baseline/);
});

// ---- this project ---------------------------------------------------------------------------------------------------------------------------------

test('this project has no hard-coded string that is not in the frozen baseline or the allowlist (this is what fails the build)', () => {
  const result = lintProject(ui);
  assert.ok(result.files > 100, `read ${result.files} files of src: a lint that reads nothing passes everything`);
  const list = (items) => items.map((violation) => `${violation.file}:${violation.line}:${violation.column} ${violation.rule} ${JSON.stringify(violation.text)}`).join('\n');
  assert.equal(result.fresh.length, 0, `new hard-coded strings: put the words in lib/i18n*.ts and use t(), or explain the exception in i18n-allow.json:\n${list(result.fresh)}`);
  assert.equal(result.stale.length, 0, `baseline entries whose string is gone: run node scripts/lint-i18n.mjs --shrink-baseline\n${result.stale.map((entry) => `${entry.file} ${entry.rule} ${entry.hash}`).join('\n')}`);
  assert.equal(result.staleAllow.length, 0, `allowlist entries that match nothing: remove them\n${result.staleAllow.map((entry) => JSON.stringify(entry.text)).join('\n')}`);
});

// The baseline is frozen: the tool never takes a violation in (--init-baseline is refused when the file exists, --shrink-baseline is refused while a violation is new). But the
// file is plain JSON, so a person, or an agent, can add an entry by hand next to a string they want to hide (the hash is the first 16 hex digits of the SHA-256 of the words),
// and nothing else would fail. This number is the freeze written where a review sees it: it is checked with equality, so every change of the baseline is also a change of this line.
const FROZEN_ENTRIES = 396;

test('the baseline has exactly the frozen number of entries: one added by hand, or one taken away, is seen', () => {
  const { entries } = JSON.parse(fs.readFileSync(path.join(ui, 'i18n-baseline.json'), 'utf8'));
  const more = entries.length - FROZEN_ENTRIES;
  const advice = more > 0
    ? `${more} more than the frozen ${FROZEN_ENTRIES}: a violation was taken into the baseline by hand. The baseline never grows: fix the string (put the words in the dictionaries and ask for them with t()) and remove the entry.`
    : `${-more} fewer than the frozen ${FROZEN_ENTRIES}. If strings were fixed, node scripts/lint-i18n.mjs --shrink-baseline drops exactly the entries whose string is gone: then set FROZEN_ENTRIES in tests/i18n-lint.test.mjs to ${entries.length}. If entries were only deleted, put them back (the project test above names the strings that became new).`;
  assert.equal(entries.length, FROZEN_ENTRIES, `i18n-baseline.json has ${entries.length} entries, ${advice}`);
});

test('every dictionary the lint skips is a file that exists, and no other file of lib is skipped', () => {
  for (const name of DICTIONARY_FILES) assert.ok(fs.existsSync(path.join(ui, name)), `${name} does not exist: the list of skipped files is out of date`);
  const lib = fs.readdirSync(path.join(ui, 'src', 'lib')).filter((name) => /^i18n.*\.ts$/.test(name)).map((name) => `src/lib/${name}`).sort();
  assert.deepEqual(lib, [...DICTIONARY_FILES].sort(), 'a new i18n file is either a dictionary (add it) or it is source (rename it)');
});

test('the baseline and the allowlist of this project are in the shape the lint writes and reads', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ui, 'i18n-baseline.json'), 'utf8'));
  assert.equal(baseline.version, 1);
  assert.ok(baseline.entries.length > 0, 'a frozen baseline with nothing in it would mean the project has no debt: say so by removing the file');
  for (const entry of baseline.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['file', 'hash', 'rule']);
    assert.ok(RULES.includes(entry.rule), entry.rule);
    assert.match(entry.hash, /^[0-9a-f]{16}$/);
    assert.ok(fs.existsSync(path.join(ui, entry.file)), `${entry.file} is in the baseline and does not exist`);
    assert.ok(!DICTIONARY_FILES.includes(entry.file), `${entry.file} is a dictionary`);
  }
  const allow = JSON.parse(fs.readFileSync(path.join(ui, 'i18n-allow.json'), 'utf8'));
  assert.equal(allow.version, 1);
  for (const entry of allow.entries) assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length >= 8, `the exception ${JSON.stringify(entry.text)} has no reason`);
});
