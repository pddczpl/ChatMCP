// Finds the browser's own dialogs (alert, confirm, prompt) in the source of the page, from its syntax tree, so that a word in a comment, a string or a JSX text is never mistaken for a call
// and a call is never missed for how it is spelled: confirm(...), window.confirm(...), globalThis['prompt'](...), window?.alert(...), const { confirm } = window.
// The page asks through components/ui/ConfirmDialog.tsx: a native dialog is a window the Hub's page cannot style, name for a screen reader or test.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const DIALOGS = new Set(['alert', 'confirm', 'prompt']);
const GLOBALS = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames']);

const isDialogName = (node) => (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && DIALOGS.has(node.text);
const isGlobal = (node) => ts.isIdentifier(node) && GLOBALS.has(node.text);

/** Every place in `text` that uses a native dialog: `{ line, text }` for each. `fileName` decides how the text is read (.tsx reads JSX). */
export function findNativeDialogs(text, fileName = 'file.tsx') {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const note = (node) => found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.getText(source).slice(0, 80) });
  const visit = (node) => {
    // confirm(...), alert(...), prompt(...): a bare name that is called
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && DIALOGS.has(node.expression.text)) note(node);
    // window.confirm, window?.confirm, globalThis.alert ...: the name read from a global object, called or not
    else if (ts.isPropertyAccessExpression(node) && isGlobal(node.expression) && DIALOGS.has(node.name.text)) note(node);
    // window['confirm']
    else if (ts.isElementAccessExpression(node) && isGlobal(node.expression) && isDialogName(node.argumentExpression)) note(node);
    // const { confirm } = window
    else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isGlobal(node.initializer)
      && node.name.elements.some((element) => DIALOGS.has((element.propertyName ?? element.name).getText(source)))) note(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The .ts and .tsx files under a folder, with their text. */
export function sourcesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [{ file: full, text: fs.readFileSync(full, 'utf8') }] : [];
  });
}
