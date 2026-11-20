// A strict, dependency-free subset of YAML 1.2 for the files of Proof-of-Done (docs/PROOF-ACCEPTANCE.md, plan task pod-20).
//
// The subset: block mappings with simple keys (letters, digits, `_`, `-`, `.`), block sequences (also "compact", at the indentation of
// their key, and `- key: value` items), plain scalars, single- and double-quoted scalars on one line, literal `|` and folded `>` block
// scalars with chomping (`-`, `+`) and indentation (1-9) indicators, comments, and one optional `---` at the start.
//
// Everything else is refused with the physical line (1-based) and a reason code, never guessed at: anchors and aliases, tags, flow
// collections, complex `?` keys, quoted keys, directives, a second document or `...`, duplicate keys, tabs in indentation, multi-line
// plain or quoted scalars, an unknown escape, text after a closing quote, reserved indicators (`@`, backtick), control characters, a
// lone CR line break, a BOM anywhere but at the start, bytes that are not UTF-8, more than `maxBytes` bytes and more than `maxDepth`
// nested collections. CRLF line breaks and one leading BOM are accepted.
//
// The result is a tree of nodes that keep their line ({kind: 'map'|'seq'|'scalar', line, ...}) so that a schema can name the line of a
// bad value; toPlainValue() turns it into plain values (null-prototype objects, so `__proto__` is an ordinary key). Plain scalars are
// typed by a small, fixed rule: `-?(0|[1-9][0-9]*)` is an integer, `true`/`false` a boolean, `null`/`~`/nothing is null, everything else
// (also `1.5`, `0x10`, `007`, `yes`) is a string. Quoted and block scalars are always strings.

export const YAML_DEFAULT_MAX_BYTES = 64 * 1024;
export const YAML_DEFAULT_MAX_DEPTH = 16;

const REASONS = {
  too_large: 'the file is larger than the limit',
  too_deep: 'collections are nested deeper than the limit',
  not_utf8: 'the file is not UTF-8 text',
  bom_misplaced: 'a byte order mark is allowed only at the start of the file',
  control_character: 'a control character is not allowed',
  hidden_character: 'a hidden character is not allowed',
  bare_cr: 'a line break must be LF or CRLF, not a lone CR',
  tab_indent: 'indentation must be spaces, not tabs',
  directive: 'YAML directives (%) are not supported',
  multiple_documents: 'only one YAML document is allowed',
  anchor: 'anchors (&) are not supported',
  alias: 'aliases (*) are not supported',
  tag: 'tags (!) are not supported',
  flow_collection: 'flow collections ({ } and [ ]) are not supported; use block style',
  complex_key: 'complex keys (?) are not supported',
  unsupported_key: 'a key must be a plain name of letters, digits, _, - or .',
  duplicate_key: 'a key appears twice in the same mapping',
  bad_indent: 'unexpected indentation',
  unclosed_quote: 'a quoted string must end on the same line',
  bad_escape: 'unknown escape sequence in a double-quoted string',
  trailing_content: 'unexpected text after a quoted string',
  reserved_indicator: 'a plain value cannot start with @ or `',
  block_scalar_header: 'unsupported block scalar header',
  unexpected_sequence: 'a sequence item is not allowed here',
  syntax: 'not valid in the supported YAML subset',
};

export class YamlSubsetError extends Error {
  constructor(line, reason, detail = '') {
    super(`line ${line}: ${REASONS[reason] ?? reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'YamlSubsetError';
    this.code = 'yaml_invalid';
    this.line = line;
    this.reason = reason;
    this.detail = detail;
  }
}

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ ]*:(?=[ ]|$)(.*)$/;
// Every control character but TAB: C0, DEL and C1 (C1 is not YAML-printable). LF never reaches the test (lines are split on it) and a
// CR left in a line is refused before as `bare_cr`.
const CONTROL = /(?!\t)\p{Cc}/u;
// A comment starts at a `#` after whitespace; a plain scalar that had one is marked, so that a schema can refuse a command cut there.
const COMMENT = /[ \t]#/;
const INTEGER = /^-?(?:0|[1-9][0-9]{0,15})$/;

/** The 1-based line of the character at `index` of `text`. */
const lineAt = (text, index) => {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** Bytes or text to text: UTF-8 only, size bound, one leading BOM dropped. */
function decode(input, maxBytes) {
  let bytes;
  if (typeof input === 'string') bytes = Buffer.from(input, 'utf8');
  else if (input instanceof Uint8Array) bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  else throw new TypeError('YAML input must be a string or bytes.');
  if (bytes.length > maxBytes) {
    const head = bytes.subarray(0, maxBytes).toString('utf8');
    throw new YamlSubsetError(lineAt(head, head.length), 'too_large', `${bytes.length} bytes, the limit is ${maxBytes}`);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch {
    const loose = bytes.toString('utf8');
    throw new YamlSubsetError(lineAt(loose, Math.max(0, loose.indexOf('\uFFFD'))), 'not_utf8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/** The text split into physical lines (LF or CRLF), each checked for characters outside the subset. */
function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.map((raw, index) => {
    const number = index + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.includes('\r')) throw new YamlSubsetError(number, 'bare_cr');
    if (line.includes('\uFEFF')) throw new YamlSubsetError(number, 'bom_misplaced');
    if (CONTROL.test(line)) throw new YamlSubsetError(number, 'control_character');
    // U+2028 and U+2029 end a line for some readers and not for others (and for JavaScript's `.`): never in a file.
    if (/[\p{Zl}\p{Zp}]/u.test(line)) throw new YamlSubsetError(number, 'hidden_character', 'a line or paragraph separator');
    return line;
  });
}

const isBlank = (line) => /^[ \t]*(?:#.*)?$/.test(line);
const indentOf = (line) => /^ */.exec(line)[0].length;

/** Unescapes the body of a double-quoted scalar. */
function unescapeDouble(body, line) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = body[++i];
    const simple = { '\\': '\\', '"': '"', '/': '/', n: '\n', t: '\t', r: '\r', 0: '\0', b: '\b', f: '\f', ' ': ' ', e: '\u001b', a: '\u0007', v: '\u000b' };
    if (next !== undefined && Object.hasOwn(simple, next)) { out += simple[next]; continue; }
    const width = { x: 2, u: 4, U: 8 }[next];
    const hex = width ? body.slice(i + 1, i + 1 + width) : '';
    if (!width || !new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) throw new YamlSubsetError(line, 'bad_escape', `\\${next ?? ''}`);
    const code = parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new YamlSubsetError(line, 'bad_escape', `\\${next}${hex}`);
    out += String.fromCodePoint(code);
    i += width;
  }
  return out;
}

/** What follows a value on its line: nothing, or a comment after whitespace. */
function expectEnd(rest, line) {
  if (rest && !/^[ \t]+(?:#.*)?$/.test(rest)) throw new YamlSubsetError(line, 'trailing_content', rest.trim().slice(0, 40));
}

/** A quoted scalar that starts `text` (which starts with the quote). */
function quoted(text, line) {
  const quote = text[0];
  if (quote === "'") {
    for (let i = 1; i < text.length; i++) {
      if (text[i] !== "'") continue;
      if (text[i + 1] === "'") { i++; continue; }
      expectEnd(text.slice(i + 1), line);
      return text.slice(1, i).replace(/''/g, "'");
    }
    throw new YamlSubsetError(line, 'unclosed_quote');
  }
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] !== '"') continue;
    expectEnd(text.slice(i + 1), line);
    return unescapeDouble(text.slice(1, i), line);
  }
  throw new YamlSubsetError(line, 'unclosed_quote');
}

/** A plain scalar: comment removed, typed by the fixed rule. */
function plainScalar(text, line) {
  const first = text[0];
  if (first === '&') throw new YamlSubsetError(line, 'anchor');
  if (first === '*') throw new YamlSubsetError(line, 'alias');
  if (first === '!') throw new YamlSubsetError(line, 'tag');
  if (first === '{' || first === '[') throw new YamlSubsetError(line, 'flow_collection');
  if (first === '@' || first === '`') throw new YamlSubsetError(line, 'reserved_indicator');
  if (first === '?' && /^\?(?:[ ]|$)/.test(text)) throw new YamlSubsetError(line, 'complex_key');
  if (first === '%') throw new YamlSubsetError(line, 'directive');
  if (first === '}' || first === ']' || first === ',') throw new YamlSubsetError(line, 'flow_collection');
  if (/^-(?:[ \t]|$)/.test(text)) throw new YamlSubsetError(line, 'unexpected_sequence', 'a list item cannot follow a key on its line');
  const comment = COMMENT.exec(text);
  const value = (comment ? text.slice(0, comment.index) : text).trim();
  if (/:(?:[ \t]|$)/.test(value)) throw new YamlSubsetError(line, 'syntax', 'a value cannot hold ": "; quote it');
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (INTEGER.test(value)) return Number(value);
  return value;
}

class Parser {
  constructor(lines, maxDepth) {
    this.lines = lines;
    this.maxDepth = maxDepth;
    this.i = 0;
  }

  /** Moves to the next line that holds content; returns its index or -1. Refuses tabs in indentation and stray markers. */
  next() {
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (/^ *\t/.test(line) && !/^[ \t]*$/.test(line)) throw new YamlSubsetError(this.i + 1, 'tab_indent');
      if (!isBlank(line)) {
        if (/^(?:---|\.\.\.)(?:[ \t]|$)/.test(line)) throw new YamlSubsetError(this.i + 1, 'multiple_documents');
        if (line.startsWith('%')) throw new YamlSubsetError(this.i + 1, 'directive');
        return this.i;
      }
      this.i++;
    }
    return -1;
  }

  /** The node that starts at the next content line, whose indentation must be exactly `indent`. */
  node(indent, depth) {
    const at = this.next();
    if (depth > this.maxDepth) throw new YamlSubsetError(at + 1, 'too_deep', `the limit is ${this.maxDepth}`);
    const text = this.lines[at].slice(indent);
    return /^-(?:[ ]|$)/.test(text) ? this.sequence(indent, depth) : this.mapping(indent, depth);
  }

  mapping(indent, depth) {
    const node = { kind: 'map', line: this.i + 1, entries: [] };
    const seen = new Set();
    for (let at = this.next(); at >= 0; at = this.next()) {
      const line = this.lines[at];
      const column = indentOf(line);
      if (column < indent) break;
      if (column > indent) throw new YamlSubsetError(at + 1, 'bad_indent');
      const text = line.slice(indent);
      if (/^-(?:[ ]|$)/.test(text)) throw new YamlSubsetError(at + 1, 'unexpected_sequence');
      const match = KEY.exec(text);
      if (!match) {
        const first = text[0];
        if (first === '?') throw new YamlSubsetError(at + 1, 'complex_key');
        if (first === '"' || first === "'") throw new YamlSubsetError(at + 1, 'unsupported_key');
        if ('&*!{[@`%,]}'.includes(first)) plainScalar(text, at + 1); // names the anchor, tag, flow collection ... at the start
        throw new YamlSubsetError(at + 1, /:(?:[ ]|$)/.test(text) ? 'unsupported_key' : 'syntax', 'expected "key: value"');
      }
      const [, key, rest] = match;
      if (seen.has(key)) throw new YamlSubsetError(at + 1, 'duplicate_key', key);
      seen.add(key);
      this.i = at + 1;
      node.entries.push({ key, line: at + 1, value: this.value(rest, at + 1, indent, depth, true) });
    }
    return node;
  }

  sequence(indent, depth) {
    const node = { kind: 'seq', line: this.i + 1, items: [] };
    for (let at = this.next(); at >= 0; at = this.next()) {
      const line = this.lines[at];
      const column = indentOf(line);
      if (column < indent) break;
      if (column > indent) throw new YamlSubsetError(at + 1, 'bad_indent');
      const text = line.slice(indent);
      if (!/^-(?:[ ]|$)/.test(text)) break; // a key of the mapping that holds this compact sequence
      const rest = text.slice(1);
      const content = rest.replace(/^ +/, '');
      if (content && !content.startsWith('#') && (KEY.test(content) || /^-(?:[ ]|$)/.test(content))) {
        // `- key: value` or `- - item`: a mapping or sequence whose column is the one of its first character.
        const inner = indent + 1 + (rest.length - content.length);
        if (depth + 1 > this.maxDepth) throw new YamlSubsetError(at + 1, 'too_deep', `the limit is ${this.maxDepth}`);
        this.lines[at] = ' '.repeat(inner) + content;
        node.items.push(KEY.test(content) ? this.mapping(inner, depth + 1) : this.sequence(inner, depth + 1));
        continue;
      }
      this.i = at + 1;
      node.items.push(this.value(rest, at + 1, indent, depth, false));
    }
    return node;
  }

  /** The value after `key:` or `-` on line `line` (text `rest`), whose parent sits at `indent`. */
  value(rest, line, indent, depth, inMapping) {
    const text = rest.replace(/^[ \t]+/, '');
    if (text === '' || text.startsWith('#')) {
      const at = this.next();
      if (at < 0) return { kind: 'scalar', line, value: null, style: 'plain' };
      const column = indentOf(this.lines[at]);
      if (column > indent) return this.node(column, depth + 1);
      // A compact sequence: `key:` followed by `- item` lines at the key's own indentation.
      if (inMapping && column === indent && /^-(?:[ ]|$)/.test(this.lines[at].slice(indent))) return this.node(indent, depth + 1);
      return { kind: 'scalar', line, value: null, style: 'plain' };
    }
    if (text[0] === '|' || text[0] === '>') return this.block(text, line, indent);
    if (text[0] === '"' || text[0] === "'") return { kind: 'scalar', line, value: quoted(text, line), style: 'quoted' };
    return { kind: 'scalar', line, value: plainScalar(text, line), style: 'plain', comment: COMMENT.test(text) };
  }

  /** A literal or folded block scalar whose header is `header`; its parent sits at `indent`. */
  block(header, line, indent) {
    const match = /^([|>])([1-9][+-]?|[+-][1-9]?)?([ \t]+#.*)?[ \t]*$/.exec(header);
    if (!match) throw new YamlSubsetError(line, 'block_scalar_header', header.slice(0, 20));
    const [, style, flags = ''] = match;
    const chomp = flags.includes('-') ? 'strip' : flags.includes('+') ? 'keep' : 'clip';
    const width = /[1-9]/.exec(flags)?.[0];
    let column = width ? indent + Number(width) : null;
    const body = [];
    let i = this.i;
    for (; i < this.lines.length; i++) {
      const raw = this.lines[i];
      if (/^ *$/.test(raw)) { body.push(null); continue; }
      const spaces = indentOf(raw);
      if (column === null) {
        if (spaces <= indent) break;
        column = spaces;
      }
      if (spaces < column) {
        if (/^ *\t/.test(raw) && !/^[ \t]*$/.test(raw)) throw new YamlSubsetError(i + 1, 'tab_indent');
        break;
      }
      body.push(raw.slice(column));
    }
    // Trailing blank lines belong to the block only for chomping; the lines after it are the parent's again.
    let end = body.length;
    while (end && body[end - 1] === null) end--;
    const trailing = body.length - end;
    this.i = i;
    const content = body.slice(0, end).map((part) => part ?? '');
    let text;
    if (style === '|') text = content.join('\n');
    else {
      text = '';
      let previous = null; // 'normal' | 'more' of the last non-empty line
      let breaks = 0;
      for (const part of content) {
        if (part === '') { breaks++; continue; }
        const kind = /^[ \t]/.test(part) ? 'more' : 'normal';
        if (previous === null) text += '\n'.repeat(breaks);
        else if (previous === 'normal' && kind === 'normal') text += breaks === 0 ? ' ' : '\n'.repeat(breaks);
        else text += '\n'.repeat(breaks + 1);
        text += part;
        previous = kind;
        breaks = 0;
      }
    }
    if (content.length) {
      if (chomp === 'clip') text += '\n';
      else if (chomp === 'keep') text += '\n'.repeat(1 + trailing);
    } else if (chomp === 'keep') text += '\n'.repeat(trailing);
    return { kind: 'scalar', line, value: text, style: 'block' };
  }
}

/**
 * Parses `input` (a string or UTF-8 bytes) in the subset; returns the root node, or null for a document without content.
 * Throws YamlSubsetError {code: 'yaml_invalid', line, reason}.
 */
export function parseYamlSubset(input, { maxBytes = YAML_DEFAULT_MAX_BYTES, maxDepth = YAML_DEFAULT_MAX_DEPTH } = {}) {
  const lines = splitLines(decode(input, maxBytes));
  const parser = new Parser(lines, maxDepth);
  // One `---` is allowed before any content (a comment may precede it); a second one is a second document.
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i]) && !/^ *\t/.test(lines[i])) continue;
    first = i;
    break;
  }
  if (first >= 0) {
    if (lines[first].startsWith('%')) throw new YamlSubsetError(first + 1, 'directive');
    if (/^---(?:[ \t]|$)/.test(lines[first])) {
      if (!/^---[ \t]*(?:#.*)?$/.test(lines[first])) throw new YamlSubsetError(first + 1, 'syntax', 'content after ---');
      parser.i = first + 1;
    }
  }
  const at = parser.next();
  if (at < 0) return null;
  const column = indentOf(lines[at]);
  if (column !== 0) throw new YamlSubsetError(at + 1, 'bad_indent');
  let root;
  const text = lines[at];
  if (/^-(?:[ ]|$)/.test(text) || (!/^[|>]/.test(text) && /:(?:[ ]|$)/.test(text))) root = parser.node(0, 1); // the mapping names a bad key
  else if (text[0] === '"' || text[0] === "'") { parser.i = at + 1; root = { kind: 'scalar', line: at + 1, value: quoted(text, at + 1), style: 'quoted' }; }
  else if (text[0] === '|' || text[0] === '>') { parser.i = at + 1; root = parser.block(text, at + 1, -1); }
  else { parser.i = at + 1; root = { kind: 'scalar', line: at + 1, value: plainScalar(text, at + 1), style: 'plain' }; }
  const after = parser.next();
  if (after >= 0) throw new YamlSubsetError(after + 1, indentOf(lines[after]) ? 'bad_indent' : 'syntax');
  return root;
}

/** A node tree to plain values: null-prototype objects, arrays, strings, numbers, booleans and null. */
export function toPlainValue(node) {
  if (node === null || node === undefined) return null;
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'seq') return node.items.map(toPlainValue);
  const object = Object.create(null);
  for (const entry of node.entries) object[entry.key] = toPlainValue(entry.value);
  return object;
}
