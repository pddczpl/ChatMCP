// The wire of the ACP agent: JSON-RPC 2.0, one message per line (newline-delimited JSON), over two byte streams. It knows nothing of ACP or of the Hub.
//
// stdout of the agent carries the protocol and nothing else (an editor reads every line of it as a message), so this module only ever writes messages to `output`, whole and one
// per line, and everything that is not a message goes to `log`, which the caller points at stderr.
//
// What it does with what the other side sends, all of it pinned by tests/verify-acp-rpc.mjs:
//   - lines are cut on BYTES (a character may arrive in two pieces) at LF, a CR before it is dropped, blank lines are ignored, a byte order mark at the start of the stream is skipped,
//     and a last line without a line end counts;
//   - a line over `maxLineBytes` is answered once (Invalid Request, id null) and the rest of it is dropped as it arrives: it is never kept, so a client cannot make the agent hold
//     more than the limit plus one piece of input;
//   - invalid UTF-8 and invalid JSON are a Parse error (id null); a batch, a wrong envelope or a bad id is an Invalid Request; the id is echoed only when it is a string or a safe integer;
//   - requests run at the same time and are answered as they finish; an id that is already in flight is refused with id null (an answer with that id could be taken for the answer of the
//     first request); an unknown method is Method not found; a notification is never answered, whatever happens to it;
//   - a handler that throws an ordinary error answers Internal error WITHOUT its message (the reason goes to the log), an RpcError keeps its code, message and data, and a handler
//     that returns nothing is a defect and answers Internal error too, so an empty result is never invented;
//   - requests of our own (the agent asks the client for a permission) get ids that never repeat, resolve with the result of the response that has their id, reject with an RpcError for an
//     error, on a timeout, on an abort and when the connection closes, and an answer nobody waits for is logged and ignored;
//   - when the input ends (or breaks), the signal of every request in flight is aborted, the requests of our own are rejected, handlers get `graceMs` to finish (their answers are still
//     written), and `closed` resolves once what was queued for the output has been written. Nothing is read afterwards.
export const ERROR_CODES = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  AUTH_REQUIRED: -32000,
  NOT_FOUND: -32002,
  CANCELLED: -32800,
});

/** The size the official SDK allows a message by default. */
export const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_GRACE_MS = 1500;

/** An error that goes to the client as it is: a JSON-RPC error object. */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isValidId = (id) => typeof id === 'string' || Number.isSafeInteger(id);
// The characters that some readers (Python splitlines, a few JavaScript ones) take for a line end although JSON allows them inside a string. They are written as escapes.
const SEPARATORS = [0x2028, 0x2029, 0x0085].map((code) => String.fromCharCode(code));
const LINE_SEPARATORS = new RegExp(`[${SEPARATORS.join('')}]`, 'g');
const escapeSeparator = (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf];
const CR = 0x0d;
const LF = 0x0a;

/**
 * Cuts a stream of bytes into lines. `onLine(buffer)` gets each non-blank line without its line end; `onOversize()` is called once for each line that is over the limit, as soon as the
 * limit is passed, and the rest of that line is counted and dropped.
 */
function createFrameReader({ maxLineBytes, onLine, onOversize, stats }) {
  let pieces = [];
  let size = 0;
  let discarding = false;
  let atStart = true;
  const blank = (buffer) => buffer.every((byte) => byte === 0x20 || byte === 0x09 || byte === CR);
  const finishLine = () => {
    let line = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, size);
    pieces = [];
    size = 0;
    if (line.length && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1);
    if (atStart && line.length) {
      atStart = false;
      if (line.length >= 3 && line[0] === BYTE_ORDER_MARK[0] && line[1] === BYTE_ORDER_MARK[1] && line[2] === BYTE_ORDER_MARK[2]) line = line.subarray(3);
    }
    if (line.length > maxLineBytes) { onOversize(); return; }
    if (blank(line)) return;
    onLine(line);
  };
  return {
    push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(LF, offset);
        const end = newline === -1 ? chunk.length : newline;
        const length = end - offset;
        if (discarding) stats.discardedBytes += length;
        else if (size + length > maxLineBytes + 1) { // beyond a line of the limit and the CR that may end it: the line is refused now, and nothing of it is kept
          stats.discardedBytes += size + length;
          pieces = [];
          size = 0;
          discarding = true;
          onOversize();
        } else if (length > 0) {
          pieces.push(chunk.subarray(offset, end));
          size += length;
          if (size > stats.maxBufferedBytes) stats.maxBufferedBytes = size;
        }
        if (newline === -1) break;
        if (discarding) discarding = false; // the long line is over
        else finishLine();
        offset = newline + 1;
      }
    },
    /** The input ended: a last line without a line end counts. */
    end() {
      if (!discarding && size > 0) finishLine();
      pieces = [];
      size = 0;
      discarding = false;
    },
  };
}

/**
 * @param {object} options
 * @param {import('node:stream').Readable} options.input  where the bytes of the client come from
 * @param {{write: Function, on?: Function}} options.output  where messages go: write(text, callback)
 * @param {(line: string) => void} [options.log]  everything that is not a message (stderr)
 * @param {number} [options.maxLineBytes]
 * @param {number} [options.graceMs]  how long handlers in flight are waited for after the input ended
 */
export function createRpcPeer({ input, output, log = () => {}, maxLineBytes = DEFAULT_MAX_LINE_BYTES, graceMs = DEFAULT_GRACE_MS }) {
  const handlers = new Map();
  const notificationHandlers = new Map();
  const inflight = new Map(); // id -> { controller, done }
  const outgoing = new Map(); // id -> { reject, resolve, cleanup }
  const closeCallbacks = [];
  const stats = { maxBufferedBytes: 0, discardedBytes: 0, messagesIn: 0, messagesOut: 0 };
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let nextRequestId = 1;
  let started = false;
  let closing = false;
  let finished = false;
  let writing = Promise.resolve();
  let outputBroken = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  // ---- the output -----------------------------------------------------------------------------------------------------------------------------------
  const markBroken = (error) => {
    if (outputBroken) return;
    outputBroken = true;
    log(`output closed or broken (${error?.code ?? error?.message ?? 'unknown'}): nothing more is written`);
  };
  output.on?.('error', markBroken);
  const writeText = (text) => {
    if (finished) return;
    const line = `${text.replace(LINE_SEPARATORS, escapeSeparator)}\n`;
    stats.messagesOut += 1;
    // One write at a time, each waited for: the order is kept, a slow reader (an editor that is busy) holds the writes back instead of piling them up in memory, and a line is never
    // interleaved with another.
    writing = writing.then(() => new Promise((resolve) => {
      if (outputBroken) { resolve(); return; }
      try { output.write(line, (error) => { if (error) markBroken(error); resolve(); }); } catch (error) { markBroken(error); resolve(); }
    }));
  };
  const stringify = (message) => {
    try { return JSON.stringify(message); } catch (error) { log(`a message could not be serialized: ${error.message}`); return undefined; }
  };
  const sendError = (id, code, message, data) => {
    writeText(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }));
  };
  const respond = (id, result) => {
    if (result === undefined || typeof result === 'function' || typeof result === 'symbol') {
      log(`the handler of request ${JSON.stringify(id)} returned nothing that can be sent`);
      sendError(id, ERROR_CODES.INTERNAL, 'Internal error');
      return;
    }
    const text = stringify({ jsonrpc: '2.0', id, result });
    if (text === undefined) { sendError(id, ERROR_CODES.INTERNAL, 'Internal error'); return; }
    writeText(text);
  };

  // ---- what arrives ---------------------------------------------------------------------------------------------------------------------------------
  const echoOf = (message) => (isValidId(message.id) ? message.id : null);
  const runRequest = (message) => {
    const { id, method, params } = message;
    if (inflight.has(id)) { sendError(null, ERROR_CODES.INVALID_REQUEST, 'Duplicate request id', { id }); return; }
    const handler = handlers.get(method);
    if (!handler) { sendError(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`); return; }
    const controller = new AbortController();
    const entry = { controller, done: null };
    inflight.set(id, entry);
    entry.done = Promise.resolve()
      .then(() => handler(params, { id, method, signal: controller.signal }))
      .then((result) => respond(id, result), (error) => {
        if (error instanceof RpcError) { sendError(id, error.code, error.message, error.data); return; }
        log(`${method} failed: ${error?.stack ?? error?.message ?? error}`);
        sendError(id, ERROR_CODES.INTERNAL, 'Internal error');
      })
      .finally(() => { if (inflight.get(id) === entry) inflight.delete(id); });
  };
  const runNotification = (message) => {
    const handler = notificationHandlers.get(message.method);
    if (!handler) { if (!message.method.startsWith('$/')) log(`ignored the notification ${message.method} (no handler)`); return; }
    Promise.resolve().then(() => handler(message.params)).catch((error) => log(`the handler of the notification ${message.method} failed: ${error?.stack ?? error?.message ?? error}`));
  };
  const runResponse = (message) => {
    if ('result' in message && 'error' in message) { log(`ignored a response with a result and an error (id ${JSON.stringify(message.id)})`); return; }
    const entry = outgoing.get(message.id);
    if (!entry) { log(`ignored a response to a request nobody is waiting for (id ${JSON.stringify(message.id)})`); return; }
    entry.cleanup();
    if ('error' in message) {
      const error = message.error;
      if (isObject(error) && Number.isInteger(error.code) && typeof error.message === 'string') entry.reject(new RpcError(error.code, error.message, error.data));
      else entry.reject(new RpcError(ERROR_CODES.INTERNAL, 'The client answered with a malformed error'));
    } else entry.resolve(message.result);
  };
  const dispatch = (message) => {
    stats.messagesIn += 1;
    if (Array.isArray(message)) { sendError(null, ERROR_CODES.INVALID_REQUEST, message.length ? 'Batch requests are not supported' : 'Invalid Request'); return; }
    if (!isObject(message)) { sendError(null, ERROR_CODES.INVALID_REQUEST, 'Invalid Request'); return; }
    const isRequestShape = 'method' in message;
    const isResponseShape = 'result' in message || 'error' in message;
    const hasId = 'id' in message;
    if (message.jsonrpc !== '2.0') {
      if (isRequestShape && !hasId) log('dropped a notification without "jsonrpc":"2.0"');
      else sendError(echoOf(message), ERROR_CODES.INVALID_REQUEST, 'Invalid Request');
      return;
    }
    if (isRequestShape) {
      if (isResponseShape || typeof message.method !== 'string' || message.method === '') {
        if (hasId) sendError(echoOf(message), ERROR_CODES.INVALID_REQUEST, 'Invalid Request');
        else log('dropped a notification whose method is not a non-empty string');
        return;
      }
      const params = message.params;
      const paramsOk = params === undefined || params === null || typeof params === 'object';
      if (!hasId) {
        if (!paramsOk) { log(`dropped the notification ${message.method}: params must be an object or an array`); return; }
        runNotification(message);
        return;
      }
      if (!isValidId(message.id)) { sendError(null, ERROR_CODES.INVALID_REQUEST, 'Invalid Request'); return; }
      if (!paramsOk) { sendError(message.id, ERROR_CODES.INVALID_PARAMS, 'Invalid params'); return; }
      runRequest(message);
      return;
    }
    if (isResponseShape) { runResponse(message); return; }
    sendError(echoOf(message), ERROR_CODES.INVALID_REQUEST, 'Invalid Request');
  };
  const onLine = (buffer) => {
    let text;
    try { text = decoder.decode(buffer); } catch { sendError(null, ERROR_CODES.PARSE, 'Parse error', { reason: 'invalid_utf8' }); return; }
    let message;
    try { message = JSON.parse(text); } catch { sendError(null, ERROR_CODES.PARSE, 'Parse error', { reason: 'invalid_json' }); return; }
    dispatch(message);
  };
  const onOversize = () => sendError(null, ERROR_CODES.INVALID_REQUEST, 'Message too large', { limitBytes: maxLineBytes });
  const reader = createFrameReader({ maxLineBytes, onLine, onOversize, stats });

  // ---- the end --------------------------------------------------------------------------------------------------------------------------------------
  const beginClose = async (reason) => {
    if (closing) return closed;
    closing = true;
    if (reason) log(reason);
    const reasonError = new RpcError(ERROR_CODES.CANCELLED, 'Connection closed');
    for (const entry of [...outgoing.values()]) { entry.cleanup(); entry.reject(reasonError); }
    for (const { controller } of inflight.values()) controller.abort(reasonError);
    for (const callback of closeCallbacks) {
      try { callback(); } catch (error) { log(`a close callback failed: ${error?.message ?? error}`); }
    }
    let timer;
    await Promise.race([
      Promise.allSettled([...inflight.values()].map((entry) => entry.done)),
      new Promise((resolve) => { timer = setTimeout(resolve, graceMs); }),
    ]);
    clearTimeout(timer);
    await writing;
    finished = true;
    resolveClosed();
    return closed;
  };
  const onData = (chunk) => { if (!closing) reader.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk); };
  const onEnd = () => { if (closing) return; reader.end(); void beginClose(); };

  return {
    stats,
    closed,
    get isClosed() { return closing; },
    /** The handler of a request method: `(params, {id, method, signal}) => result`. */
    handle(method, handler) { handlers.set(method, handler); },
    /** The handler of a notification method: `(params) => void`. */
    onNotification(method, handler) { notificationHandlers.set(method, handler); },
    onClose(callback) { closeCallbacks.push(callback); },
    start() {
      if (started) return;
      started = true;
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('error', (error) => { void beginClose(`input error (${error?.code ?? error?.message ?? 'unknown'})`); });
      input.on('close', () => { if (!closing) void beginClose('input closed'); });
    },
    notify(method, params) {
      const text = stringify({ jsonrpc: '2.0', method, params });
      if (text !== undefined) writeText(text);
    },
    /** A request of our own. Rejects with an RpcError for an error response, a timeout and a close; with the reason of `signal` for an abort. */
    request(method, params, { signal, timeoutMs } = {}) {
      if (closing) return Promise.reject(new RpcError(ERROR_CODES.CANCELLED, 'Connection closed'));
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        let timer = null;
        let onAbort = null;
        const cleanup = () => {
          clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          outgoing.delete(id);
        };
        outgoing.set(id, { resolve, reject, cleanup });
        if (timeoutMs > 0) timer = setTimeout(() => { cleanup(); reject(new RpcError(ERROR_CODES.INTERNAL, `Request ${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
        if (signal) {
          onAbort = () => { cleanup(); reject(signal.reason ?? new Error('aborted')); };
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        const text = stringify({ jsonrpc: '2.0', id, method, params });
        if (text === undefined) { cleanup(); reject(new RpcError(ERROR_CODES.INTERNAL, 'The request could not be serialized')); return; }
        writeText(text);
      });
    },
    /** Resolves when everything queued for the output has been written. */
    flush() { return writing; },
    /** Ends the peer from our side (a shutdown): the same as the input ending. */
    close(reason) { return beginClose(reason); },
  };
}
