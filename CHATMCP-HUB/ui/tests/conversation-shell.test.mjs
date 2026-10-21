import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The four components around the conversation: the header, the status bar, the full-access banner and the Git branch picker. Their words moved into the
// dictionary. Vietnamese is what they always said (the specs and the WebView2 smoke find the header by those names), so it is pinned, and so is the text of every
// toast they raise, which no render shows: it is run, with a Hub that answers as the test says. On the English screen nothing they write may read Vietnamese
// or be a key. A state only a click reaches (the picker open) is started by rewriting the line that declares it.
const ENTRY = `
  ${renderPrelude}
  import { Header } from './src/components/layout/Header';
  import { StatusBar } from './src/components/layout/StatusBar';
  import { FullAccessBanner } from './src/components/layout/FullAccessBanner';
  import { GitWorkspacePicker } from './src/components/layout/GitWorkspacePicker';
  import { translations, translate } from './src/lib/i18n';
  import { formatNumber } from './src/lib/format';
  export { Header, StatusBar, FullAccessBanner, GitWorkspacePicker, translations, translate, formatNumber };
`;
const plain = await bundleTsx(ENTRY, 'chatmcp-shell-', { recordJsx: true });
const open = await bundleTsx(ENTRY, 'chatmcp-shell-open-', { recordJsx: true, rewrites: [{ file: 'components/layout/GitWorkspacePicker.tsx', from: 'const [open,setOpen]=useState(false);', to: 'const [open,setOpen]=useState(true);' }] });
after(async () => { await plain.dispose(); await open.dispose(); });
const { translations, translate, formatNumber } = plain.loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const RAW_KEY = /\b(?:agent|agents|group|coding)_[a-z_]+\b/;
const decode = (html) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const text = (html) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');

// ---- a Hub that answers as the test says (the same idea as tests/conversation-screen.test.mjs) ----
const calls = []; const toasts = []; const routes = new Map();
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (route, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push({ route, body });
  const answer = routes.get(route);
  const result = answer ? await answer(body) : { ok: true };
  return result instanceof Response ? result : reply(200, result);
};
function serve(table = {}) { calls.length = 0; toasts.length = 0; routes.clear(); for (const [route, answer] of Object.entries(table)) routes.set(route, typeof answer === 'function' ? answer : () => answer); }
const showToast = (message, kind) => { toasts.push([message, kind]); };

async function shot(bundle, name, { lang = 'vi', hub, entries = [], store = {}, props = {} } = {}) {
  globalThis.__chatmcpJsx = [];
  const all = [...(hub ? [[['hubState'], hub]] : []), ...entries];
  const html = await bundle.loaded.renderWith(bundle.loaded[name], props, all, [], { lang, showToast, ...store });
  return { html, text: text(html), plain: decode(html), elements: globalThis.__chatmcpJsx.slice() };
}
const component = (name) => (element) => typeof element.type === 'function' && element.type.name === name;
const handlerOf = (result, match, prop = 'onClick') => {
  const found = result.elements.find((element) => match(element) && typeof element.props[prop] === 'function');
  assert.ok(found, `no element gave a ${prop}`);
  return found.props[prop];
};
/** Click it, as a browser would: the browser globals the store and the API read exist, and every step the handler started is let finish. */
async function fire(handler, args = []) {
  globalThis.window = { confirm: () => true };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    const result = await handler(...args);
    for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve));
    return result;
  } finally { delete globalThis.window; delete globalThis.localStorage; }
}

const ALPHA = '/work/alpha';
const hubWith = (over = {}) => ({
  workspace: { path: ALPHA, git: { branch: 'main', dirty: true } }, workspaces: { activePath: ALPHA, items: [{ path: ALPHA, name: 'alpha' }] },
  tasks: [], agent: { mode: 'api', tasks: [] }, browser: {}, ai: { model: 'mock-coder', profiles: [] }, studio: { permissions: { mode: 'review', pending: [], recent: [] } }, version: '3.9.0', ...over,
});
const none = { workspace: undefined, workspaces: { activePath: '', items: [] } };

/** Both languages: Vietnamese says every old piece, English every new one, and English reads no Vietnamese, no key and not the word "Xong". */
async function both(name, options, { vi: viPieces, en: enPieces }, label, bundle = plain) {
  const vi = await shot(bundle, name, { ...options, lang: 'vi' }); const en = await shot(bundle, name, { ...options, lang: 'en' });
  for (const piece of viPieces) assert.ok(vi.plain.includes(piece), `${label}: the Vietnamese screen says "${piece}"`);
  for (const piece of enPieces) assert.ok(en.plain.includes(piece), `${label}: the English screen says "${piece}"`);
  assert.doesNotMatch(en.html, DIACRITICS, `${label}: the English screen reads Vietnamese: ${en.text.match(/\S*[^\s\x00-\x7F]\S*/g)}`);
  assert.doesNotMatch(en.html, /\bXong\b/, `${label}: the English screen says "Xong"`);
  for (const [lang, shown] of [['vi', vi], ['en', en]]) assert.doesNotMatch(shown.text, RAW_KEY, `${label} (${lang}) prints a key`);
  return { vi, en };
}

test('the header names each control, and the folder it shows, in the language on screen', async () => {
  await both('Header', { hub: hubWith(), store: { sidebarOpen: true, inspectorOpen: false } }, {
    vi: ['aria-label="Thu gọn hội thoại"', 'title="Danh sách hội thoại (Ctrl+B)"', 'title="Thư mục: /work/alpha (Nhấp để đổi)"', 'aria-label="Tìm kiếm hoặc lệnh"', 'aria-label="Mở Inspector"', 'title="Mở Inspector (Ctrl+J)"', 'aria-label="Chọn nhánh Git và worktree"'],
    en: ['aria-label="Collapse conversations"', 'title="Conversation list (Ctrl+B)"', 'title="Folder: /work/alpha (click to change)"', 'aria-label="Search or command"', 'aria-label="Open Inspector"', 'title="Open Inspector (Ctrl+J)"', 'aria-label="Choose a Git branch and worktree"'],
  }, 'header (sidebar open, inspector closed)');
  await both('Header', { hub: hubWith(), store: { sidebarOpen: false, inspectorOpen: true } }, {
    vi: ['aria-label="Mở danh sách hội thoại"', 'aria-label="Thu gọn Inspector"', 'title="Thu gọn Inspector (Ctrl+J)"'],
    en: ['aria-label="Open the conversation list"', 'aria-label="Collapse Inspector"', 'title="Collapse Inspector (Ctrl+J)"'],
  }, 'header (sidebar closed, inspector open)');
  await both('Header', { hub: hubWith(none), store: { sidebarOpen: true, inspectorOpen: true } }, {
    vi: ['Chưa chọn workspace', 'title="Thư mục: Chưa chọn workspace (Nhấp để đổi)"', 'Git refs'],
    en: ['No workspace selected', 'title="Folder: No workspace selected (click to change)"', 'Git refs'],
  }, 'header (no workspace)');
});

test('with no workspace chosen the Git picker gets no workspace at all, in either language (the words "No workspace selected" are not a folder)', async () => {
  for (const lang of ['vi', 'en']) {
    const empty = await shot(plain, 'Header', { lang, hub: hubWith(none) });
    assert.equal(empty.elements.find(component('GitWorkspacePicker')).props.workspace, '', `${lang}: the picker is asked about a folder that is not there`);
    const chosen = await shot(plain, 'Header', { lang, hub: hubWith() });
    assert.equal(chosen.elements.find(component('GitWorkspacePicker')).props.workspace, ALPHA, `${lang}: the picker is asked about the folder that is chosen`);
  }
});

test('the folder button opens the folder dialog at the current folder, or at none, in either language, and a refusal is shown as the Hub wrote it', async () => {
  for (const lang of ['vi', 'en']) {
    for (const [hub, initialPath] of [[hubWith(), ALPHA], [hubWith(none), null]]) {
      const header = await shot(plain, 'Header', { lang, hub, store: {} });
      serve({ '/api/workspace/browse': { path: '/work/new' }, '/api/workspaces/add': { workspace: { path: '/work/new', name: 'new' }, workspaces: {} } });
      await fire(handlerOf(header, (element) => element.type === 'button' && /^(?:Thư mục|Folder): /.test(element.props.title || '')));
      assert.deepEqual(calls.map((call) => call.route), ['/api/workspace/browse', '/api/workspaces/add', '/api/workspaces/activate', '/api/state'].slice(0, calls.length), `${lang}: the steps of choosing a folder`);
      assert.deepEqual(calls[0].body, { initialPath }, `${lang}: the dialog opens at ${initialPath}`);
    }
    const header = await shot(plain, 'Header', { lang, hub: hubWith(), store: {} });
    serve({ '/api/workspace/browse': () => reply(409, { error: 'The folder dialog is not available' }) });
    await fire(handlerOf(header, (element) => element.type === 'button' && /^(?:Thư mục|Folder): /.test(element.props.title || '')));
    assert.deepEqual(toasts[0], ['The folder dialog is not available', 'error'], `${lang}: the Hub's own message is shown`);
  }
});

test('the status bar says what it knows in the language on screen: its name, the Git state, the Companion and the context window', async () => {
  const fallback = { source: 'conservative_fallback', capacityTokens: 32768, maxHistoryTokens: 20000, reservedOutputTokens: 8000, approximate: true };
  const configured = { source: 'configured', capacityTokens: 200000, maxHistoryTokens: 100000, reservedOutputTokens: 8000 };
  const withContext = (policy) => ({ entries: [[['task', 'chat-1'], { id: 'chat-1', contextPolicy: policy }]], store: { selectedTaskId: 'chat-1' } });
  const f = (n, lang) => formatNumber(n, lang);
  const hub = hubWith({ agent: { mode: 'chatgpt-web', tasks: [] }, browser: { connected: false, paired: false } });
  await both('StatusBar', { hub, ...withContext(fallback) }, {
    vi: ['aria-label="Trạng thái"', 'title="Có thay đổi chưa commit"', 'aria-label="Có thay đổi chưa commit"', 'title="ChatGPT Web Companion: mở cài đặt kênh agent"',
      `title="Chưa biết cửa sổ ngữ cảnh của model: đang lập kế hoạch với ${f(32768, 'vi')} token. Đặt kích thước thật trong Cài đặt → Mô hình AI."`],
    en: ['aria-label="Status"', 'title="Uncommitted changes"', 'aria-label="Uncommitted changes"', 'title="ChatGPT Web Companion: open the agent channel settings"',
      `title="The model's context window is unknown: planning with ${f(32768, 'en')} tokens. Set the real size in Settings → AI model."`],
  }, 'status bar (unknown window, dirty tree)');
  await both('StatusBar', { hub: hubWith({ workspace: { path: ALPHA, git: { branch: 'main', dirty: false } } }), ...withContext(configured) }, {
    vi: ['title="Workspace sạch"', `title="Cửa sổ ngữ cảnh đã cấu hình: ${f(200000, 'vi')} token. Lịch sử tối đa ${f(100000, 'vi')} token; dành ${f(8000, 'vi')} cho đầu ra."`],
    en: ['title="Working tree clean"', `title="Configured context window: ${f(200000, 'en')} tokens. History up to ${f(100000, 'en')} tokens; ${f(8000, 'en')} kept for output."`],
  }, 'status bar (configured window, clean tree)');
});

test('the full-access banner: shown only in full access, and its way back says what it did in the language on screen', async () => {
  for (const lang of ['vi', 'en']) assert.equal((await shot(plain, 'FullAccessBanner', { lang, hub: hubWith() })).html, '', `${lang}: no banner outside full access`);
  const fullAccess = hubWith({ studio: { permissions: { mode: 'review', executionPolicy: 'full-access', pending: [], recent: [] } } });
  await both('FullAccessBanner', { hub: fullAccess }, { vi: ['Quay về Review', 'FULL ACCESS đang bật'], en: ['Back to Review', 'FULL ACCESS is on'] }, 'full-access banner');
  for (const [lang, said] of [['vi', 'Đã quay về chế độ Review.'], ['en', 'Switched back to Review mode.']]) {
    const banner = await shot(plain, 'FullAccessBanner', { lang, hub: fullAccess });
    const turnOff = handlerOf(banner, (element) => element.props?.children === (lang === 'vi' ? 'Quay về Review' : 'Back to Review'));
    serve({ '/api/studio/permissions/config': { ok: true } });
    await fire(turnOff);
    assert.deepEqual(calls[0], { route: '/api/studio/permissions/config', body: { mode: 'review', executionPolicy: 'host-review' } }, `${lang}: the request is the same`);
    assert.deepEqual(toasts[0], [said, 'info'], `${lang}: the toast`);
    serve({ '/api/studio/permissions/config': () => reply(409, { error: 'Not allowed now' }) });
    await fire(turnOff);
    assert.deepEqual(toasts[0], ['Not allowed now', 'error'], `${lang}: a refusal is shown as the Hub wrote it`);
  }
});

test('the Git branch picker: closed it names itself, open it explains the base branch and lists the worktrees, in the language on screen', async () => {
  const refs = { currentBranch: 'main', branches: [{ ref: 'refs/heads/main', name: 'main' }, { ref: 'refs/heads/dev', name: 'dev' }], worktrees: [{ path: '/work/wt', branch: 'dev', head: 'abc' }, { path: '/work/old', branch: null, head: 'def' }] };
  const entries = [[['gitRefs', ALPHA], refs]];
  await both('GitWorkspacePicker', { props: { workspace: ALPHA }, entries }, { vi: ['aria-label="Chọn nhánh Git và worktree"', '>main<'], en: ['aria-label="Choose a Git branch and worktree"', '>main<'] }, 'git picker (closed)');
  await both('GitWorkspacePicker', { props: { workspace: ALPHA }, entries: [] }, { vi: ['Git refs'], en: ['Git refs'] }, 'git picker (no refs yet)');
  const opened = await both('GitWorkspacePicker', { props: { workspace: ALPHA }, entries }, {
    vi: ['Nhánh nguồn cho chat mới', 'aria-label="Nhánh nguồn Git"', '>HEAD hiện tại<', 'Chat mới tạo worktree riêng từ commit của nhánh nguồn. Thay đổi chưa commit không được sao chép.', 'Các Git worktree đã có', 'detached HEAD'],
    en: ['Source branch for new chats', 'aria-label="Git source branch"', '>Current HEAD<', "A new chat creates its own worktree from the source branch's commit. Uncommitted changes are not copied.", 'Existing Git worktrees', 'detached HEAD'],
  }, 'git picker (open)', open);
  assert.ok(opened.vi.text.includes('/work/wt') && opened.en.text.includes('/work/wt'), 'a worktree is listed by its path');
  for (const lang of ['vi', 'en']) assert.ok((await shot(open, 'GitWorkspacePicker', { lang, props: { workspace: ALPHA }, entries: [[['gitRefs', ALPHA], { ...refs, worktrees: [] }]] })).text.includes(lang === 'vi' ? 'Chưa tìm thấy worktree.' : 'No worktree found.'), `${lang}: no worktree is said`);
  for (const [lang, said] of [['vi', 'Đã chọn worktree /work/wt'], ['en', 'Selected worktree /work/wt']]) {
    const picker = await shot(open, 'GitWorkspacePicker', { lang, props: { workspace: ALPHA }, entries });
    const choose = handlerOf(picker, (element) => element.type === 'button' && element.props.title === '/work/wt');
    serve({ '/api/workspaces/add': { workspace: { path: '/work/wt', name: 'wt' }, workspaces: {} } });
    await fire(choose);
    assert.deepEqual(toasts[0], [said, 'success'], `${lang}: choosing a worktree says which`);
    serve({ '/api/workspaces/add': () => reply(409, { error: 'That folder is not a worktree' }) });
    await fire(choose);
    assert.deepEqual(toasts[0], ['That folder is not a worktree', 'error'], `${lang}: a refusal is shown as the Hub wrote it`);
  }
});

// The words nothing renders alone (a toast, a tooltip of a state the page is not in): the Vietnamese of each is the literal the component had, byte for byte.
const OLD_VIETNAMESE = {
  agents_hdr_no_workspace: 'Chưa chọn workspace', agents_hdr_sidebar_close: 'Thu gọn hội thoại', agents_hdr_sidebar_open: 'Mở danh sách hội thoại', agents_hdr_sidebar_list: 'Danh sách hội thoại',
  agents_hdr_folder_title: 'Thư mục: {path} (Nhấp để đổi)', agents_hdr_search_label: 'Tìm kiếm hoặc lệnh', agents_hdr_inspector_close: 'Thu gọn Inspector', agents_hdr_inspector_open: 'Mở Inspector',
  agents_sbar_label: 'Trạng thái', agents_sbar_companion_title: 'ChatGPT Web Companion: mở cài đặt kênh agent',
  agents_sbar_ctx_unknown: 'Chưa biết cửa sổ ngữ cảnh của model: đang lập kế hoạch với {tokens} token. Đặt kích thước thật trong Cài đặt → Mô hình AI.',
  agents_sbar_ctx_known: 'Cửa sổ ngữ cảnh đã cấu hình: {capacity} token. Lịch sử tối đa {history} token; dành {output} cho đầu ra.',
  agents_fab_back_to_review: 'Đã quay về chế độ Review.', agents_conv_mode_failed: 'Không thể đổi chế độ quyền', agents_side_pick_failed: 'Không thể chọn workspace.',
  agents_git_picker_label: 'Chọn nhánh Git và worktree', agents_git_base_title: 'Nhánh nguồn cho chat mới', agents_git_base_label: 'Nhánh nguồn Git', agents_git_head: 'HEAD hiện tại',
  agents_git_base_hint: 'Chat mới tạo worktree riêng từ commit của nhánh nguồn. Thay đổi chưa commit không được sao chép.', agents_git_worktrees: 'Các Git worktree đã có',
  agents_git_no_worktree: 'Chưa tìm thấy worktree.', agents_git_picked: 'Đã chọn worktree {path}', agents_git_switch_failed: 'Không thể chuyển worktree.', agents_git_refs: 'Git refs', agents_tool_done: 'Xong',
  git_clean: 'Workspace sạch', git_dirty: 'Có thay đổi chưa commit',
};
test('the Vietnamese of every string of these components is what the component wrote before, and the English of each is English', () => {
  for (const [key, old] of Object.entries(OLD_VIETNAMESE)) {
    assert.equal(translations.vi[key], old, `vi.${key}`);
    const en = translations.en[key];
    assert.ok(en?.trim(), `en.${key} has text`);
    if (en !== old) assert.doesNotMatch(en, DIACRITICS, `en.${key} reads Vietnamese`);
    assert.deepEqual([...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), [...old.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), `${key}: the placeholders differ between the languages`);
  }
  assert.equal(translate('vi', 'agents_git_picked', { path: 'D:\\work\\wt' }), 'Đã chọn worktree ' + 'D:\\work\\wt', 'a Windows path goes into the sentence as it is');
  assert.equal(translate('en', 'agents_hdr_folder_title', { path: 'C:\\Users\\a$&b' }), 'Folder: C:\\Users\\a$&b (click to change)', 'a path with $ and & goes in untouched');
});
