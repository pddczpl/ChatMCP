import test from 'node:test';
import assert from 'node:assert/strict';
import { fitDimensions, fitImage, fittedName, limitLabel, STEPS, IMAGE_LIMIT_BYTES, FILE_LIMIT_BYTES, FILES_PER_MESSAGE, TOTAL_LIMIT_BYTES } from '../src/lib/image-fit.ts';
import { ATTACHMENT_LIMITS, limitLabel as hubLimitLabel } from '../../lib/attachment-limits.mjs';

// An image that is over the limit of the Hub (it was 2 MB, it is 3.75 MB) used to be refused ("File image.png quá lớn") without saying what the limit was. A screenshot of a 4K or a scaled display is
// often a few MB as a PNG, and the person only pasted it. It is made smaller instead, in steps from the least loss to the most, and refused only when no step fits.
const MB = 1024 * 1024;
const file = (name, type, size) => ({ name, type, size });
/** A decoder that reads the size of the picture, and an encoder whose result size follows the area (PNG about 0.6 byte per pixel, JPEG 0.25 byte per pixel and per unit of quality). */
function tools({ width = 3000, height = 2000, png = 0.6, jpeg = 0.25, failDecode = false, failEncode = () => false } = {}) {
  const calls = [];
  return {
    calls,
    decode: async () => { calls.push(['decode']); if (failDecode) throw new Error('cannot decode'); return { width, height }; },
    encode: async (_file, w, h, type, quality) => {
      calls.push(['encode', type, w, h, quality]);
      if (failEncode(type, quality)) return null;
      const bytes = type === 'image/png' ? w * h * png : w * h * jpeg * (quality ?? 1);
      return { size: Math.round(bytes), type };
    },
  };
}

test('a picture is scaled to fit inside the longer side, never made larger', () => {
  assert.deepEqual(fitDimensions(4000, 2000, 2048), { width: 2048, height: 1024 });
  assert.deepEqual(fitDimensions(2000, 4000, 2048), { width: 1024, height: 2048 });
  assert.deepEqual(fitDimensions(1000, 500, 2048), { width: 1000, height: 500 }, 'a small picture is not enlarged');
  assert.deepEqual(fitDimensions(1, 5000, 2048), { width: 1, height: 2048 }, 'a side never becomes zero');
  assert.deepEqual(fitDimensions(2048, 2048, 2048), { width: 2048, height: 2048 });
});

test('the steps go from the least loss to the most, and each one is smaller than the one before', () => {
  assert.equal(STEPS[0].type, 'image/png', 'a screenshot keeps its sharp text as long as it can');
  assert.ok(STEPS.every((step) => step.side <= 2048));
  for (let i = 1; i < STEPS.length; i++) {
    const before = STEPS[i - 1], now = STEPS[i];
    assert.ok(now.side <= before.side && (now.type === 'image/jpeg'), `step ${i} is not larger than step ${i - 1}`);
    if (before.type === 'image/jpeg') assert.ok(now.quality <= before.quality, `the quality never goes back up (step ${i})`);
  }
});

test('the page refuses by the numbers the Hub enforces (lib/attachment-limits.mjs), written once there', () => {
  assert.equal(IMAGE_LIMIT_BYTES, ATTACHMENT_LIMITS.imageBytes, 'one picture');
  assert.equal(FILE_LIMIT_BYTES, ATTACHMENT_LIMITS.textBytes, 'one text file');
  assert.equal(FILES_PER_MESSAGE, ATTACHMENT_LIMITS.files, 'files in a message');
  assert.equal(TOTAL_LIMIT_BYTES, ATTACHMENT_LIMITS.totalBytes, 'all the files of a message');
  for (const bytes of [IMAGE_LIMIT_BYTES, FILE_LIMIT_BYTES, TOTAL_LIMIT_BYTES, 2 * MB, 999_999]) assert.equal(limitLabel(bytes), hubLimitLabel(bytes), `the same words for ${bytes} bytes`);
});

test('the first step that fits is the one used, and nothing after it is tried', async () => {
  const fake = tools({ width: 3000, height: 2000 }); // PNG at 2048 x 1365: 1.68 MB, under the limit
  const fitted = await fitImage(file('image.png', 'image/png', 5 * MB), IMAGE_LIMIT_BYTES, fake);
  assert.equal(fitted.type, 'image/png');
  assert.deepEqual({ width: fitted.width, height: fitted.height }, { width: 2048, height: 1365 });
  assert.deepEqual(fake.calls.map((call) => call[0]), ['decode', 'encode'], 'one decode, one encode');
});

test('when the PNG is still too large the next steps are tried in order until one fits', async () => {
  const fake = tools({ width: 3000, height: 2000, png: 3, jpeg: 1.8 }); // PNG 8.4 MB; JPEG 0.9 at 2048: 4.6 MB; JPEG 0.8 at 1600: 2.5 MB
  const fitted = await fitImage(file('image.png', 'image/png', 9 * MB), IMAGE_LIMIT_BYTES, fake);
  assert.equal(fitted.type, 'image/jpeg');
  assert.ok(fitted.blob.size <= IMAGE_LIMIT_BYTES);
  const encodes = fake.calls.filter((call) => call[0] === 'encode');
  assert.deepEqual(encodes.map((call) => [call[1], call[4]]), [['image/png', undefined], ['image/jpeg', 0.9], ['image/jpeg', 0.8]], 'in the order of the steps, and stops at the one that fits');
});

test('a picture that fits at no step is not returned, so that the person is told the limit', async () => {
  const fake = tools({ width: 6000, height: 4000, png: 9, jpeg: 12 }); // the last step, 1024 x 683, is still 5 MB at quality 0.6
  assert.equal(await fitImage(file('image.png', 'image/png', 30 * MB), IMAGE_LIMIT_BYTES, fake), null);
  assert.equal(fake.calls.filter((call) => call[0] === 'encode').length, STEPS.length, 'every step was tried');
});

test('a step that the browser cannot encode is skipped, not fatal', async () => {
  const fake = tools({ png: 3, jpeg: 1.2, failEncode: (type) => type === 'image/png' });
  const fitted = await fitImage(file('image.png', 'image/png', 9 * MB), IMAGE_LIMIT_BYTES, fake);
  assert.equal(fitted.type, 'image/jpeg');
});

test('a picture is never enlarged on the way: a small one keeps its size at every step', async () => {
  const fake = tools({ width: 800, height: 600, png: 40, jpeg: 20 }); // too heavy for its size, whatever the steps
  await fitImage(file('image.png', 'image/png', 3 * MB), IMAGE_LIMIT_BYTES, fake);
  for (const call of fake.calls.filter((entry) => entry[0] === 'encode')) assert.deepEqual([call[2], call[3]], [800, 600]);
});

test('a GIF (it may be animated: one frame would be all that is kept) and anything that is not a picture are left alone', async () => {
  for (const type of ['image/gif', 'text/plain', 'application/pdf', '']) {
    const fake = tools();
    assert.equal(await fitImage(file('x', type, 9 * MB), IMAGE_LIMIT_BYTES, fake), null, type || '(no type)');
    assert.deepEqual(fake.calls, [], `${type || '(no type)'}: not even decoded`);
  }
});

test('a picture that cannot be read at all says so (it is not "too large")', async () => {
  await assert.rejects(fitImage(file('image.png', 'image/png', 9 * MB), IMAGE_LIMIT_BYTES, tools({ failDecode: true })), /cannot decode/);
});

test('a limit is written the way a person reads it: 3.75 MB for a picture, 12 MB in all, 200 KB for a file (not 195,3 KB)', () => {
  assert.equal(limitLabel(IMAGE_LIMIT_BYTES), '3.75 MB');
  assert.equal(limitLabel(TOTAL_LIMIT_BYTES), '12 MB');
  assert.equal(limitLabel(FILE_LIMIT_BYTES), '200 KB');
  assert.equal(limitLabel(5 * 1024 * 1024), '5 MB');
  assert.equal(limitLabel(2 * 1024 * 1024), '2 MB');
});

test('a picture that became a JPEG is named like one, and any other name is kept', () => {
  assert.equal(fittedName('image.png', 'image/png'), 'image.png');
  assert.equal(fittedName('image.png', 'image/jpeg'), 'image.jpg');
  assert.equal(fittedName('photo.final.webp', 'image/jpeg'), 'photo.final.jpg');
  assert.equal(fittedName('screenshot', 'image/jpeg'), 'screenshot.jpg');
});
