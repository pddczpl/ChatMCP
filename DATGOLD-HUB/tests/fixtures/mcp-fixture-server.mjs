#!/usr/bin/env node
// A small MCP server built on the v2 server SDK (@modelcontextprotocol/server of tests/fixtures/mcp-reference), for the MCP client suites.
//
//   node mcp-fixture-server.mjs --transport stdio|http [--port N] [--era both|legacy] [--pages 1|2] [--counter file] [--stderr text]
//                               [--linger yes] [--reference folder]
//
// Tools:   echo {message}            -> "echo: <message>"
//          add {a, b}                -> the sum, as text and structuredContent
//          sleep {}                  -> answers only when the request is cancelled (or after 10 minutes)
//          env_names {}              -> the names of the environment variables this process sees, as JSON text
//          env_value {name}          -> the value of one variable, or "(unset)"
//          whoami {}                 -> {"pid", "ppid"} of this process
//          drop {}                   -> stdio: the process exits without answering; http: the socket is destroyed without an answer
// Every tools/call is written as one line "call <name>" to --counter (appended synchronously BEFORE the tool runs), so a suite can tell how
// many times a call reached the server. On HTTP the server also writes "post <name>" for each POST that carries a tools/call.
// --era legacy: a hand-wired 2025 server (StdioServerTransport + Server.connect), which answers server/discover with "method not found", so
// the client falls back to initialize. --era both (default): serveStdio / createMcpHandler, which serve 2026-07-28 and 2025 clients.
// --pages 2: tools/list answers in two pages (cursor "page-2"). --stderr: a line written to stderr at start (the suites put a secret there).
// --linger yes: stays alive after its stdin closes.
// http: prints "listening <port>" on stdout once bound (127.0.0.1 only).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = { transport: 'stdio', port: 0, era: 'both', pages: 1, counter: '', stderr: '', linger: 'no', reference: '' };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, '');
  if (!(key in options)) throw new Error(`unknown option ${process.argv[index]}`);
  options[key] = typeof options[key] === 'number' ? Number(process.argv[index + 1]) : process.argv[index + 1];
}

/**
 * The folder whose node_modules holds the server SDK: --reference (the suites pass it, since the client manager gives a server only an
 * allow-list of variables), else this checkout's, else the one of the Hub a mutation copy was made from (the copy has no node_modules).
 */
function referenceFolder() {
  const candidates = [...(options.reference ? [options.reference] : []), path.join(here, 'mcp-reference')];
  if (process.env.CHATMCP_MUTATION_SOURCE) candidates.push(path.join(process.env.CHATMCP_MUTATION_SOURCE, 'tests', 'fixtures', 'mcp-reference'));
  const found = candidates.find((folder) => existsSync(path.join(folder, 'node_modules', '@modelcontextprotocol', 'server', 'package.json')));
  if (!found) throw new Error('the MCP reference servers are not installed (npm ci --ignore-scripts --prefix DATGOLD-HUB/tests/fixtures/mcp-reference)');
  return found;
}
const folder = referenceFolder();
/** The ESM entry of a package (or of one of its subpaths) inside the reference folder, from its export map. */
const resolveIn = (specifier) => {
  const parts = specifier.split('/');
  const packageFolder = path.join(folder, 'node_modules', ...parts.slice(0, 2));
  const manifest = JSON.parse(readFileSync(path.join(packageFolder, 'package.json'), 'utf8'));
  const subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.';
  return pathToFileURL(path.join(packageFolder, manifest.exports[subpath].import.default)).href;
};
const { Server, createMcpHandler } = await import(resolveIn('@modelcontextprotocol/server'));
const { StdioServerTransport, serveStdio } = await import(resolveIn('@modelcontextprotocol/server/stdio'));

const count = (line) => { if (options.counter) appendFileSync(options.counter, `${line}\n`); };
const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });
const object = (properties = {}, required = []) => ({ type: 'object', properties, required });
const TOOLS = [
  { name: 'echo', description: 'Echoes the message back', inputSchema: object({ message: { type: 'string' } }, ['message']) },
  { name: 'add', description: 'Adds two numbers', inputSchema: object({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']), outputSchema: object({ sum: { type: 'number' } }, ['sum']) },
  { name: 'sleep', description: 'Never answers until cancelled', inputSchema: object() },
  { name: 'env_names', description: 'Lists the environment variable names', inputSchema: object() },
  { name: 'env_value', description: 'Reads one environment variable', inputSchema: object({ name: { type: 'string' } }, ['name']) },
  { name: 'whoami', description: 'Process ids', inputSchema: object() },
  { name: 'drop', description: 'Loses the answer', inputSchema: object() },
];

function createServer() {
  const server = new Server({ name: 'datgold-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async (request) => {
    if (options.pages !== 2) return { tools: TOOLS };
    const half = Math.ceil(TOOLS.length / 2);
    return request.params?.cursor === 'page-2' ? { tools: TOOLS.slice(half) } : { tools: TOOLS.slice(0, half), nextCursor: 'page-2' };
  });
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: args = {} } = request.params;
    count(`call ${name}`);
    switch (name) {
      case 'echo': return text(`echo: ${args.message}`);
      case 'add': return { ...text(args.a + args.b), structuredContent: { sum: args.a + args.b } };
      case 'sleep':
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 600_000);
          ctx?.mcpReq?.signal?.addEventListener('abort', () => { clearTimeout(timer); count('cancelled sleep'); resolve(); }, { once: true });
        });
        return text('woke up');
      case 'env_names': return text(JSON.stringify(Object.keys(process.env).sort()));
      case 'env_value': return text(process.env[args.name] ?? '(unset)');
      case 'whoami': return text(JSON.stringify({ pid: process.pid, ppid: process.ppid }));
      case 'drop':
        if (options.transport === 'stdio') process.exit(3);
        return text('unreachable');
      default: return { ...text(`unknown tool ${name}`), isError: true };
    }
  });
  return server;
}

if (options.stderr) process.stderr.write(`${options.stderr}\n`);
// --linger yes: the process stays when its stdin closes (a server that ignores EOF), so that only stopping its process tree ends it.
if (options.linger === 'yes') setInterval(() => {}, 60_000);

if (options.transport === 'stdio') {
  if (options.era === 'legacy') await createServer().connect(new StdioServerTransport());
  else serveStdio(() => createServer());
} else {
  const handler = createMcpHandler(() => createServer(), { legacy: 'stateless' });
  const { toNodeHandler } = await import(resolveIn('@modelcontextprotocol/node'));
  const serve = toNodeHandler(handler);
  const httpServer = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { await serve(req, res); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
    const calls = (Array.isArray(body) ? body : [body]).filter((message) => message?.method === 'tools/call');
    for (const call of calls) {
      count(`post ${call.params?.name}`);
      // Proves that a configured header arrived without writing it down: its SHA-256.
      if (req.headers.authorization) count(`auth ${createHash('sha256').update(req.headers.authorization).digest('hex')}`);
    }
    if (calls.some((call) => call.params?.name === 'drop')) { count('call drop'); req.socket.destroy(); return; }
    // --era legacy: a 2025 server knows no server/discover (and nothing else of 2026-07-28 reaches it then).
    if (options.era === 'legacy' && body?.method === 'server/discover') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    await serve(req, res, body);
  });
  httpServer.listen(options.port, '127.0.0.1', () => { process.stdout.write(`listening ${httpServer.address().port}\n`); });
  process.on('SIGTERM', () => { httpServer.close(); void handler.close(); process.exit(0); });
}
