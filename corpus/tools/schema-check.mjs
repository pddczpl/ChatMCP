// A small checker for the JSON Schema of task.yml (corpus/schema/task.schema.json), run on the node tree of the YAML subset so that a
// problem is reported with the line it is on. No dependency: the corpus tools are plain Node.
//
// It implements a fixed subset of JSON Schema 2020-12 and refuses a schema that uses any other keyword, so the schema can never say more
// than what is checked: type (object, array, string, integer, boolean, null), properties, required, additionalProperties (false only),
// items, minItems, maxItems, uniqueItems, minLength, maxLength, pattern (Unicode mode), minimum, maximum, const, enum, $defs and local
// $ref ("#/$defs/<name>"). Annotations: $schema, $id, $comment, title, description, and x-code, the refusal code to report for a value
// that fails the keywords of that schema object (otherwise the code is the keyword's: bad_type, out_of_range, bad_format ...).
const KEYWORDS = new Set([
  '$schema', '$id', '$comment', '$defs', '$ref', 'title', 'description', 'x-code',
  'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'const', 'enum',
]);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'boolean', 'null']);
const TYPE_TEXT = { object: 'a mapping', array: 'a list', string: 'text', integer: 'a whole number', boolean: 'true or false', null: 'empty' };
const REF = /^#\/\$defs\/([A-Za-z0-9_-]+)$/;

/** Checks that `schema` uses only the supported keywords and that every $ref and pattern resolves; returns {root, defs, patterns}. */
export function compileSchema(schema) {
  const defs = schema?.$defs ?? {};
  const patterns = new Map();
  const visit = (node, where) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${where}: a schema must be an object`);
    for (const key of Object.keys(node)) if (!KEYWORDS.has(key)) throw new Error(`${where}: unsupported keyword \`${key}\``);
    if (node.type !== undefined && !TYPES.has(node.type)) throw new Error(`${where}: unsupported type ${JSON.stringify(node.type)}`);
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) throw new Error(`${where}: only \`additionalProperties: false\` is supported`);
    if (node.$ref !== undefined && !Object.hasOwn(defs, REF.exec(node.$ref)?.[1] ?? '')) throw new Error(`${where}: $ref ${JSON.stringify(node.$ref)} does not name an entry of $defs`);
    if (node.pattern !== undefined) patterns.set(node.pattern, new RegExp(node.pattern, 'u'));
    for (const [name, child] of Object.entries(node.properties ?? {})) visit(child, `${where}/properties/${name}`);
    if (node.items !== undefined) visit(node.items, `${where}/items`);
    for (const [name, child] of Object.entries(node.$defs ?? {})) visit(child, `${where}/$defs/${name}`);
  };
  visit(schema, '#');
  return { root: schema, defs, patterns };
}

/** The JSON type of a node of the YAML subset (plain scalars are typed there: integers, true/false, null, the rest text). */
function typeOf(node) {
  if (node.kind === 'map') return 'object';
  if (node.kind === 'seq') return 'array';
  if (node.value === null) return 'null';
  if (typeof node.value === 'boolean') return 'boolean';
  return typeof node.value === 'number' ? 'integer' : 'string';
}

function plainOf(node) {
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'seq') return node.items.map(plainOf);
  return Object.fromEntries(node.entries.map((entry) => [entry.key, plainOf(entry.value)]));
}

const label = (where) => (where ? `\`${where}\`` : 'the task');
const child = (where, key) => (where ? `${where}.${key}` : key);

/**
 * The first problem of `node` against the compiled schema, or null: {code, path, line, message}. `line` is the line of the value, or for
 * a missing key the line of the key that holds the mapping. Mappings report unknown keys first (in file order), then missing ones (in
 * schema order), then their values; lists report their length, then their items, then a repeated item.
 */
export function checkNode(compiled, node) {
  return check(compiled, compiled.root, node, '', node.line);
}

function check(compiled, schema, node, where, keyLine) {
  if (schema.$ref !== undefined) {
    const problem = check(compiled, compiled.defs[REF.exec(schema.$ref)[1]], node, where, keyLine);
    if (problem) return problem;
  }
  const fail = (keywordCode, text, line = node.line) => ({ code: schema['x-code'] ?? keywordCode, path: where, line, message: `${label(where)} ${text}` });
  const expected = (fallback) => schema.description ?? fallback;
  const type = typeOf(node);
  if (schema.const !== undefined && JSON.stringify(plainOf(node)) !== JSON.stringify(schema.const)) return fail('bad_value', `must be ${expected(JSON.stringify(schema.const))}`);
  if (schema.enum !== undefined && !schema.enum.some((value) => JSON.stringify(value) === JSON.stringify(plainOf(node)))) {
    return fail('bad_value', `must be one of ${schema.enum.map((value) => JSON.stringify(value)).join(', ')}`);
  }
  if (schema.type !== undefined && type !== schema.type) return fail('bad_type', `must be ${expected(TYPE_TEXT[schema.type])}`);

  if (type === 'object') {
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const entry of node.entries) {
        if (!Object.hasOwn(properties, entry.key)) return { code: 'unknown_key', path: child(where, entry.key), line: entry.line, message: `unknown key \`${entry.key}\` in ${label(where)}` };
      }
    }
    for (const key of schema.required ?? []) {
      if (!node.entries.some((entry) => entry.key === key)) {
        const about = properties[key]?.description ?? (properties[key]?.$ref ? compiled.defs[REF.exec(properties[key].$ref)[1]].description : undefined);
        return { code: 'missing_key', path: child(where, key), line: keyLine, message: `${label(where)} is missing \`${key}\`${about ? ` (${about})` : ''}` };
      }
    }
    for (const entry of node.entries) {
      const problem = check(compiled, properties[entry.key] ?? {}, entry.value, child(where, entry.key), entry.line);
      if (problem) return problem;
    }
  } else if (type === 'array') {
    const count = node.items.length;
    if ((schema.minItems !== undefined && count < schema.minItems) || (schema.maxItems !== undefined && count > schema.maxItems)) {
      return fail('bad_count', `must have ${schema.minItems ?? 0} to ${schema.maxItems ?? 'any number of'} entries (it has ${count})`);
    }
    for (const [index, item] of node.items.entries()) {
      const problem = check(compiled, schema.items ?? {}, item, `${where}[${index}]`, item.line);
      if (problem) return problem;
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const [index, item] of node.items.entries()) {
        const key = JSON.stringify(plainOf(item));
        if (seen.has(key)) return { code: 'duplicate_item', path: `${where}[${index}]`, line: item.line, message: `\`${where}[${index}]\` repeats ${key}` };
        seen.add(key);
      }
    }
  } else if (type === 'string') {
    const length = node.value.length;
    if ((schema.minLength !== undefined && length < schema.minLength) || (schema.maxLength !== undefined && length > schema.maxLength)) {
      return fail('bad_length', `must be ${schema.minLength ?? 0} to ${schema.maxLength ?? 'any number of'} characters long (it has ${length})`);
    }
    if (schema.pattern !== undefined && !compiled.patterns.get(schema.pattern).test(node.value)) return fail('bad_format', `must be ${expected(`text that matches /${schema.pattern}/`)}`);
  } else if (type === 'integer') {
    if ((schema.minimum !== undefined && node.value < schema.minimum) || (schema.maximum !== undefined && node.value > schema.maximum)) {
      return fail('out_of_range', `must be ${schema.minimum ?? 'any number'} to ${schema.maximum ?? 'any number'} (it is ${node.value})`);
    }
  }
  return null;
}
