import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, all, accessibleName, duplicateIds, unnamedControls, brokenReferences } from './support/html.mjs';

// The conversation screen (ConversationView) and the sidebar (SessionSidebar). Their Vietnamese is what the screen said before their words moved
// into the dictionary (ui/e2e/agents.spec.mjs and readability.spec.mjs match some of it), so these tests pin that text; their English is dictionary
// text, so on the English screen nothing these two files write may read Vietnamese. What the Hub itself writes (the message of a refusal, a handoff
// note, the error of a task) is shown as written in both languages: the Hub has one language.
//
// Three kinds of words are tested. What a server render shows (a paragraph, a title, a label) is read from the markup. A toast, a confirmation or a
// prompt exists only when a person clicks, so the handler that a button or a child component was given is taken from the elements the render
// created and called here, against a Hub that answers as the test says (tests/support/bundle.mjs: recordJsx). And a state only a click reaches (an
// open form, a typed value, the "back to the latest" button) is started by rewriting the line that declares it in a second bundle (rewrites).
const REWRITES = [
  { file: 'src/components/sessions/SessionSidebar.tsx', from: 'const [manualFolderOpen,setManualFolderOpen]=useState(false)', to: 'const [manualFolderOpen,setManualFolderOpen]=useState(true)' },
  { file: 'src/components/sessions/SessionSidebar.tsx', from: "const [manualFolder,setManualFolder]=useState('')", to: "const [manualFolder,setManualFolder]=useState('/work/typed')" },
  { file: 'src/components/sessions/SessionSidebar.tsx', from: 'useState<Record<string,boolean>>({})', to: "useState<Record<string,boolean>>({'/work/beta':true})" },
  { file: 'src/components/conversation/ConversationView.tsx', from: 'const [showLatest, setShowLatest] = useState(false)', to: 'const [showLatest, setShowLatest] = useState(true)' },
  { file: 'src/components/conversation/ConversationView.tsx', from: 'const [recoveringChatUrl,setRecoveringChatUrl] = useState(false)', to: 'const [recoveringChatUrl,setRecoveringChatUrl] = useState(true)' },
  { file: 'src/components/conversation/ConversationView.tsx', from: "const [selectedProfileId, setSelectedProfileId] = useState('')", to: "const [selectedProfileId, setSelectedProfileId] = useState('missing-profile')" },
];
const ENTRY = `
  ${renderPrelude}
  import { ConversationView } from './src/components/conversation/ConversationView';
  import { SessionSidebar } from './src/components/sessions/SessionSidebar';
  import { translations } from './src/lib/i18n';
  export { ConversationView, SessionSidebar, translations };
`;
const plain = await bundleTsx(ENTRY, 'chatmcp-screen-', { recordJsx: true });
const forced = await bundleTsx(ENTRY, 'chatmcp-screen-forced-', { recordJsx: true, rewrites: REWRITES });
after(async () => { await plain.dispose(); await forced.dispose(); });
const { translations } = plain.loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
/** A dictionary key printed instead of its text. Nothing the fixtures below say looks like one. */
const RAW_KEY = /\b(?:agents?|group|coding|sidebar|status)_[a-z_]+\b/;

// ---- the Hub's answers, in plain ASCII so that any Vietnamese on the English screen can only come from the component ----
const ALPHA = '/work/alpha', BETA = '/work/beta';
const chat = (id, extra = {}) => ({ id, task: `Chat ${id}`, status: 'completed', state: 'completed', workspacePath: ALPHA, ...extra });
const hubState = (overrides = {}) => ({
  workspace: { path: ALPHA },
  workspaces: { activePath: ALPHA, items: [{ path: ALPHA, name: 'alpha' }, { path: BETA, name: 'beta' }] },
  tasks: [chat('chat-1', { task: 'Fix the login page' }), chat('chat-2', { task: '', status: 'running', state: 'running' }), chat('chat-3', { workspacePath: BETA })],
  agent: { mode: 'api', tasks: [] },
  studio: { permissions: { mode: 'review', pending: [], recent: [] } },
  browser: {},
  ai: { profiles: [] },
  ...overrides,
});
const record = (extra = {}) => ({ id: 'chat-1', task: 'Fix the login page', status: 'completed', state: 'completed', messages: [], toolCalls: [], transport: 'api', ...extra });
const review = { id: 'rv-1', taskId: 'chat-1', turn: 3, tool: 'local.read_file', kind: 'tool_result', at: '2026-10-20T10:00:00Z', expiresAt: '2099-01-01T00:00:00Z', bytes: 120, preview: 'file text', redactions: {}, withheld: [], manualCount: 0 };
const flow = { id: 'wf-1', name: 'Review and verify', conversationId: 'chat-1', parentRunId: 'run-1', workspacePath: ALPHA, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:01:00Z', status: 'running', completed: 1, total: 2, activeAgents: 1, failedAgents: 0, usage: {}, phases: [] };

// ---- a Hub that answers as the test says, and a screen that records what it was asked ----
const calls = [];
const routes = new Map();
const toasts = [];
const showToast = (message, type) => { toasts.push([message, type]); };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (route, options = {}) => {
  calls.push({ route, body: options.body ? JSON.parse(options.body) : undefined });
  const answer = routes.get(route);
  const result = answer ? await answer(options.body ? JSON.parse(options.body) : undefined) : { ok: true };
  return result instanceof Response ? result : reply(200, result);
};
/** The Hub's routes for the next steps: a value is its answer, a function is called with the request and may return a Response or throw. */
function serve(table = {}) {
  calls.length = 0; toasts.length = 0; routes.clear();
  for (const [route, answer] of Object.entries(table)) routes.set(route, typeof answer === 'function' ? answer : () => answer);
}
const refuses = (message, code) => () => reply(409, { error: message, ...(code ? { code } : {}) });
const throwsNothingSaid = () => { throw new Error(''); };

async function screen(bundle, name, { lang = 'vi', hub = hubState(), task, extra = [], store = {} } = {}) {
  globalThis.__chatmcpJsx = [];
  const entries = [[['hubState'], hub], ...(task ? [[['task', task.id], task]] : []), ...extra];
  const html = await bundle.loaded.renderWith(bundle.loaded[name], {}, entries, [], { lang, showToast, ...store });
  return { html, root: parseHtml(html), elements: globalThis.__chatmcpJsx.slice() };
}
const conversation = (options) => screen(plain, 'ConversationView', options);
const sidebar = (options) => screen(plain, 'SessionSidebar', options);

const button = (label) => (element) => element.type === 'button' && element.props['aria-label'] === label;
const labelled = (text) => (element) => element.type === 'button' && element.props.children === text;
const component = (name) => (element) => typeof element.type === 'function' && element.type.name === name;
const handlerOf = (shot, match, prop = 'onClick') => {
  const found = shot.elements.find((element) => match(element) && typeof element.props[prop] === 'function');
  assert.ok(found, `no element gave a ${prop}`);
  return found.props[prop];
};
/**
 * Click it, as a browser would: window.confirm answers `confirmAnswer` and says what it was asked, localStorage exists (the store writes the
 * selection there), and every step the handler started (a request, a toast) is let finish. It gives back what the handler returned.
 */
async function fire(handler, args = [], { confirmAnswer = true } = {}) {
  const asked = [];
  globalThis.window = { confirm: (message) => { asked.push(message); return confirmAnswer; } };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  let result;
  try {
    result = await handler(...args);
    // a handler that does not hand back its promise (onClick={() => void remove()}) goes on after it returned: the browser's globals stay until it is done
    for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve));
  } finally { delete globalThis.window; delete globalThis.localStorage; }
  return { asked, result };
}
const testId = (root, id) => all(root).filter((node) => node.attrs['data-testid'] === id);
/** Everything a person or a screen reader can read in a subtree: its text and its titles, labels and placeholders. */
const words = (node) => [node.text, ...[node, ...all(node)].flatMap((item) => ['title', 'aria-label', 'placeholder'].map((name) => item.attrs?.[name]).filter(Boolean))].join(' | ');
const paragraph = (root, text) => all(root).find((node) => node.tag === 'p' && node.text === text);

// ---- every word the two files write, in both languages: what the screen said before, and its English ----
const T = {
  vi: {
    loading: 'Đang tải hội thoại…', empty: 'Chưa có nội dung hội thoại được lưu.', replying: 'Đang trả lời…', copyReply: 'Sao chép nội dung đang trả lời',
    approvals: (n) => `Lịch sử phê duyệt (${n})`, latest: 'Về nội dung mới nhất ↓',
    urlMissing: 'Chưa có URL ChatGPT chính thức cho task này. Mở tab ChatGPT đã gửi nhiệm vụ, rồi yêu cầu Extension xác nhận URL. ChatMCP sẽ không tự tạo chat mới hoặc gửi lại prompt.',
    urlRecover: 'Khôi phục URL ChatGPT từ tab đã gửi', urlAsking: 'Đang yêu cầu…',
    switchNotice: (transport) => `Lượt tiếp theo sử dụng ${transport}. ChatMCP giữ liên kết với các lượt trước và chuyển tóm tắt ngữ cảnh, nhưng không giả định hai model dùng chung lịch sử. Các thao tác ghi file chưa xác minh sẽ không được tự động phát lại.`,
    webHint: 'Kênh Web Companion hiện chỉ gửi văn bản qua tab ChatGPT; dùng Model API để gửi ảnh/tệp đính kèm.',
    webConnected: 'Companion đã kết nối', webPaired: 'Companion đã ghép; mở tab ChatGPT', webUnpaired: 'Cần ghép ChatMCP Hub Companion trước khi gửi task', setup: 'Thiết lập',
    reviewMissing: 'Không tìm thấy chuỗi đó trong gói đang chờ.', reviewApproved: 'Đã duyệt: gói được chuyển cho Companion để gửi.', reviewWithheld: 'Đã giữ lại: ChatGPT chỉ nhận một thông báo.',
    reviewRedacted: 'Đã che thêm; gói vẫn đang chờ bạn quyết định.', reviewFailed: 'Không thể gửi quyết định xem lại.', profileGone: 'Model profile đã chọn không còn tồn tại.',
    filesPrompt: 'Hãy phân tích tệp/ảnh đính kèm.', handoff: 'Đã chuyển sang kênh agent đã chọn.', sendFailed: 'Không thể gửi tin nhắn',
    workflowStopped: 'Đã gửi yêu cầu dừng các subagent trong workflow.', workflowStopFailed: 'Không thể dừng workflow',
    urlKnown: 'URL chính thức đã có.', urlAskingToast: 'Đang yêu cầu Companion kiểm tra tab ChatGPT cũ. Giữ tab đó mở, chờ kết quả rồi nhấn Tiếp tục.', urlFailed: 'Không thể khôi phục URL chat.',
    stopSent: 'Đã gửi yêu cầu dừng tác vụ', stopFailed: 'Không thể dừng tác vụ', modeSet: (mode) => `Đã chuyển sang chế độ ${mode}`, modeFailed: 'Không thể đổi chế độ quyền',
    approved: 'Đã phê duyệt hành động', approveFailed: 'Lỗi phê duyệt', denied: 'Đã từ chối hành động', denyFailed: 'Lỗi từ chối',
    continuePrompt: 'Tiếp tục tác vụ trong cùng cuộc hội thoại. Kiểm tra trạng thái hiện tại trước khi thao tác; không tự chạy lại thao tác có kết quả chưa rõ.',
    profileTitle: (name, model, revision) => `Model profile: ${name} · ${model} · revision ${revision}`,
    // the sidebar
    pickFailed: 'Không thể chọn workspace.', picked: (path) => `Đã chọn workspace ${path}`, pathInvalid: 'Đường dẫn workspace không hợp lệ.', switchFailed: 'Không thể chuyển workspace.',
    removeConfirm: (name, n) => `Gỡ workspace "${name}" khỏi ChatMCP?\n\n${n} hội thoại và các background tasks của workspace sẽ được ẩn khỏi giao diện. Lịch sử vẫn được lưu và hiện lại khi thêm đúng thư mục.\n\nKHÔNG xoá thư mục, file, nhánh Git hay worktree trên máy.`,
    removed: 'Đã gỡ workspace khỏi danh sách. Tệp trên ổ đĩa vẫn được giữ nguyên.', removeFailed: 'Không thể gỡ workspace.',
    deleteConfirm: (title, related) => `Xóa hội thoại "${title}"?\n\nLịch sử các lượt task${related ? ` và ${related} subagent` : ''} sẽ bị xóa khỏi ChatMCP. Không thể hoàn tác việc xóa lịch sử.\n\nKHÔNG xóa file dự án, nhánh Git hay worktree.`,
    deleted: 'Đã xóa hội thoại và các tác vụ con. Các tệp dự án được giữ nguyên.', deleteFailed: 'Không thể xóa hội thoại.',
    search: 'Tìm hội thoại', add: 'Thêm workspace', addHint: 'Chọn thư mục bằng Windows Explorer', manual: 'Nhập đường dẫn thư mục nếu hộp chọn Windows không mở',
    manualLabel: 'Nhập đường dẫn workspace thủ công', cancel: 'Hủy', open: (name) => `Mở nhóm ${name}`, shut: (name) => `Thu gọn nhóm ${name}`,
    removeLabel: (name) => `Gỡ workspace ${name}`, removeHint: 'Gỡ khỏi ChatMCP — không xóa thư mục trên ổ đĩa', deleteLabel: (title) => `Xóa hội thoại: ${title}`,
    deleteBusy: 'Dừng task và subagent trước khi xóa', deleteHint: 'Xóa hội thoại và lịch sử task (không xóa file)', untitled: 'Cuộc hội thoại',
    newChat: 'Hội thoại mới', searchPlaceholder: 'Tìm kiếm phiên...', workspaces: 'Workspace',
  },
  en: {
    loading: 'Loading the conversation…', empty: 'No conversation content has been saved yet.', replying: 'Replying…', copyReply: 'Copy the reply in progress',
    approvals: (n) => `Approval history (${n})`, latest: 'Back to the latest ↓',
    urlMissing: 'There is no official ChatGPT URL for this task yet. Open the ChatGPT tab that received the task, then ask the Extension to confirm the URL. ChatMCP will not start a new chat or send the prompt again on its own.',
    urlRecover: 'Recover the ChatGPT URL from the tab that received the task', urlAsking: 'Requesting…',
    switchNotice: (transport) => `The next turn uses ${transport}. ChatMCP keeps the link to the earlier turns and passes on a summary of the context, but it does not assume the two models share a history. File writes that were not verified are not replayed automatically.`,
    webHint: 'The Web Companion channel only sends text through the ChatGPT tab for now; use the Model API to send images or attached files.',
    webConnected: 'Companion connected', webPaired: 'Companion paired; open a ChatGPT tab', webUnpaired: 'Pair the ChatMCP Hub Companion before sending a task', setup: 'Set up',
    reviewMissing: 'That text was not found in the package that is waiting.', reviewApproved: 'Approved: the package was passed to the Companion to send.', reviewWithheld: 'Withheld: ChatGPT receives only a notice.',
    reviewRedacted: 'More text hidden; the package is still waiting for your decision.', reviewFailed: 'Could not send the review decision.', profileGone: 'The model profile you chose no longer exists.',
    filesPrompt: 'Please analyze the attached files and images.', handoff: 'Switched to the agent channel you chose.', sendFailed: 'Could not send the message',
    workflowStopped: 'Stop requested for the subagents in the workflow.', workflowStopFailed: 'Could not stop the workflow',
    urlKnown: 'The official URL is already known.', urlAskingToast: 'Asking the Companion to check the earlier ChatGPT tab. Keep that tab open, wait for the result, then press Continue.', urlFailed: 'Could not recover the chat URL.',
    stopSent: 'Stop requested for the task', stopFailed: 'Could not stop the task', modeSet: (mode) => `Switched to ${mode} mode`, modeFailed: 'Could not change the permission mode',
    approved: 'Action approved', approveFailed: 'Approval failed', denied: 'Action denied', denyFailed: 'Denial failed',
    continuePrompt: 'Continue the task in the same conversation. Check the current state before acting; do not re-run an action whose result is unclear.',
    profileTitle: (name, model, revision) => `Model profile: ${name} · ${model} · revision ${revision}`,
    pickFailed: 'Could not choose the workspace.', picked: (path) => `Selected workspace ${path}`, pathInvalid: 'The workspace path is not valid.', switchFailed: 'Could not switch workspace.',
    removeConfirm: (name, n) => `Remove the workspace "${name}" from ChatMCP?\n\n${n} conversation${n === 1 ? '' : 's'} and the workspace’s background tasks will be hidden from the interface. The history stays saved and comes back when you add the same folder again.\n\nThis does NOT delete the folder, files, Git branches or worktrees on this computer.`,
    removed: 'The workspace was removed from the list. The files on disk are left untouched.', removeFailed: 'Could not remove the workspace.',
    deleteConfirm: (title, related) => `Delete the conversation "${title}"?\n\nThe history of its task turns${related ? ` and ${related} subagent${related === 1 ? '' : 's'}` : ''} will be removed from ChatMCP. This cannot be undone.\n\nThis does NOT delete project files, Git branches or worktrees.`,
    deleted: 'The conversation and its subtasks were deleted. The project files are left untouched.', deleteFailed: 'Could not delete the conversation.',
    search: 'Search conversations', add: 'Add workspace', addHint: 'Choose a folder with Windows Explorer', manual: 'Type the folder path if the Windows folder picker does not open',
    manualLabel: 'Type the workspace path by hand', cancel: 'Cancel', open: (name) => `Expand group ${name}`, shut: (name) => `Collapse group ${name}`,
    removeLabel: (name) => `Remove workspace ${name}`, removeHint: 'Remove from ChatMCP — the folder on disk is not deleted', deleteLabel: (title) => `Delete conversation: ${title}`,
    deleteBusy: 'Stop the task and its subagents before deleting', deleteHint: 'Delete the conversation and its task history (files are not deleted)', untitled: 'Conversation',
    newChat: 'New Session', searchPlaceholder: 'Search sessions...', workspaces: 'Workspaces',
  },
};
const LANGS = [['vi', 'in Vietnamese'], ['en', 'in English']];

// ---- what a server render shows: the conversation screen ----

for (const [lang, label] of LANGS) {
  const t = T[lang];
  test(`${label} the conversation screen writes ${lang === 'vi' ? 'what it wrote before its words moved into the dictionary' : 'English where it used to write Vietnamese'}: loading, empty, replying, history`, async () => {
    const loading = await conversation({ lang, store: { selectedTaskId: 'chat-1' } });
    assert.ok(paragraph(loading.root, t.loading), `the loading line: ${words(loading.root).slice(0, 300)}`);
    const empty = await conversation({ lang, task: record(), store: { selectedTaskId: 'chat-1' } });
    assert.ok(paragraph(empty.root, t.empty), 'a saved conversation with nothing in it says so');
    // a reply in progress: its heading line and the name of the button that copies it
    const replying = await conversation({ lang, task: record({ status: 'running', state: 'running' }), store: { selectedTaskId: 'chat-1', streamingTaskId: 'chat-1', streamingToken: 'partial answer' } });
    const live = testId(replying.root, 'streaming-message')[0];
    assert.ok(live, 'the live reply is on screen');
    assert.ok(all(live).some((node) => node.tag === 'span' && node.text === t.replying), `“${t.replying}”`);
    assert.ok(byTag(live, 'button').some((node) => accessibleName(live, node) === t.copyReply), `the copy button is named “${t.copyReply}”`);
    // earlier approvals sit under a summary that counts them
    const decided = { id: 'a-1', taskId: 'chat-1', category: 'workspace_edit', toolName: 'local.write_file', summary: 'Write a file', decision: 'approved' };
    const history = await conversation({ lang, task: record(), hub: hubState({ studio: { permissions: { mode: 'review', pending: [], recent: [decided, { ...decided, id: 'a-2' }, { ...decided, id: 'a-3', taskId: 'other' }] } } }), store: { selectedTaskId: 'chat-1' } });
    assert.equal(byTag(history.root, 'summary')[0]?.text, t.approvals(2), 'the approvals of this conversation are counted, not the other conversations’');
    for (const shot of [loading, empty, replying, history]) assert.doesNotMatch(shot.html, RAW_KEY, `${lang}: a dictionary key was shown instead of text`);
    if (lang === 'en') for (const node of [paragraph(loading.root, t.loading), paragraph(empty.root, t.empty), all(live).find((item) => item.tag === 'span' && item.text === t.replying), byTag(history.root, 'summary')[0]]) {
      assert.doesNotMatch(words(node), DIACRITICS, `Vietnamese on the English screen: ${words(node)}`);
    }
    if (lang === 'en') assert.doesNotMatch(byTag(live, 'button').map((item) => item.attrs['aria-label']).join(' | '), DIACRITICS, 'the copy button’s name (its own visible word is the CopyButton’s)');
  });

  test(`${label} the notices above a conversation (the missing ChatGPT URL, the change of channel, the ChatGPT Web banner, the latest-message button) read as the dictionary says`, async () => {
    // a ChatGPT Web task with no official URL: the notice, and its button (also while it asks)
    const lost = await conversation({ lang, task: record({ transport: 'chatgpt-web', chatUrl: '' }), store: { selectedTaskId: 'chat-1' } });
    assert.ok(paragraph(lost.root, t.urlMissing), 'the notice');
    assert.ok(byTag(lost.root, 'button').some((node) => node.text === t.urlRecover && !('disabled' in node.attrs)), 'the button that asks the Companion');
    const asking = await screen(forced, 'ConversationView', { lang, task: record({ transport: 'chatgpt-web', chatUrl: '' }), store: { selectedTaskId: 'chat-1' } });
    assert.ok(byTag(asking.root, 'button').some((node) => node.text === t.urlAsking && 'disabled' in node.attrs), 'while it asks, the button says so and is off');
    // the next turn goes through the other channel: the notice names it in bold
    for (const [mode, transport, name] of [['chatgpt-web', 'api', 'ChatGPT Web Companion'], ['api', 'chatgpt-web', 'Model API']]) {
      const hub = hubState({ agent: { mode, tasks: [] } });
      const shot = await conversation({ lang, hub, task: record({ transport, chatUrl: 'https://chatgpt.com/c/abc' }), store: { selectedTaskId: 'chat-1' } });
      const notice = testId(shot.root, 'transport-switch-notice')[0];
      assert.ok(notice, `${transport} -> ${mode}: the notice`);
      assert.equal(notice.text, t.switchNotice(name));
      assert.deepEqual(byTag(notice, 'strong').map((node) => node.text), [name], 'only the channel is bold');
    }
    assert.equal(testId((await conversation({ lang, task: record(), store: { selectedTaskId: 'chat-1' } })).root, 'transport-switch-notice').length, 0, 'the same channel: no notice');
    // the banner of a new ChatGPT Web conversation, for each state of the Companion
    for (const [browser, status] of [[{ connected: true }, t.webConnected], [{ paired: true }, t.webPaired], [{}, t.webUnpaired]]) {
      const shot = await conversation({ lang, hub: hubState({ agent: { mode: 'chatgpt-web', tasks: [] }, browser }) });
      const banner = testId(shot.root, 'chatgpt-web-mode-banner')[0];
      assert.ok(banner, 'the banner');
      const line = byTag(banner, 'span')[0];
      assert.equal(line.text, `ChatGPT Web (text-only) · ${status}`);
      assert.equal(line.attrs.title, t.webHint);
      assert.deepEqual(byTag(banner, 'button').map((node) => node.text), [t.setup]);
      assert.doesNotMatch(banner.text + line.attrs.title, RAW_KEY);
      if (lang === 'en') assert.doesNotMatch(words(banner), DIACRITICS, `Vietnamese in the English banner: ${words(banner)}`);
    }
    // the button that takes a reader back to the newest message
    const scrolled = await screen(forced, 'ConversationView', { lang, task: record(), store: { selectedTaskId: 'chat-1' } });
    assert.ok(byTag(scrolled.root, 'button').some((node) => node.text === t.latest), `“${t.latest}”`);
    assert.equal(byTag((await conversation({ lang, task: record(), store: { selectedTaskId: 'chat-1' } })).root, 'button').filter((node) => node.text === t.latest).length, 0, 'and only once the reader has scrolled away');
    if (lang === 'en') for (const shot of [lost, asking, scrolled]) {
      const mine = all(shot.root).filter((node) => (node.tag === 'p' && [t.urlMissing].includes(node.text)) || (node.tag === 'button' && [t.urlRecover, t.urlAsking, t.latest].includes(node.text)));
      assert.ok(mine.length > 0);
      for (const node of mine) assert.doesNotMatch(words(node), DIACRITICS, `Vietnamese on the English screen: ${words(node)}`);
    }
  });

  test(`${label} the title of the active model profile is the one it always was`, async () => {
    const profile = { id: 'p-1', name: 'Fast', model: 'mock-coder', revision: '0123456789abcdef', provider: 'x', protocol: 'x', endpointOrigin: 'x', credentialSource: 'x' };
    const shot = await conversation({ lang, task: record({ effectiveProfile: profile }), store: { selectedTaskId: 'chat-1' } });
    const chip = testId(shot.root, 'active-model-profile')[0];
    assert.equal(chip.attrs.title, t.profileTitle('Fast', 'mock-coder', '01234567'));
  });
}

// ---- what a server render shows: the sidebar ----

for (const [lang, label] of LANGS) {
  const t = T[lang];
  test(`${label} the sidebar names every control as the dictionary says (and has no Vietnamese of its own on the English screen)`, async () => {
    const shot = await sidebar({ lang });
    const names = byTag(shot.root, 'button', 'input').map((node) => [node.tag, accessibleName(shot.root, node), node.attrs.title, node.attrs.placeholder]);
    const textOf = (name) => names.find((entry) => entry[1] === name);
    assert.ok(textOf(t.newChat), 'the new-conversation button');
    assert.deepEqual(textOf(t.search)?.slice(0, 1), ['input'], `the search box is named “${t.search}”`);
    assert.equal(textOf(t.search)[3], t.searchPlaceholder);
    assert.equal(textOf(t.add)?.[2], t.addHint, 'the + button is named and has a hint');
    for (const name of ['alpha', 'beta']) {
      assert.ok(textOf(t.shut(name)), `an open group can be collapsed: ${t.shut(name)}`);
      assert.equal(textOf(t.removeLabel(name))?.[2], t.removeHint, `${name}: the remove button and its hint`);
    }
    // a conversation with text, one with none that is running (so it cannot be deleted), and the ids that name them
    assert.equal(textOf(t.deleteLabel('Fix the login page'))?.[2], t.deleteHint);
    assert.equal(textOf(t.deleteLabel('chat-2'))?.[2], t.deleteBusy, 'a running conversation says why it cannot be deleted yet');
    assert.ok(all(shot.root).some((node) => node.tag === 'span' && node.text === t.untitled), `a conversation with no text is called “${t.untitled}”`);
    assert.ok(all(shot.root).some((node) => node.tag === 'span' && node.text === t.workspaces));
    assert.doesNotMatch(shot.html, RAW_KEY, `${lang}: a dictionary key was shown instead of text`);
    if (lang === 'en') assert.doesNotMatch(shot.html, DIACRITICS, `Vietnamese on the English screen: ${shot.html.match(new RegExp(`.{0,60}${DIACRITICS.source}.{0,60}`, 'i'))?.[0]}`);
  });

  test(`${label} the sidebar's folder form, a collapsed group and the empty states read as the dictionary says`, async () => {
    const shot = await screen(forced, 'SessionSidebar', { lang });
    const form = byTag(shot.root, 'form')[0];
    assert.ok(form, 'the form for typing a folder is open');
    assert.equal(byTag(form, 'label')[0].text, t.manual);
    const input = byTag(form, 'input')[0];
    assert.equal(accessibleName(form, input), t.manualLabel);
    assert.equal(input.attrs.value, '/work/typed');
    assert.equal(input.attrs.placeholder, 'F:\\\\Personal_Project\\\\Vin\\\\ChatMCP', 'the example path was never a translated word');
    assert.deepEqual(byTag(form, 'button').map((node) => node.text), [t.add, t.cancel]);
    assert.ok(byTag(shot.root, 'button').some((node) => accessibleName(shot.root, node) === t.open('beta')), `a collapsed group can be opened: ${t.open('beta')}`);
    assert.ok(byTag(shot.root, 'button').some((node) => accessibleName(shot.root, node) === t.shut('alpha')));
    const quiet = await sidebar({ lang, hub: hubState({ workspaces: { activePath: '', items: [] }, workspace: undefined, tasks: [] }) });
    assert.doesNotMatch(quiet.html, RAW_KEY);
    if (lang === 'en') for (const html of [shot.html, quiet.html]) assert.doesNotMatch(html, DIACRITICS, `Vietnamese on the English screen: ${html.match(new RegExp(`.{0,60}${DIACRITICS.source}.{0,60}`, 'i'))?.[0]}`);
  });
}

// ---- what only a click shows: toasts, confirmations and the prompts the screen writes on a person's behalf ----

for (const [lang, label] of LANGS) {
  const t = T[lang];
  test(`${label} sending a message: the prompt it writes when there is only an attachment, the toasts of a refusal, a handoff and a profile that is gone`, async () => {
    const files = [{ name: 'a.txt', mimeType: 'text/plain', size: 1, data: 'eA==' }];
    // a new conversation and an existing one: with attachments and no text, the prompt is the screen's own
    serve({ '/api/tasks/start': { task: { id: 'new-1', status: 'queued' } } });
    const fresh = await conversation({ lang });
    assert.equal((await fire(handlerOf(fresh, component('Composer'), 'onSendMessage'), ['', files])).result, true);
    assert.equal(calls[0].route, '/api/tasks/start');
    assert.equal(calls[0].body.prompt, t.filesPrompt);
    assert.deepEqual(toasts, []);
    serve({ '/api/tasks/continue': { task: { id: 'chat-1', status: 'queued' } } });
    const open = await conversation({ lang, task: record(), store: { selectedTaskId: 'chat-1' } });
    await fire(handlerOf(open, component('Composer'), 'onSendMessage'), ['', files]);
    assert.equal(calls[0].body.prompt, t.filesPrompt);
    await fire(handlerOf(open, component('Composer'), 'onSendMessage'), ['  typed text  ', []]);
    assert.equal(calls[1].body.prompt, '  typed text  ', 'what a person types is sent as typed');
    // a refusal: the Hub's own words win; a failure that says nothing gets the screen's sentence
    serve({ '/api/tasks/start': refuses('Hub says no', 'hub_busy') });
    assert.equal((await fire(handlerOf(fresh, component('Composer'), 'onSendMessage'), ['hello', []])).result, false);
    assert.deepEqual(toasts, [['Hub says no', 'error']]);
    serve({ '/api/tasks/start': throwsNothingSaid });
    await fire(handlerOf(fresh, component('Composer'), 'onSendMessage'), ['hello', []]);
    assert.deepEqual(toasts, [[t.sendFailed, 'error']]);
    // a model profile that was chosen and has since been deleted
    serve();
    const gone = await screen(forced, 'ConversationView', { lang });
    await fire(handlerOf(gone, component('Composer'), 'onSendMessage'), ['hello', []]);
    assert.deepEqual(toasts, [[t.profileGone, 'error']]);
    assert.deepEqual(calls, [], 'and nothing is sent');
    // the next turn went to another channel: the Hub's note, else the screen's own
    serve({ '/api/tasks/continue': { task: { id: 'chat-9', status: 'queued', handoff: { note: 'Hub note' } } } });
    await fire(handlerOf(open, component('Composer'), 'onSendMessage'), ['again', []]);
    assert.deepEqual(toasts, [['Hub note', 'info']]);
    serve({ '/api/tasks/continue': { task: { id: 'chat-9', status: 'queued' } } });
    await fire(handlerOf(open, component('Composer'), 'onSendMessage'), ['again', []]);
    assert.deepEqual(toasts, [[t.handoff, 'info']]);
  });

  test(`${label} Stop, the permission mode, an approval, a denial and the workflow's Stop: the toast of each success and each failure`, async () => {
    const stoppable = await conversation({ lang, task: record({ status: 'running', state: 'running' }), store: { selectedTaskId: 'chat-1' } });
    const stop = handlerOf(stoppable, component('PhaseRibbon'), 'onCancel');
    serve({ '/api/tasks/cancel': { task: { id: 'chat-1', status: 'cancelled' } } });
    await fire(stop);
    assert.deepEqual(toasts, [[t.stopSent, 'info']]);
    serve({ '/api/tasks/cancel': throwsNothingSaid });
    await fire(stop);
    assert.deepEqual(toasts, [[t.stopFailed, 'error']]);
    serve({ '/api/tasks/cancel': refuses('Hub says no') });
    await fire(stop);
    assert.deepEqual(toasts, [['Hub says no', 'error']]);

    const mode = handlerOf(stoppable, component('Composer'), 'onModeChange');
    serve({ '/api/studio/permissions/config': { ok: true } });
    await fire(mode, ['autonomous']);
    assert.deepEqual(toasts, [[t.modeSet('autonomous'), 'info']]);
    assert.deepEqual(calls[0].body, { mode: 'autonomous', leaveFullAccess: true });
    // The menu asks the Hub to leave Full Access whatever the page last read: the snapshot it holds can be older than the Hub's state (Full Access was
    // turned on a moment ago), so it is the Hub, not the snapshot, that knows whether there is a Full Access to leave.
    const inFullAccess = await conversation({ lang, hub: hubState({ studio: { permissions: { mode: 'autonomous', executionPolicy: 'full-access', pending: [], recent: [] } } }), task: record({ status: 'running', state: 'running' }), store: { selectedTaskId: 'chat-1' } });
    serve({ '/api/studio/permissions/config': { ok: true } });
    await fire(handlerOf(inFullAccess, component('Composer'), 'onModeChange'), ['review']);
    assert.deepEqual(calls[0].body, { mode: 'review', leaveFullAccess: true }, 'the same request when the page knows Full Access is on');
    serve({ '/api/studio/permissions/config': { ok: true } });
    serve({ '/api/studio/permissions/config': throwsNothingSaid });
    await fire(mode, ['autonomous']);
    assert.deepEqual(toasts, [[t.modeFailed, 'error']]);

    const stack = handlerOf(stoppable, component('ApprovalStack'), 'onApprove');
    const deny = handlerOf(stoppable, component('ApprovalStack'), 'onDeny');
    serve({ '/api/studio/permissions/decide': { ok: true } });
    await fire(stack, ['a-1']);
    assert.deepEqual(toasts, [[t.approved, 'success']]);
    assert.deepEqual(calls[0].body, { id: 'a-1', approved: true });
    serve({ '/api/studio/permissions/decide': { ok: true } });
    await fire(deny, ['a-1']);
    assert.deepEqual(toasts, [[t.denied, 'info']]);
    assert.deepEqual(calls[0].body, { id: 'a-1', approved: false });
    serve({ '/api/studio/permissions/decide': throwsNothingSaid });
    await fire(stack, ['a-1']);
    assert.deepEqual(toasts, [[t.approveFailed, 'error']]);
    serve({ '/api/studio/permissions/decide': throwsNothingSaid });
    await fire(deny, ['a-1']);
    assert.deepEqual(toasts, [[t.denyFailed, 'error']]);

    const withFlow = await conversation({ lang, task: record(), extra: [[['backgroundRuns'], { tasks: [], workflows: [flow, { ...flow, id: 'wf-other', conversationId: 'chat-other' }] }]], store: { selectedTaskId: 'chat-1' } });
    const cards = withFlow.elements.filter(component('WorkflowCard'));
    assert.equal(cards.length, 1, 'only this conversation’s workflow is in the chat');
    serve({ '/api/workflows/cancel': { workflow: flow } });
    await fire(cards[0].props.onCancel, ['wf-1']);
    assert.deepEqual(toasts, [[t.workflowStopped, 'info']]);
    assert.deepEqual(calls[0].body, { id: 'wf-1' });
    serve({ '/api/workflows/cancel': throwsNothingSaid });
    await fire(cards[0].props.onCancel, ['wf-1']);
    assert.deepEqual(toasts, [[t.workflowStopFailed, 'error']]);
  });

  test(`${label} Retry and Continue send the screen's own prompt, and the held ChatGPT package's decisions and the lost URL's recovery toast what they did`, async () => {
    const failed = await conversation({ lang, task: record({ status: 'failed', state: 'failed', error: 'Hub error' }), store: { selectedTaskId: 'chat-1' } });
    for (const prop of ['onRetry', 'onResume']) {
      serve({ '/api/tasks/continue': { task: { id: 'chat-1', status: 'queued' } } });
      await fire(handlerOf(failed, component('StateBanner'), prop));
      assert.equal(calls[0].route, '/api/tasks/continue');
      assert.equal(calls[0].body.prompt, t.continuePrompt, `${prop}: the instruction that is sent as the person’s message`);
      assert.equal(calls[0].body.id, 'chat-1');
    }

    const held = await conversation({ lang, hub: hubState({ agent: { mode: 'chatgpt-web', tasks: [] }, browser: { outboundReview: review } }), task: record({ transport: 'chatgpt-web', chatUrl: 'https://chatgpt.com/c/abc' }), store: { selectedTaskId: 'chat-1' } });
    const decide = handlerOf(held, component('OutboundReviewCard'), 'onDecide');
    const decision = async (action, redact, answer) => { serve({ '/api/browser/outbound/decide': answer }); await fire(decide, [action, redact]); return [...toasts]; };
    assert.deepEqual(await decision('approve', undefined, { ok: true }), [[t.reviewApproved, 'success']]);
    assert.deepEqual(calls[0].body, { id: 'rv-1', action: 'approve', redact: [] });
    assert.deepEqual(await decision('withhold', undefined, { ok: true }), [[t.reviewWithheld, 'success']]);
    assert.deepEqual(await decision('redact_more', ['secret-text'], { ok: true, matched: 2 }), [[t.reviewRedacted, 'success']]);
    assert.deepEqual(calls[0].body, { id: 'rv-1', action: 'redact_more', redact: ['secret-text'] });
    assert.deepEqual(await decision('redact_more', ['no-such-text'], { ok: true, matched: 0 }), [[t.reviewMissing, 'info']]);
    assert.deepEqual(await decision('approve', undefined, throwsNothingSaid), [[t.reviewFailed, 'error']]);
    assert.deepEqual(await decision('approve', undefined, refuses('Hub says no')), [['Hub says no', 'error']]);

    const lost = await conversation({ lang, task: record({ transport: 'chatgpt-web', chatUrl: '' }), store: { selectedTaskId: 'chat-1' } });
    const recover = handlerOf(lost, labelled(t.urlRecover));
    serve({ '/api/browser/recover-url/request': { ok: true, alreadyBound: true } });
    await fire(recover);
    assert.deepEqual(toasts, [[t.urlKnown, 'info']]);
    assert.deepEqual(calls[0].body, { id: 'chat-1' });
    serve({ '/api/browser/recover-url/request': { ok: true, pending: true } });
    await fire(recover);
    assert.deepEqual(toasts, [[t.urlAskingToast, 'info']]);
    serve({ '/api/browser/recover-url/request': throwsNothingSaid });
    await fire(recover);
    assert.deepEqual(toasts, [[t.urlFailed, 'error']]);
  });

  test(`${label} the sidebar's toasts and confirmations: choosing, typing, switching, removing a folder and deleting a conversation`, async () => {
    const shot = await sidebar({ lang });
    // the + button: a failure that is not an Error says the screen's sentence; an Error says its own message
    const pick = handlerOf(shot, button(t.add));
    serve({ '/api/workspace/browse': () => { throw 'denied'; } });
    await fire(pick);
    assert.deepEqual(toasts, [[t.pickFailed, 'error']]);
    serve({ '/api/workspace/browse': refuses('Hub says no') });
    await fire(pick);
    assert.deepEqual(toasts, [['Hub says no', 'error']]);
    // typing a folder (the form is open and filled in the second bundle)
    const typed = await screen(forced, 'SessionSidebar', { lang });
    const submit = handlerOf(typed, (element) => element.type === 'form', 'onSubmit');
    serve({ '/api/workspaces/add': { workspace: { path: '/work/typed', name: 'typed' }, workspaces: {} }, '/api/workspaces/activate': { activePath: '/work/typed', items: [] } });
    await fire(submit, [{ preventDefault() {} }]);
    assert.deepEqual(toasts, [[t.picked('/work/typed'), 'success']]);
    assert.deepEqual(calls.map((call) => call.route), ['/api/workspaces/add', '/api/workspaces/activate']);
    serve({ '/api/workspaces/add': () => { throw 'denied'; } });
    await fire(submit, [{ preventDefault() {} }]);
    assert.deepEqual(toasts, [[t.pathInvalid, 'error']]);
    serve({ '/api/workspaces/add': refuses('Hub says no') });
    await fire(submit, [{ preventDefault() {} }]);
    assert.deepEqual(toasts, [['Hub says no', 'error']], 'the Hub’s own refusal is shown as the Hub wrote it');
    // switching to another folder
    const toBeta = handlerOf(shot, (element) => element.type === 'button' && element.props.title === BETA);
    serve({ '/api/workspaces/activate': () => { throw 'denied'; } });
    await fire(toBeta);
    assert.deepEqual(toasts, [[t.switchFailed, 'error']]);
    serve({ '/api/workspaces/activate': refuses('Hub says no') });
    await fire(toBeta);
    assert.deepEqual(toasts, [['Hub says no', 'error']]);
    // removing a folder from the list: the question first (and nothing happens when it is refused), then the toast of what happened
    const remove = handlerOf(shot, button(t.removeLabel('alpha')));
    serve();
    const { asked } = await fire(remove, [], { confirmAnswer: false });
    assert.deepEqual(asked, [t.removeConfirm('alpha', 2)], 'alpha holds two conversations');
    assert.deepEqual(calls, [], 'refused: nothing was sent');
    serve({ '/api/workspaces/remove': { activePath: BETA, items: [] } });
    await fire(remove);
    assert.deepEqual(toasts, [[t.removed, 'success']]);
    assert.deepEqual(calls[0].body, { path: ALPHA });
    serve({ '/api/workspaces/remove': () => { throw 'denied'; } });
    await fire(remove);
    assert.deepEqual(toasts, [[t.removeFailed, 'error']]);
    serve({ '/api/workspaces/remove': refuses('Hub says no') });
    await fire(remove);
    assert.deepEqual(toasts, [['Hub says no', 'error']]);
    const single = handlerOf(shot, button(t.removeLabel('beta')));
    serve();
    assert.deepEqual((await fire(single, [], { confirmAnswer: false })).asked, [t.removeConfirm('beta', 1)], 'beta holds one: not “1 conversations”');
    // deleting a conversation: with no subagent, with one and with two (the hub lists a conversation's subagents among its tasks)
    const subagent = (id) => ({ ...chat(id, { task: `Helper ${id}` }), conversationId: 'chat-1', parentTaskId: 'chat-1' });
    for (const related of [0, 1, 2]) {
      const withHelpers = await sidebar({ lang, hub: hubState({ tasks: [...hubState().tasks, ...Array.from({ length: related }, (_, index) => subagent(`sub-${index}`))] }) });
      const erase = handlerOf(withHelpers, button(t.deleteLabel('Fix the login page')));
      serve();
      assert.deepEqual((await fire(erase, [], { confirmAnswer: false })).asked, [t.deleteConfirm('Fix the login page', related)], `${related} subagents`);
      assert.deepEqual(calls, []);
    }
    const erase = handlerOf(shot, button(t.deleteLabel('Fix the login page')));
    serve({ '/api/tasks/delete': { ok: true, deletedId: 'chat-1' } });
    await fire(erase);
    assert.deepEqual(toasts, [[t.deleted, 'success']]);
    assert.deepEqual(calls[0].body, { id: 'chat-1' });
    serve({ '/api/tasks/delete': () => { throw 'denied'; } });
    await fire(erase);
    assert.deepEqual(toasts, [[t.deleteFailed, 'error']]);
    serve({ '/api/tasks/delete': refuses('Hub says no') });
    await fire(erase);
    assert.deepEqual(toasts, [['Hub says no', 'error']]);
    // a conversation with no text is called by the screen’s name in the question, and by its id in the label
    serve();
    const idle = await sidebar({ lang, hub: hubState({ tasks: [chat('chat-2', { task: '', status: 'completed', state: 'completed' })] }) });
    assert.deepEqual((await fire(handlerOf(idle, button(t.deleteLabel('chat-2'))), [], { confirmAnswer: false })).asked, [t.deleteConfirm(t.untitled, 0)]);
  });
}

// ---- the dictionary behind both ----

const keysOf = (language, prefix) => Object.keys(translations[language]).filter((key) => key.startsWith(prefix));

test('the words of the conversation screen and the sidebar are in both languages, the English ones are English, and a count has its singular', () => {
  const vi = [...keysOf('vi', 'agents_conv_'), ...keysOf('vi', 'agents_side_')];
  assert.ok(vi.length >= 55, `the two files have ${vi.length} keys`);
  assert.deepEqual([...keysOf('en', 'agents_conv_'), ...keysOf('en', 'agents_side_')].sort(), [...vi].sort(), 'the two languages hold the same keys');
  for (const key of vi) {
    assert.ok(translations.en[key]?.trim(), `en.${key} has no text`);
    assert.doesNotMatch(translations.en[key], DIACRITICS, `en.${key} still reads Vietnamese: ${translations.en[key]}`);
  }
  // the notice names its channel in bold, so its sentence is cut at the place the name goes
  for (const language of ['vi', 'en']) {
    assert.equal(translations[language].agents_conv_switch.split('{transport}').length, 2, `${language}: one place for the channel`);
  }
  // Vietnamese has no plural; English names one or many
  assert.equal(translations.vi.agents_side_remove_confirm_one, translations.vi.agents_side_remove_confirm_other);
  assert.equal(translations.vi.agents_side_delete_confirm_one, translations.vi.agents_side_delete_confirm_other);
  assert.match(translations.en.agents_side_remove_confirm_one, /\{n\} conversation and/);
  assert.match(translations.en.agents_side_remove_confirm_other, /\{n\} conversations and/);
  assert.match(translations.en.agents_side_delete_confirm_one, /\{n\} subagent will/);
  assert.match(translations.en.agents_side_delete_confirm_other, /\{n\} subagents will/);
  // the two names that were already in the dictionary are the ones used
  assert.equal(translations.vi.agents_bg_untitled_chat, T.vi.untitled);
  assert.equal(translations.en.agents_bg_untitled_chat, T.en.untitled);
  assert.equal(translations.vi.agents_bg_open_workspace_failed, T.vi.switchFailed);
  assert.equal(translations.en.agents_bg_open_workspace_failed, T.en.switchFailed);
  assert.equal(translations.vi.sidebar_add_workspace, T.vi.add);
  assert.equal(translations.vi.status_companion_connected, T.vi.webConnected);
});

// ---- both are read by a screen reader, and React needs the same hooks on every render ----

test('every control has a name, every id is used once and every reference points somewhere, in both languages', async () => {
  for (const lang of ['vi', 'en']) {
    const shots = [
      await conversation({ lang, task: record({ transport: 'chatgpt-web', chatUrl: '' }), store: { selectedTaskId: 'chat-1' } }),
      await conversation({ lang, hub: hubState({ agent: { mode: 'chatgpt-web', tasks: [] } }) }),
      await screen(forced, 'ConversationView', { lang, task: record(), store: { selectedTaskId: 'chat-1' } }),
      await sidebar({ lang }), await screen(forced, 'SessionSidebar', { lang }),
    ];
    for (const { html } of shots) {
      // the composer's hidden file input has no name of its own (it is the composer's, not these two files')
      const root = parseHtml(html.replace(/<input[^>]*type="file"[^>]*>/g, ''));
      assert.deepEqual(unnamedControls(root), [], `${lang}: unnamed controls`);
      assert.deepEqual(duplicateIds(root), [], `${lang}: duplicate ids`);
      assert.deepEqual(brokenReferences(root), [], `${lang}: references to nothing`);
    }
  }
});

test('both components ask for their words before anything can return early, so that every render calls the same hooks', () => {
  for (const file of ['conversation/ConversationView.tsx', 'sessions/SessionSidebar.tsx']) {
    const source = fs.readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
    const hook = source.indexOf('useTranslation()');
    const early = source.search(/\breturn\b/);
    assert.ok(hook > 0, `${file} reads the language through useTranslation()`);
    assert.ok(early > hook, `${file} does so before its first return`);
  }
});
