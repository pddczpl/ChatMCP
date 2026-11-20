// Build-time proof that the staged MCP client runtime works in the layout the installer ships:
//
//   node scripts/Verify-McpRuntime.mjs <hub-folder> [<runtime-folder>]
//
// <hub-folder> is a DATGOLD-HUB folder (the installer payload's); <runtime-folder> defaults to <hub-folder>/runtimes/mcp. The runtime is
// checked against its manifest (scripts/mcp-runtime/verify.mjs), then the Hub's OWN code (<hub-folder>/lib/mcp/client-manager.mjs, which
// loads the SDK through lib/mcp/sdk.mjs) connects to a small stdio MCP server written below, lists its tools, calls one and closes; the
// server's process must have exited when close() resolves. Run it with the Node.js that is shipped (Build-Installer.ps1 does).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyMcpRuntime } from './mcp-runtime/verify.mjs';

const hub = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!hub || !existsSync(path.join(hub, 'lib', 'mcp', 'client-manager.mjs'))) throw new Error('Usage: node scripts/Verify-McpRuntime.mjs <DATGOLD-HUB folder> [<runtime folder>]');
const runtime = path.resolve(process.argv[3] ?? path.join(hub, 'runtimes', 'mcp'));

// A 2025-era stdio server in plain JSON-RPC (server/discover is unknown to it), so that nothing but the staged client is under test.
const SERVER = String.raw`
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'verify-mcp-runtime', version: '1.0.0' } } });
  if (method === 'tools/list') return send({ id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  if (method === 'tools/call') return send({ id, result: { content: [{ type: 'text', text: 'echo: ' + params.arguments.text }] } });
  send({ id, error: { code: -32601, message: 'Method not found' } });
});
`;

const integrity = await verifyMcpRuntime(runtime);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'datgold-verify-mcp-'));
try {
  const serverFile = path.join(scratch, 'server.cjs');
  writeFileSync(serverFile, SERVER);
  const { McpClientManager } = await import(pathToFileURL(path.join(hub, 'lib', 'mcp', 'client-manager.mjs')).href);
  const manager = new McpClientManager({ hubDirectory: path.join(scratch, 'state'), runtimeRoots: [runtime] });
  if (manager.status().runtime.state !== 'ready') throw new Error(`The Hub does not find the staged runtime: ${JSON.stringify(manager.status().runtime)}`);
  await manager.store.save('verify', { transport: 'stdio', command: process.execPath, args: [serverFile] });
  // The owner's two approvals, given here by the build (the server is the script above): the launch record, then the lists the server shows.
  const launch = await manager.launchRecord('verify');
  await manager.approveLaunch('verify', { expectedFingerprint: launch.fingerprint });
  const summary = await manager.connect('verify');
  await manager.approveTools('verify', { expectedFingerprint: manager.toolReview('verify').fingerprint });
  const tools = await manager.listTools('verify');
  const result = await manager.callTool('verify', 'echo', { text: 'staged' });
  const pid = manager.connections.get('verify').channel.pid;
  await manager.close();
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  if (tools.length !== 1 || result.content?.[0]?.text !== 'echo: staged') throw new Error(`Unexpected answer from the staged client: ${JSON.stringify({ tools, result })}`);
  if (alive) throw new Error(`The server process ${pid} is still running after close()`);
  console.log(JSON.stringify({ verified: true, ...integrity, node: process.version, protocolVersion: summary.protocolVersion, tools: tools.length }));
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
