import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { visibleWords } from './support/html.mjs';

// The FULL ACCESS dialog, the six sections of Settings (About, Agent channel, Appearance, Code intelligence, Permissions, Workspace), the command
// palette, the first-run setup, the notices of the AI connection form and of the Inspector, and the status words of the Files tab. Their words
// moved from the source files into the dictionary (lib/i18n.ts), so these tests do four things.
//   1. The Vietnamese screen says what it said before: tests/support/settings-screens.vi.json holds every word (text, title, label, placeholder) of
//      each state, taken from the renders of the files before they were changed.
//   2. The English screen reads English: no Vietnamese letter and no dictionary key in any word of any state. The one Vietnamese word on it is the
//      name of the Vietnamese language in the language selector, which is written in that language on purpose.
//   3. No Vietnamese is written into these files any more (the two lines that keep it are meant, and listed).
//   4. What only a click shows (a toast, a confirmation, a message in the form) is called here with a Hub that answers as the test says, in both
//      languages, so that the placeholders ({mode}, {path}) and the fallbacks for a failure that says nothing are the right ones.
const ui = fileURLToPath(new URL('..', import.meta.url));
const PINS = JSON.parse(fs.readFileSync(new URL('./support/settings-screens.vi.json', import.meta.url), 'utf8'));

const FOLDERS = {
  FullAccessDialog: 'approval', AboutSection: 'settings', AgentChannelSection: 'settings', AppearanceSection: 'settings',
  CodeIntelligenceSection: 'settings', PermissionsSection: 'settings', WorkspaceSection: 'settings', CommandPalette: 'palette',
  OnboardingModal: 'onboarding', IntelligenceTab: 'inspector', InspectorPanel: 'inspector', FilesTab: 'inspector', GitTab: 'inspector',
};
const entryOf = (names) => `
  ${renderPrelude}
  ${names.map((name) => `import { ${name} } from './src/components/${FOLDERS[name]}/${name}';`).join('\n')}
  import { translations } from './src/lib/i18n';
  export { translations, ${names.join(', ')} };
`;

// ---- what the Hub says: plain ASCII, so that Vietnamese on the English screen can only come from a component ----
const ALPHA = '/work/alpha';
const hub = (extra = {}) => ({
  version: '3.9.0', workspace: { path: ALPHA },
  workspaces: { activePath: ALPHA, items: [{ path: ALPHA, name: 'alpha' }, { path: '/work/beta', name: 'beta' }] },
  agent: { mode: 'api' },
  browser: { paired: false, connected: false, pairingAvailable: true, privacy: { reviewBeforeSend: false, workspaces: [] } },
  studio: { permissions: { mode: 'review', executionPolicy: 'host-review', pending: [] } },
  ...extra,
});
const aiOf = (extra = {}) => ({ configured: true, model: 'mock-model', provider: 'openai', preset: 'openai', protocol: 'responses', apiBaseUrl: 'https://api.example.test/v1', ...extra });
const sandbox = (extra = {}) => ({ available: true, osIsolated: false, backend: 'host', platform: 'win32', enforcedLimits: ['timeoutSeconds'], unsupportedLimits: ['maxMemoryMb'], reasons: [], ...extra });
const engines = { engineHealth: { engines: [
  { id: 'typescript-lsp', status: 'ready', version: '5.4.0', source: 'bundled' },
  { id: 'python-lsp', status: 'unavailable', source: 'pyright', detail: 'not installed' },
] } };
/** Two snapshots of the Hub's state a page can hold when a person picks a mode: from before Full Access was turned on, and from after. */
const SNAPSHOTS = {
  'a state from before Full Access': hub(),
  'a state with Full Access on': hub({ studio: { permissions: { mode: 'autonomous', executionPolicy: 'full-access', pending: [] } } }),
};
const webHub = (browser) => hub({ agent: { mode: 'chatgpt-web' }, browser: { pairingAvailable: true, ...browser, privacy: { reviewBeforeSend: false, workspaces: [], ...browser.privacy } } });
const ws = { selectedWorkspacePath: ALPHA };

const STATES = [
  { id: 'full-access-dialog', component: 'FullAccessDialog', store: { fullAccessModalOpen: true } },
  { id: 'about', component: 'AboutSection', entries: [[['hubState'], hub()]] },
  { id: 'about-loading', component: 'AboutSection' },
  { id: 'about-error', component: 'AboutSection', errors: [[['hubState'], 'connection refused']] },
  { id: 'channel-api', component: 'AgentChannelSection', entries: [[['hubState'], hub()]], store: ws },
  { id: 'channel-web-unpaired', component: 'AgentChannelSection', entries: [[['hubState'], webHub({ paired: false, connected: false })]], store: ws },
  { id: 'channel-web-paired', component: 'AgentChannelSection', entries: [[['hubState'], webHub({ paired: true, connected: false, privacy: { reviewBeforeSend: true, workspaces: [{ path: ALPHA, review: false }] } })]], store: ws },
  { id: 'channel-web-connected', component: 'AgentChannelSection', entries: [[['hubState'], webHub({ paired: true, connected: true, pairingAvailable: false, privacy: { reviewBeforeSend: true, workspaces: [{ path: ALPHA, review: true }] } })]], store: ws },
  { id: 'appearance', component: 'AppearanceSection' },
  { id: 'code-intelligence', component: 'CodeIntelligenceSection', entries: [[['hubState'], hub()], [['intelligenceEngineHealth'], engines]] },
  { id: 'code-intelligence-empty', component: 'CodeIntelligenceSection' },
  { id: 'permissions', component: 'PermissionsSection', entries: [[['hubState'], hub()], [['sandboxStatus'], sandbox()]] },
  { id: 'permissions-full', component: 'PermissionsSection', entries: [[['hubState'], hub({ studio: { permissions: { mode: 'autonomous', executionPolicy: 'full-access' } } })], [['sandboxStatus'], sandbox({ osIsolated: true, reasons: ['Windows Sandbox is not available'] })]] },
  { id: 'permissions-unavailable', component: 'PermissionsSection', entries: [[['hubState'], hub()], [['sandboxStatus'], { available: false }]] },
  { id: 'workspace', component: 'WorkspaceSection', entries: [[['hubState'], hub()]], store: ws },
  { id: 'workspace-none', component: 'WorkspaceSection' },
  { id: 'palette', component: 'CommandPalette', entries: [[['hubState'], hub()]], store: { commandPaletteOpen: true } },
  { id: 'onboarding-1', component: 'OnboardingModal', store: { onboardingOpen: true } },
  { id: 'intelligence', component: 'IntelligenceTab', entries: [[['hubState'], hub()]] },
  { id: 'intelligence-ai', component: 'IntelligenceTab', entries: [[['hubState'], hub({ ai: aiOf() })]] },
  { id: 'files', component: 'FilesTab', entries: [[['hubState'], hub()], [['gitStatus', ALPHA], { entries: [' M src/a.ts', '?? new.txt', 'D  gone.txt', 'A  added.txt', 'R  old.txt -> new.txt', 'UU conflict.txt'], partial: true }]] },
];

// the states only a click reaches, started by rewriting the line that declares them (one bundle each)
const DRAFT = { file: 'IntelligenceTab.tsx', from: 'const draftChanged = aiDraftHasChanges(form, ai as any) || customHeadersDirty || contextWindowDirty;', to: 'const draftChanged = true;' };
const ONBOARDING = { file: 'OnboardingModal.tsx' };
const FORCED = [
  { id: 'onboarding-2', component: 'OnboardingModal', store: { onboardingOpen: true }, entries: [[['hubState'], hub()]], rewrite: { ...ONBOARDING, from: 'const [step, setStep] = useState(1);', to: 'const [step, setStep] = useState(2);' } },
  { id: 'onboarding-3', component: 'OnboardingModal', store: { onboardingOpen: true }, rewrite: { ...ONBOARDING, from: 'const [step, setStep] = useState(1);', to: 'const [step, setStep] = useState(3);' } },
  { id: 'onboarding-applied', component: 'OnboardingModal', store: { onboardingOpen: true }, rewrite: { ...ONBOARDING, from: "const [appliedFolder, setAppliedFolder] = useState('');", to: "const [appliedFolder, setAppliedFolder] = useState('/work/alpha');" } },
  { id: 'onboarding-error', component: 'OnboardingModal', store: { onboardingOpen: true }, rewrite: { ...ONBOARDING, from: "const [error, setError] = useState('');", to: "const [error, setError] = useState('boom');" } },
  { id: 'dialog-typed', component: 'FullAccessDialog', store: { fullAccessModalOpen: true }, rewrite: { file: 'FullAccessDialog.tsx', from: "const [confirmText, setConfirmText] = useState('');", to: "const [confirmText, setConfirmText] = useState('FULL ACCESS');" } },
  { id: 'channel-paircode', component: 'AgentChannelSection', store: ws, entries: [[['hubState'], webHub({ paired: true, connected: true })]], rewrite: { file: 'AgentChannelSection.tsx', from: 'useState<{ code: string; expiresAt: string } | null>(null)', to: "useState<{ code: string; expiresAt: string } | null>({ code: 'ABC123', expiresAt: '2026-10-20T10:05:00Z' })" } },
  { id: 'inspector-blocked', component: 'InspectorPanel', rewrite: { file: 'InspectorPanel.tsx', from: "const blocked = differentRoot && activeTab !== 'agents';", to: 'const blocked = true;' } },
  { id: 'intelligence-draft', component: 'IntelligenceTab', entries: [[['hubState'], hub()]], rewrite: DRAFT },
  { id: 'intelligence-draft-ai', component: 'IntelligenceTab', entries: [[['hubState'], hub({ ai: aiOf() })]], rewrite: DRAFT },
  { id: 'intelligence-draft-retain', component: 'IntelligenceTab', entries: [[['hubState'], hub({ ai: aiOf({ preset: 'custom-openai', provider: 'custom-openai', keySource: 'saved' }) })]], rewrite: DRAFT },
];

const plain = await bundleTsx(entryOf(Object.keys(FOLDERS)), 'chatmcp-settings-');
const disposers = [plain.dispose];
after(async () => { for (const dispose of disposers) await dispose(); });
const { translations } = plain.loaded;

const LANGS = ['vi', 'en'];
const rendered = {};
/**
 * The model picker is a script of its own that the field fetches the first time it renders (React.lazy): the first render of a bundle shows the plain input it falls back to, and every
 * later one the picker. A person meets the picker (it arrives in milliseconds), so every bundle renders its component once and lets the script arrive before the renders that are pinned.
 */
async function warmUp(bundle, state) {
  await bundle.loaded.renderWith(bundle.loaded[state.component], {}, state.entries ?? [], [], { ...state.store, lang: 'vi' });
  await new Promise((resolve) => setImmediate(resolve));
}
async function renderState(bundle, state) {
  if (!bundle.warm) bundle.warm = new Set();
  if (!bundle.warm.has(state.component)) { bundle.warm.add(state.component); await warmUp(bundle, state); }
  rendered[state.id] = {};
  for (const lang of LANGS) {
    rendered[state.id][lang] = await bundle.loaded.renderWith(bundle.loaded[state.component], {}, state.entries ?? [], state.errors ?? [], { ...state.store, lang });
  }
}
for (const state of STATES) await renderState(plain, state);
for (const state of FORCED) {
  const forced = await bundleTsx(entryOf([state.component]), 'chatmcp-settings-forced-', { rewrites: [state.rewrite] });
  disposers.push(forced.dispose);
  await renderState(forced, state);
}

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
/** The Vietnamese a person meets on an English screen: a letter only Vietnamese has, or the abbreviation "vd:" (ví dụ, for example). */
const VIETNAMESE = new RegExp(`${DIACRITICS.source}|\\bvd[:.]`, 'i');
/** The name of the Vietnamese language in the language selector. It is written in Vietnamese in both languages, so that a person who cannot read English finds it. */
const OWN_NAME = 'Tiếng Việt (Vietnamese)';
/** A clock time depends on the time zone the test runs in. */
const stable = (word) => word.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<time>');
const wordsOf = (id, lang) => visibleWords(rendered[id][lang]).map(stable);

// ---------------------------------------------------------------------------------------------------------------------------------------------
test('every state that is rendered has its words pinned, and every pin has a state', () => {
  assert.deepEqual(Object.keys(rendered).sort(), Object.keys(PINS).sort());
});

test('the Vietnamese screens say what they said before their words moved into the dictionary', () => {
  for (const id of Object.keys(rendered)) {
    const now = wordsOf(id, 'vi');
    const was = PINS[id];
    const at = now.findIndex((word, index) => word !== was[index]);
    const first = at !== -1 ? at : now.length === was.length ? -1 : Math.min(now.length, was.length);
    assert.equal(first, -1, `${id}: word ${first} is ${JSON.stringify(now[first])}, it was ${JSON.stringify(was[first])}`);
  }
});

test('on the English screen nothing these files write reads Vietnamese, and no dictionary key is shown instead of its text', () => {
  // a key has a word, an underscore, then more: "onb_title". Plain words that happen to be a key name (there are none with an underscore) would not count.
  const keys = new Set(Object.keys(translations.vi).filter((key) => key.includes('_')));
  let checked = 0;
  for (const id of Object.keys(rendered)) {
    for (const word of wordsOf(id, 'en')) {
      checked++;
      if (word === OWN_NAME) continue;
      assert.doesNotMatch(word, VIETNAMESE, `${id}: this reads Vietnamese: ${word}`);
      for (const token of word.split(/[\s,.;:()"'“”‘’!?…→·|/]+/)) assert.ok(!keys.has(token), `${id}: the key ${token} is shown instead of its text, in: ${word}`);
    }
  }
  assert.ok(checked > 1000, `read ${checked} English words`);
  assert.ok(wordsOf('appearance', 'en').includes(OWN_NAME), 'the language selector names the Vietnamese language in Vietnamese');
});

test('the whole English dictionary reads English, but for the name of the Vietnamese language', () => {
  const offenders = Object.entries(translations.en).filter(([, value]) => VIETNAMESE.test(String(value))).map(([key]) => key);
  assert.deepEqual(offenders, ['lang_vi']);
});

test('the English screens say what they should', () => {
  const says = {
    'full-access-dialog': ['Confirm FULL ACCESS permission', 'Important security warning', 'Turn on FULL ACCESS'],
    about: ['Keyboard shortcuts', 'Search and run commands', 'Received the state from the Hub', 'Export Data'],
    'about-error': ['Cannot reach the Hub: connection refused'],
    'channel-api': ['Coding Agent channel', 'Agent channel: ChatGPT Web', 'Create a 5-minute pairing code'],
    'channel-web-paired': ['Companion is paired; waiting for a ChatGPT tab with the extension turned on', 'Follow the general setting (on)', 'Unpair'],
    'channel-paircode': ['Companion is paired and connected', 'Copy the pairing code'],
    appearance: ['Theme', 'Language', 'English (Current)'],
    'code-intelligence': ['Check again', 'Ready', 'Unavailable'],
    permissions: ['Agent Execution Mode', 'Host Unisolated'],
    'permissions-unavailable': ['Unavailable'],
    workspace: ['Project Workspace Directory', 'In use:', 'Reopen Onboarding Walkthrough'],
    palette: ['Command palette', 'Type a command or search for an action…', 'Change workspace folder', 'Follow the system', 'Appearance and language'],
    'onboarding-1': ['Welcome to DatGold Studio', 'Project folder', 'No folder chosen yet...', 'Apply workspace', 'Skip', 'Continue'],
    'onboarding-applied': ['Workspace selected: /work/alpha'],
    'onboarding-3': ['Review (recommended)', 'Read-only', 'Autonomous', 'Start working now'],
    'intelligence-draft': ['The new configuration has not been applied yet. The Hub is still using', 'unknown / unknown', 'Save and test', 'e.g. claude-sonnet-5-5, gpt-4o, deepseek-chat...', 'A hosted API or a local model'],
    'intelligence-draft-ai': ['openai / responses', '. Press Save Configuration to apply openai / openai-chat.'],
    'intelligence-draft-retain': ['. Press Save Configuration to apply custom-openai / openai-chat. The saved API key will be kept because the host does not change.'],
    'inspector-blocked': ['The agent is working on the selected folder independently. The older file / Git / terminal inspector is tied to the main workspace only.', 'To avoid editing the wrong project by mistake, Inspector actions are hidden in the second workspace. You can still assign several tasks, see the results and stop subagents in the Agents tab.'],
    files: ['New', 'Deleted', 'Added', 'Renamed', 'Modified'],
  };
  for (const [id, phrases] of Object.entries(says)) {
    const words = wordsOf(id, 'en').map((word) => word.trim());
    for (const phrase of phrases) assert.ok(words.includes(phrase), `${id} does not say "${phrase}"; it says: ${words.join(' | ').slice(0, 600)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
const SOURCES = [
  'approval/FullAccessDialog', 'settings/AboutSection', 'settings/AgentChannelSection', 'settings/AppearanceSection', 'settings/CodeIntelligenceSection',
  'settings/PermissionsSection', 'settings/WorkspaceSection', 'palette/CommandPalette', 'onboarding/OnboardingModal', 'inspector/IntelligenceTab', 'inspector/InspectorPanel',
];
/** The Vietnamese that stays in these files on purpose: the toast that follows a switch to Vietnamese is in Vietnamese, and the palette finds an item by what a Vietnamese speaker types. */
const MEANT = {
  'settings/AppearanceSection': ["'Đã chuyển ngôn ngữ sang Tiếng Việt'"],
  'palette/CommandPalette': ["'kế hoạch'", "'nhật ký'"],
};

test('no Vietnamese is written into the files of these screens any more; the two lines that keep it are meant', () => {
  for (const file of SOURCES) {
    let source = fs.readFileSync(path.join(ui, 'src', 'components', `${file}.tsx`), 'utf8');
    for (const meant of MEANT[file] ?? []) {
      assert.ok(source.includes(meant), `${file}: the text that is meant to stay (${meant}) moved`);
      source = source.replaceAll(meant, '');
    }
    const lines = source.split(/\r?\n/).map((line, index) => [index + 1, line.trim()]).filter(([, line]) => DIACRITICS.test(line));
    assert.deepEqual(lines, [], `${file} writes Vietnamese: put it in lib/i18n.ts`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What only a click shows. Each handler a screen gave to a button is called here, as a browser would, against a Hub that answers as the test says.
const SAYS = {
  vi: {
    modeChanged: (mode) => `Đã đổi quyền sang ${mode}`, modeFailed: 'Lỗi cập nhật quyền',
    paletteMode: (mode) => `Đã chuyển quyền sang ${mode}`, paletteModeFailed: 'Lỗi chuyển quyền', paletteWorkspace: (where) => `Đã chọn workspace: ${where}`,
    channelWeb: 'Đã chọn ChatGPT Web Companion. Hãy ghép extension và đăng nhập ChatGPT trên trình duyệt.', channelSwitchFailed: 'Không thể chuyển chế độ agent.',
    unpairConfirm: 'Ngắt ghép DatGold Companion trên trình duyệt? Các cuộc chat đã lưu vẫn được giữ.', unpaired: 'Đã ngắt ghép tiện ích.',
    dismissed: 'Bạn có thể chọn lại thư mục và cấu hình AI bất cứ lúc nào trong Cài đặt',
    activated: 'Đã kích hoạt chế độ FULL ACCESS', activateFailed: 'Không thể cấp quyền FULL ACCESS',
    probed: 'Đã kiểm tra các Code Intelligence engines', probeFailed: 'Không thể kiểm tra Code Intelligence',
    browseFailed: 'Lỗi duyệt thư mục', changeFailed: 'Lỗi thay đổi thư mục',
    checkpointFailed: 'Lỗi tạo checkpoint', previewFailed: 'Không thể tạo bản xem trước cho checkpoint.', restoreFailed: 'Lỗi khôi phục checkpoint',
    protocolUnsaved: 'Hub chưa lưu đúng giao thức đã chọn. Cấu hình AI hiện tại chưa được xác nhận.',
    protocolMismatch: 'Giao thức kiểm tra không khớp lựa chọn của bạn. Kiểm tra lại cấu hình đã lưu.', saveFailed: 'Lỗi lưu cấu hình',
    welcome: 'Chào mừng bạn đến với DatGold Studio!',
  },
  en: {
    modeChanged: (mode) => `Permission mode changed to ${mode}`, modeFailed: 'Could not update the permission mode',
    paletteMode: (mode) => `Switched permission mode to ${mode}`, paletteModeFailed: 'Could not switch the permission mode', paletteWorkspace: (where) => `Workspace selected: ${where}`,
    channelWeb: 'ChatGPT Web Companion selected. Pair the extension and sign in to ChatGPT in the browser.', channelSwitchFailed: 'Could not switch the agent mode.',
    unpairConfirm: 'Unpair DatGold Companion from the browser? Saved chats are kept.', unpaired: 'Extension unpaired.',
    dismissed: 'You can choose the folder and configure the AI again at any time in Settings',
    activated: 'FULL ACCESS mode is on', activateFailed: 'Could not grant FULL ACCESS',
    probed: 'Checked the Code Intelligence engines', probeFailed: 'Could not check Code Intelligence',
    browseFailed: 'Could not browse for a folder', changeFailed: 'Could not change the folder',
    checkpointFailed: 'Could not create the checkpoint', previewFailed: 'Could not build a preview of the checkpoint.', restoreFailed: 'Could not restore the checkpoint',
    protocolUnsaved: 'The Hub did not save the protocol you chose. The current AI configuration is not confirmed.',
    protocolMismatch: 'The connection test used a different protocol from the one you chose. Check the saved configuration again.', saveFailed: 'Could not save the configuration',
    welcome: 'Welcome to DatGold Studio!',
  },
};

const clicks = await bundleTsx(entryOf(['PermissionsSection', 'CommandPalette', 'AgentChannelSection', 'OnboardingModal', 'CodeIntelligenceSection', 'WorkspaceSection', 'IntelligenceTab']), 'chatmcp-settings-clicks-', { recordJsx: true });
const typedDialog = await bundleTsx(entryOf(['FullAccessDialog']), 'chatmcp-settings-clicks-', { recordJsx: true, rewrites: [{ file: 'FullAccessDialog.tsx', from: "const [confirmText, setConfirmText] = useState('');", to: "const [confirmText, setConfirmText] = useState('FULL ACCESS');" }] });
const typedCheckpoint = await bundleTsx(entryOf(['GitTab']), 'chatmcp-settings-clicks-', { recordJsx: true, rewrites: [{ file: 'GitTab.tsx', from: "const [checkpointName, setCheckpointName] = useState('');", to: "const [checkpointName, setCheckpointName] = useState('before');" }] });
const lastStep = await bundleTsx(entryOf(['OnboardingModal']), 'chatmcp-settings-clicks-', { recordJsx: true, rewrites: [{ file: 'OnboardingModal.tsx', from: 'const [step, setStep] = useState(1);', to: 'const [step, setStep] = useState(3);' }] });
// the AI form with a thinking level already chosen (the line that declares the draft is rewritten, since choosing needs a browser)
const chosenLevel = await bundleTsx(entryOf(['IntelligenceTab']), 'chatmcp-settings-clicks-', { recordJsx: true, rewrites: [{ file: 'IntelligenceTab.tsx', from: 'const [reasoningDraft, setReasoningDraft] = useState<string | null>(null);', to: "const [reasoningDraft, setReasoningDraft] = useState<string | null>('medium');" }] });
disposers.push(clicks.dispose, typedDialog.dispose, typedCheckpoint.dispose, lastStep.dispose, chosenLevel.dispose);

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
const saysNothing = () => { throw new Error(''); };
/** Not an Error at all: the Git tab shows a message of its own only for something that is not one. */
const throwsAString = () => { throw 'no message'; };

async function look(bundle, name, { lang, entries = [], store = {} }) {
  globalThis.__chatmcpJsx = [];
  await bundle.loaded.renderWith(bundle.loaded[name], {}, [[['hubState'], hub()], ...entries], [], { lang, showToast, ...store });
  return globalThis.__chatmcpJsx.slice();
}
const handlerOf = (elements, match, prop = 'onClick') => {
  const found = elements.find((element) => match(element) && typeof element.props[prop] === 'function');
  assert.ok(found, `no element gave a ${prop}`);
  return found.props[prop];
};
const domButton = (matchProps) => (element) => element.type === 'button' && matchProps(element.props);
const aButton = (matchProps) => (element) => typeof element.type === 'object' && element.type?.displayName === 'Button' && matchProps(element.props);
const item = (label) => (element) => typeof element.type === 'function' && element.type.name === 'Item' && element.props.label === label;
/**
 * Click it, as a browser would: window.confirm (and the bare confirm the Git tab calls) answers `confirmAnswer` and says what it was asked, localStorage
 * exists, and every step the handler started (a request, a toast) is let finish.
 */
async function fire(handler, args = [], { confirmAnswer = true } = {}) {
  const asked = [];
  const confirm = (message) => { asked.push(message); return confirmAnswer; };
  globalThis.window = { confirm };
  globalThis.confirm = confirm;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    await handler(...args);
    for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve));
  } finally { delete globalThis.window; delete globalThis.confirm; delete globalThis.localStorage; }
  return { asked };
}

test('the permission list and the command palette change the mode and say so in the language of the screen', async () => {
  for (const lang of LANGS) {
    const says = SAYS[lang];
    const words = translations[lang];
    const sandboxEntries = [[['sandboxStatus'], sandbox()]];
    // the list in Settings: the first button is "Read-only"
    let elements = await look(clicks, 'PermissionsSection', { lang, entries: sandboxEntries });
    const readOnly = handlerOf(elements, domButton((props) => typeof props['aria-pressed'] === 'boolean'));
    serve();
    await fire(readOnly);
    assert.deepEqual(toasts, [[says.modeChanged('readonly'), 'info']], `${lang}: Settings`);
    assert.deepEqual(calls.find((call) => call.route === '/api/studio/permissions/config')?.body, { mode: 'readonly', leaveFullAccess: true }, `${lang}: what was asked of the Hub`);
    serve({ '/api/studio/permissions/config': saysNothing });
    await fire(readOnly);
    assert.deepEqual(toasts, [[says.modeFailed, 'error']], `${lang}: Settings, a failure that says nothing`);

    // The page may hold any snapshot of the Hub's state, and the one it holds can be older than the Hub's (Full Access was turned on a moment ago):
    // the request is the same either way, because the Hub, not the snapshot, knows whether there is a Full Access to leave.
    for (const [label, snapshot] of Object.entries(SNAPSHOTS)) {
      const settings = await look(clicks, 'PermissionsSection', { lang, entries: [[['hubState'], snapshot], ...sandboxEntries] });
      serve();
      await fire(handlerOf(settings, domButton((props) => typeof props['aria-pressed'] === 'boolean')));
      assert.deepEqual(calls.find((call) => call.route === '/api/studio/permissions/config')?.body, { mode: 'readonly', leaveFullAccess: true }, `${lang}: Settings, page holding ${label}`);
      const opened = await look(clicks, 'CommandPalette', { lang, entries: [[['hubState'], snapshot]], store: { commandPaletteOpen: true } });
      serve();
      await fire(handlerOf(opened, item(words.cmd_readonly), 'onSelect'));
      assert.deepEqual(calls.find((call) => call.route === '/api/studio/permissions/config')?.body, { mode: 'readonly', leaveFullAccess: true }, `${lang}: palette, page holding ${label}`);
    }

    // the palette
    elements = await look(clicks, 'CommandPalette', { lang, store: { commandPaletteOpen: true } });
    const palette = handlerOf(elements, item(words.cmd_readonly), 'onSelect');
    serve();
    await fire(palette);
    assert.deepEqual(toasts, [[says.paletteMode('readonly'), 'info']], `${lang}: palette`);
    serve({ '/api/studio/permissions/config': saysNothing });
    await fire(palette);
    assert.deepEqual(toasts, [[says.paletteModeFailed, 'error']], `${lang}: palette, a failure that says nothing`);

    // the palette: the folder picker answers with a folder
    const browse = handlerOf(elements, item(words.cmd_change_ws), 'onSelect');
    serve({ '/api/workspace/browse': { path: '/work/gamma' } });
    await fire(browse);
    assert.deepEqual(toasts, [[says.paletteWorkspace('/work/gamma'), 'success']], `${lang}: palette, workspace`);
  }
});

test('the agent channel switches, unpairs and fails in the language of the screen', async () => {
  for (const lang of LANGS) {
    const says = SAYS[lang];
    const words = translations[lang];
    const paired = hub({ browser: { paired: true, connected: true, pairingAvailable: true, privacy: { reviewBeforeSend: false, workspaces: [] } } });
    const elements = await look(clicks, 'AgentChannelSection', { lang, entries: [[['hubState'], paired]], store: ws });
    const web = handlerOf(elements, domButton((props) => props['aria-label'] === words.chan_opt_aria.replace('{label}', 'ChatGPT Web')));
    serve();
    await fire(web);
    assert.deepEqual(toasts, [[says.channelWeb, 'success']], `${lang}: switch`);
    assert.deepEqual(calls.find((call) => call.route === '/api/agent/mode')?.body, { mode: 'chatgpt-web' });
    serve({ '/api/agent/mode': saysNothing });
    await fire(web);
    assert.deepEqual(toasts, [[says.channelSwitchFailed, 'error']], `${lang}: switch, a failure that says nothing`);

    const unpair = handlerOf(elements, domButton((props) => props.children === words.chan_unpair));
    serve();
    const asked = await fire(unpair, [], { confirmAnswer: true });
    assert.deepEqual(asked.asked, [says.unpairConfirm], `${lang}: what the person is asked`);
    assert.deepEqual(toasts, [[says.unpaired, 'info']], `${lang}: unpair`);
    serve();
    await fire(unpair, [], { confirmAnswer: false });
    assert.deepEqual([calls.length, toasts.length], [0, 0], `${lang}: a person who says no changes nothing`);
  }
});

test('the first-run setup, the FULL ACCESS dialog, the engine check and the workspace folder toast in the language of the screen', async () => {
  for (const lang of LANGS) {
    const says = SAYS[lang];
    const words = translations[lang];
    // closing the setup
    let elements = await look(clicks, 'OnboardingModal', { lang, store: { onboardingOpen: true } });
    serve();
    await fire(handlerOf(elements, domButton((props) => props['aria-label'] === words.onb_close)));
    assert.deepEqual(toasts, [[says.dismissed, 'info']], `${lang}: setup closed`);
    // the last step: the mode is saved and the person is welcomed
    elements = await look(lastStep, 'OnboardingModal', { lang, store: { onboardingOpen: true } });
    serve();
    await fire(handlerOf(elements, aButton((props) => props.variant === 'primary')));
    assert.deepEqual(toasts, [[says.welcome, 'success']], `${lang}: setup finished`);
    assert.deepEqual(calls.find((call) => call.route === '/api/studio/permissions/config')?.body, { mode: 'review', leaveFullAccess: true }, `${lang}: the mode that was chosen, leaving Full Access if the Hub is in it`);
    assert.equal(calls[0]?.route, '/api/studio/permissions/config', `${lang}: the request comes first, with no read of the Hub's state before it`);

    // FULL ACCESS, with the phrase typed
    elements = await look(typedDialog, 'FullAccessDialog', { lang, store: { fullAccessModalOpen: true } });
    const activate = handlerOf(elements, aButton((props) => props.variant === 'danger'));
    serve();
    await fire(activate);
    assert.deepEqual(toasts, [[says.activated, 'warning']], `${lang}: FULL ACCESS on`);
    assert.deepEqual(calls.find((call) => call.route === '/api/studio/permissions/config')?.body, { mode: 'autonomous', executionPolicy: 'full-access', confirmation: 'FULL ACCESS' });
    assert.ok(globalThis.__chatmcpInvalidated.some((filters) => JSON.stringify(filters) === JSON.stringify({ queryKey: ['hubState'] })),
      `${lang}: the page reads the Hub's state again at once, so that the banner and the lists do not wait for the next poll`);
    serve({ '/api/studio/permissions/config': saysNothing });
    await fire(activate);
    assert.deepEqual(toasts, [[says.activateFailed, 'error']], `${lang}: FULL ACCESS, a failure that says nothing`);

    // the engine check
    elements = await look(clicks, 'CodeIntelligenceSection', { lang });
    const probe = handlerOf(elements, aButton((props) => props.size === 'sm' && props.variant === 'secondary'));
    serve();
    await fire(probe);
    assert.deepEqual(toasts, [[says.probed, 'success']], `${lang}: engines checked`);
    serve({ '/api/studio/intelligence/engines/probe': saysNothing });
    await fire(probe);
    assert.deepEqual(toasts, [[says.probeFailed, 'error']], `${lang}: engines, a failure that says nothing`);

    // the workspace folder
    elements = await look(clicks, 'WorkspaceSection', { lang, store: ws });
    const browse = handlerOf(elements, aButton((props) => props.variant === 'secondary' && typeof props.onClick === 'function'));
    serve({ '/api/workspace/browse': saysNothing });
    await fire(browse);
    assert.deepEqual(toasts, [[says.browseFailed, 'error']], `${lang}: browse, a failure that says nothing`);
    const apply = handlerOf(elements, aButton((props) => props.variant === 'primary' && typeof props.onClick === 'function'));
    serve({ '/api/workspaces/add': saysNothing });
    await fire(apply);
    assert.deepEqual(toasts, [[says.changeFailed, 'error']], `${lang}: apply, a failure that says nothing`);
  }
});

test('the AI connection form says why it did not save or test, in the language of the screen', async () => {
  for (const lang of LANGS) {
    const says = SAYS[lang];
    const words = translations[lang];
    const entries = [[['hubState'], hub({ ai: aiOf() })]];
    const elements = await look(clicks, 'IntelligenceTab', { lang, entries });
    const save = handlerOf(elements, aButton((props) => props.variant === 'primary'));
    // the Hub saved another protocol than the one chosen
    serve({ '/api/ai/config': { ai: aiOf({ protocol: 'openai-responses' }) } });
    await fire(save);
    assert.deepEqual(toasts, [[says.protocolUnsaved, 'error']], `${lang}: save, another protocol`);
    // a failure that says nothing
    serve({ '/api/ai/config': saysNothing });
    await fire(save);
    assert.deepEqual(toasts, [[says.saveFailed, 'error']], `${lang}: save, a failure that says nothing`);
    // saved as chosen, tested with another protocol
    const test = handlerOf(elements, aButton((props) => props['aria-label'] === words.ai_test_aria));
    serve({ '/api/ai/config': { ai: aiOf({ protocol: 'openai-chat' }) }, '/api/ai/test': { ok: true, protocol: 'openai-responses' } });
    await fire(test);
    assert.deepEqual(toasts, [[says.protocolMismatch, 'error']], `${lang}: test, another protocol`);
  }
});

test('the Git tab says it could not create, preview or restore a checkpoint when the Hub says nothing, in the language of the screen', async () => {
  for (const lang of LANGS) {
    const says = SAYS[lang];
    const entries = [
      [['gitStatus', ALPHA], { branch: 'main', dirty: false }],
      [['checkpointsList', ALPHA], [{ id: 'cp-1', label: 'before', fileCount: 2 }]],
      [['gitDiff', ALPHA, false], { diff: '' }],
    ];
    const elements = await look(typedCheckpoint, 'GitTab', { lang, entries });
    const create = handlerOf(elements, aButton((props) => props.variant === 'primary'));
    serve({ '/api/studio/checkpoint': throwsAString });
    await fire(create);
    assert.deepEqual(toasts, [[says.checkpointFailed, 'error']], `${lang}: create`);
    const restore = handlerOf(elements, aButton((props) => props.size === 'sm' && props.variant === 'secondary'));
    serve({ '/api/studio/preview-checkpoint?checkpointId=cp-1': { ok: false } });
    await fire(restore);
    assert.deepEqual(toasts, [[says.previewFailed, 'error']], `${lang}: preview refused`);
    serve({ '/api/studio/preview-checkpoint?checkpointId=cp-1': { ok: true, files: [], modifiedFilesCount: 0 }, '/api/studio/restore-checkpoint': throwsAString });
    await fire(restore);
    assert.deepEqual(toasts, [[says.restoreFailed, 'error']], `${lang}: restore`);
  }
});

test('the AI connection form shows the saved thinking level, sends one only when it was chosen, and warns when the provider refused it', async () => {
  const isField = (element) => typeof element.type === 'function' && element.type.name === 'ReasoningEffortField';
  const primary = aButton((props) => props.variant === 'primary');
  const sentToConfig = () => calls.find((call) => call.route === '/api/ai/config')?.body;
  for (const lang of LANGS) {
    // untouched: the saved level is shown and the request says nothing about thinking
    const saved = await look(clicks, 'IntelligenceTab', { lang, entries: [[['hubState'], hub({ ai: aiOf({ reasoningEffort: 'high' }) })]] });
    const field = saved.find(isField);
    assert.ok(field, `${lang}: the form has the thinking field`);
    assert.equal(field.props.value, 'high', `${lang}: the saved level is the one shown`);
    assert.equal(field.props.refused, false);
    serve({ '/api/ai/config': { ai: aiOf({ reasoningEffort: 'high' }) } });
    await fire(handlerOf(saved, primary));
    assert.ok(sentToConfig(), `${lang}: the form saved`);
    assert.equal(Object.hasOwn(sentToConfig(), 'reasoningEffort'), false, `${lang}: an untouched level is not sent (the Hub keeps the saved one)`);
    // nothing saved: auto
    const fresh = await look(clicks, 'IntelligenceTab', { lang, entries: [[['hubState'], hub({ ai: aiOf() })]] });
    assert.equal(fresh.find(isField).props.value, 'auto', `${lang}: no level saved reads auto`);
    // chosen: it is sent
    const chosen = await look(chosenLevel, 'IntelligenceTab', { lang, entries: [[['hubState'], hub({ ai: aiOf() })]] });
    assert.equal(chosen.find(isField).props.value, 'medium', `${lang}: the chosen level is shown`);
    serve({ '/api/ai/config': { ai: aiOf({ reasoningEffort: 'medium' }) } });
    await fire(handlerOf(chosen, primary));
    assert.equal(sentToConfig().reasoningEffort, 'medium', `${lang}: the chosen level is sent`);
    // a Hub with no connection yet calls its provider "gateway", which is not a preset: the field asks about the protocol only, never about a preset the Hub would refuse
    const bare = await look(clicks, 'IntelligenceTab', { lang, entries: [[['hubState'], hub({ ai: { provider: 'gateway', preset: '', protocol: 'gemini', model: 'gemini-2.5-flash', apiBaseUrl: 'https://generativelanguage.googleapis.com' } })]] });
    assert.deepEqual([bare.find(isField).props.preset, bare.find(isField).props.protocol], [undefined, 'gemini'], `${lang}: a provider that is not a preset is not sent as one`);
    const chosenPreset = await look(clicks, 'IntelligenceTab', { lang, entries: [[['hubState'], hub({ ai: aiOf({ preset: 'anthropic', protocol: 'anthropic' }) })]] });
    assert.deepEqual([chosenPreset.find(isField).props.preset, chosenPreset.find(isField).props.protocol], ['anthropic', 'anthropic'], `${lang}: a preset is sent with its protocol`);
    // the Hub says the provider refused the saved level
    const refused = await look(clicks, 'IntelligenceTab', { lang, entries: [[['hubState'], hub({ ai: aiOf({ reasoningEffort: 'high', reasoning: { effort: 'high', sent: false, why: null, refused: true } }) })]] });
    assert.equal(refused.find(isField).props.refused, true, `${lang}: the refusal reaches the field`);
  }
});
