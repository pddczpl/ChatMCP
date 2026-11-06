import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNativeDialogs, sourcesUnder } from './support/native-dialogs.mjs';

// The page never opens a browser dialog: confirm(), alert() and prompt() are windows that cannot be styled, named for a screen reader, tested or kept inside the Hub's Content-Security-Policy
// story, and they stop the page while they are open. Every question goes through components/ui/ConfirmDialog.tsx (useConfirm). This reads the syntax tree of everything under src/, so a
// word in a comment, a string or a text of the page does not count, and a call counts however it is spelled.
const src = path.join(fileURLToPath(new URL('..', import.meta.url)), 'src');

test('the source of the page uses no native dialog', () => {
  const sources = sourcesUnder(src);
  assert.ok(sources.length > 100, `read the source: ${sources.length} files`);
  const used = sources.flatMap(({ file, text }) => findNativeDialogs(text, file).map((hit) => `${path.relative(src, file)}:${hit.line}  ${hit.text}`));
  assert.deepEqual(used, [], 'ask through useConfirm() (components/ui/ConfirmDialog.tsx) instead');
});

test('the scan can fail: every way of spelling a native dialog is found', () => {
  for (const code of [
    "if (!confirm('sure?')) return;",
    "window.alert('done');",
    "const answer = window.prompt('name');",
    "globalThis.confirm('x');",
    "self.confirm('x');",
    "window?.confirm?.('x');",
    "window['confirm']('x');",
    "globalThis[`alert`]('x');",
    "const { confirm } = window;",
    "const { prompt: ask } = globalThis;",
    "const sure = window.confirm;",
    "export const f = async () => { if (!(await Promise.resolve(confirm('x')))) return; };",
    "top.alert('x');",
  ]) assert.equal(findNativeDialogs(code, 'x.ts').length, 1, `found: ${code}`);
  assert.equal(findNativeDialogs("export function A() { return <button onClick={() => confirm('x')}>go</button>; }", 'x.tsx').length, 1, 'found inside JSX');
  assert.deepEqual(findNativeDialogs("alert('a'); confirm('b');\nprompt('c');", 'x.ts').map((hit) => hit.line), [1, 1, 2], 'with the line of each');
});

test('the scan does not cry wolf: a word is not a call', () => {
  for (const code of [
    "// confirm('this is a comment')\n/* window.alert('so is this') */",
    "const text = \"call confirm() or prompt() or window.alert()\";",
    "const tpl = `confirm(${1})`;",
    "export const A = () => <p>Please confirm() before alert()</p>;",
    "const ask = useConfirm(); await ask({ title: 'x', confirmLabel: 'y' });",
    "const options = { confirm: true, alert: false, prompt: 'x' }; options.confirm = false;",
    "type Props = { confirm(): void; alert: string };",
    "interface Dialog { prompt(): void }",
    "dialog.confirm();",
    "this.alert('x');",
    "function confirmAll() {}\nconfirmAll();",
    "const confirmLabel = 'x'; promptUser(confirmLabel);",
    "import { alert as notify } from './toast'; notify('x');",
  ]) assert.deepEqual(findNativeDialogs(code, 'x.tsx'), [], `not found: ${code.slice(0, 60)}`);
});
