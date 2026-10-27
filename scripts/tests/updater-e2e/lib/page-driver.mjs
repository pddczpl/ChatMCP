// What a person does in the page of the Studio, as calls on a Chrome DevTools Protocol connection (lib/cdp.mjs): look for an element by its data-testid, wait for it, press it with the mouse. The press is
// the browser's own: Input.dispatchMouseEvent moves the pointer to the middle of the element, presses and releases the left button, and the page gets a trusted click (isTrusted true), not the click() of a
// script. It is injected through the DevTools protocol, so it is not the operating system's mouse: Windows never moves a cursor, and the proof does not claim it.
// Before it presses, the driver checks that the point it is about to press is on the element (elementFromPoint) and not on something that covers it, as a person's eyes would; after it, it says whether the
// click the page got was trusted. The same page driver runs against the installed desktop shell (WebView2) on the runner and against a Chromium in the rehearsal (scripts/tests/updater-e2e/rehearse-page.mjs).
//
// What it does NOT do: it does not change what the page sends or receives. `postApplyRequests` is the one exception, and it is named so: it is a MESSAGE POSTED BY SCRIPT to the shell, from the page's own origin,
// which is what the shell's gate has to withstand (the page itself never sends two at once or one while work runs, so a click cannot reach those codes).
import { writeFile } from 'node:fs/promises';
import { sleep } from './cdp.mjs';

const byTestId = (id) => `[data-testid="${id}"]`;

export class PageDriver {
  /** @param {import('./cdp.mjs').Cdp} cdp @param {{log?: (line: string) => void}} [options] */
  constructor(cdp, { log = () => {} } = {}) {
    this.cdp = cdp;
    this.log = log;
  }

  evaluate(expression, options) { return this.cdp.evaluate(expression, options); }

  /** Polls `expression` (script that is truthy when the wait is over) until it is, or throws with `label` and the last value. A page that is navigating does not end the wait; a page that is gone does. */
  async waitFor(expression, { timeoutMs = 30_000, intervalMs = 250, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      if (!this.cdp.open) throw new Error(`Waiting for ${label}: the page went away (the debugging connection closed)`);
      try {
        last = await this.cdp.evaluate(`Boolean(${expression})`, { timeoutMs: 15_000 });
        if (last === true) return;
      } catch (error) {
        last = error?.message ?? String(error);
        if (!this.cdp.open) throw new Error(`Waiting for ${label}: ${last}`);
      }
      if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label} (last: ${String(last).slice(0, 200)})`);
      await sleep(intervalMs);
    }
  }

  /** An element that is there and has a size (it is on the page, not just in it). */
  visible(testId) { return `(() => { const el = document.querySelector('${byTestId(testId)}'); return Boolean(el) && el.getClientRects().length > 0; })()`; }
  waitForVisible(testId, options = {}) { return this.waitFor(this.visible(testId), { label: `${testId} to be on the page`, ...options }); }
  waitForGone(testId, options = {}) { return this.waitFor(`document.querySelector('${byTestId(testId)}') === null`, { label: `${testId} to be gone`, ...options }); }
  isVisible(testId) { return this.cdp.evaluate(this.visible(testId)); }
  /** How many elements carry the test id. */
  count(testId) { return this.cdp.evaluate(`document.querySelectorAll('${byTestId(testId)}').length`); }
  text(testId) { return this.cdp.evaluate(`document.querySelector('${byTestId(testId)}')?.innerText ?? null`); }
  attribute(testId, name) { return this.cdp.evaluate(`document.querySelector('${byTestId(testId)}')?.getAttribute(${JSON.stringify(name)}) ?? null`); }
  isDisabled(testId) { return this.cdp.evaluate(`(() => { const el = document.querySelector('${byTestId(testId)}'); return el ? (el.disabled === true || el.getAttribute('aria-disabled') === 'true') : null; })()`); }

  /**
   * Presses the element that `selector` names with the mouse: scroll it into view, find its middle, check that the middle is on the element, move there, press and release the left button. Throws when the
   * element is not there, is too small to press, is covered, or is disabled (a disabled button is looked at with isDisabled, and a person's press on it does nothing: pressDisabled does exactly that).
   * Resolves {trusted, x, y}: whether the click the page got was a person's (trusted).
   */
  async press(target, { label = typeof target === 'string' ? target : 'the element', allowDisabled = false } = {}) {
    // `target` is a CSS selector, or { find } with a script expression that gives the element (for one that a selector cannot name, such as a button by its words)
    const finder = typeof target === 'string' ? `document.querySelector(${JSON.stringify(target)})` : target.find;
    const before = await this.cdp.evaluate(`(() => {
      const el = ${finder};
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { found: true, sized: false };
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      // the click the page gets, whichever element it lands on (a page that draws again between the look and the press has a new element in the old one's place)
      window.__lastPress = null;
      document.addEventListener('click', (event) => {
        const marked = event.target instanceof Element ? event.target.closest('[data-testid]') : null;
        window.__lastPress = { trusted: event.isTrusted, type: event.type, detail: event.detail, testId: marked ? marked.getAttribute('data-testid') : null };
      }, { once: true, capture: true });
      return { found: true, sized: true, x, y, disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true', covered: !(hit && (hit === el || el.contains(hit))),
        hit: hit ? hit.tagName.toLowerCase() + (hit.getAttribute('data-testid') ? '[' + hit.getAttribute('data-testid') + ']' : '') : null };
    })()`);
    if (!before.found) throw new Error(`Cannot press ${label}: it is not on the page`);
    if (!before.sized) throw new Error(`Cannot press ${label}: it has no size on the page`);
    if (before.covered) throw new Error(`Cannot press ${label}: its middle (${Math.round(before.x)}, ${Math.round(before.y)}) is covered by ${before.hit}`);
    if (before.disabled && !allowDisabled) throw new Error(`Cannot press ${label}: it is disabled`);
    const { x, y } = before;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(60);
    const after = await this.cdp.evaluate('window.__lastPress ?? null').catch(() => null); // the page may be gone already (a press that closes the window)
    this.log(`pressed ${label} at (${Math.round(x)}, ${Math.round(y)})${after ? ` - click ${after.trusted ? 'TRUSTED' : 'NOT trusted'}` : before.disabled ? ' - disabled, no click' : ' - no click event seen'}`);
    return { trusted: after?.trusted ?? null, clicked: after !== null, testId: after?.testId ?? null, x, y };
  }

  /** The press of a person on an element with this test id; the click must reach the page, must be trusted, and must land on that element. */
  async pressTestId(testId, options = {}) {
    const done = await this.press(byTestId(testId), { label: testId, ...options });
    if (!done.clicked) throw new Error(`The press on ${testId} did not reach the page as a click`);
    if (done.trusted !== true) throw new Error(`The press on ${testId} reached the page as a click that is not trusted`);
    if (done.testId !== testId) throw new Error(`The press on ${testId} landed on ${done.testId ?? 'an element with no test id'}`);
    return done;
  }

  /** A person's press on a button that is disabled: nothing may happen, and the driver says so (the click is not delivered to a disabled button). */
  async pressDisabled(testId) {
    const done = await this.press(byTestId(testId), { label: `${testId} (disabled)`, allowDisabled: true });
    // a browser may hand the click to something behind a disabled control; the control itself must not get it
    if (done.clicked && done.testId === testId) throw new Error(`The disabled button ${testId} received a click`);
    return done;
  }

  async screenshot(file) {
    try {
      const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 20_000 });
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      return true;
    } catch (error) {
      this.log(`no screenshot (${error?.message ?? error})`);
      return false;
    }
  }

  /** The page ready for the proof: English words, the first-run walkthrough already done (what a returning person has), reloaded so that the page starts that way; waits for the header of the Studio. */
  async prepare({ language = 'en', timeoutMs = 120_000 } = {}) {
    await this.waitFor("document.querySelector('#root header')", { timeoutMs, label: 'the Studio to render its header' });
    await this.cdp.evaluate(`localStorage.setItem('chatmcp:language', ${JSON.stringify(language)}); localStorage.setItem('chatmcp:onboarding-completed', '1'); true`);
    await this.cdp.send('Page.reload', { ignoreCache: false });
    await sleep(500);
    await this.waitFor("document.querySelector('#root header') && document.readyState === 'complete'", { timeoutMs, label: 'the Studio to render again after the reload' });
    const state = await this.cdp.evaluate(`({ language: localStorage.getItem('chatmcp:language'), session: Boolean(sessionStorage.getItem('chatmcp.hub-session')), shell: Boolean(window.chrome && window.chrome.webview), address: location.origin })`);
    if (!state.session) throw new Error('After the reload the page has no Hub session: it would be refused by the Hub.');
    return state;
  }

  /** A press that must have reached the page as a click, and as a trusted one (the browser's own, not a script's); a press that did not is an error, never a quiet success. Resolves what `press` does. */
  async #pressTrusted(target, label) {
    const done = await this.press(target, { label });
    if (!done.clicked) throw new Error(`The press on ${label} did not reach the page as a click`);
    if (done.trusted !== true) throw new Error(`The press on ${label} reached the page as a click that is not trusted`);
    return done;
  }

  /** Settings -> the section named `section` (English words), opened with presses of the mouse. Resolves what each press was ({trusted, ...}); every one of them was a trusted click, or this threw. */
  async openSettings(section) {
    const presses = [];
    if (!(await this.cdp.evaluate("Boolean(document.querySelector('dialog[open]'))"))) presses.push(await this.#pressTrusted('header button[aria-label="Settings"]', 'the Settings button'));
    await this.waitFor("document.querySelector('dialog[open][aria-label=\"Settings\"]')", { label: 'Settings to open' });
    const find = `Array.from(document.querySelectorAll('dialog[open] nav[aria-label="Settings sections"] button')).find((item) => item.textContent.trim() === ${JSON.stringify(section)})`;
    if (!(await this.cdp.evaluate(`Boolean(${find})`))) throw new Error(`Settings has no section called ${section}`);
    presses.push(await this.#pressTrusted({ find }, `the Settings section ${section}`));
    return presses;
  }

  async closeSettings() {
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await this.waitFor("!document.querySelector('dialog[open]')", { label: 'Settings to close' });
  }

  // ------------------------------------------------------------------------------------------------------------------------------- the desktop shell

  /** Whether this page runs in a desktop shell (window.chrome.webview, with what the page needs of it). */
  inShell() { return this.cdp.evaluate("Boolean(window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function')"); }

  /** Starts keeping every message the shell posts to the page (it survives until the page is loaded again). */
  async recordShellMessages() {
    const recording = await this.cdp.evaluate(`(() => {
      if (!(window.chrome && window.chrome.webview)) return false;
      if (!window.__shellMessages) { window.__shellMessages = []; window.chrome.webview.addEventListener('message', (event) => window.__shellMessages.push(event.data)); }
      return true;
    })()`);
    if (!recording) throw new Error('This page has no window.chrome.webview: it does not run in the desktop shell.');
  }

  shellMessages() { return this.cdp.evaluate('JSON.parse(JSON.stringify(window.__shellMessages ?? []))'); }

  /**
   * MESSAGES POSTED BY SCRIPT from the page to the shell (chrome.webview.postMessage), `count` apply-update requests in ONE script, each with an id of its own. This is not a click: the page's own button sends one
   * request, never two at once and none while work runs, so these are what the shell's own gate has to answer. Returns the ids.
   */
  postApplyRequests(count = 1) {
    return this.cdp.evaluate(`(() => { const ids = Array.from({ length: ${Number(count)} }, () => crypto.randomUUID()); for (const id of ids) window.chrome.webview.postMessage({ type: 'chatmcp.apply-update', id }); return ids; })()`);
  }

  /** The answer of the shell to the request `id` ({ok, code}), waited for. */
  async shellAnswer(id, { timeoutMs = 60_000 } = {}) {
    await this.waitFor(`(window.__shellMessages ?? []).some((message) => message && message.type === 'chatmcp.update-result' && message.id === ${JSON.stringify(id)})`, { timeoutMs, label: `the answer of the shell to ${id}` });
    const all = await this.shellMessages();
    const answer = all.find((message) => message && message.type === 'chatmcp.update-result' && message.id === id);
    return { ok: answer.ok === true, code: answer.code };
  }
}
