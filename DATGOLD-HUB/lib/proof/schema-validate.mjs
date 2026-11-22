// A small JSON-Schema validator for the proof pack (plan task pod-29, docs/spec/agent-change-v0.1.md).
//
// The Hub has no runtime dependencies, so the schema of the agent-change predicate is checked by this file. It supports exactly the
// keywords that schema uses (SUPPORTED_KEYWORDS, draft 2020-12 meaning) and nothing else: a schema that holds any other keyword, or a
// supported keyword with a value this file does not understand, is refused when it is compiled (SchemaError), never read half-way. A
// validator that silently ignored `format` or `anyOf` would accept what the schema's author meant to refuse.
//
// What the values may be: JSON values only. A number is finite, an integer is a safe integer (|n| <= 2^53 - 1), an object is a plain
// object (its prototype is Object.prototype or null), a string is well-formed UTF-16 (no lone surrogate, whatever the schema says).
// The keys "__proto__", "constructor" and "prototype" are refused in every object, as an own key, before anything else is read there.
// An error is {path, keyword, message}; `path` is a JSON Pointer (RFC 6901) into the value. A missing required property is reported
// at its own path ("/subject/0/digest"), not at the object that lacks it.
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** The keywords this validator understands; the agent-change schema uses every one of them (tests/verify-proof-pack.mjs). */
export const SUPPORTED_KEYWORDS = Object.freeze([
  '$schema', '$id', '$comment', 'title', 'description', '$defs', '$ref',
  'type', 'enum', 'const', 'oneOf',
  'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
]);
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const REF = /^#\/\$defs\/([A-Za-z0-9_-]+)$/;

/** A schema this file refuses to read: `path` is where in the schema, `reason` one of unknown_keyword, bad_keyword_value, not_a_schema, unknown_reference, reference_loop. */
export class SchemaError extends Error {
  constructor(path, reason, message) {
    super(`schema ${path || '(root)'}: ${message}`);
    this.name = 'SchemaError';
    this.code = 'schema_invalid';
    this.path = path;
    this.reason = reason;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
/** A JSON Pointer segment (RFC 6901): "~" is "~0", "/" is "~1". */
const segment = (key) => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const join = (at, key) => `${at}/${segment(key)}`;
const depthOf = (pointer) => (pointer === '' ? 0 : pointer.split('/').length - 1);

/** JSON equality: arrays item by item, objects key by key whatever their order, everything else by ===. */
function jsonEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return a === b;
}

/** A JSON value with object keys in one order, for comparing items (uniqueItems). Values are already known to be JSON here. */
const sortedText = (value) => JSON.stringify(value, (key, item) => (isPlainObject(item) ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));

const isJsonValue = (value, depth = 0) => {
  if (depth > 256) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
};

function typeMatches(type, value) {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isSafeInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    default: return false;
  }
}

const describe = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number') return Number.isFinite(value) ? (Number.isInteger(value) ? 'an integer' : 'a number') : String(value);
  if (typeof value === 'object') return isPlainObject(value) ? 'an object' : `a ${value.constructor?.name ?? 'non-plain'} object`;
  return `a ${typeof value}`;
};

/** The number of code points of `text` compared with `limit`: -1 below, 0 equal, 1 above (without counting a text far from it). */
function compareLength(text, limit) {
  if (text.length < limit) return -1; // code points <= UTF-16 units
  if (text.length > 2 * limit) return 1; // code points >= UTF-16 units / 2
  let count = 0;
  for (const _ of text) { count += 1; if (count > limit) return 1; }
  return count === limit ? 0 : -1;
}

// ------------------------------------------------------------------ compiling: the schema is checked whole, before any value
function checkSchema(node, at, root, patterns, isRoot = false) {
  const bad = (keyword, message) => new SchemaError(join(at, keyword), 'bad_keyword_value', message);
  if (!isPlainObject(node)) throw new SchemaError(at, 'not_a_schema', 'a schema is an object');
  for (const [keyword, value] of Object.entries(node)) {
    switch (keyword) {
      case '$schema':
        if (!isRoot || value !== DIALECT) throw bad(keyword, `$schema is ${DIALECT}, at the root only`);
        break;
      case '$id':
        if (!isRoot || typeof value !== 'string' || !value) throw bad(keyword, '$id is text, at the root only');
        break;
      case '$comment': case 'title': case 'description':
        if (typeof value !== 'string') throw bad(keyword, `${keyword} is text`);
        break;
      case '$defs':
        if (!isRoot || !isPlainObject(value)) throw bad(keyword, '$defs is an object of schemas, at the root only');
        for (const [name, schema] of Object.entries(value)) {
          if (!/^[A-Za-z0-9_-]+$/.test(name)) throw bad(keyword, `a definition name is letters, digits, _ and -: ${JSON.stringify(name)}`);
          checkSchema(schema, join(join(at, keyword), name), root, patterns);
        }
        break;
      case '$ref': {
        const match = typeof value === 'string' ? REF.exec(value) : null;
        if (!match) throw bad(keyword, '$ref is "#/$defs/<name>" (no other reference is resolved)');
        if (!isPlainObject(root.$defs) || !Object.hasOwn(root.$defs, match[1])) throw new SchemaError(join(at, keyword), 'unknown_reference', `${value} names no definition`);
        // A chain of plain references that comes back to where it started never reaches a value: refused here, not at run time.
        const seen = new Set();
        for (let target = value; typeof target === 'string';) {
          if (seen.has(target)) throw new SchemaError(join(at, keyword), 'reference_loop', `${value} refers to itself through ${[...seen].join(' -> ')}`);
          seen.add(target);
          const name = REF.exec(target)?.[1];
          const next = name && Object.hasOwn(root.$defs, name) ? root.$defs[name] : null;
          target = isPlainObject(next) ? next.$ref : undefined;
        }
        break;
      }
      case 'type': {
        const list = Array.isArray(value) ? value : [value];
        if (!list.length || list.some((type) => !TYPES.has(type)) || new Set(list).size !== list.length) throw bad(keyword, `type is one of ${[...TYPES].join(', ')} or a list of them without repeats`);
        break;
      }
      case 'enum':
        if (!Array.isArray(value) || !value.length || !value.every((item) => isJsonValue(item))) throw bad(keyword, 'enum is a non-empty list of JSON values');
        break;
      case 'const':
        if (!isJsonValue(value)) throw bad(keyword, 'const is a JSON value');
        break;
      case 'oneOf':
        if (!Array.isArray(value) || !value.length) throw bad(keyword, 'oneOf is a non-empty list of schemas');
        value.forEach((schema, index) => checkSchema(schema, join(join(at, keyword), index), root, patterns));
        break;
      case 'properties':
        if (!isPlainObject(value)) throw bad(keyword, 'properties is an object of schemas');
        for (const [name, schema] of Object.entries(value)) {
          if (FORBIDDEN_KEYS.has(name)) throw new SchemaError(join(join(at, keyword), name), 'bad_keyword_value', `"${name}" cannot be a property name`);
          checkSchema(schema, join(join(at, keyword), name), root, patterns);
        }
        break;
      case 'required':
        if (!Array.isArray(value) || !value.every((name) => typeof name === 'string' && !FORBIDDEN_KEYS.has(name)) || new Set(value).size !== value.length) throw bad(keyword, 'required is a list of distinct property names');
        break;
      case 'additionalProperties':
        if (value !== false) throw bad(keyword, 'only additionalProperties: false is supported');
        break;
      case 'items':
        checkSchema(value, join(at, keyword), root, patterns);
        break;
      case 'uniqueItems':
        if (typeof value !== 'boolean') throw bad(keyword, 'uniqueItems is a boolean');
        break;
      case 'minProperties': case 'maxProperties': case 'minItems': case 'maxItems': case 'minLength': case 'maxLength':
        if (!isCount(value)) throw bad(keyword, `${keyword} is a non-negative integer`);
        break;
      case 'minimum': case 'maximum':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(keyword, `${keyword} is a finite number`);
        break;
      case 'pattern':
        try {
          if (typeof value !== 'string') throw new Error('not text');
          patterns.set(value, new RegExp(value, 'u'));
        } catch (error) { throw bad(keyword, `pattern is a regular expression (u flag): ${error.message}`); }
        break;
      default: throw new SchemaError(join(at, keyword), 'unknown_keyword', `unknown keyword "${keyword}" (supported: ${SUPPORTED_KEYWORDS.join(', ')})`);
    }
  }
}

/**
 * Compiles a schema: the whole schema is checked first (SchemaError on anything not understood), then `validate(value)` returns
 * {valid, errors: [{path, keyword, message}]}. `maxErrors` bounds the errors kept, `maxDepth` how deep a value is followed.
 */
export function compileSchema(schema, { maxErrors = 100, maxDepth = 64 } = {}) {
  const patterns = new Map();
  checkSchema(schema, '', schema, patterns, true);

  const validateNode = (node, value, at, errors) => {
    if (errors.length >= maxErrors) return;
    const add = (path, keyword, message) => { if (errors.length < maxErrors) errors.push({ path, keyword, message }); };
    if (depthOf(at) > maxDepth) { add(at, 'maxDepth', `nested deeper than ${maxDepth} levels`); return; }
    if (typeof value === 'string' && !value.isWellFormed()) { add(at, 'wellFormed', 'the text holds a lone surrogate (not well-formed Unicode)'); return; }
    if (isPlainObject(value)) {
      const forbidden = Object.keys(value).filter((key) => FORBIDDEN_KEYS.has(key));
      if (forbidden.length) { for (const key of forbidden) add(join(at, key), 'forbiddenKey', `the key "${key}" is refused in every object`); return; }
    }
    if (node.$ref !== undefined) {
      const before = errors.length;
      validateNode(schema.$defs[REF.exec(node.$ref)[1]], value, at, errors);
      if (errors.length > before) return;
    }
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((type) => typeMatches(type, value))) { add(at, 'type', `expected ${types.join(' or ')}, found ${describe(value)}`); return; }
    }
    if (node.enum !== undefined && !node.enum.some((item) => jsonEqual(item, value))) { add(at, 'enum', `not one of ${JSON.stringify(node.enum).slice(0, 200)}`); return; }
    if (node.const !== undefined && !jsonEqual(node.const, value)) { add(at, 'const', `not ${JSON.stringify(node.const).slice(0, 200)}`); return; }

    if (typeof value === 'string') {
      if (node.minLength !== undefined && compareLength(value, node.minLength) < 0) add(at, 'minLength', `shorter than ${node.minLength} characters`);
      if (node.maxLength !== undefined && compareLength(value, node.maxLength) > 0) add(at, 'maxLength', `longer than ${node.maxLength} characters`);
      if (node.pattern !== undefined && !patterns.get(node.pattern).test(value)) add(at, 'pattern', `does not match ${node.pattern}`);
    }
    if (typeof value === 'number') {
      if (node.minimum !== undefined && value < node.minimum) add(at, 'minimum', `below ${node.minimum}`);
      if (node.maximum !== undefined && value > node.maximum) add(at, 'maximum', `above ${node.maximum}`);
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      for (const name of node.required ?? []) if (!Object.hasOwn(value, name)) add(join(at, name), 'required', `"${name}" is required`);
      const properties = node.properties ?? {};
      for (const [name, sub] of Object.entries(properties)) if (Object.hasOwn(value, name)) validateNode(sub, value[name], join(at, name), errors);
      if (node.additionalProperties === false) {
        for (const name of keys.filter((key) => !Object.hasOwn(properties, key)).sort()) add(join(at, name), 'additionalProperties', `"${name}" is not a field of this object`);
      }
      if (node.minProperties !== undefined && keys.length < node.minProperties) add(at, 'minProperties', `fewer than ${node.minProperties} fields`);
      if (node.maxProperties !== undefined && keys.length > node.maxProperties) add(at, 'maxProperties', `more than ${node.maxProperties} fields`);
    }
    if (Array.isArray(value)) {
      if (node.minItems !== undefined && value.length < node.minItems) add(at, 'minItems', `fewer than ${node.minItems} items`);
      if (node.maxItems !== undefined && value.length > node.maxItems) { add(at, 'maxItems', `more than ${node.maxItems} items`); return; }
      if (node.items !== undefined) value.forEach((item, index) => validateNode(node.items, item, join(at, index), errors));
      if (node.uniqueItems === true && value.every((item) => isJsonValue(item))) {
        const seen = new Set();
        value.forEach((item, index) => {
          const text = sortedText(item);
          if (seen.has(text)) add(join(at, index), 'uniqueItems', 'an item that occurs earlier in the list');
          seen.add(text);
        });
      }
    }
    if (node.oneOf !== undefined) {
      const branches = node.oneOf.map((branch) => { const found = []; validateNode(branch, value, at, found); return found; });
      const passing = branches.filter((found) => found.length === 0).length;
      if (passing > 1) add(at, 'oneOf', `matches ${passing} branches of oneOf, exactly one is allowed`);
      else if (passing === 0) {
        // the branch that got furthest into the value explains best why the value fails; the first one when they tie
        let best = branches[0];
        for (const found of branches.slice(1)) if (depthOf(found[0].path) > depthOf(best[0].path)) best = found;
        for (const error of best) add(error.path, error.keyword, error.message);
      }
    }
  };

  return {
    validate(value) {
      const errors = [];
      validateNode(schema, value, '', errors);
      return { valid: errors.length === 0, errors };
    },
  };
}
