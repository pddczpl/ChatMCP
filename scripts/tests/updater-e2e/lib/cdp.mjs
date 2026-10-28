// A small client of the Chrome DevTools Protocol, for the page of an application that was started with a remote debugging port: the installed desktop shell (WebView2) on the hosted runner, or a
// Chromium in the rehearsal. It is the same technique as scripts/tests/windows-installer/desktop-probe.mjs (the global WebSocket of Node, the list of targets at /json/list) and as the real mouse press of
// DATGOLD-HUB/ui/e2e/windows-webview2/Program.cs (Input.dispatchMouseEvent: a trusted event of the browser, not a click that a script makes).
//
// It talks to 127.0.0.1 only, and never reads or sends anything that is not a command and its answer.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The targets the browser at `port` lists (pages and others), or throws when nothing answers. */
export async function listTargets(port, { timeoutMs = 3000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`The debugging port ${port} answered HTTP ${response.status}.`);
  return response.json();
}

/** The version of the browser at `port` (Browser, Protocol-Version, User-Agent ...). */
export async function browserVersion(port, { timeoutMs = 3000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`The debugging port ${port} answered HTTP ${response.status}.`);
  return response.json();
}

/** One connection to one page. */
export class Cdp {
  #socket;
  #serial = 0;
  #pending = new Map();
  #listeners = new Map();
  closed;
  target;

  constructor(socket, target) {
    this.#socket = socket;
    this.target = target;
    let markClosed;
    this.closed = new Promise((resolve) => { markClosed = resolve; });
    socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return; }
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        if (!waiter) return;
        this.#pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(Object.assign(new Error(`${waiter.method}: ${message.error.message ?? 'error'}`), { cdp: message.error }));
        else waiter.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.#listeners.get(message.method) ?? []) { try { listener(message.params ?? {}); } catch { /* a listener must not break the connection */ } }
      }
    });
    socket.addEventListener('close', () => {
      for (const [id, waiter] of this.#pending) { clearTimeout(waiter.timer); waiter.reject(new Error(`${waiter.method}: the page went away (the connection closed)`)); this.#pending.delete(id); }
      markClosed();
    });
  }

  /** True while the connection is open. */
  get open() { return this.#socket.readyState === 1; }

  /** A command of the protocol and its result. */
  send(method, params = {}, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.open) { reject(new Error(`${method}: the connection is closed`)); return; }
      const id = (this.#serial += 1);
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Calls `listener(params)` for each event named `method`; returns the function that takes it off. */
  on(method, listener) {
    const set = this.#listeners.get(method) ?? new Set();
    set.add(listener);
    this.#listeners.set(method, set);
    return () => set.delete(listener);
  }

  /**
   * Runs `expression` in the page and returns its value (as JSON; promises are awaited). `userGesture` makes the page treat it as a person's action. A script error is thrown with the page's own words.
   */
  async evaluate(expression, { userGesture = false, timeoutMs = 30_000 } = {}) {
    const answer = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }, { timeoutMs });
    if (answer.exceptionDetails) {
      const detail = answer.exceptionDetails;
      throw new Error(`The page threw: ${detail.exception?.description ?? detail.text ?? JSON.stringify(detail).slice(0, 300)}`);
    }
    return answer.result?.value;
  }

  close() { try { this.#socket.close(); } catch { /* already closed */ } }
}

/**
 * Connects to the first page of the browser at `port` whose address `match` accepts (a function of the address, or the text it must start with), waiting up to `timeoutMs` for one to appear. The
 * wait is for an application that is still starting; each failed try is remembered and said if the wait ends.
 */
export async function connectPage({ port, match, timeoutMs = 120_000, intervalMs = 400, label = 'the page' } = {}) {
  const accepts = typeof match === 'function' ? match : (address) => address.startsWith(match);
  const deadline = Date.now() + timeoutMs;
  let last = 'nothing was tried';
  for (;;) {
    try {
      const targets = await listTargets(port);
      const page = targets.find((target) => target.type === 'page' && typeof target.url === 'string' && accepts(target.url) && target.webSocketDebuggerUrl);
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        // a socket that neither opens nor fails (a browser that is busy starting) must not hold the wait for ever: it is given up after 15 s and the next try is made
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { try { socket.close(); } catch { /* none */ } reject(new Error('the debugging socket of the page did not open within 15 s')); }, 15_000);
          socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
          socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the debugging socket of the page refused the connection')); }, { once: true });
        });
        return new Cdp(socket, page);
      }
      last = `${targets.length} target(s): ${targets.map((target) => `${target.type} ${String(target.url).slice(0, 80)}`).join(' | ') || 'none'}`;
    } catch (error) {
      last = error?.cause?.code ?? error?.message ?? String(error);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms connecting to ${label} on debugging port ${port} (last: ${last})`);
    await sleep(intervalMs);
  }
}
