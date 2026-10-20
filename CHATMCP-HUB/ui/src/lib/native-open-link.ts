// The desktop shell forwards window.open / target=_blank requests to the page as a WebView2 web message
// ({ type: 'chatmcp.open-in-app-tab', url }). The address is data: it is never run as script and is checked again here, so
// only an absolute http/https URL ever reaches the preview as a `chatmcp:open-in-app-tab` event.

export const OPEN_IN_APP_TAB_MESSAGE = 'chatmcp.open-in-app-tab';

interface WebviewHost {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** The address a web message asks to open, exactly as sent, or null when it is not an http/https open request. */
export function openInAppTabUrl(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as { type?: unknown; url?: unknown };
  if (message.type !== OPEN_IN_APP_TAB_MESSAGE || typeof message.url !== 'string' || message.url.length > 8192) return null;
  try {
    const parsed = new URL(message.url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? message.url : null;
  } catch { return null; }
}

/** Listen for the shell's messages and re-dispatch them as the page-level event the preview tab listens for. */
export function installOpenInAppTabBridge(
  host: WebviewHost | undefined = (globalThis as { chrome?: { webview?: WebviewHost } }).chrome?.webview,
  target: EventTarget = window,
): () => void {
  if (!host) return () => {};
  const onMessage = (event: { data: unknown }) => {
    const url = openInAppTabUrl(event.data);
    if (url) target.dispatchEvent(new CustomEvent('chatmcp:open-in-app-tab', { detail: { url } }));
  };
  host.addEventListener('message', onMessage);
  return () => host.removeEventListener('message', onMessage);
}
