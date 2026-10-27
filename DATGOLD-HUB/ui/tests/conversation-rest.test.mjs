import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The rest of the conversation screen went through the dictionary: the held ChatGPT package, the approval card, the copy button, the toast, the model profile
// chip and the first screen of a new conversation. Their Vietnamese is what the screen said before (the e2e and the specs match some of it by name), so these
// tests pin that text; on the English screen nothing they write may read Vietnamese or be a key.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { OutboundReviewCard } from './src/components/approval/OutboundReviewCard';
  import { ApprovalStack } from './src/components/approval/ApprovalStack';
  import { CopyButton } from './src/components/ui/CopyButton';
  import { Toast } from './src/components/ui/Toast';
  import { ModelProfilePicker, RoleOverridesField } from './src/components/conversation/ModelProfilePicker';
  import { EmptyState } from './src/components/conversation/EmptyState';
  import { translations } from './src/lib/i18n';
  export { OutboundReviewCard, ApprovalStack, CopyButton, Toast, ModelProfilePicker, RoleOverridesField, EmptyState, translations };
`, 'chatmcp-conversation-rest-');
after(dispose);
const { renderWith, OutboundReviewCard, ApprovalStack, CopyButton, Toast, ModelProfilePicker, RoleOverridesField, EmptyState, translations } = loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const RAW_KEY = /\b(?:agent|agents|group|coding)_[a-z_]+\b/;
const markup = (Component, props, lang) => renderWith(Component, props, [], [], { lang });
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const FUTURE = new Date(Date.now() + 10 * 60_000).toISOString();
const noop = () => {};

/** Both languages of one render: Vietnamese holds the old text, English holds none of it. */
async function both(Component, props, pinned, label) {
  const vi = await markup(Component, props, 'vi'); const en = await markup(Component, props, 'en');
  for (const piece of pinned) assert.ok(vi.includes(piece) || text(vi).includes(piece), `${label}: the Vietnamese screen says "${piece}"`);
  assert.doesNotMatch(en, DIACRITICS, `${label}: the English screen reads Vietnamese: ${text(en).match(/\S*[^\s\x00-\x7F]\S*/g)}`);
  for (const [lang, html] of [['vi', vi], ['en', en]]) assert.doesNotMatch(text(html), RAW_KEY, `${label} (${lang}) prints a key`);
  return { vi, en };
}

test('the held ChatGPT package reads in both languages, its Vietnamese is the old text and its controls keep their names', async () => {
  const review = { id: 'r1', tool: 'local.read_file', turn: 3, bytes: 120, expiresAt: FUTURE, redactions: [], withheld: ['.env'], preview: 'hello' };
  const { vi, en } = await both(OutboundReviewCard, { review, onDecide: noop, busy: false }, [
    'Xem lại trước khi gửi sang ChatGPT', 'Kết quả công cụ', '(gói #3, 120 byte) đang được giữ trên máy bạn.', 'Chưa có gì được gửi.', 'Nội dung dưới đây là đúng văn bản sẽ được nhập vào cuộc chat nếu bạn duyệt.',
    'Không gửi nội dung file được bảo vệ: .env.', 'trước khi nhiệm vụ dừng mà không gửi gì.', 'Duyệt và gửi', 'Giữ lại, không gửi', 'Thêm đoạn đang chọn', 'Che thêm (0)', 'Chuỗi cần che thêm, mỗi dòng một chuỗi',
  ], 'outbound review');
  for (const html of [vi, en]) for (const name of ['Approve and send', 'Withhold this result', 'Redact more']) assert.ok(html.includes(`aria-label="${name}"`), `the control named "${name}" keeps its name`);
  assert.ok(text(en).includes('Review before sending to ChatGPT') && text(en).includes('Approve and send') && text(en).includes('Hide more (0)'));
  const expired = await markup(OutboundReviewCard, { review: { ...review, expiresAt: new Date(Date.now() - 1000).toISOString() }, onDecide: noop }, 'vi');
  assert.ok(text(expired).includes('Đã hết thời gian chờ: nhiệm vụ sẽ dừng và không gửi gì.'));
  assert.doesNotMatch(await markup(OutboundReviewCard, { review: { ...review, expiresAt: new Date(Date.now() - 1000).toISOString() }, onDecide: noop }, 'en'), DIACRITICS);
});

test('the approval card reads in both languages and the section keeps the name the specs look for', async () => {
  const pending = { id: 'a1', tool: 'local.write_file', risk: 'workspace_edit', summary: 'Write a file', expiresAt: FUTURE };
  const decided = Object.fromEntries(['approved', 'denied', 'expired', 'cancelled', 'blocked', 'policy'].map((decision) => [decision, { id: `d-${decision}`, tool: 'local.write_file', risk: 'workspace_edit', decision }]));
  const { vi, en } = await both(ApprovalStack, { approvals: [pending, ...Object.values(decided)], onApprove: noop, onDeny: noop, busy: false },
    ['Yêu cầu phê duyệt hành động', 'Phân loại rủi ro:', 'Hết hạn:', 'Từ chối', 'Phê duyệt', 'Đã phê duyệt', 'Đã từ chối', 'Đã hết hạn', 'Đã hủy', 'Bị chặn', 'Bị từ chối theo chính sách', 'Tự từ chối sau'], 'approval');
  assert.ok(vi.includes('aria-label="Phê duyệt local.write_file"'), 'the Vietnamese section is named "Phê duyệt local.write_file"');
  assert.ok(en.includes('aria-label="Approval: local.write_file"'), 'the English one is named in English');
  for (const word of ['Action approval request', 'Deny', 'Approve', 'Approved', 'Denied', 'Expired', 'Cancelled', 'Blocked', 'Refused by policy']) assert.ok(text(en).includes(word), `English: ${word}`);
});

test('the copy button, the toast and the model profile chip read in both languages', async () => {
  const copy = await both(CopyButton, { text: 'x' }, ['Sao chép'], 'copy button');
  assert.ok(text(copy.en).includes('Copy') && copy.en.includes('aria-label="Copy"'));
  assert.ok((await markup(CopyButton, { text: 'x', label: 'Sao chép tin nhắn' }, 'vi')).includes('aria-label="Sao chép tin nhắn"'), 'a label given by the caller still wins');
  const toast = await both(Toast, { message: 'Hi', type: 'info', onClose: noop }, ['Đóng thông báo'], 'toast');
  assert.ok(toast.en.includes('aria-label="Close notification"'));
  const hub = { ai: { profiles: [{ id: 'p1', name: 'Fast', model: 'm', isDefault: true }], defaultProfileId: 'p1' } };
  const picker = await both(ModelProfilePicker, { hub, value: '', onChange: noop, rolesOpen: false, onToggleRoles: noop }, ['Mặc định (profile đã lưu)', 'Global gateway (không dùng profile)', '(mặc định)', 'Chọn model riêng cho từng vai trò subagent'], 'profile picker');
  for (const name of ['Task model profile']) assert.ok(picker.vi.includes(`aria-label="${name}"`) && picker.en.includes(`aria-label="${name}"`), `${name} keeps its name`);
  assert.ok(text(picker.en).includes('Default (saved profile)') && text(picker.en).includes('Global gateway (no profile)'));
  await both(RoleOverridesField, { value: '', onChange: noop }, ['Vai trò → ID profile đã lưu (JSON, tối đa 12)', 'Profile được chọn khi task bắt đầu.'], 'role overrides');
});

test('the first screen of a new conversation reads in both languages and its four starter prompts are translated', async () => {
  const hub = { agent: { mode: 'api' }, ai: { configured: false }, workspace: {}, workspaces: {} };
  await both(EmptyState, { hub, sending: false, onPick: noop }, ['Chưa chọn thư mục dự án cho agent.', 'Chọn thư mục'], 'empty state');
  const en = text(await markup(EmptyState, { hub: { ...hub, workspace: { path: '/w' }, ai: { configured: false } }, sending: false, onPick: noop }, 'en'));
  assert.ok(en.includes('No AI model is connected, so the agent cannot answer yet.') && en.includes('Connect a model'));
  for (let n = 1; n <= 4; n += 1) {
    const key = `agents_empty_prompt_${n}`;
    assert.match(translations.vi[key], /^Hãy /, `${key} in Vietnamese is the prompt the screen always sent`);
    assert.doesNotMatch(translations.en[key], DIACRITICS, `${key} in English is English`);
    assert.notEqual(translations.en[key], translations.vi[key]);
  }
});

test('every key this pass added has both languages, and the English one holds no Vietnamese unless it is the same words on both screens', () => {
  const added = Object.keys(translations.vi).filter((key) => /^agents_(?:out|apr|cmp|msg|mp|tool|toast|empty)_/.test(key) || ['agents_copy', 'agents_copied', 'agents_copy_failed'].includes(key));
  assert.ok(added.length >= 80, `the new keys are there (${added.length})`);
  for (const key of added) {
    assert.ok(translations.en[key]?.trim(), `en: ${key}`);
    if (translations.en[key] !== translations.vi[key]) assert.doesNotMatch(translations.en[key], DIACRITICS, `en.${key} reads Vietnamese`);
  }
});

// What a click does, which a server render never shows: the sentence of a copy that failed, and the prompt each starter hands over.
const clickable = await bundleTsx(`
  ${renderPrelude}
  import { CopyButton } from './src/components/ui/CopyButton';
  import { EmptyState } from './src/components/conversation/EmptyState';
  export { CopyButton, EmptyState };
`, 'chatmcp-conversation-rest-click-', { recordJsx: true });
after(clickable.dispose);
const toasts = [];
const showToast = (message, type) => { toasts.push([message, type]); };
async function elementsOf(Component, props, lang) {
  globalThis.__chatmcpJsx = [];
  await clickable.loaded.renderWith(Component, props, [], [], { lang, showToast });
  return globalThis.__chatmcpJsx.slice();
}

test('a copy that fails says so in the language on screen', async () => {
  assert.equal(translations.vi.agents_copy_failed, 'Không thể sao chép. Hãy chọn văn bản và nhấn Ctrl+C.', 'the Vietnamese sentence is the one the readability spec waits for');
  assert.equal(translations.en.agents_copy_failed, 'Cannot copy. Select the text and press Ctrl+C.');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, configurable: true });
  try {
    for (const lang of ['vi', 'en']) {
      toasts.length = 0;
      const button = (await elementsOf(clickable.loaded.CopyButton, { text: 'x' }, lang)).find((element) => element.type === 'button');
      await button.props.onClick();
      assert.deepEqual(toasts, [[translations[lang].agents_copy_failed, 'error']], `${lang}: the toast of a copy that failed`);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator;
  }
});

test('each starter of the first screen hands over the prompt of its own, in the language on screen', async () => {
  const hub = { agent: { mode: 'api' }, ai: { configured: true }, workspace: { path: '/w' }, workspaces: { activePath: '/w' } };
  for (const lang of ['vi', 'en']) {
    const picked = [];
    const elements = await elementsOf(clickable.loaded.EmptyState, { hub, sending: false, onPick: (prompt) => picked.push(prompt) }, lang);
    const starters = elements.filter((element) => element.type === 'button' && typeof element.props.onClick === 'function');
    assert.equal(starters.length, 4, `${lang}: four starters`);
    for (const starter of starters) starter.props.onClick();
    assert.deepEqual(picked, [1, 2, 3, 4].map((n) => translations[lang][`agents_empty_prompt_${n}`]), `${lang}: the starters, in order, hand over their own prompts`);
  }
});
