import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DICTIONARY_FILES, RULES, findViolations, fingerprint, initBaseline, lintProject, selfTest, shrinkBaseline } from '../scripts/lint-i18n.mjs';

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

test('the baseline file lists one entry per violation, with the file, the rule and the hash and nothing of the text', () => {
  const root = project({ 'src/components/Two.tsx': TWO });
  initBaseline(root);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'i18n-baseline.json'), 'utf8'));
  assert.equal(file.entries.length, 2);
  for (const entry of file.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['file', 'hash', 'rule']);
    assert.equal(entry.file, 'src/components/Two.tsx');
    assert.equal(entry.rule, 'jsx-text');
  }
  const keyOf = (entry) => `${entry.file}|${entry.rule}|${entry.hash}`;
  assert.deepEqual(file.entries, [...file.entries].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0)), 'sorted, so that a change to it reads as a change');
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
  write(root, 'i18n-baseline.json', '{"version": 1}');
  assert.throws(() => lintProject(root), /baseline/);
  write(root, 'i18n-baseline.json', '{"version": 1, "entries": [{"file": "a"}]}');
  assert.throws(() => lintProject(root), /baseline/);
  write(root, 'i18n-baseline.json', 'not json');
  assert.throws(() => lintProject(root), /baseline/);
  write(root, 'i18n-baseline.json', '{"version": 1, "entries": []}');
  write(root, 'i18n-allow.json', '{"version": 1}');
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

// ---- this project ---------------------------------------------------------------------------------------------------------------------------------

test('this project has no hard-coded string that is not in the frozen baseline or the allowlist (this is what fails the build)', () => {
  const result = lintProject(ui);
  assert.ok(result.files > 100, `read ${result.files} files of src: a lint that reads nothing passes everything`);
  const list = (items) => items.map((violation) => `${violation.file}:${violation.line}:${violation.column} ${violation.rule} ${JSON.stringify(violation.text)}`).join('\n');
  assert.equal(result.fresh.length, 0, `new hard-coded strings: put the words in lib/i18n*.ts and use t(), or explain the exception in i18n-allow.json:\n${list(result.fresh)}`);
  assert.equal(result.stale.length, 0, `baseline entries whose string is gone: run node scripts/lint-i18n.mjs --shrink-baseline\n${result.stale.map((entry) => `${entry.file} ${entry.rule} ${entry.hash}`).join('\n')}`);
  assert.equal(result.staleAllow.length, 0, `allowlist entries that match nothing: remove them\n${result.staleAllow.map((entry) => JSON.stringify(entry.text)).join('\n')}`);
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
