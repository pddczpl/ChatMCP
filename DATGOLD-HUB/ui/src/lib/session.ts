// The per-launch Hub secret for this tab.
//
// The Hub requires `Authorization: Bearer <secret>` on every API call. The launcher / desktop shell opens the dashboard at
// `/#chatmcp-boot=<one-time ticket>`; this module (at import time, once, not in a React effect, so StrictMode cannot burn the
// single-use ticket) strips the fragment, trades the ticket for the secret and keeps it in sessionStorage for the life of the tab.
// A page opened without a ticket and without a stored secret has no session: the UI shows "reopen ChatMCP" instead of failing
// request by request.

const STORAGE_KEY = 'chatmcp.hub-session';
const BOOT_FRAGMENT = 'chatmcp-boot';

type Listener = () => void;
const listeners = new Set<Listener>();
let secret = '';
let lost = false;

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}
function readStored(): string {
  try { return storage()?.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
}
function writeStored(value: string) {
  try { if (value) storage()?.setItem(STORAGE_KEY, value); else storage()?.removeItem(STORAGE_KEY); } catch { /* private mode: the tab keeps it in memory */ }
}

export function getHubSecret(): string { return secret; }
export function isHubSessionLost(): boolean { return lost; }
/** Used by the bootstrap and by tests. */
export function setHubSecret(value: string) { secret = value; lost = false; writeStored(value); }

/** Subscribe to "this tab has no (longer a) valid Hub session". Returns the unsubscribe function. */
export function onHubSessionLost(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** The Hub refused the secret (restarted, or never given): forget it and tell the UI once. */
export function reportHubSessionLost() {
  if (lost) return;
  lost = true;
  secret = '';
  writeStored('');
  for (const listener of [...listeners]) listener();
}

/** Remove `#chatmcp-boot=<ticket>` from the address bar and return the ticket (null when the URL carries none). */
function takeTicket(): string | null {
  if (typeof window === 'undefined') return null;
  const match = new RegExp(`^#${BOOT_FRAGMENT}=([A-Za-z0-9_-]{16,256})$`).exec(window.location.hash);
  if (!match) return null;
  try { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search); } catch { /* keep going */ }
  return match[1];
}

async function redeem(ticket: string): Promise<string> {
  const response = await fetch('/api/session/redeem', {
    method: 'POST', cache: 'no-store', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-ChatMCP-Request': 'local-dashboard' },
    body: JSON.stringify({ ticket }),
  });
  if (!response.ok) {
    await response.text().catch(() => ''); // read the refusal to the end so the connection and its recorded body are released
    throw new Error(`ticket refused (${response.status})`);
  }
  const body = await response.json();
  if (typeof body?.secret !== 'string' || !body.secret) throw new Error('no secret in the answer');
  return body.secret;
}

/** Resolves once the tab knows whether it has a session. Created at import time; every request and stream waits for it. */
export const hubSessionReady: Promise<void> = typeof window === 'undefined' ? Promise.resolve() : (async () => {
  const ticket = takeTicket();
  if (ticket) {
    try { setHubSecret(await redeem(ticket)); } catch { /* an old ticket: fall back to what the tab already has */ }
  }
  if (!secret) secret = readStored();
  if (!secret) reportHubSessionLost();
})();
