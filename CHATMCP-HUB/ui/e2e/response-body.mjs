// How the browserErrors fixture (fixtures.mjs) reads the body of an API response without waiting for it for good.
//
// A reload or a navigation can cut a response off between its headers and the end of its body. Chromium then neither delivers the body nor
// fails the read, and Playwright raises no event for it (no requestfailed, no requestfinished): response.json() stays pending until the browser
// closes. The fixture finishes every read before it closes a page, so one such read held up the teardown for the whole 90 s of the test timeout:
// "Tearing down "app" exceeded the test timeout", twice on windows-latest, in the test that reloads the page right after it saved the connection.
// The Hub was idle and healthy all that time: it was only asked to stop after the timeout, when the browser closed and the read finally failed.
export const BODY_LIMIT_MS = 10_000;
export const BODY_GRACE_MS = 1_000;

/**
 * What became of the body of `response`, and never later than `limitMs`:
 *   { value }  the JSON arrived;
 *   { error }  reading it failed (the caller decides what a failure like that means);
 *   { left }   `documentGone` settled (the main frame navigated away from the document that made the request) and the body had still not arrived
 *              `graceMs` later: a reload cancels the requests of the old page and nothing is left to check;
 *   { stuck }  the page never left that document and the body did not arrive within `limitMs`: the response itself hangs.
 * A body that lands within `graceMs` of a navigation is still read, because a navigation inside the page (history.replaceState) cancels nothing.
 */
export function readBody(response, documentGone, { limitMs = BODY_LIMIT_MS, graceMs = BODY_GRACE_MS } = {}) {
  // Never rejects: the read can fail long after nobody waits for it (the context closing), and that must not be an unhandled rejection.
  const body = response.json().then((value) => ({ value }), (error) => ({ error }));
  const timers = new Set();
  let over = false;
  const after = (ms, outcome) => new Promise((resolve) => { if (!over) timers.add(setTimeout(resolve, ms, outcome)); });
  return Promise.race([body, documentGone.then(() => after(graceMs, { left: true })), after(limitMs, { stuck: true })])
    .finally(() => { over = true; for (const timer of timers) clearTimeout(timer); });
}
