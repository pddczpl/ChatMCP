// Validates what the ACP agent says against the official JSON Schema of the protocol.
//
// The root of the schema is an `anyOf` of three messages with a `method` that is any string and `params` that may be any of a dozen shapes (and an extension shape
// that takes any object), so validating a message against the root accepts almost everything. The schema tells which parameters belong to which method in two
// annotations of its definitions instead: `x-method` (the method) and `x-side` (who HANDLES it: `agent` = the client sends it to the agent, `client` = the agent sends
// it to the client). This module builds that table and validates a message against the one definition its method names.
//
//   a response of the agent   -> the `...Response` definition (x-side agent) of the method of the request it answers (the id is looked up)
//   a request of the agent    -> the `...Request` definition (x-side client): session/request_permission, fs/*, terminal/*
//   a notification            -> the `...Notification` definition (x-side client): session/update
//   an error                  -> the `Error` definition
//
// Beyond the definitions: the envelope has exactly the members JSON-RPC 2.0 allows, ids are strings or integers, and a method that is not in the schema is an error
// unless it starts with an underscore (the extension space of the protocol).
//
// The formats the schema names (`uint16`, `uint64`, `int64`, ...) and its own annotations are registered, so ajv runs in strict mode: a keyword or a format that the
// schema starts using later fails here instead of being skipped.
const ENVELOPE = new Set(['jsonrpc', 'id', 'method', 'params', 'result', 'error']);

const integerBetween = (min, max) => ({ type: 'number', validate: (value) => Number.isInteger(value) && value >= min && value <= max });

function sideAndKind(name, definition) {
  const method = definition['x-method'];
  const side = definition['x-side'];
  if (!method || !side) return null;
  const kind = name.endsWith('Request') ? 'request' : name.endsWith('Response') ? 'response' : name.endsWith('Notification') ? 'notification' : null;
  return kind ? { method, side, kind } : null;
}

/**
 * @param {{Ajv2020: Function, schema: object}} options  the Ajv class (ajv/dist/2020) and the parsed schema.json of the protocol
 */
export function createAcpSchemaValidator({ Ajv2020, schema }) {
  const definitions = schema.$defs;
  const table = new Map(); // `${side}|${method}|${kind}` -> definition name
  const keywords = new Set();
  const formats = new Set();
  const collect = (node) => {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('x-')) keywords.add(key);
      if (key === 'format' && typeof value === 'string') formats.add(value);
      collect(value);
    }
  };
  collect(schema);
  for (const [name, definition] of Object.entries(definitions)) {
    const found = sideAndKind(name, definition);
    if (found) table.set(`${found.side}|${found.method}|${found.kind}`, name);
  }

  const ajv = new Ajv2020({ strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, discriminator: true, allErrors: true });
  for (const keyword of keywords) ajv.addKeyword({ keyword });
  const known = {
    uint16: integerBetween(0, 65535),
    uint32: integerBetween(0, 2 ** 32 - 1),
    int32: integerBetween(-(2 ** 31), 2 ** 31 - 1),
    uint64: integerBetween(0, Number.MAX_SAFE_INTEGER),
    int64: integerBetween(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    double: { type: 'number', validate: (value) => Number.isFinite(value) },
    uri: { type: 'string', validate: (value) => /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/.test(value) },
  };
  for (const format of formats) {
    if (!known[format]) throw new Error(`the schema uses the format "${format}", which this validator does not know: add it to tests/support/acp-schema.mjs`);
    ajv.addFormat(format, known[format]);
  }
  ajv.addSchema(schema, 'acp');
  const compiled = new Map();
  const validatorOf = (name) => {
    if (!compiled.has(name)) compiled.set(name, ajv.compile({ $ref: `acp#/$defs/${name}` }));
    return compiled.get(name);
  };
  const errorsOf = (check) => (check.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}${error.params?.allowedValues ? ` (${error.params.allowedValues.join('|')})` : ''}`);
  const against = (name, value, where) => {
    if (!definitions[name]) return [`${where}: the schema has no definition ${name}`];
    const check = validatorOf(name);
    return check(value) ? [] : errorsOf(check).map((message) => `${where} (${name}): ${message}`);
  };
  const isId = (id) => typeof id === 'string' || Number.isSafeInteger(id);
  const isExtension = (method) => typeof method === 'string' && method.startsWith('_');

  const api = {
    /** The names of the definitions, for a suite that wants to know that its table is complete. */
    table: () => new Map(table),
    definitionNames: () => Object.keys(definitions),
    /** The methods the agent handles (the client sends them), and the ones the client handles (the agent sends them). */
    methods(side) { return [...new Set([...table.keys()].filter((key) => key.startsWith(`${side}|`)).map((key) => key.split('|')[1]))]; },
    /** `value` against one definition by name. */
    validateDefinition: (name, value) => against(name, value, name),
    /** The parameters of a message of this method that the client sends the agent (side `agent`) or the agent sends the client (side `client`). */
    validateParams(side, method, kind, params) {
      const name = table.get(`${side}|${method}|${kind}`);
      if (!name) return [`${kind} ${method}: not in the schema`];
      return against(name, params, `${kind} ${method} params`);
    },
    /**
     * A message that the AGENT sent. `requestMethods` maps the id of every request the client sent to its method (a response is judged by the method it answers).
     * Returns the problems; an empty list is a valid message.
     */
    validateAgentMessage(message, requestMethods = new Map()) {
      if (message === null || typeof message !== 'object' || Array.isArray(message)) return ['the message is not an object'];
      const problems = [];
      for (const key of Object.keys(message)) if (!ENVELOPE.has(key)) problems.push(`unknown member "${key}" in the envelope`);
      if (message.jsonrpc !== '2.0') problems.push('jsonrpc must be "2.0"');
      const hasMethod = 'method' in message;
      const hasResult = 'result' in message;
      const hasError = 'error' in message;
      if (hasMethod && (hasResult || hasError)) problems.push('a message cannot be a request and a response at once');
      if (hasResult && hasError) problems.push('a response cannot carry a result and an error');
      if (hasMethod) {
        if (typeof message.method !== 'string' || !message.method) { problems.push('method must be a non-empty string'); return problems; }
        const request = 'id' in message;
        if (request && !isId(message.id)) problems.push('the id of a request is a string or an integer');
        if (isExtension(message.method)) return problems;
        const kind = request ? 'request' : 'notification';
        if (message.params === undefined) problems.push(`${kind} ${message.method}: params are missing`);
        else problems.push(...api.validateParams('client', message.method, kind, message.params));
        return problems;
      }
      if (!hasResult && !hasError) { problems.push('neither a method, a result nor an error'); return problems; }
      if (!('id' in message)) { problems.push('a response needs an id'); return problems; }
      if (message.id !== null && !isId(message.id)) problems.push('the id of a response is a string, an integer or null');
      if (hasError) {
        problems.push(...against('Error', message.error, 'error'));
        if (message.error && typeof message.error === 'object' && !Number.isInteger(message.error.code)) problems.push('error.code must be an integer');
        return problems;
      }
      if (!requestMethods.has(message.id)) { problems.push(`a result for the id ${JSON.stringify(message.id)}, which no request used`); return problems; }
      const method = requestMethods.get(message.id);
      const name = table.get(`agent|${method}|response`);
      if (!name) problems.push(`result of ${method}: not in the schema`);
      else problems.push(...against(name, message.result, `result of ${method}`));
      return problems;
    },
  };
  return api;
}
