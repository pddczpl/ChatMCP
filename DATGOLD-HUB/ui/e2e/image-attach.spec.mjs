// A pasted screenshot over the limit of the Hub (3.75 MB, it was 2 MB) is made smaller and attached instead of refused, and a file that cannot be made smaller is refused with the limit written in the
// message and the way around it (the project folder). Reported on 2026-10-28: "File image.png quá lớn." for a screenshot, with no word about the limit. Behind it, found the same day with a real Hub
// and a scripted model: the Hub counted the base64 of a picture as text, so a picture of 600 KB or more was taken out of the request when the model's window was known, and one of 100 KB when
// it was not, and the task still ended "completed". The page is the production build and the Hub and its routes are real; the model is scripted. The canvas that makes the picture smaller exists
// only in a browser, which is why this is a browser test.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { say } from '../../tests/e2e/scenarios.mjs';
import { connectModel } from '../../tests/e2e/hub-process.mjs';

const MB = 1024 * 1024;
const IMAGE_LIMIT = 3.75 * MB;

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
/** A PNG of random noise (8-bit RGB): far over the limit, and as noise it is no smaller as a smaller PNG, so only a JPEG step can make it fit. */
function noisePng(width, height) {
  const row = 1 + width * 3;
  const raw = crypto.randomFillSync(Buffer.alloc(row * height));
  for (let y = 0; y < height; y++) raw[y * row] = 0; // filter type "none" at the start of each row
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
/** A file the page takes as a picture it cannot make smaller (a GIF may be animated, so it is sent as it is). Its bytes are random: the Hub does not read a picture, the provider does. */
const gif = (name, bytes) => ({ name, mimeType: 'image/gif', buffer: crypto.randomBytes(bytes) });

/** The first request the scripted model received: what it was sent in bytes. A request that held a picture of N bytes of base64 is longer than N. */
async function firstModelRequestBytes(app) {
  await expect.poll(() => app.mock.state.requests.length, { message: 'the model was asked' }).toBeGreaterThan(0);
  return app.mock.state.requests[0].bytes;
}

test('a screenshot over 3.75 MB is made smaller and attached, what reaches the Hub fits its limit, and the model gets it', async ({ page, app }) => {
  app.mock.define('image-seen', () => say('Đã nhận ảnh.'));
  app.mock.setScenario('image-seen');
  await onboard(page, app);
  const png = noisePng(3000, 2200);
  expect(png.length, 'the picture is over the limit before the page touches it').toBeGreaterThan(IMAGE_LIMIT);

  await page.locator('input[type="file"]').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText(/^Ảnh image\.png \(.+\) quá lớn nên đã được thu nhỏ còn .+ để gửi\.$/), 'the toast names the picture as it was sent').toBeVisible();
  await expect(page.getByLabel('Tệp đính kèm').getByText('image.jpg')).toBeVisible();

  app.mock.setScenario('image-seen'); // the requests of the connection check are not the task's
  const started = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/tasks/start' && request.method() === 'POST');
  await send(page, 'Ảnh này có gì?');
  const [attachment] = (await started).postDataJSON().attachments;
  expect(attachment.mimeType).toBe('image/jpeg');
  expect(attachment.name, 'a picture that became a JPEG is named like one').toBe('image.jpg');
  const bytes = Buffer.from(attachment.dataBase64, 'base64');
  expect(bytes.length, 'what is sent is under the limit of the Hub').toBeLessThanOrEqual(IMAGE_LIMIT);
  expect(attachment.size).toBe(bytes.length);
  expect([...bytes.subarray(0, 3)], 'and it is a JPEG').toEqual([0xff, 0xd8, 0xff]);
  const task = await taskByPrompt(app, 'Ảnh này có gì?');
  expect(task, 'the Hub took it (no 413)').toBeTruthy();
  expect(await firstModelRequestBytes(app), 'and the request to the model holds the picture (the model\'s window is not known here)').toBeGreaterThan(attachment.dataBase64.length);
});

test('a picture that is small enough is sent as it is, byte for byte', async ({ page, app }) => {
  app.mock.define('image-seen', () => say('Đã nhận ảnh.'));
  app.mock.setScenario('image-seen');
  await onboard(page, app);
  const small = noisePng(64, 64);
  expect(small.length).toBeLessThan(IMAGE_LIMIT);
  await page.locator('input[type="file"]').setInputFiles({ name: 'small.png', mimeType: 'image/png', buffer: small });
  await expect(page.getByLabel('Tệp đính kèm').getByText('small.png')).toBeVisible();
  app.mock.setScenario('image-seen'); // the requests of the connection check are not the task's
  const started = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/tasks/start' && request.method() === 'POST');
  await send(page, 'Ảnh nhỏ');
  const [attachment] = (await started).postDataJSON().attachments;
  expect(attachment.mimeType).toBe('image/png');
  expect(Buffer.from(attachment.dataBase64, 'base64').equals(small), 'the picture is not re-encoded when it fits').toBe(true);
});

/** Attaches the pictures through the page, sends the message and returns what the page sent to the Hub. */
async function sendPictures(page, app, prompt, pictures) {
  await page.locator('input[type="file"]').setInputFiles(pictures);
  await expect(page.getByLabel('Tệp đính kèm').getByText(pictures.at(-1).name)).toBeVisible();
  app.mock.setScenario('image-seen'); // the requests of the connection check are not the task's
  const started = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/tasks/start' && request.method() === 'POST');
  await send(page, prompt);
  const request = await started;
  expect(request.postDataJSON().attachments.map((item) => item.name), 'the pictures go in one message').toEqual(pictures.map((item) => item.name));
  expect(await taskByPrompt(app, prompt), 'the Hub took the request (no 413)').toBeTruthy();
  return request.postDataJSON().attachments.reduce((sum, item) => sum + item.dataBase64.length, 0);
}

test('a window the Hub knows: three pictures of 3.5 MB in one message, and the model gets all three', async ({ page, app }) => {
  app.mock.define('image-seen', () => say('Đã nhận ảnh.'));
  app.mock.setScenario('image-seen');
  await onboard(page, app);
  await connectModel(app.hub, app.mock, { contextWindowTokens: 200000 });
  const base64 = await sendPictures(page, app, 'Ba ảnh này khác nhau thế nào?', [gif('a.gif', 3.5 * MB), gif('b.gif', 3.5 * MB), gif('c.gif', 3.5 * MB)]);
  expect(await firstModelRequestBytes(app), 'the request to the model holds the base64 of all three, 14 MB').toBeGreaterThan(base64);
});

test('a window the Hub does not know (it plans on 32,768 tokens): one picture of 3.5 MB reaches the model', async ({ page, app }) => {
  app.mock.define('image-seen', () => say('Đã nhận ảnh.'));
  app.mock.setScenario('image-seen');
  await onboard(page, app);
  await connectModel(app.hub, app.mock, { contextWindowTokens: undefined });
  const base64 = await sendPictures(page, app, 'Ảnh này có gì?', [gif('a.gif', 3.5 * MB)]);
  expect(await firstModelRequestBytes(app), 'a picture is paid for as a picture: it fits what the Hub plans for an unknown window').toBeGreaterThan(base64);
});

test('a window the Hub does not know: three pictures of 3.5 MB do not fit its plan, and the model and the person are both told', async ({ page, app }) => {
  app.mock.define('image-seen', () => say('Đã nhận ảnh.'));
  app.mock.setScenario('image-seen');
  await onboard(page, app);
  await connectModel(app.hub, app.mock, { contextWindowTokens: undefined });
  await sendPictures(page, app, 'Ba ảnh này khác nhau thế nào?', [gif('a.gif', 3.5 * MB), gif('b.gif', 3.5 * MB), gif('c.gif', 3.5 * MB)]);
  await expect.poll(() => app.mock.state.requests.length, { message: 'the model was asked' }).toBeGreaterThan(0);
  expect(JSON.stringify(app.mock.state.lastBody), 'the model is told that three pictures are not in front of it').toContain('3 pictures attached earlier in this conversation');
  const task = await taskByPrompt(app, 'Ba ảnh này khác nhau thế nào?');
  await expect.poll(async () => JSON.stringify((await app.hub.task(task.id)).events ?? []), { message: 'the person is told too' })
    .toContain('3 ảnh đính kèm không còn trong yêu cầu gửi model');
});

test('over 12 MB in one message the file is not added, and the message says the limit and the way around it', async ({ page, app }) => {
  await onboard(page, app);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles([gif('a.gif', 3.7 * MB), gif('b.gif', 3.7 * MB), gif('c.gif', 3.7 * MB)]);
  await expect(page.getByLabel('Tệp đính kèm').getByText('c.gif')).toBeVisible();
  await input.setInputFiles(gif('d.gif', 3.7 * MB));
  const toast = page.getByText(/^Các file đính kèm vượt 12 MB cho một tin nhắn\./);
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('thư mục dự án');
  await expect(page.getByLabel('Tệp đính kèm').getByText('d.gif'), 'the fourth was not added').toHaveCount(0);
  await expect(page.getByLabel('Tệp đính kèm').getByText('c.gif')).toBeVisible();
});

test('ten files in one message are the most, and the eleventh is answered with the way around', async ({ page, app }) => {
  await onboard(page, app);
  const input = page.locator('input[type="file"]');
  const small = (i) => ({ name: `n${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`note ${i}`) });
  await input.setInputFiles(Array.from({ length: 10 }, (_, i) => small(i)));
  await expect(page.getByLabel('Tệp đính kèm').getByText('n9.txt')).toBeVisible();
  await input.setInputFiles(small(10));
  const toast = page.getByText(/^Tối đa 10 file mỗi tin nhắn\./);
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('thư mục dự án');
  await expect(page.getByLabel('Tệp đính kèm').getByText('n10.txt')).toHaveCount(0);
});

test('what cannot be made smaller is refused, and the message says the limit and the way around it', async ({ page, app }) => {
  await onboard(page, app);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(300_000, 'a') });
  const text = page.getByText(/^File big\.txt quá lớn để đính kèm \(tối đa 200 KB\)\./);
  await expect(text).toBeVisible();
  await expect(text).toContainText('thư mục dự án');
  await input.setInputFiles({ name: 'film.gif', mimeType: 'image/gif', buffer: Buffer.alloc(4 * MB, 1) });
  const film = page.getByText(/^File film\.gif quá lớn để đính kèm \(tối đa 3\.75 MB\)\./);
  await expect(film).toBeVisible();
  await expect(film).toContainText('thư mục dự án');
  await expect(page.getByLabel('Tệp đính kèm')).toHaveCount(0);
});
