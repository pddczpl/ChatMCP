import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml, accessibleName, byTag, byId, duplicateIds, unnamedControls, brokenReferences, byRole, visibleWords } from './support/html.mjs';

// The reader the component tests rely on has to be right about what a screen reader is told; these are its own checks.

const html = '<main><h3 id="t">Title</h3><label for="a">Goal</label><textarea id="a"></textarea><label>Wrapped <input type="checkbox"></label>'
  + '<button type="button" aria-label="Remove task 2">Remove</button><button type="button"><svg aria-hidden="true"></svg>Save</button><button></button>'
  + '<input id="b" aria-labelledby="t"><select id="c"></select><div role="status" id="s">A &amp; B <!-- -->done</div></main>';
const root = parseHtml(html);

test('the name of a control comes from aria-label, a label that points at it, a label that wraps it, or its text', () => {
  assert.equal(accessibleName(root, byId(root, 'a')), 'Goal');
  assert.equal(accessibleName(root, byTag(root, 'input')[0]), 'Wrapped');
  assert.equal(accessibleName(root, byTag(root, 'button')[0]), 'Remove task 2');
  assert.equal(accessibleName(root, byTag(root, 'button')[1]), 'Save');
  assert.equal(accessibleName(root, byId(root, 'b')), 'Title');
});

test('controls without a name are found, and decoration is not counted as one', () => {
  assert.deepEqual(unnamedControls(root).sort(), ['button', 'select#c']);
});

test('text is decoded and comments between text nodes are gone', () => {
  assert.equal(byRole(root, 'status')[0].text, 'A & B done');
});

test('a repeated id and a reference to an id that is not there are reported', () => {
  assert.deepEqual(duplicateIds(parseHtml('<p id="x"></p><p id="x"></p><p id="y"></p>')), ['x']);
  assert.deepEqual(brokenReferences(parseHtml('<button aria-controls="gone"></button><label for="a"></label><input id="a">')), ['button[aria-controls=gone]']);
});

test('void elements do not swallow what follows them', () => {
  const tree = parseHtml('<div><input id="i"><p id="after">x</p></div>');
  assert.equal(byId(tree, 'after').parent.tag, 'div');
});

test('the words of a render are its text and its titles, labels and placeholders, in page order', () => {
  const words = visibleWords('<section aria-label="Setup"><h2>Title</h2><input placeholder="Path..." aria-label="Folder"><button title="Close">X</button></section>');
  // an element's label, then its placeholder, then its title, then what is inside it
  assert.deepEqual(words, ['Setup', 'Title', 'Folder', 'Path...', 'Close', 'X']);
});

test('white space inside the text is one space, and the space at the edge of a piece of text stays, because it is the gap before the next element', () => {
  assert.deepEqual(visibleWords('<p>The Hub is using <strong>x / y</strong>.   Press\n   Save to apply </p><p>   </p>'), ['The Hub is using ', 'x / y', '. Press Save to apply ']);
  // a gap that is lost is a difference, and a text that is only white space is no word
  assert.notDeepEqual(visibleWords('<p>The Hub is using<strong>x</strong></p>'), visibleWords('<p>The Hub is using <strong>x</strong></p>'));
  assert.deepEqual(visibleWords('<ul> <li>a</li> <li>b</li> </ul>'), ['a', 'b']);
});

test('entities in the words are decoded', () => {
  assert.deepEqual(visibleWords('<p title="Tom &amp; Jerry&#x27;s">&quot;Hi&quot; &lt;you&gt;</p>'), ["Tom & Jerry's", '"Hi" <you>']);
});
