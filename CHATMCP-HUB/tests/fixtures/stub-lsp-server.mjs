// Protocol-faithful stub Language Server for tests/verify-lsp-tier.mjs.
//
// It speaks real LSP over stdio (Content-Length framing, JSON-RPC 2.0, initialize / initialized / didOpen / didChange / definition /
// references / shutdown / exit) and answers from the actual files below the workspace root it was initialized with, so a request is
// resolved from real file contents rather than from a canned reply. It is a stand-in for pyright and typescript-language-server when
// the staged runtime is not installed; it is NOT those servers and the test says so.
//
// Test hooks (environment, inherited from the test process):
//   CHATMCP_STUB_LSP_SPAWN_LOG   append one line per process start (lets a test count spawns)
//   CHATMCP_STUB_LSP_CRASH_FILE  while this file exists the server dies the moment it receives a definition/references request
//   CHATMCP_STUB_LSP_COLD_FILE   while this file exists a definition request on a name that the queried file imports is answered the way
//                                a cold typescript-language-server answers it (measured with 4.3.4 / typescript 5.9.3): with the import
//                                binding in the queried file itself, not with the declaration. The file content picks the answer:
//                                "binding" (default) = the binding only, "binding-then-declaration" = the binding, then the declaration.
//                                A name the queried file does not import (its declaration, a local symbol) is answered as usual.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.CHATMCP_STUB_LSP_SPAWN_LOG) fs.appendFileSync(process.env.CHATMCP_STUB_LSP_SPAWN_LOG, `${process.pid}\n`);

let root = null;
const documents = new Map();
let buffer = Buffer.alloc(0);

function send(message) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function listSources(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) listSources(full, found);
    else if (/\.(mjs|js|ts|tsx|py)$/.test(entry.name)) found.push(full);
  }
  return found;
}

function textOf(file) {
  const uri = pathToFileURL(file).href;
  return documents.has(uri) ? documents.get(uri) : fs.readFileSync(file, 'utf8');
}

function wordAt(text, line, character) {
  const source = text.split(/\r?\n/)[line] ?? '';
  const isWord = (char) => /[\w$]/.test(char ?? '');
  let start = character;
  let end = character;
  while (start > 0 && isWord(source[start - 1])) start -= 1;
  while (end < source.length && isWord(source[end])) end += 1;
  return source.slice(start, end);
}

function locate(name, { declarationsOnly }) {
  const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`, 'g');
  const declaration = new RegExp(`(?:function|class|const|let|var|def|interface|type|enum)\\s+${name.replace(/[$]/g, '\\$&')}(?![\\w$])`);
  const locations = [];
  for (const file of listSources(root)) {
    const lines = textOf(file).split(/\r?\n/);
    lines.forEach((source, line) => {
      if (declarationsOnly && !declaration.test(source)) return;
      for (const match of source.matchAll(word)) {
        locations.push({
          uri: pathToFileURL(file).href,
          range: { start: { line, character: match.index }, end: { line, character: match.index + name.length } },
        });
        if (declarationsOnly) break;
      }
    });
  }
  return locations;
}

// ES `import ... from '...'` (also over several lines) and Python `from x import y`.
const IMPORT_STATEMENT = /(?:^|\n)[ \t]*(?:import\b[^;'"]*?\bfrom\s*['"][^'"\n]+['"]|from\s+\S+\s+import\s+[^\n]+)/g;

/** Where `name` is bound by an import statement of `file`, as an LSP location; null when the file does not import it. */
function importBinding(file, name) {
  const text = textOf(file);
  const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`);
  for (const statement of text.matchAll(IMPORT_STATEMENT)) {
    const inside = word.exec(statement[0]);
    if (!inside) continue;
    const offset = statement.index + inside.index;
    const before = text.slice(0, offset).split('\n');
    const start = { line: before.length - 1, character: before.at(-1).length };
    return { uri: pathToFileURL(file).href, range: { start, end: { line: start.line, character: start.character + name.length } } };
  }
  return null;
}

function coldMode() {
  const file = process.env.CHATMCP_STUB_LSP_COLD_FILE;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim() || 'binding';
}

function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    root = fileURLToPath(params.rootUri);
    return send({ id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true, referencesProvider: true }, serverInfo: { name: 'chatmcp-stub-lsp' } } });
  }
  if (method === 'textDocument/didOpen') { documents.set(params.textDocument.uri, params.textDocument.text); return undefined; }
  if (method === 'textDocument/didChange') { documents.set(params.textDocument.uri, params.contentChanges.at(-1).text); return undefined; }
  if (method === 'textDocument/didClose') { documents.delete(params.textDocument.uri); return undefined; }
  if (method === 'textDocument/definition' || method === 'textDocument/references') {
    if (process.env.CHATMCP_STUB_LSP_CRASH_FILE && fs.existsSync(process.env.CHATMCP_STUB_LSP_CRASH_FILE)) process.exit(137);
    const file = fileURLToPath(params.textDocument.uri);
    const name = wordAt(textOf(file), params.position.line, params.position.character);
    if (!name) return send({ id, result: null });
    const cold = method === 'textDocument/definition' ? coldMode() : null;
    const binding = cold ? importBinding(file, name) : null;
    if (binding) return send({ id, result: cold === 'binding-then-declaration' ? [binding, ...locate(name, { declarationsOnly: true })] : [binding] });
    return send({ id, result: locate(name, { declarationsOnly: method === 'textDocument/definition' }) });
  }
  if (method === 'shutdown') return send({ id, result: null });
  if (method === 'exit') process.exit(0);
  if (id !== undefined) return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  return undefined;
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const split = buffer.indexOf('\r\n\r\n');
    if (split < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, split).toString('ascii'))?.[1]);
    if (!Number.isFinite(length)) { buffer = buffer.subarray(split + 4); continue; }
    if (buffer.length < split + 4 + length) return;
    const body = buffer.subarray(split + 4, split + 4 + length).toString('utf8');
    buffer = buffer.subarray(split + 4 + length);
    handle(JSON.parse(body));
  }
});
