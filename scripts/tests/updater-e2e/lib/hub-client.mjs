// What the page does to a running Hub, as calls from the proof: the Hub's session file (run/hub-session.json in its data folder, readable by this Windows account only) holds the secret of this launch, and every
// call carries it as a bearer; a call that changes something carries the headers the Hub demands of the dashboard (Origin, the request marker, the CSRF token of the state it just read). This is the way
// tests/e2e/hub-process.mjs and ui/e2e/fixtures.mjs talk to a Hub they started, for a Hub that something else started (the installed desktop shell).
import { bearerHeaders, mutationHeaders, readSession } from '../../../../CHATMCP-HUB/lib/hub-session.mjs';

export class HubClient {
  /** @param {{origin: string, stateDirectory: string}} options the origin of the Hub (http://127.0.0.1:<port>) and its data folder (where run/hub-session.json is) */
  constructor({ origin, stateDirectory }) {
    this.origin = origin;
    this.stateDirectory = stateDirectory;
  }

  /** The session of the Hub that is running now: its secret, its pid and its port. Throws when there is none. */
  async session() {
    const session = await readSession(this.stateDirectory);
    if (!session || `http://127.0.0.1:${session.port}` !== this.origin) throw new Error(`There is no session of a Hub at ${this.origin} in ${this.stateDirectory}`);
    return session;
  }

  /** GET /api/health, which needs no secret. */
  async health() {
    const response = await fetch(`${this.origin}/api/health`, { signal: AbortSignal.timeout(5000) });
    return response.json();
  }

  async get(route) {
    const { secret } = await this.session();
    const response = await fetch(`${this.origin}${route}`, { headers: bearerHeaders(secret), signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, ok: response.ok, json, text };
  }

  state() { return this.get('/api/state').then((answer) => { if (!answer.ok) throw new Error(`GET /api/state answered HTTP ${answer.status}`); return answer.json; }); }

  /** POST with the headers of the dashboard. Resolves {status, ok, json, text}; use `must` for one that has to work. */
  async post(route, body = {}) {
    const { secret } = await this.session();
    const state = await this.state();
    const response = await fetch(`${this.origin}${route}`, {
      method: 'POST', headers: mutationHeaders(this.origin, secret, state.csrfToken), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, ok: response.ok, json, text };
  }

  async must(route, body = {}) {
    const answer = await this.post(route, body);
    if (!answer.ok) throw new Error(`POST ${route} answered HTTP ${answer.status}: ${String(answer.json?.error ?? answer.text).slice(0, 300)}`);
    return answer.json;
  }
}
