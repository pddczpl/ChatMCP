import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_GRACE_MS, BODY_LIMIT_MS, readBody } from '../e2e/response-body.mjs';

// A response of the page as the gate sees it: all that is asked of it is json().
const never = () => new Promise(() => {});
const after = (ms, settle) => new Promise((resolve, reject) => setTimeout(() => settle(resolve, reject), ms));
const arrives = (ms, value) => () => after(ms, (resolve) => resolve(value));
const fails = (ms, message) => () => after(ms, (_, reject) => reject(new Error(message)));
const navigation = () => { let leave; const gone = new Promise((resolve) => { leave = resolve; }); return { gone, leave }; };
const timings = { limitMs: 600, graceMs: 80 };
const timeouts = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

test('the defaults leave the test timeout of the suite (90 s) far behind and give a body that is on its way time to land', () => {
  assert.ok(BODY_LIMIT_MS >= 5_000 && BODY_LIMIT_MS <= 20_000, `${BODY_LIMIT_MS}`);
  assert.ok(BODY_GRACE_MS >= 250 && BODY_GRACE_MS <= BODY_LIMIT_MS / 4, `${BODY_GRACE_MS}`);
});

test('a body that arrives is handed back as a value', async () => {
  assert.deepEqual(await readBody({ json: arrives(5, { ok: true }) }, navigation().gone, timings), { value: { ok: true } });
});

test('a read that fails is handed back as an error, however late it fails: the caller decides what that means', async () => {
  const error = (await readBody({ json: fails(5, 'Network.getResponseBody: no resource') }, navigation().gone, timings)).error;
  assert.match(error.message, /no resource/);
});

test('a response cut off by a navigation is let go of after the grace: the read that never settles does not hold the gate', async () => {
  const { gone, leave } = navigation();
  const started = Date.now();
  const result = readBody({ json: never }, gone, timings);
  setTimeout(leave, 30);
  assert.deepEqual(await result, { left: true });
  const waited = Date.now() - started;
  assert.ok(waited >= 30 + timings.graceMs - 15 && waited < timings.limitMs, `waited ${waited} ms`);
});

test('a body that lands within the grace after the navigation is still checked: a navigation inside the page cancels nothing', async () => {
  const { gone, leave } = navigation();
  const result = readBody({ json: arrives(50, { late: true }) }, gone, { limitMs: 600, graceMs: 300 });
  leave();
  assert.deepEqual(await result, { value: { late: true } });
});

test('a body that does not arrive on a page that stays is stuck after the limit', async () => {
  const started = Date.now();
  assert.deepEqual(await readBody({ json: never }, navigation().gone, timings), { stuck: true });
  const waited = Date.now() - started;
  assert.ok(waited >= timings.limitMs - 15 && waited < timings.limitMs + 400, `waited ${waited} ms`);
});

test('a navigation after the answer came changes nothing and leaves no timer behind', async () => {
  const before = timeouts();
  const { gone, leave } = navigation();
  assert.deepEqual(await readBody({ json: arrives(5, 1) }, gone, timings), { value: 1 });
  leave();
  await after(20, (resolve) => resolve());
  assert.equal(timeouts(), before, 'a timer of the wait outlived it');
});

test('a read that fails after the wait was given up is not an unhandled rejection', async () => {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    const { gone, leave } = navigation();
    const result = readBody({ json: fails(150, 'Target page, context or browser has been closed') }, gone, timings);
    leave();
    assert.deepEqual(await result, { left: true });
    await after(250, (resolve) => resolve());
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
  }
});
