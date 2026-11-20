import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { PermissionGate } from '../../lib/permissions.mjs';

// The approval card of a tool of an external MCP server, rendered by the real ApprovalStack for a request made by the Hub's own PermissionGate (lib/permissions.mjs,
// plan task ext-12): so the page and the Hub cannot drift apart. What is pinned is what the owner reads before saying yes: which server and which tool, how the
// server is reached, the arguments as the Hub masked them, the risk named as an external tool, in both languages, and that nothing in the arguments is taken for markup.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { ApprovalStack } from './src/components/approval/ApprovalStack';
  import { parseMcpDetail } from './src/lib/mcp-approval';
  import { normalizeApproval } from './src/lib/task-view';
  import { translations } from './src/lib/i18n';
  export { ApprovalStack, parseMcpDetail, normalizeApproval, translations };
`, 'chatmcp-approval-mcp-');
after(dispose);
const { renderWith, ApprovalStack, parseMcpDetail, normalizeApproval, translations } = loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const SECRETS = ['hunter2hunter2', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 's3cretpass', 'leakme12345678'];

/** The pending request the Hub's gate makes for one external call in Review, as the page receives it. */
async function hubRequest(name, args, describe) {
  const gate = new PermissionGate({ manager: { secrets: [] }, workspace: null, timeout: 60_000 });
  gate.attachExternalPolicy({ describeServer: describe });
  const waiting = gate.authorize({ name, args, definition: {}, taskId: 'task-1' });
  for (let i = 0; i < 200 && gate.state().pending.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const request = gate.state().pending[0];
  gate.shutdown();
  await waiting;
  return request;
}
const stdio = () => ({ transport: 'stdio', command: 'npx -y @modelcontextprotocol/server-github --token ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
const http = () => ({ transport: 'http', url: 'https://user:s3cretpass@mcp.example.com/v1?api_key=leakme12345678' });
const render = (request, lang = 'vi') => renderWith(ApprovalStack, { approvals: [normalizeApproval(request)], onApprove() {}, onDeny() {} }, [], [], { lang }, {});
const inner = (html, testid) => {
  const open = new RegExp(`<([a-z0-9]+)[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  if (!open) return null;
  const rest = html.slice(open.index + open[0].length);
  return rest.slice(0, rest.indexOf(`</${open[1]}>`)).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
};

test('the card of an external tool names the server and the tool, how the server is started and the masked arguments (Vietnamese)', async () => {
  const request = await hubRequest('github.create_issue', { owner: 'o', repo: 'r', title: 'Lỗi đăng nhập', password: 'hunter2hunter2' }, stdio);
  assert.equal(request.detail.kind, 'mcp', 'the Hub made an mcp card');
  const html = await render(request);
  assert.match(html, /data-testid="mcp-preview"/);
  assert.match(html, /Công cụ của máy chủ MCP bên ngoài/);
  assert.equal(inner(html, 'mcp-server'), 'github');
  assert.equal(inner(html, 'mcp-tool'), 'create_issue');
  assert.equal(inner(html, 'mcp-transport'), 'stdio');
  assert.match(inner(html, 'mcp-launch'), /^npx -y @modelcontextprotocol\/server-github --token \[REDACTED\]$/, 'the command, with its token masked');
  const shown = inner(html, 'mcp-arguments');
  assert.match(shown, /"title": "Lỗi đăng nhập"/, 'the arguments, indented');
  assert.match(shown, /"password": "\[REDACTED\]"/);
  assert.match(html, /Phân loại rủi ro: <span[^>]*>Công cụ MCP bên ngoài<\/span>/, 'the risk is named as an external tool');
  assert.match(html, /Rủi ro cao/, 'and its level is high');
  assert.match(html, /Hub không kiểm tra đường dẫn/, 'the card says what the Hub does not check');
  assert.equal(inner(html, 'mcp-origin'), null, 'no origin for a stdio server');
  for (const secret of SECRETS) assert.ok(!html.includes(secret), `${secret} is not on the page`);
});

test('the same card in English, for an HTTP server: the origin only', async () => {
  const request = await hubRequest('remote.search', { q: 'docs' }, http);
  const html = await render(request, 'en');
  assert.match(html, /A tool of an external MCP server/);
  assert.equal(inner(html, 'mcp-server'), 'remote');
  assert.equal(inner(html, 'mcp-tool'), 'search');
  assert.equal(inner(html, 'mcp-transport'), 'http');
  assert.equal(inner(html, 'mcp-origin'), 'https://mcp.example.com', 'the scheme, the host and the port: no user, password, path or query');
  assert.equal(inner(html, 'mcp-launch'), null);
  assert.match(html, /Risk class: <span[^>]*>External MCP tool<\/span>/);
  assert.match(html, /does not check its paths/);
  // The reason line is the Hub's own words (the Hub writes its reasons in Vietnamese for every category); the section of the card is the page's.
  assert.doesNotMatch(inner(html, 'mcp-preview'), DIACRITICS, 'nothing of the other language in the section');
  for (const secret of SECRETS) assert.ok(!html.includes(secret), `${secret} is not on the page`);
});

test('a card without a description of the server shows the server, the tool and the arguments only', async () => {
  const request = await hubRequest('memory.search_nodes', { query: 'x' });
  const html = await render(request);
  assert.equal(inner(html, 'mcp-server'), 'memory');
  assert.equal(inner(html, 'mcp-tool'), 'search_nodes');
  for (const id of ['mcp-transport', 'mcp-launch', 'mcp-origin']) assert.equal(inner(html, id), null, `no ${id}`);
});

test('the arguments are text, never markup', async () => {
  const request = await hubRequest('github.create_issue', { body: '<img src=x onerror=alert(1)> </pre><script>alert(1)</script>' });
  const html = await render(request);
  assert.doesNotMatch(html, /<img src=x|<script>alert/, 'escaped by React');
  assert.match(inner(html, 'mcp-arguments'), /<img src=x onerror=alert\(1\)>/, 'and shown as the text it is');
});

test('a request that is not an mcp one has no mcp section, and a broken one does not break the page', async () => {
  const base = { id: 'req-1', toolName: 'local.run_command', category: 'execute', summary: '$ npm test', reason: 'x' };
  const other = await render({ ...base, detail: { kind: 'command', command: 'npm test' } });
  assert.doesNotMatch(other, /mcp-preview/);
  for (const detail of [undefined, null, 'text', 5, [], { kind: 'mcp' }, { kind: 'mcp', server: 5, tool: {}, arguments: [] }, { kind: 'mcp', arguments: '{"cut":' }]) {
    const html = await render({ ...base, category: 'external', detail });
    assert.match(html, /data-approval-id="req-1"/, `the card still renders for ${JSON.stringify(detail)}`);
  }
  const cut = await render({ ...base, category: 'external', detail: { kind: 'mcp', server: 'a', tool: 'b', arguments: '{"cut":"abc' } });
  assert.equal(inner(cut, 'mcp-arguments'), '{"cut":"abc', 'a cut preview is shown as the Hub sent it');
});

test('parseMcpDetail reads only what it knows, bounded', () => {
  assert.equal(parseMcpDetail(undefined), null);
  assert.equal(parseMcpDetail({ kind: 'tool' }), null);
  assert.equal(parseMcpDetail([]), null);
  assert.deepEqual(parseMcpDetail({ kind: 'mcp', server: 5, tool: null, transport: {}, launch: [], origin: 1, arguments: 7 }), { server: '', tool: '', transport: '', launch: '', origin: '', arguments: '' });
  const long = parseMcpDetail({ kind: 'mcp', server: 's'.repeat(500), tool: 't'.repeat(500), transport: 'x'.repeat(100), launch: 'l'.repeat(5000), origin: 'o'.repeat(500), arguments: 'a'.repeat(9000) });
  assert.deepEqual([long.server.length, long.tool.length, long.transport.length, long.launch.length, long.origin.length, long.arguments.length], [200, 300, 40, 2000, 300, 4000]);
  assert.equal(parseMcpDetail({ kind: 'mcp', arguments: '{"a":1}' }).arguments, '{\n  "a": 1\n}', 'whole JSON is indented');
});

test('every string of the card exists in both languages, and the Vietnamese has its diacritics', () => {
  const keys = Object.keys(translations.vi).filter((key) => key.startsWith('agents_apr_mcp_'));
  assert.equal(keys.length, 9, `the mcp strings: ${keys.length}`);
  for (const key of keys) {
    assert.equal(typeof translations.en[key], 'string', `${key} in English`);
    assert.notEqual(translations.en[key], translations.vi[key], `${key} is translated, not copied`);
    assert.match(translations.vi[key], DIACRITICS, `${key} is written with diacritics`);
  }
  assert.deepEqual(Object.keys(translations.en).filter((key) => key.startsWith('agents_apr_mcp_')).sort(), keys.sort(), 'no key in only one language');
});
