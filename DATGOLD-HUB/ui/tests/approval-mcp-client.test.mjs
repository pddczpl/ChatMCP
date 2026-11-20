import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { PermissionGate } from '../../lib/permissions.mjs';
import { tagPending } from '../../lib/mcp/host.mjs';

// The approval card of a request that a local MCP CLIENT made through the Hub's MCP server host (lib/mcp/host.mjs, plan task ext-18), rendered by
// the real ApprovalStack for a request made by the Hub's own PermissionGate and tagged by the host's own tagPending: the card says which client
// asked (mcp:<client>), in both languages, and a request of the Hub's own agents carries no such tag.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { ApprovalStack } from './src/components/approval/ApprovalStack';
  import { normalizeApproval } from './src/lib/task-view';
  import { translations } from './src/lib/i18n';
  export { ApprovalStack, normalizeApproval, translations };
`, 'chatmcp-approval-mcp-client-');
after(dispose);
const { renderWith, ApprovalStack, normalizeApproval, translations } = loaded;

/** A pending edit_file request of a gate in Review, as the gate makes it. */
async function gateRequest() {
  const gate = new PermissionGate({ manager: { secrets: [] }, workspace: null, timeout: 90_000 });
  const waiting = gate.authorize({ name: 'remote.edit_file', args: { path: 'notes.txt' }, definition: {}, taskId: '468680ff-4596-407d-b689-f4e24836bda8' });
  for (let i = 0; i < 200 && gate.state().pending.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const request = gate.state().pending[0];
  gate.shutdown();
  await waiting;
  return request;
}
const render = (request, lang) => renderWith(ApprovalStack, { approvals: [normalizeApproval(request)], onApprove() {}, onDeny() {} }, [], [], { lang }, {});
const textOf = (html, testid) => {
  const match = new RegExp(`<([a-z0-9]+)[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return match ? match[2].replace(/<[^>]+>/g, '') : null;
};

test('a request of an MCP client shows its tag mcp:<client> and says who asked (Vietnamese)', async () => {
  const html = await render(tagPending(await gateRequest(), 'claude-code'), 'vi');
  assert.equal(textOf(html, 'approval-requester'), 'mcp:claude-code');
  assert.match(textOf(html, 'approval-requester-note'), /^Yêu cầu này đến từ máy khách MCP mcp:claude-code trên máy này/);
  assert.match(html, /title="Máy khách MCP gửi yêu cầu \(tên do máy khách tự khai\)"/);
});

test('a request of an MCP client shows its tag and says who asked (English)', async () => {
  const html = await render(tagPending(await gateRequest(), 'codex'), 'en');
  assert.equal(textOf(html, 'approval-requester'), 'mcp:codex');
  assert.match(textOf(html, 'approval-requester-note'), /^This request comes from the MCP client mcp:codex on this computer/);
});

test('the two strings of the tag exist in both languages, translated, the Vietnamese with its diacritics', () => {
  for (const key of ['agents_apr_client', 'agents_apr_client_title']) {
    assert.equal(typeof translations.en[key], 'string', `${key} in English`);
    assert.notEqual(translations.en[key], translations.vi[key], `${key} is translated`);
    assert.match(translations.vi[key], /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i, `${key} has diacritics`);
  }
  assert.match(translations.en.agents_apr_client, /\{client\}/);
  assert.match(translations.vi.agents_apr_client, /\{client\}/);
});

test('a request of the Hub\'s own agents has no tag; a tag that is not the host\'s shape is not shown', async () => {
  const own = await gateRequest();
  const html = await render(own, 'en');
  assert.equal(textOf(html, 'approval-requester'), null);
  assert.equal(normalizeApproval({ ...own, source: 'mcp', tag: 'mcp:<img src=x onerror=alert(1)>' }).requester, undefined);
  assert.equal(normalizeApproval({ ...own, source: 'agent', tag: 'mcp:codex' }).requester, undefined, 'only a request whose source is mcp');
  assert.equal(normalizeApproval({ ...own, source: 'mcp', tag: `mcp:${'a'.repeat(65)}` }).requester, undefined);
});
