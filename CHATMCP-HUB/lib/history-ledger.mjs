// The one writer of the conversation the agent sends to the model.
//
// The history is a list of items in the format described at the top of model-history.mjs:
//   { role:'user', content:[...] }                      a user message (the person's, or one the host wrote)
//   { type:'message'|'reasoning'|'function_call', ... } what the model said in one turn
//   { type:'function_call_output', call_id, output }    the result of one call
//
// Nothing else appends to it, so the rules live here and nowhere else:
//
//  * A model turn is a BATCH: beginBatch() when the request goes out, endBatch() once every result of that turn is in. A
//    user-role message that arrives in between (a recovery hint, a Stop-hook continue message, the notice that a background
//    agent finished) is held and appended, in the order it arrived, after the last result. Every adapter turns the history
//    into "assistant calls, then ALL of their results, then anything else"; a user message between two results is what makes
//    Chat Completions answer HTTP 400 ("tool_calls must be followed by tool messages"). pairToolCalls() in model-history.mjs
//    relies on the same layout (it ends a group of results at the first item that is neither a call nor a result), so the
//    ledger keeps the layout and the adapters keep their repair for a history that an interrupted run left unpaired.
//  * The ledger copies what it is given (structuredClone, once per item), and a snapshot hands out those items without
//    copying them: snapshotForModel() is a new array over the SAME items, so a step costs O(items) pointer copies instead of a
//    deep clone of the whole history. The adapters and the compaction passes treat the items as read-only (tests/
//    verify-history-ledger.mjs runs every one of them on deep-frozen items); a consumer that wants to change an item must
//    copy it first.
//  * onAppend listeners see every item once it is in the history, in order, with { index, role, kind, deferred, batch }. The
//    state is final before the first listener runs, and a listener that throws does not stop the others or leave the ledger
//    half-written: the first error is rethrown after all of them ran.
//
// The ledger does not judge what a model sent. A repeated or missing call id is stored as it came, and the agent rejects it
// (invalid_call_id) exactly as before. It only refuses its own misuse: a result with no call, a second result for one call,
// and a result that would land after a user message that follows its call.

const fault = (code, message) => Object.assign(new Error(message), { code });
const jsonBytes = (value) => {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 4 : Buffer.byteLength(encoded);
};

export class HistoryLedger {
  #items = [];
  #itemBytes = 0;
  #open = new Map();
  #answered = new Set();
  #lastUser = -1;
  #batch = null;
  #batchCount = 0;
  #listeners = [];

  /** @param {{onAppend?: (item: object, meta: object) => void}} [options] */
  constructor({ onAppend = null } = {}) {
    if (typeof onAppend === 'function') this.#listeners.push(onAppend);
  }

  /** Items in the history (messages that are waiting for the end of a batch are not counted). */
  get length() { return this.#items.length; }
  get batchOpen() { return this.#batch !== null; }
  /** User-role messages held until the open batch ends. */
  get deferredCount() { return this.#batch?.waiting.length ?? 0; }

  /** Size of JSON.stringify(history) in UTF-8 bytes, kept as items arrive (the agent checks it against its context limit). */
  byteLength() {
    const n = this.#items.length;
    return n === 0 ? 2 : 2 + this.#itemBytes + (n - 1);
  }

  /** Adds a listener that runs once for every item that enters the history. Returns a function that removes it. */
  onAppend(listener) {
    if (typeof listener !== 'function') throw new TypeError('onAppend needs a function');
    this.#listeners.push(listener);
    return () => { this.#listeners = this.#listeners.filter((entry) => entry !== listener); };
  }

  /** A model turn starts: its request is going out. Returns the batch number. */
  beginBatch() {
    if (this.#batch) throw fault('batch_already_open', 'A model turn is already open; two turns must never be written at the same time.');
    this.#batchCount += 1;
    this.#batch = { id: this.#batchCount, waiting: [] };
    return this.#batch.id;
  }

  /** The turn is complete: appends the user messages that waited, in arrival order. Returns how many. No batch open: 0. */
  endBatch() {
    const batch = this.#batch;
    if (!batch) return 0;
    this.#batch = null;
    const records = batch.waiting.map(({ item, kind }) => this.#commit(item, 'user', kind, batch.id, true));
    this.#notify(records);
    return records.length;
  }

  /**
   * A user-role message: the person's (the prompt, a queued message) or one the host wrote. While a batch is open it waits.
   * @param {object[]|string} content parts such as [{type:'input_text', text}]
   * @param {{kind?: string}} [options] a label for the listeners ('prompt', 'recovery_hint', ...)
   */
  appendUser(content, { kind = 'user' } = {}) {
    if (typeof content !== 'string' && !Array.isArray(content)) throw fault('invalid_item', 'A user message needs text or a list of parts.');
    const item = { role: 'user', content: structuredClone(content) };
    if (this.#batch) { this.#batch.waiting.push({ item, kind }); return; }
    this.#notify([this.#commit(item, 'user', kind, null, false)]);
  }

  /** Every item of one model response, in the order the model produced them. Never held back. */
  appendModelOutput(items) {
    if (!Array.isArray(items)) throw fault('invalid_item', 'A model response is a list of items.');
    const records = structuredClone(items).map((item) => {
      const index = this.#items.length;
      const record = this.#commit(item, 'model', 'model_output', this.#batch?.id ?? null, false);
      const id = item?.type === 'function_call' ? item.call_id : null;
      if (typeof id === 'string' && id && !this.#open.has(id) && !this.#answered.has(id)) this.#open.set(id, index);
      return record;
    });
    this.#notify(records);
  }

  /** The result of one call. Never held back; it must belong to a call that has no result yet and no user message after it. */
  appendToolOutput(callId, output) {
    const callIndex = typeof callId === 'string' ? this.#open.get(callId) : undefined;
    if (callIndex === undefined) {
      throw this.#answered.has(callId)
        ? fault('duplicate_output', `The call ${callId} already has a result.`)
        : fault('unknown_call', `No open call has the id ${String(callId)}.`);
    }
    if (this.#lastUser > callIndex) throw fault('late_output', `The result of ${callId} would follow a user message that came after its call.`);
    const item = { type: 'function_call_output', call_id: callId, output: structuredClone(output) };
    const record = this.#commit(item, 'tool', 'tool_output', this.#batch?.id ?? null, false);
    this.#open.delete(callId);
    this.#answered.add(callId);
    this.#notify([record]);
  }

  /** What the next model request is built from: a new array over the ledger's own items (see the top of this file). */
  snapshotForModel() {
    return this.#items.slice();
  }

  /** Forgets everything (the run is over). Listeners stay. */
  clear() {
    this.#items = [];
    this.#itemBytes = 0;
    this.#open.clear();
    this.#answered.clear();
    this.#lastUser = -1;
    this.#batch = null;
  }

  #commit(item, role, kind, batch, deferred) {
    const index = this.#items.length;
    this.#items.push(item);
    this.#itemBytes += jsonBytes(item);
    if (role === 'user') this.#lastUser = index;
    return { item, meta: { index, role, kind, deferred, batch } };
  }

  #notify(records) {
    let failed = false;
    let failure;
    for (const { item, meta } of records) {
      for (const listener of [...this.#listeners]) {
        try { listener(item, { ...meta }); } catch (error) { if (!failed) { failed = true; failure = error; } }
      }
    }
    if (failed) throw failure;
  }
}
