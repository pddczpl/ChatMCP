// Server-sent events over fetch().
//
// EventSource cannot send an Authorization header, and the Hub accepts the session secret only as a bearer (no cookie, which
// browsers share between ports of the same host). So the stream is an ordinary fetch whose body is read incrementally.
import { getHubSecret, hubSessionReady, reportHubSessionLost } from './session.ts';

/** Incremental `text/event-stream` parser: feed it text, get back the `data` payload of every completed event. */
export class SseParser {
  private buffer = '';
  push(text: string): string[] {
    this.buffer += text;
    const events: string[] = [];
    for (;;) {
      const boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!boundary) break;
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data: string[] = [];
      for (const line of block.split(/\r\n|\n|\r/)) {
        if (!line || line.startsWith(':')) continue; // comment / heartbeat
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        if (field !== 'data') continue;
        const value = colon < 0 ? '' : line.slice(colon + 1);
        data.push(value.startsWith(' ') ? value.slice(1) : value);
      }
      if (data.length) events.push(data.join('\n'));
    }
    return events;
  }
}

export interface EventStreamHandlers {
  /** The stream is connected (also after every reconnect). */
  onOpen?: () => void;
  onMessage: (data: string) => void;
  /** The stream ended or could not connect; a new attempt follows unless it was closed. */
  onError?: () => void;
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Open `route` as an authenticated event stream and keep it open; returns the function that closes it. */
export function openEventStream(route: string, handlers: EventStreamHandlers, { retryMs = 2000 }: { retryMs?: number } = {}): () => void {
  const controller = new AbortController();
  const run = async () => {
    await hubSessionReady;
    while (!controller.signal.aborted) {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        const secret = getHubSecret();
        if (secret) headers.Authorization = `Bearer ${secret}`;
        const response = await fetch(route, { headers, cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (response.status === 401) { await response.text().catch(() => ''); reportHubSessionLost(); return; }
        if (!response.ok || !response.body || !/text\/event-stream/i.test(response.headers.get('content-type') ?? ''))
          throw new Error(`event stream ${route} answered ${response.status}`);
        handlers.onOpen?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const data of parser.push(decoder.decode(value, { stream: true }))) handlers.onMessage(data);
        }
      } catch { /* aborted, refused or dropped: reported below */ }
      if (controller.signal.aborted) return;
      handlers.onError?.();
      await wait(retryMs, controller.signal);
    }
  };
  void run();
  return () => controller.abort();
}
