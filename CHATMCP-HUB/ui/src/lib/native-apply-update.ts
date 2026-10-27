// The desktop shell can install the update that the Hub downloaded, for the page. The page sends ONE message, { type: 'chatmcp.apply-update', id }, and the shell reads those two fields and nothing
// else: it computes the folder, the file and the version itself and checks all of it again with its own code before it runs an installer (native-shared/PageMessage.cs, UpdateApplier.cs). The shell answers
// ONCE, { type: 'chatmcp.update-result', id, ok, code }, with a code of a closed list; `launched` is the only success, and after it the window closes. In a plain browser there is no window.chrome.webview,
// so there is nothing to ask and the page does not offer the button.

export const APPLY_UPDATE_MESSAGE = 'chatmcp.apply-update';
export const UPDATE_RESULT_MESSAGE = 'chatmcp.update-result';
/** The shell hashes a file of 230 MB before it answers; a shell that has said nothing after this is not waited for any longer. */
export const APPLY_TIMEOUT_MS = 90_000;

interface WebviewHost {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export type ApplyResult = { ok: true } | { ok: false; code: string };

/** What the shell accepts as an id (PageMessage.RequestId): 16 to 64 hexadecimal digits and dashes. */
const REQUEST_ID = /^[a-fA-F0-9-]{16,64}$/;

/** The WebView2 host of this page, or null: a plain browser has none, and an object that is not a host (it must post and add and remove listeners) is none. */
export function desktopShellHost(host: unknown = (globalThis as { chrome?: { webview?: unknown } }).chrome?.webview): WebviewHost | null {
  if (!host || typeof host !== 'object') return null;
  const candidate = host as Partial<WebviewHost>;
  return typeof candidate.postMessage === 'function' && typeof candidate.addEventListener === 'function' && typeof candidate.removeEventListener === 'function' ? (host as WebviewHost) : null;
}

export const isDesktopShell = (host?: unknown): boolean => desktopShellHost(host as never) !== null;

function randomId(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Asks the shell to install the update and resolves with its one answer: `{ ok: true }` for launched, `{ ok: false, code }` for a refusal (the code is the shell's; the page has words for each), `no_answer` when
 * nothing came in `timeoutMs`, `not_in_shell` when there is no host, `launch_failed` when the host cannot take the message. The listener is in place before the message goes, only the answer with this
 * id counts, and it is removed when the request ends. Never rejects.
 */
export function requestApplyUpdate({ host = (globalThis as { chrome?: { webview?: unknown } }).chrome?.webview, timeoutMs = APPLY_TIMEOUT_MS, newId = randomId }: { host?: unknown; timeoutMs?: number; newId?: () => string } = {}): Promise<ApplyResult> {
  const shell = desktopShellHost(host);
  if (!shell) return Promise.resolve({ ok: false, code: 'not_in_shell' });
  const id = newId();
  if (!REQUEST_ID.test(id)) return Promise.resolve({ ok: false, code: 'launch_failed' });
  return new Promise<ApplyResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ApplyResult) => {
      if (timer !== undefined) clearTimeout(timer);
      shell.removeEventListener('message', onMessage);
      resolve(result);
    };
    function onMessage(event: { data: unknown }) {
      const message = event?.data;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const answer = message as { type?: unknown; id?: unknown; ok?: unknown; code?: unknown };
      if (answer.type !== UPDATE_RESULT_MESSAGE || answer.id !== id) return;
      const code = typeof answer.code === 'string' && answer.code !== '' ? answer.code : 'unknown';
      finish(answer.ok === true && code === 'launched' ? { ok: true } : { ok: false, code });
    }
    shell.addEventListener('message', onMessage);
    timer = setTimeout(() => finish({ ok: false, code: 'no_answer' }), timeoutMs);
    try { shell.postMessage({ type: APPLY_UPDATE_MESSAGE, id }); } catch { finish({ ok: false, code: 'launch_failed' }); }
  });
}
