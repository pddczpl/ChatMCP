// A pasted screenshot over the limit of the Hub (2 MB) is made smaller and attached instead of refused, and a file that cannot be made smaller is refused with the limit written in the
// message. Reported on 2026-10-28: "File image.png quá lớn." for a screenshot, with no word about the limit. The page is the production build and the Hub and its routes are real; the
// model is scripted. The canvas that makes the picture smaller exists only in a browser, which is why this is a browser test.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { say } from '../../tests/e2e/scenarios.mjs';

const MB = 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
const crc32 = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** A PNG of random noise (8-bit RGB): far over 2 MB, and as noise it is no smaller as a smaller PNG, so only a JPEG step can make it fit. */
function noisePng(width, height) {
  const row = 1 + width * 3;
  const raw = crypto.randomFillSync(Buffer.alloc(row * height));
  for (let y = 0; y < height; y++) raw[y * row] = 0; // filter type "none" at the start of each row
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

test('a screenshot over 2 MB is made smaller and attached, and what reaches the Hub fits its limit', async ({ page, app }) => {
  app.mock.define('image-seen', () => say('Đã nhận ảnh.'));
  app.mock.setScenario('image-seen');
  await onboard(page, app);
  const png = noisePng(2600, 1800);
  expect(png.length, 'the picture is over the limit before the page touches it').toBeGreaterThan(2 * MB);

  await page.locator('input[type="file"]').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText(/quá lớn nên đã được thu nhỏ còn/)).toBeVisible();
  await expect(page.getByLabel('Tệp đính kèm').getByText('image.jpg')).toBeVisible();

  const started = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/tasks/start' && request.method() === 'POST');
  await send(page, 'Ảnh này có gì?');
  const [attachment] = (await started).postDataJSON().attachments;
  expect(attachment.mimeType).toBe('image/jpeg');
  expect(attachment.name, 'a picture that became a JPEG is named like one').toBe('image.jpg');
  const bytes = Buffer.from(attachment.dataBase64, 'base64');
  expect(bytes.length, 'what is sent is under the limit of the Hub').toBeLessThanOrEqual(2 * MB);
  expect(attachment.size).toBe(bytes.length);
  expect([...bytes.subarray(0, 3)], 'and it is a JPEG').toEqual([0xff, 0xd8, 0xff]);
  const task = await taskByPrompt(app, 'Ảnh này có gì?');
  expect(task, 'the Hub took it (no 413)').toBeTruthy();
});

test('a picture that is small enough is sent as it is, byte for byte', async ({ page, app }) => {
  app.mock.define('image-seen', () => say('Đã nhận ảnh.'));
  app.mock.setScenario('image-seen');
  await onboard(page, app);
  const small = noisePng(64, 64);
  expect(small.length).toBeLessThan(2 * MB);
  await page.locator('input[type="file"]').setInputFiles({ name: 'small.png', mimeType: 'image/png', buffer: small });
  await expect(page.getByLabel('Tệp đính kèm').getByText('small.png')).toBeVisible();
  const started = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/tasks/start' && request.method() === 'POST');
  await send(page, 'Ảnh nhỏ');
  const [attachment] = (await started).postDataJSON().attachments;
  expect(attachment.mimeType).toBe('image/png');
  expect(Buffer.from(attachment.dataBase64, 'base64').equals(small), 'the picture is not re-encoded when it fits').toBe(true);
});

test('what cannot be made smaller is refused, and the message says the limit', async ({ page, app }) => {
  await onboard(page, app);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(300_000, 'a') });
  await expect(page.getByText('File big.txt quá lớn (tối đa 200 KB).')).toBeVisible();
  await input.setInputFiles({ name: 'film.gif', mimeType: 'image/gif', buffer: Buffer.alloc(3 * MB, 1) });
  await expect(page.getByText('File film.gif quá lớn (tối đa 2 MB).')).toBeVisible();
  await expect(page.getByLabel('Tệp đính kèm')).toHaveCount(0);
});
