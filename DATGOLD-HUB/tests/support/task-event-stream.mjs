// A reader of the Hub's task event streams (`GET /api/tasks/events`, `GET /api/tasks/<id>/stream`) for the tests: an authenticated fetch whose body is read as it
// arrives, the way the page does it (ui/src/lib/sse.ts). It keeps what the Hub sent apart: the `data` events (parsed), and the comment lines (`: connected`, heartbeats).

const BOUNDARY = /\r\n\r\n|\n\n/;

/**
 * Opens `route` of the Hub at `origin`. Resolves once the Hub answered and its first bytes (`: connected`) were read.
 * `events` grows as data arrives; `close()` ends the request (the Hub sees the connection close) and waits for the reader to stop.
 */
export async function openTaskEventStream(origin, route, { headers = {} } = {}) {
  const controller = new AbortController();
  const response = await fetch(origin + route, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal });
  const stream = { status: response.status, contentType: response.headers.get('content-type') ?? '', events: [], comments: [], ended: false, close: async () => {} };
  if (response.status !== 200 || !response.body) { await response.text().catch(() => ''); stream.ended = true; return stream; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const take = () => {
    for (;;) {
      const boundary = BOUNDARY.exec(buffer);
      if (!boundary) return;
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = [];
      for (const line of block.split(/\r\n|\n/)) {
        if (line.startsWith(':')) stream.comments.push(line.slice(1).trim());
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) stream.events.push(JSON.parse(data.join('\n')));
    }
  };
  let connected;
  const first = new Promise((resolve) => { connected = resolve; });
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        take();
        if (stream.comments.length) connected();
      }
    } catch { /* closed by the test, or the Hub went away */ }
    stream.ended = true;
    connected();
  })();
  stream.close = async () => { controller.abort(); await pump; };
  await first;
  return stream;
}
