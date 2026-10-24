import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The four components every conversation is made of: the box a message is written in, one message, a run of tool calls and one tool call. Their words moved into
// the dictionary (and "Xong", which no scan for Vietnamese letters could see, was still written into the two tool rows). Nothing rendered them on its own before.
// Vietnamese is what they always said (the specs and the WebView2 smoke match some of it by name), so it is pinned; on the English screen nothing may read
// Vietnamese or be a key. The states a click reaches (an open menu, a file attached, a row opened) are started by rewriting the line that declares them.
const ENTRY = `
  ${renderPrelude}
  import { Composer } from './src/components/conversation/Composer';
  import { MessageItem } from './src/components/conversation/MessageItem';
  import { ToolActivityGroup } from './src/components/conversation/ToolActivityGroup';
  import { ToolReceipt } from './src/components/conversation/ToolReceipt';
  export { Composer, MessageItem, ToolActivityGroup, ToolReceipt };
`;
const FILES = [
  { name: 'a.txt', mimeType: 'text/plain', dataBase64: '', size: 1 },
  { name: 'b.png', mimeType: 'image/png', dataBase64: '', size: 2 },
];
const rewrite = (file, from, to) => ({ file, from, to });
const COMPOSER = 'components/conversation/Composer.tsx';

const plain = await bundleTsx(ENTRY, 'chatmcp-core-plain-');
const menu = await bundleTsx(ENTRY, 'chatmcp-core-menu-', { rewrites: [rewrite(COMPOSER, 'const [modeMenuOpen, setModeMenuOpen] = useState(false);', 'const [modeMenuOpen, setModeMenuOpen] = useState(true);')] });
const waiting = await bundleTsx(ENTRY, 'chatmcp-core-wait-', { rewrites: [rewrite(COMPOSER, 'const [dependencyMenuOpen, setDependencyMenuOpen] = useState(false);', 'const [dependencyMenuOpen, setDependencyMenuOpen] = useState(true);')] });
const attached = await bundleTsx(ENTRY, 'chatmcp-core-files-', { rewrites: [rewrite(COMPOSER, 'const [attachments, setAttachments] = useState<ChatAttachment[]>([]);', `const [attachments, setAttachments] = useState<ChatAttachment[]>(${JSON.stringify(FILES)});`)] });
const opened = await bundleTsx(ENTRY, 'chatmcp-core-open-', { rewrites: [
  rewrite('components/conversation/ToolReceipt.tsx', 'const [expanded, setExpanded] = useState(false);', 'const [expanded, setExpanded] = useState(true);'),
  rewrite('components/conversation/ToolActivityGroup.tsx', 'const [expanded, setExpanded] = useState(false);', 'const [expanded, setExpanded] = useState(true);'),
] });
after(async () => { for (const bundle of [plain, menu, waiting, attached, opened]) await bundle.dispose(); });

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const PLAIN_VIETNAMESE = /\bXong\b/;
const RAW_KEY = /\b(?:agent|agents|group|coding)_[a-z_]+\b/;
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};
const markup = (bundle, name, props, lang) => bundle.loaded.renderWith(bundle.loaded[name], props, [], [], { lang });

/** Both languages of one render: Vietnamese says every old piece, English says every new one and reads no Vietnamese and no key. */
async function both(bundle, name, props, { vi: viPieces, en: enPieces }, label) {
  const vi = await markup(bundle, name, props, 'vi'); const en = await markup(bundle, name, props, 'en');
  for (const piece of viPieces) assert.ok(vi.includes(piece) || text(vi).includes(piece), `${label}: the Vietnamese screen says "${piece}"`);
  for (const piece of enPieces) assert.ok(en.includes(piece) || text(en).includes(piece), `${label}: the English screen says "${piece}"`);
  assert.doesNotMatch(en, DIACRITICS, `${label}: the English screen reads Vietnamese: ${text(en).match(/\S*[^\s\x00-\x7F]\S*/g)}`);
  assert.doesNotMatch(en, PLAIN_VIETNAMESE, `${label}: the English screen says "Xong"`);
  for (const [lang, html] of [['vi', vi], ['en', en]]) assert.doesNotMatch(text(html), RAW_KEY, `${label} (${lang}) prints a key`);
  return { vi, en };
}

test('the composer: the box, the attach button, the send and stop buttons, and the running placeholder', async () => {
  await both(plain, 'Composer', { onSendMessage: noop }, {
    vi: ['aria-label="Tin nhắn cho agent"', 'placeholder="Bạn muốn làm gì với dự án này?"', 'aria-label="Đính kèm file hoặc ảnh"', 'title="Chọn file / kéo thả / Ctrl+V để dán ảnh"', 'Gửi', 'Enter để gửi'],
    en: ['aria-label="Message for the agent"', 'placeholder="What would you like to do with this project?"', 'aria-label="Attach a file or an image"', 'title="Choose a file / drag and drop / Ctrl+V to paste an image"', 'Send', 'Enter to send'],
  }, 'composer');
  const running = await both(plain, 'Composer', { onSendMessage: noop, isWorking: true, onStop: noop }, {
    vi: ['placeholder="Agent đang chạy — gửi chỉ dẫn mới bất kỳ lúc nào…"', 'Dừng'],
    en: ['placeholder="The agent is running — send new instructions at any time…"', 'Stop'],
  }, 'composer (running)');
  assert.ok(!running.en.includes('What would you like to do'), 'a running composer does not show the idle placeholder');
  assert.ok((await markup(plain, 'Composer', { onSendMessage: noop, placeholder: 'Custom hint' }, 'en')).includes('placeholder="Custom hint"'), 'a placeholder the caller gives is shown as it is');
});

test('the composer: the menu of permission modes, the wait-for-tasks menu and the files attached', async () => {
  const modes = await both(menu, 'Composer', { onSendMessage: noop, currentMode: 'review' }, {
    vi: ['Chế độ quyền thực thi của Agent', 'Chỉ đọc (Read-only)', 'Review (Mặc định)', 'Tự động (Autonomous)', 'FULL ACCESS'],
    en: ['Agent Execution Mode', 'Read-only', 'Review (Default)', 'Autonomous', 'FULL ACCESS'],
  }, 'composer (mode menu)');
  // the words are also the title of the button that opens the menu: the heading of the menu is what the text holds
  assert.ok(text(modes.vi).includes('Chế độ quyền thực thi của Agent') && text(modes.en).includes('Agent Execution Mode'), 'the open menu has its heading');
  const options = [{ id: 't1', label: 'Fix the login', state: 'running' }, { id: 't2', label: 'Write docs', state: 'completed' }];
  await both(plain, 'Composer', { onSendMessage: noop, dependencyOptions: options, selectedDependsOn: ['t1'] }, {
    vi: ['title="Chờ các task được chọn hoàn tất"', 'Chờ task (1)'],
    en: ['title="Wait for the selected tasks to finish"', 'Wait for tasks (1)'],
  }, 'composer (wait button)');
  const list = await both(waiting, 'Composer', { onSendMessage: noop, dependencyOptions: options, selectedDependsOn: [] }, {
    vi: ['Chỉ bắt đầu khi các task đã chọn hoàn tất', 'Fix the login', 'Write docs'],
    en: ['Starts only when the selected tasks have finished', 'Fix the login', 'Write docs'],
  }, 'composer (wait menu)');
  assert.ok(list.vi.includes('running') && list.en.includes('completed'), 'the state of a task is shown as the Hub gave it');
  await both(attached, 'Composer', { onSendMessage: noop }, {
    vi: ['aria-label="Tệp đính kèm"', 'aria-label="Bỏ a.txt"', 'aria-label="Bỏ b.png"'],
    en: ['aria-label="Attachments"', 'aria-label="Remove a.txt"', 'aria-label="Remove b.png"'],
  }, 'composer (files)');
});

test('a message: its author, its copy button and the copy button of a code block', async () => {
  const answer = { id: 'm2', role: 'assistant', content: 'Here is **the** fix:\n\n```js\nconst a = 1;\n```\n\nand `inline` code.', timestamp: '2026-10-20T10:00:05Z' };
  const reply = await both(plain, 'MessageItem', { message: answer }, {
    vi: ['DatGold', 'aria-label="Sao chép tin nhắn"', 'aria-label="Sao chép mã"', 'const a = 1;'],
    en: ['DatGold', 'aria-label="Copy message"', 'aria-label="Copy code"', 'const a = 1;'],
  }, 'assistant message');
  assert.ok(reply.vi.includes('data-testid="message-code"') && reply.en.includes('<code>const a = 1;</code>'), 'the code block is rendered, and its text is not touched');
  await both(plain, 'MessageItem', { message: { id: 'm1', role: 'user', content: 'Please fix it', timestamp: '2026-10-20T10:00:00Z' } }, {
    vi: ['Bạn', 'Please fix it', 'aria-label="Sao chép tin nhắn"'], en: ['You', 'Please fix it', 'aria-label="Copy message"'],
  }, 'user message');
  await both(plain, 'MessageItem', { message: { id: 'm3', role: 'system', content: 'The run was stopped' } }, {
    vi: ['Hệ thống', 'The run was stopped'], en: ['System', 'The run was stopped'],
  }, 'system message');
});

const call = (status, extra = {}) => ({ id: `t-${status}`, name: 'local.read_file', status, args: { path: 'src/a.ts' }, ...extra });

test('a tool call: the word for each state, and "Xong" is Done on the English screen', async () => {
  const done = await both(plain, 'ToolReceipt', { tool: call('success', { result: 'ok' }) }, { vi: ['Xong'], en: ['Done'] }, 'receipt (success)');
  assert.ok(done.vi.includes('data-status="success"') && done.en.includes('data-status="success"'), 'the status the Hub gave is kept');
  await both(plain, 'ToolReceipt', { tool: call('running') }, { vi: ['Đang chạy'], en: ['Running'] }, 'receipt (running)');
  await both(plain, 'ToolReceipt', { tool: call('error', { result: 'boom' }) }, { vi: ['Lỗi'], en: ['Error'] }, 'receipt (error)');
  await both(plain, 'ToolReceipt', { tool: call('weird') }, { vi: ['Chưa rõ kết quả'], en: ['Result unknown'] }, 'receipt (unknown)');
  assert.doesNotMatch(text(await markup(plain, 'ToolReceipt', { tool: call('success', { result: 'ok' }) }, 'en')), /\bXong\b/);
});

test('a tool call that is opened: the recorded output, the copy button and the empty states', async () => {
  await both(opened, 'ToolReceipt', { tool: call('success', { result: 'file text' }) }, {
    vi: ['Kết quả phản hồi', 'aria-label="Sao chép kết quả"', 'file text'], en: ['Reply result', 'aria-label="Copy result"', 'file text'],
  }, 'receipt (opened, with a result)');
  await both(opened, 'ToolReceipt', { tool: call('success') }, { vi: ['Chi tiết công cụ đã ghi nhận'], en: ['Recorded tool details'] }, 'receipt (opened, no result)');
  await both(opened, 'ToolReceipt', { tool: call('running', { args: undefined, result: undefined }) }, { vi: ['Đang chờ kết quả…'], en: ['Waiting for the result…'] }, 'receipt (opened, running)');
  await both(opened, 'ToolReceipt', { tool: call('success', { args: undefined, result: '' }) }, { vi: ['Không có nội dung phản hồi.'], en: ['The reply has no content.'] }, 'receipt (opened, empty)');
});

test('a run of tool calls: the state icon says Done, Running or Failed, and an opened group lists its calls', async () => {
  const finished = await both(plain, 'ToolActivityGroup', { items: [call('success'), call('success', { id: 'b' })] }, { vi: ['aria-label="Xong"'], en: ['aria-label="Done"'] }, 'group (finished)');
  assert.ok(finished.vi.includes('data-testid="tool-activity-group"'));
  await both(plain, 'ToolActivityGroup', { items: [call('success'), call('running', { id: 'b' })] }, { vi: ['aria-label="Đang chạy"'], en: ['aria-label="Running"'] }, 'group (running)');
  await both(plain, 'ToolActivityGroup', { items: [call('success'), call('error', { id: 'b' })] }, { vi: ['aria-label="Có lỗi"'], en: ['aria-label="Failed"'] }, 'group (failed)');
  const list = await both(opened, 'ToolActivityGroup', { items: [call('success', { result: 'one' }), call('error', { id: 'b', result: 'two' })] }, { vi: ['Xong', 'Lỗi'], en: ['Done', 'Error'] }, 'group (opened)');
  assert.equal((list.en.match(/data-testid="tool-receipt"/g) || []).length, 2, 'an opened group lists each call');
});
