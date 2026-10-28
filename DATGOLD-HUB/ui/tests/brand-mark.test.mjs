import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The mark in the top bar of the app is the icon of DatGold: a gold "D" on a dark rounded square, the same drawing as the icon of the application, the setup and the browser tab
// (scripts/generate-brand-icon.py). It was still the letter "C" of the old name on a blue square. The real Header and the real mark are rendered; what is pinned is what a person sees.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { BrandMark } from './src/components/layout/BrandMark';
  import { Header } from './src/components/layout/Header';
  function TwoMarks() { return React.createElement('div', null, React.createElement(BrandMark, {}), React.createElement(BrandMark, {})); }
  export { BrandMark, Header, TwoMarks };
`, 'chatmcp-brand-mark-');
after(dispose);
const { renderWith, BrandMark, Header, TwoMarks } = loaded;

// The D of the icon: 440 wide and 512 tall, its strokes 128 thick. An outer shape with a half circle (radius 256) on its right, and the counter of the same kind (radius 128) cut out of it.
const D_OUTLINE = 'M304 256H488A256 256 0 0 1 488 768H304ZM432 384H488A128 128 0 0 1 488 640H432Z';

/** The attributes of the `nth` element of this tag in the markup, as an object. */
function tag(html, name, nth = 0) {
  const found = [...html.matchAll(new RegExp(`<${name} ([^>]*)>`, 'g'))][nth];
  assert.ok(found, `<${name}> number ${nth} is in the drawing`);
  return Object.fromEntries([...found[1].matchAll(/([A-Za-z0-9-]+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]));
}

/** One of the two gradients of a mark (`gold` or `slate`): its id, its attributes (without the id) and its stops as [offset, colour]. */
function gradient(html, which) {
  const match = html.match(new RegExp(`<linearGradient id="([^"]+-${which})"([^>]*)>(.*?)</linearGradient>`));
  assert.ok(match, `the ${which} gradient is in the drawing`);
  const attributes = Object.fromEntries([...match[2].matchAll(/([A-Za-z0-9]+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]));
  const stops = [...match[3].matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"/g)].map((pair) => [Number(pair[1]), pair[2].toLowerCase()]);
  return { id: match[1], attributes, stops };
}

test('the mark is an image the caller sizes, hidden from screen readers, with no text in it', async () => {
  const html = await renderWith(BrandMark, { className: 'h-6 w-6' });
  assert.match(html, /^<svg /, 'one svg');
  assert.match(html, /aria-hidden="true"/, 'it decorates the name beside it: a screen reader reads "DatGold", not a picture');
  assert.match(html, /class="h-6 w-6"/, 'the size is the caller\'s');
  assert.match(html, /data-testid="brand-mark"/);
  assert.doesNotMatch(html, /<text|>C</, 'no letter: the old mark was the letter C');
});

test('the colours are the gold of the icon on the dark of the icon, and each shape is filled with its own', async () => {
  const html = await renderWith(BrandMark, {});
  const gold = gradient(html, 'gold');
  assert.deepEqual(gold.stops, [[0, '#ffe28a'], [0.5, '#f2b416'], [1, '#b07004']], 'the gold of the icon: pale at the top, amber, deep amber at the bottom');
  assert.deepEqual(gold.attributes, { gradientUnits: 'userSpaceOnUse', x1: '0', y1: '256', x2: '0', y2: '768' }, 'the gold runs down the letter, from its top (256) to its bottom (768)');
  const slate = gradient(html, 'slate');
  assert.deepEqual(slate.stops, [[0, '#111827'], [0.5, '#0d1220'], [1, '#090d1a']], 'the dark of the square: a little lighter at the top');
  assert.deepEqual(slate.attributes, { x1: '0', y1: '0', x2: '0', y2: '1' }, 'the dark runs down the square');
  assert.equal(tag(html, 'rect', 0).fill, `url(#${slate.id})`, 'the rounded square is filled with the dark');
  assert.equal(tag(html, 'path').fill, `url(#${gold.id})`, 'the D is filled with the gold');
});

test('the drawing: a rounded square that fills the picture, a thin gold rim inside its edge, and the D of the icon', async () => {
  const html = await renderWith(BrandMark, {});
  const [x, y, width, height] = tag(html, 'svg').viewBox.split(' ').map(Number);
  const square = tag(html, 'rect', 0);
  assert.deepEqual([square.x, square.y, square.width, square.height].map(Number), [x, y, width, height], 'the dark square fills the picture to its edges: no margin, as the blue square of the letter C had none');
  assert.ok(Number(square.rx) > 0, 'its corners are rounded');
  assert.equal(square.stroke, undefined, 'the rim is a shape of its own, so that all of it is drawn over the dark and none of it over the page behind');

  const rim = tag(html, 'rect', 1);
  assert.equal(rim.fill, 'none', 'the rim is a line, not a second square');
  assert.equal(rim.stroke, '#f2b416', 'in the amber of the icon');
  assert.equal(rim['stroke-opacity'], '0.6', 'and softened, as in the icon');
  const half = Number(rim['stroke-width']) / 2;
  assert.ok(half > 0, 'it has a width');
  assert.ok(Number(rim.x) - half >= x && Number(rim.y) - half >= y, 'the rim is inside the top and left edges of the square');
  assert.ok(Number(rim.x) + Number(rim.width) + half <= x + width && Number(rim.y) + Number(rim.height) + half <= y + height, 'and inside the bottom and right edges');

  const letter = tag(html, 'path');
  assert.equal(letter['fill-rule'], 'evenodd', 'the counter of the D is a hole, not a second disc on top');
  assert.equal(letter.d, D_OUTLINE, 'the outline is the D of the icon');
});

test('two marks on one page do not share the ids of their gradients (a hidden or removed one must not blank the other)', async () => {
  const html = await renderWith(TwoMarks, {});
  const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 4, 'two gradients in each mark');
  assert.equal(new Set(ids).size, 4, `every id is its own: ${ids.join(' ')}`);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/, `an id that url(#...) can name without escaping: ${id}`);
  for (const [, id] of html.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(id), `url(#${id}) names a gradient that is there`);
});

test('the top bar draws the mark and not the letter C, and still says DatGold', async () => {
  const html = await renderWith(Header, {}, [[['hubState'], { initialized: true, workspace: '' }]]);
  assert.match(html, /<svg [^>]*class="h-6 w-6 shrink-0"[^>]*data-testid="brand-mark"/, 'the gold D is in the top bar, at the size the letter had, and does not shrink in a narrow bar');
  assert.doesNotMatch(html, /bg-gradient-to-br[^>]*>C<\/span>/, 'the blue square with the letter C is gone');
  assert.match(html, /DatGold/, 'the name is still beside the mark');
});
