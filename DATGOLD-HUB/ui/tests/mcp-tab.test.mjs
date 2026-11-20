// The MCP servers tab (P2 slice D, ext-14): the form that turns what the owner typed into the body of POST /api/mcp/server/upsert (secrets are write-only:
// a stored secret left empty is kept, never sent back), and what the tab shows for each state the Hub reports (GET /api/mcp/servers): the launch record
// to approve, the lists to review with their diff, the tools with their rule, the error and the back-off. The components are the real ones, rendered to
// static markup with the real React Query and store; the end-to-end path against a real Hub is ui/e2e/mcp-servers.spec.mjs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx } from './support/bundle.mjs';

const { loaded, dispose } = await bundleTsx(`
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { McpTab, LaunchRecordView, ToolReviewView, McpServerFormView } from './src/components/inspector/McpTab';
  import { useAppStore } from './src/store/useAppStore';
  export { emptyServerForm, formFromServer, serverPayload, mcpErrorKey } from './src/lib/mcp-servers';
  const wrap = (lang, element, data) => {
    // A server render reads the store's initial state (zustand's server snapshot), so the language is set there.
    Object.assign(useAppStore.getInitialState(), { lang });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
    if (data) client.setQueryData(['mcpServers'], data);
    const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, element));
    client.clear();
    return html;
  };
  export const renderTab = (data, lang = 'vi') => wrap(lang, React.createElement(McpTab), data);
  export const renderRecord = (answer, lang = 'vi') => wrap(lang, React.createElement(LaunchRecordView, { answer, busy: false, onApprove: () => {} }));
  export const renderReview = (review, lang = 'vi') => wrap(lang, React.createElement(ToolReviewView, { review, busy: false, onApprove: () => {} }));
  export const renderForm = (initial, editing, lang = 'vi') => wrap(lang, React.createElement(McpServerFormView, { initial, editing, busy: false, onSubmit: () => {}, onCancel: () => {} }));
`, 'chatmcp-mcp-tab-');
after(dispose);
const { renderTab, renderRecord, renderReview, renderForm, emptyServerForm, formFromServer, serverPayload, mcpErrorKey } = loaded;

const SECRET = 'sk-never-shown-1234567890';
const status = (state, extra = {}) => ({
  id: 'seam', transport: 'stdio', state, enabled: true, review: null, launch: { required: true, approved: false, fingerprint: null },
  refused: { tools: 0, prompts: 0, resources: 0 }, stderr: null, protocolVersion: null, era: null, server: null, tools: null, fingerprint: null,
  connectedAt: null, calls: 0, unknownResultTypes: 0, lastError: null, retryAt: null, ...extra,
});
const stdio = (extra = {}) => ({
  id: 'seam', transport: 'stdio', enabled: true, timeouts: { connectMs: 30000, callMs: 120000 }, policy: {}, trust: { annotations: false }, touchesWorkspace: false,
  command: 'C:\\node\\node.exe', args: ['server.mjs', '--count-file', 'calls.txt'], env: { PLAIN_NAME: { value: 'visible-value', secret: false }, API_TOKEN: { secret: true } },
  status: status('idle'), tools: [], toolReview: { state: 'not_connected', fingerprint: null, refused: null }, ...extra,
});
const answer = (servers, extra = {}) => ({ runtime: { state: 'ready', version: '2.4.0' }, configLoaded: true, configError: null, closed: false, maxServers: 64, servers, ...extra });
const testid = (html, id) => html.match(new RegExp(`<[a-z]+ [^>]*data-testid="${id}"[^>]*>[\\s\\S]*?(?=<[a-z]+ [^>]*data-testid="mcp-(?:server|tool)-|$)`))?.[0] ?? '';

test('a new stdio server: args one per line, a plain value as a string, a secret marked by the owner as {value, secret: true}', () => {
  const form = { ...emptyServerForm(), id: 'seam', command: 'node', args: 'server.mjs\n--flag\r\n\nvalue with spaces', env: [
    { name: 'PLAIN_NAME', value: 'visible', secret: false, stored: false },
    { name: 'OTHER', value: SECRET, secret: true, stored: false },
    { name: '', value: 'dropped', secret: false, stored: false },
  ] };
  assert.deepEqual(serverPayload(form), { id: 'seam', server: { transport: 'stdio', command: 'node', args: ['server.mjs', '--flag', 'value with spaces'], env: { PLAIN_NAME: 'visible', OTHER: { value: SECRET, secret: true } }, enabled: true, trust: { annotations: false }, touchesWorkspace: false } });
});

test('an HTTP server sends its url and headers, never a command or args; a cwd is sent only when typed', () => {
  const form = { ...emptyServerForm(), id: 'docs', transport: 'http', command: 'ignored', args: 'ignored', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', value: `Bearer ${SECRET}`, secret: true, stored: false }] };
  const { server } = serverPayload(form);
  assert.deepEqual(server, { transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: { value: `Bearer ${SECRET}`, secret: true } }, env: {}, enabled: true, trust: { annotations: false }, touchesWorkspace: false });
  assert.equal(serverPayload({ ...emptyServerForm(), id: 'x', command: 'node', cwd: 'C:\\work' }).server.cwd, 'C:\\work');
  assert.equal('cwd' in serverPayload({ ...emptyServerForm(), id: 'x', command: 'node' }).server, false);
});

test('editing: a stored secret comes back empty and is kept with {keep: true}; a new value replaces it; the timeouts read are sent back', () => {
  const form = formFromServer(stdio({ timeouts: { connectMs: 5000, callMs: 9000 } }));
  assert.equal(form.id, 'seam');
  assert.equal(form.args, 'server.mjs\n--count-file\ncalls.txt');
  assert.deepEqual(form.env, [{ name: 'PLAIN_NAME', value: 'visible-value', secret: false, stored: false }, { name: 'API_TOKEN', value: '', secret: true, stored: true }]);
  assert.deepEqual(serverPayload(form).server.env, { PLAIN_NAME: 'visible-value', API_TOKEN: { keep: true } });
  assert.deepEqual(serverPayload(form).server.timeouts, { connectMs: 5000, callMs: 9000 });
  const replaced = { ...form, env: form.env.map((entry) => (entry.stored ? { ...entry, value: 'new-secret' } : entry)) };
  assert.deepEqual(serverPayload(replaced).server.env.API_TOKEN, { value: 'new-secret', secret: true });
  assert.equal(JSON.stringify(form).includes(SECRET), false);
});

test('the Hub codes the tab explains in its own words', () => {
  assert.equal(mcpErrorKey('mcp_task_active'), 'mcp_err_task_active');
  assert.equal(mcpErrorKey('mcp_launch_changed'), 'mcp_err_launch_changed');
  assert.equal(mcpErrorKey('mcp_fingerprint_mismatch'), 'mcp_err_tools_changed');
  assert.equal(mcpErrorKey('mcp_something_else'), null);
  assert.equal(mcpErrorKey(undefined), null);
});

test('no server: the heading, the add button and the empty line, in Vietnamese and in English', () => {
  const vi = renderTab(answer([]));
  assert.match(vi, /Máy chủ MCP bên ngoài/);
  assert.match(vi, />Thêm máy chủ<\/button>/);
  assert.match(vi, />Đọc lại tệp cấu hình<\/button>/);
  assert.match(vi, /Chưa có máy chủ MCP nào\./);
  const en = renderTab(answer([]), 'en');
  assert.match(en, /External MCP servers/);
  assert.match(en, />Add server<\/button>/);
  assert.match(en, /No MCP server yet\./);
});

test('a missing SDK and a file that could not be read are said before the list', () => {
  const html = renderTab(answer([stdio()], { runtime: { state: 'missing', code: 'mcp_runtime_missing' }, configError: { code: 'mcp_config_invalid', message: 'servers.x.shell: is not a setting' } }));
  assert.match(html, /mcp_runtime_missing/);
  assert.match(html, /Không đọc được mcp-servers\.json: servers\.x\.shell: is not a setting/);
  assert.match(html, /data-testid="mcp-server-seam"/);
});

test('a stdio server not yet approved: its state, the launch to approve, and never a secret value', () => {
  const html = renderTab(answer([stdio({ status: status('needs_launch_approval', { lastError: { code: 'mcp_launch_not_approved', message: 'not approved' } }) })]));
  const card = testid(html, 'mcp-server-seam');
  assert.match(card, /seam/);
  assert.match(card, /Cần duyệt lệnh khởi động/);
  assert.match(card, /chưa được khởi động: bạn cần duyệt lệnh khởi động của nó/);
  assert.match(card, />Xem lệnh khởi động<\/button>/);
  assert.match(card, />Kiểm tra kết nối<\/button>/);
  assert.doesNotMatch(html, new RegExp(SECRET));
});

test('the launch record: command, args, env NAMES, the executable and its sha256, the fingerprint, and the Approve button', () => {
  const html = renderRecord({ required: true, approved: false, fingerprint: 'a'.repeat(64), record: { version: 1, transport: 'stdio', command: 'C:\\node\\node.exe', args: ['server.mjs', '--token', '[secret]'], cwd: null, envKeys: ['API_TOKEN', 'PLAIN_NAME'], executable: 'C:\\node\\node.exe', sha256: 'b'.repeat(64) } });
  assert.match(html, /data-testid="mcp-launch-record"/);
  for (const text of ['C:\\node\\node.exe', 'server.mjs', '--token', '[secret]', 'API_TOKEN', 'PLAIN_NAME', 'b'.repeat(64), 'a'.repeat(64)]) assert.ok(html.includes(text), text);
  assert.match(html, />Duyệt lệnh khởi động này<\/button>/);
  assert.match(html, /\(không có\)/, 'no cwd is said as such');
});

test('the lists to review: the diff (added, removed, changed with its fields) and the tools, with the Approve button', () => {
  const html = renderReview({ state: 'needs_review', fingerprint: 'c'.repeat(64), diff: { added: [{ kind: 'tool', name: 'new_tool' }], removed: [{ kind: 'prompt', name: 'old_prompt' }], changed: [{ kind: 'tool', name: 'tool_1', fields: ['description'] }] }, tools: [{ name: 'tool_1', description: 'Reads a file.', inputSchema: { type: 'object' }, annotations: {} }, { name: 'new_tool', description: 'New.', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } }], prompts: [], refused: { tools: 0, prompts: 0, resources: 0 } });
  assert.match(html, /data-testid="mcp-tool-review"/);
  assert.match(html, /new_tool/);
  assert.match(html, /old_prompt/);
  assert.match(html, /tool_1[\s\S]*description/);
  assert.match(html, /Reads a file\./);
  assert.match(html, /phá huỷ \(lời máy chủ\)/);
  assert.match(html, />Duyệt danh sách này<\/button>/);
  const first = renderReview({ state: 'unpinned', fingerprint: 'c'.repeat(64), tools: [], prompts: [], refused: null });
  assert.match(first, /Lần duyệt đầu/);
});

test('a connected server: each tool with its rule chosen, the default, and the hints of the server', () => {
  const tools = [
    { name: 'echo', description: 'Echoes.', annotations: { readOnlyHint: true }, rule: 'allow', policy: 'allow' },
    { name: 'forbidden', description: 'Denied.', annotations: {}, rule: 'deny', policy: 'deny' },
    { name: 'create_issue', description: 'Creates.', annotations: {}, rule: null, policy: 'ask' },
  ];
  const html = renderTab(answer([stdio({ policy: { tools: { echo: 'allow', forbidden: 'deny', gone: 'deny' } }, status: status('connected', { launch: { required: true, approved: true, fingerprint: 'a'.repeat(64) }, review: { state: 'pinned', fingerprint: 'c'.repeat(64) }, tools: 3, server: { name: 'mcp-seam-fixture', version: '2.0.0' }, protocolVersion: '2025-06-18' }), tools, toolReview: { state: 'pinned', fingerprint: 'c'.repeat(64), refused: { tools: 0, prompts: 0, resources: 0 } } })]));
  const card = testid(html, 'mcp-server-seam');
  assert.match(card, /Đã kết nối/);
  assert.match(card, /Lệnh khởi động đã được duyệt/);
  assert.match(card, /mcp-seam-fixture/);
  assert.match(testid(html, 'mcp-tool-seam-echo'), /<option value="allow" selected="">/);
  assert.match(testid(html, 'mcp-tool-seam-echo'), /chỉ đọc \(lời máy chủ\)/);
  assert.match(testid(html, 'mcp-tool-seam-forbidden'), /<option value="deny" selected="">/);
  assert.match(testid(html, 'mcp-tool-seam-create_issue'), /<option value="" selected="">Theo mặc định \(Hỏi\)<\/option>/);
  assert.match(html, /gone/, 'a rule for a tool that is not listed now is still shown');
  assert.match(html, /Mặc định cho mọi công cụ/);
});

test('a server that failed: the error, the time the preflight tries again, and the explicit test', () => {
  const html = renderTab(answer([stdio({ transport: 'http', command: undefined, args: undefined, url: 'http://127.0.0.1:9/mcp', headers: { Authorization: { secret: true } }, status: status('failed', { transport: 'http', launch: { required: false, approved: true, fingerprint: null }, lastError: { code: 'mcp_connect_failed', message: 'fetch failed' }, retryAt: '2026-11-21T10:05:00.000Z' }) })]));
  const card = testid(html, 'mcp-server-seam');
  assert.match(card, /Kết nối lỗi/);
  assert.match(card, /mcp_connect_failed/);
  assert.match(card, /fetch failed/);
  assert.match(card, /Hub tự thử lại/);
  assert.match(card, /http:\/\/127\.0\.0\.1:9\/mcp/);
  assert.doesNotMatch(card, /Xem lệnh khởi động/, 'an HTTP server has no launch record');
});

test('the form: a stored secret is shown as set and never as text; the id cannot be changed while editing', () => {
  const html = renderForm(formFromServer(stdio()), true);
  assert.match(html, /data-testid="mcp-server-form"/);
  assert.match(html, /placeholder="Đã đặt \(để trống để giữ\)"/);
  assert.match(html, /value="visible-value"/);
  assert.doesNotMatch(html, new RegExp(SECRET));
  assert.match(html, /<input[^>]*disabled=""[^>]*value="seam"|<input[^>]*value="seam"[^>]*disabled=""/);
  const fresh = renderForm(emptyServerForm(), false, 'en');
  assert.match(fresh, /Add an MCP server/);
  assert.match(fresh, />Save server<\/button>/);
});
