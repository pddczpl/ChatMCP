import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The real components of the update notice, rendered for each state and clicked: the strip under the header (the question that is asked once, and the release on offer with "What's new"
// and "Skip this version") and Settings → Cập nhật / Updates (versions, last check, "Check now", the owner's choice). What is pinned is what a person reads, in both languages, what
// the link may be, and what each button asks of the Hub. The Hub's answers are made up by the test; the components, React Query and the store are the real ones.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { AppliedNotice, UpdateBanner, UpdateNotice } from './src/components/layout/UpdateBanner';
  import { UpdatesSection, UpdatesPanel } from './src/components/settings/UpdatesSection';
  import { translations } from './src/lib/i18n';
  export { useAppStore, AppliedNotice, UpdateBanner, UpdateNotice, UpdatesSection, UpdatesPanel, translations };
`, 'chatmcp-updates-components-', { recordJsx: true });
after(dispose);
const { renderWith, useAppStore, AppliedNotice, UpdateBanner, UpdateNotice, UpdatesSection, UpdatesPanel, translations } = loaded;

// The same banner with the hook of the owner's click already at the question, which is where a click on "Install and restart" takes it (a server render cannot click). The rewrite fails the build
// when the line it changes is gone, so a rename cannot make it a silent no-op. Built before the first test is registered: a test that is already running defines window for a moment, and the module
// that reads the address of the page when it is loaded must not meet it.
const atTheQuestion = await bundleTsx(`
  ${renderPrelude}
  import { UpdateBanner } from './src/components/layout/UpdateBanner';
  export { UpdateBanner };
`, 'chatmcp-updates-question-', { recordJsx: true, rewrites: [{ file: 'src/lib/useUpdateActions.ts', from: "{ phase: 'idle' } as ApplyPhase", to: "{ phase: 'confirm', version: '3.10.3' } as ApplyPhase" }] });
after(atTheQuestion.dispose);

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const update = (overrides = {}) => ({
  current: '3.10.2', latest: '3.10.3', available: true, checkedAt: '2026-10-26T12:00:00.000Z', lastAttemptAt: '2026-10-26T12:00:00.000Z',
  notesUrl: 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3', installerName: 'DatGoldSetup.exe', installerBytes: 232753314, signature: null, kid: null, skippedVersion: null, error: null, checking: false,
  manualCheckAfter: '2026-10-26T12:01:00.000Z', nextAutomaticCheckAt: null, autoCheck: { enabled: true, saved: true, needsChoice: false }, download: { state: 'idle' }, ...overrides,
});
/** A release whose signature checked, so that it can be downloaded. */
const signed = (overrides = {}) => update({ signature: 'valid', kid: '1a2b3c4d', ...overrides });
const asking = (overrides = {}) => update({ autoCheck: { enabled: false, saved: null, needsChoice: true }, ...overrides });
const failure = (code, status = null) => ({ code, message: 'diagnostic in English that is never shown as it is', status, at: '2026-10-26T12:05:00.000Z' });
const NOW = Date.parse('2026-10-26T12:30:00.000Z'); // long after the minute of the state above
const noop = () => {};

// the language is given to the component and to the store: CopyButton, which the panel shares with the rest of the page, reads the store's
const strip = (props, lang = 'vi') => renderWith(UpdateNotice, { update: update(), onAnswer: noop, onSkip: noop, onDetails: noop, onDownload: noop, onCancel: noop, onCheck: noop, lang, ...props }, [], [], { lang });
const panel = (props, lang = 'vi') => renderWith(UpdatesPanel, { update: update(), now: NOW, onCheck: noop, onSkip: noop, onToggle: noop, onDownload: noop, onCancel: noop, lang, ...props }, [], [], { lang });
const tag = (html, testid) => new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0] ?? '';
const text = (html, testid) => {
  const open = new RegExp(`<([a-z0-9]+)[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  if (!open) return null;
  const rest = html.slice(open.index + open[0].length);
  const close = rest.indexOf(`</${open[1]}>`);
  return rest.slice(0, close).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
};
const has = (html, testid) => html.includes(`data-testid="${testid}"`);
// everything that would make a notice look like a verdict: the green of a check that passed, the red of a refusal
const PROOF_LOOK = /text-success|border-success|bg-success|text-danger|border-danger|bg-danger|ShieldCheck|CircleCheck|lucide-shield|lucide-circle-check|lucide-check|data-testid="proof-strip"/;

// ---- the strip -----------------------------------------------------------------------------------------------------------------------------

test('unanswered: the strip asks once, says what is sent and to whom, and offers yes, no and the details', async () => {
  const vi = await strip({ update: asking() });
  assert.match(vi, /role="status"/, 'a status, not an alert: it does not interrupt');
  assert.ok(has(vi, 'update-question'));
  assert.match(tag(vi, 'update-question'), /data-kind="question"/);
  assert.equal(text(vi, 'update-question-title'), translations.vi.upd_q_title);
  assert.match(text(vi, 'update-question-body'), /GitHub/);
  assert.match(text(vi, 'update-question-body'), /DatGold\/3\.10\.2/, 'which line GitHub sees');
  assert.match(text(vi, 'update-question-body'), /12 giờ/);
  assert.match(text(vi, 'update-question-body'), /không tải gì về trừ khi bạn bấm Tải về, và không cài gì/, 'and that checking only tells: a download is the owner\'s click');
  assert.equal(text(vi, 'update-yes'), 'Có, kiểm tra');
  assert.equal(text(vi, 'update-no'), 'Không');
  assert.equal(text(vi, 'update-details'), 'Chi tiết');
  assert.ok(!has(vi, 'update-notice') && !has(vi, 'update-notes') && !has(vi, 'update-copy') && !has(vi, 'update-skip'), 'and nothing of the other strip');
  assert.doesNotMatch(vi, PROOF_LOOK);
  const en = await strip({ update: asking() }, 'en');
  assert.equal(text(en, 'update-yes'), 'Yes, check');
  assert.equal(text(en, 'update-no'), 'No');
  assert.match(text(en, 'update-question-body'), /GitHub sees your IP address and the line "DatGold\/3\.10\.2"/);
  assert.match(text(en, 'update-question-body'), /nothing is downloaded unless you press Download, and nothing is installed/);
  assert.doesNotMatch(en, DIACRITICS, 'the English strip reads English');
  assert.doesNotMatch(en, /ChatMCP/);
  const busy = await strip({ update: asking(), busy: true });
  for (const id of ['update-yes', 'update-no']) assert.match(tag(busy, id), /disabled=""/, `${id} waits while a request is out`);
});

test('a release on offer: the strip says which, links to the notes on GitHub and offers to skip', async () => {
  const vi = await strip({});
  assert.ok(has(vi, 'update-notice'));
  assert.match(tag(vi, 'update-notice'), /data-kind="available"/);
  assert.match(tag(vi, 'update-notice'), /data-version="3\.10\.3"/);
  assert.match(vi, /role="status"/);
  assert.equal(text(vi, 'update-notice-text'), 'Đã có DatGold 3.10.3.', 'a headline that cannot be read as "DatGold has a new version"');
  const link = tag(vi, 'update-notes');
  assert.match(link, /href="https:\/\/github\.com\/pddczpl\/ChatMCP\/releases\/tag\/v3\.10\.3"/);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.equal(text(vi, 'update-notes'), 'Có gì mới');
  assert.ok(has(vi, 'update-copy'), 'a copy button beside the link: in the desktop shell the link may open nothing');
  assert.match(vi, /aria-label="Sao chép liên kết ghi chú phát hành"/);
  assert.equal(text(vi, 'update-skip'), 'Bỏ qua bản này');
  assert.ok(!has(vi, 'update-question'), 'not the question');
  assert.doesNotMatch(vi, PROOF_LOOK, 'a notice is not drawn like a result that was checked');
  const en = await strip({}, 'en');
  assert.equal(text(en, 'update-notice-text'), 'DatGold 3.10.3 is available.');
  assert.equal(text(en, 'update-notes'), "What's new");
  assert.equal(text(en, 'update-skip'), 'Skip this version');
  assert.doesNotMatch(en, DIACRITICS);
});

test('a link that is not the notes of that release on the project\'s GitHub is not drawn', async () => {
  for (const notesUrl of ['https://evil.example/pddczpl/ChatMCP/releases/tag/v3.10.3', 'javascript:alert(1)', 'https://github.com/pddczpl/ChatMCP/releases/tag/v9.9.9', null, '']) {
    const html = await strip({ update: update({ notesUrl }) });
    assert.ok(has(html, 'update-notice'), 'the notice itself stays');
    assert.ok(!has(html, 'update-notes') && !has(html, 'update-copy'), `no link and nothing to copy for ${JSON.stringify(notesUrl)}`);
    assert.doesNotMatch(html, /evil\.example|javascript:/, 'and the text is nowhere in the markup');
  }
});

test('nothing is drawn when there is nothing to say', async () => {
  for (const [label, props] of [
    ['up to date', { update: update({ available: false, latest: '3.10.2' }) }], ['skipped', { update: update({ skippedVersion: '3.10.3' }) }], ['nothing known', { update: update({ latest: null, available: false }) }],
    ['no state at all', { update: null }], ['a state the Hub did not give in full', { update: { current: '3.10.2' } }],
  ]) assert.equal((await strip(props)).trim(), '', label);
  const container = await renderWith(UpdateBanner, {}, [[['hubState'], { update: update({ skippedVersion: '3.10.3' }) }]], [], { lang: 'vi' });
  assert.equal(container.trim(), '', 'the banner on a Hub state that holds a skipped release');
  const none = await renderWith(UpdateBanner, {}, [[['hubState'], {}]], [], { lang: 'vi' });
  assert.equal(none.trim(), '', 'and on one with no update at all (a Hub from before this notice)');
  const loading = await renderWith(UpdateBanner, {}, [], [], { lang: 'vi' });
  assert.equal(loading.trim(), '', 'and before the Hub has answered');
});

// ---- Settings → Updates ---------------------------------------------------------------------------------------------------------------------

test('the Updates section: the version in use, the latest known, when it was checked, and what is on offer', async () => {
  const vi = await panel({ update: update() }, 'vi');
  assert.equal(text(vi, 'updates-current'), 'v3.10.2');
  assert.equal(text(vi, 'updates-latest'), 'v3.10.3');
  assert.match(text(vi, 'updates-checked'), /26/);
  assert.match(tag(vi, 'updates-status'), /data-state="available"/);
  assert.equal(text(vi, 'updates-status'), 'Có DatGold 3.10.3.');
  assert.equal(text(vi, 'updates-check'), 'Kiểm tra ngay');
  assert.match(tag(vi, 'updates-notes'), /href="https:\/\/github\.com\/pddczpl\/ChatMCP\/releases\/tag\/v3\.10\.3"[^>]*target="_blank"[^>]*rel="noopener noreferrer"|target="_blank"[^>]*rel="noopener noreferrer"[^>]*href=/);
  assert.ok(has(vi, 'updates-copy'), 'a copy button: the shell may not open the link');
  assert.match(vi, /aria-label="Sao chép liên kết ghi chú phát hành"/);
  assert.equal(text(vi, 'updates-skip'), 'Bỏ qua bản này');
  assert.ok(!has(vi, 'updates-unskip') && !has(vi, 'updates-error'));
  const en = await panel({ update: update() }, 'en');
  assert.equal(text(en, 'updates-status'), 'DatGold 3.10.3 is available.');
  assert.equal(text(en, 'updates-check'), 'Check now');
  assert.doesNotMatch(en, DIACRITICS);
  assert.doesNotMatch(vi + en, /ChatMCP(?!\/releases|\/tag)/, 'the product is DatGold on this screen (the repository is only in a link)');
});

test('never checked, up to date and skipped each read differently', async () => {
  const never = await panel({ update: update({ latest: null, available: false, checkedAt: null, lastAttemptAt: null, manualCheckAfter: null, notesUrl: null }) }, 'en');
  assert.match(tag(never, 'updates-status'), /data-state="unknown"/);
  assert.equal(text(never, 'updates-checked'), 'Not checked yet');
  assert.equal(text(never, 'updates-latest'), '–');
  assert.ok(!has(never, 'updates-notes') && !has(never, 'updates-skip') && !has(never, 'updates-copy'));
  const current = await panel({ update: update({ available: false, latest: '3.10.2' }) }, 'en');
  assert.match(tag(current, 'updates-status'), /data-state="uptodate"/);
  assert.equal(text(current, 'updates-status'), 'You are up to date.');
  assert.ok(!has(current, 'updates-skip') && !has(current, 'updates-notes'), 'no notes link and no skip when nothing is on offer');
  const skipped = await panel({ update: update({ skippedVersion: '3.10.3' }) }, 'en');
  assert.match(tag(skipped, 'updates-status'), /data-state="skipped"/);
  assert.equal(text(skipped, 'updates-status'), 'DatGold 3.10.3 is available, but you skipped this version.');
  assert.equal(text(skipped, 'updates-unskip'), 'Remind me about this version');
  assert.ok(!has(skipped, 'updates-skip'), 'a skipped release offers to be remembered, not skipped');
  assert.ok(has(skipped, 'updates-notes'), 'its notes are still one click away');
});

test('a failed check says what went wrong, in words, and keeps what was known', async () => {
  const says = {
    update_network: [/Không kết nối được tới GitHub/, /Could not reach GitHub/], update_timeout: [/không trả lời kịp/, /did not answer in time/],
    update_http: [/HTTP 503/, /HTTP 503/], update_redirect_refused: [/không tin/, /does not trust/], update_too_large: [/không phải là mô tả bản phát hành hợp lệ/, /not a valid release description/],
    update_state_unsaved: [/không lưu được ghi chú/, /could not save its note/],
    update_signature_invalid: [/Chữ ký của bản mới nhất không khớp/, /signature of the newest release does not check/],
    update_signature_unknown_key: [/khóa mà phiên bản DatGold này chưa biết/, /key this version of DatGold does not know/],
    update_signature_unreachable: [/chưa đọc được chữ ký/, /its signature could not be read/],
    update_something_new: [/Lần kiểm tra không thành công/, /The check did not work/],
  };
  for (const [code, [vi, en]] of Object.entries(says)) {
    const state = update({ error: failure(code, code === 'update_http' ? 503 : null) });
    const viHtml = await panel({ update: state }, 'vi');
    const enHtml = await panel({ update: state }, 'en');
    assert.match(text(viHtml, 'updates-error'), vi, `${code} in Vietnamese`);
    assert.match(text(enHtml, 'updates-error'), en, `${code} in English`);
    assert.doesNotMatch(enHtml, DIACRITICS, `${code}: the English screen reads English`);
    assert.ok(!viHtml.includes('diagnostic in English'), 'the Hub\'s diagnostic is not shown as it is');
    assert.match(tag(viHtml, 'updates-status'), /data-state="available"/, 'and the release that was known is still there');
    assert.doesNotMatch(viHtml, /text-danger|bg-danger|border-danger/, 'a failure of the network is not drawn as a danger');
  }
  assert.ok(!has(await panel({ update: update() }), 'updates-error'));
});

test('"Check now" is disabled while a check is out and for the minute after one, and says so', async () => {
  const checking = await panel({ update: update({ checking: true }) }, 'vi');
  assert.match(tag(checking, 'updates-check'), /disabled=""/);
  assert.equal(text(checking, 'updates-check'), 'Đang kiểm tra…');
  const recent = update({ manualCheckAfter: new Date(NOW + 42_000).toISOString() });
  const waiting = await panel({ update: recent }, 'en');
  assert.match(tag(waiting, 'updates-check'), /disabled=""/);
  assert.equal(text(waiting, 'updates-wait'), 'Just checked. You can check again in 42 s.');
  const waitingVi = await panel({ update: recent }, 'vi');
  assert.equal(text(waitingVi, 'updates-wait'), 'Vừa kiểm tra xong. Kiểm tra lại được sau 42 giây.');
  const rounded = await panel({ update: update({ manualCheckAfter: new Date(NOW + 1).toISOString() }) }, 'en');
  assert.equal(text(rounded, 'updates-wait'), 'Just checked. You can check again in 1 s.', 'a fraction of a second is a second');
  const ready = await panel({ update: update() }, 'en');
  assert.doesNotMatch(tag(ready, 'updates-check'), /disabled=""/);
  assert.ok(!has(ready, 'updates-wait'));
  const busy = await panel({ busy: true }, 'en');
  assert.match(tag(busy, 'updates-check'), /disabled=""/, 'and while a request of this page is out');
});

test('the owner\'s choice is a box with three readings, and the page says what each means', async () => {
  const unset = await panel({ update: asking() }, 'vi');
  assert.match(tag(unset, 'updates-auto-toggle'), /type="checkbox"/);
  assert.doesNotMatch(tag(unset, 'updates-auto-toggle'), /checked=""/);
  assert.doesNotMatch(tag(unset, 'updates-auto-toggle'), /disabled=""/);
  assert.match(tag(unset, 'updates-auto-status'), /data-state="unset"/);
  assert.equal(text(unset, 'updates-auto-status'), 'Chưa chọn: DatGold không tự kiểm tra cho đến khi bạn chọn.');
  const on = await panel({ update: update() }, 'en');
  assert.match(tag(on, 'updates-auto-toggle'), /checked=""/);
  assert.match(tag(on, 'updates-auto-status'), /data-state="on"/);
  assert.equal(text(on, 'updates-auto-status'), 'On (your choice).');
  const off = await panel({ update: update({ autoCheck: { enabled: false, saved: false, needsChoice: false } }) }, 'en');
  assert.doesNotMatch(tag(off, 'updates-auto-toggle'), /checked=""/);
  assert.match(tag(off, 'updates-auto-status'), /data-state="off"/);
  assert.match(text(off, 'updates-auto-status'), /Off \(your choice\)\. "Check now" still works\./);
  const defaulted = await panel({ update: update({ autoCheck: { enabled: true, saved: null, needsChoice: false } }) }, 'en');
  assert.match(tag(defaulted, 'updates-auto-toggle'), /checked=""/);
  assert.equal(text(defaulted, 'updates-auto-status'), 'On (default).');
  const unknown = await panel({ update: null }, 'en');
  assert.match(tag(unknown, 'updates-auto-toggle'), /disabled=""/, 'the box cannot be used before the Hub has said what the choice is');
  const points = (await panel({ update: update() }, 'en'));
  assert.match(points, /two short chains of GET requests/, 'a check is two chains of requests: the manifest and its signature');
  assert.match(points, /RELEASE-MANIFEST\.json\.sig/, 'the signature file is named');
  assert.match(points, /starts at github\.com/);
  assert.match(points, /release-assets\.githubusercontent\.com/, 'the file server of GitHub is named: it is the host a firewall rule has to allow');
  assert.match(points, /DatGold\/3\.10\.2/);
  const pointsVi = await panel({ update: update() }, 'vi');
  assert.match(pointsVi, /chuỗi ngắn các yêu cầu GET/);
  assert.match(pointsVi, /release-assets\.githubusercontent\.com/);
  assert.match(points, /never more often than every 15 minutes/);
  assert.match(points, /Nothing is downloaded until you press Download/, 'a download is the owner\'s click');
  assert.match(points, /Downloading installs nothing: the installer runs only when you press Install and restart in the desktop app/, 'and says what installs it');
  assert.match(points, /at most once a minute/);
  assert.doesNotMatch(points, /\b(?:certified|tamper-proof|guarantee|verified|secure)\b/i, 'no word that claims more than it does');
});

test('the English dictionary of the update notice holds no Vietnamese and no key stands in for a text', () => {
  const keys = Object.keys(translations.vi).filter((key) => key.startsWith('upd_') || key === 'sec_updates');
  assert.ok(keys.length > 40, `${keys.length} keys`);
  for (const key of keys) {
    assert.ok(translations.en[key]?.trim(), `en.${key}`);
    assert.doesNotMatch(translations.en[key], DIACRITICS, `en.${key} reads English`);
    assert.doesNotMatch(translations.vi[key] + translations.en[key], /ChatMCP/, `${key} says DatGold`);
    assert.ok(translations.en[key] !== translations.vi[key] || !DIACRITICS.test(translations.vi[key]), `${key} is translated`);
  }
});

// ---- clicks --------------------------------------------------------------------------------------------------------------------------------

const calls = [];
const toasts = [];
const routes = new Map();
const showToast = (message, type) => { toasts.push([message, type]); };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const serve = (table = {}) => { calls.length = 0; toasts.length = 0; routes.clear(); for (const [route, answer] of Object.entries(table)) routes.set(route, answer); };
globalThis.fetch = async (route, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push({ route, method: options.method ?? 'GET', body });
  const answer = routes.get(route);
  const result = typeof answer === 'function' ? await answer(body) : answer ?? { ok: true };
  return result instanceof Response ? result : reply(200, result);
};
async function look(component, props, state, lang = 'vi', store = {}, hubExtra = {}) {
  globalThis.__chatmcpJsx = [];
  await renderWith(component, props, [[['hubState'], { update: state, ...hubExtra }]], [], { lang, showToast, ...store });
  return globalThis.__chatmcpJsx.slice();
}
const handlerOf = (elements, name, prop) => {
  const found = elements.find((element) => typeof element.type === 'function' && element.type.name === name && typeof element.props[prop] === 'function');
  assert.ok(found, `no ${name} gave a ${prop}`);
  return found.props[prop];
};
/** Call the handler as a browser would, and let every step it started (a request, a refresh, a toast) finish. */
async function fire(handler, ...args) {
  globalThis.window = { confirm: () => true };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    await handler(...args);
    for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  } finally { delete globalThis.window; delete globalThis.localStorage; }
}
const asked = () => calls.map((call) => `${call.method} ${call.route}${call.body === undefined ? '' : ` ${JSON.stringify(call.body)}`}`);
const hubSays = (state, extra = {}) => ({ update: state, ...extra });

test('Yes saves the choice and then asks once at once; No saves it and asks nothing; Details opens the Updates section', async () => {
  const elements = await look(UpdateBanner, {}, asking());
  const answer = handlerOf(elements, 'UpdateNotice', 'onAnswer');
  const found = update();
  serve({ '/api/update/auto-check': hubSays(update()), '/api/update/check': { update: found, checked: true, throttled: false } });
  await fire(answer, true);
  assert.deepEqual(asked(), ['POST /api/update/auto-check {"enabled":true}', 'POST /api/update/check {}'], 'yes: the choice first, then the first look, so that the person sees the answer now');
  assert.deepEqual(toasts, [[translations.vi.upd_toast_on, 'success']]);
  assert.ok(globalThis.__chatmcpInvalidated.some((filter) => JSON.stringify(filter?.queryKey) === '["hubState"]'), 'and the page refreshes what it knows');

  serve({ '/api/update/auto-check': hubSays(update({ autoCheck: { enabled: false, saved: false, needsChoice: false } })) });
  await fire(answer, false);
  assert.deepEqual(asked(), ['POST /api/update/auto-check {"enabled":false}'], 'no: the choice, and nothing else');
  assert.deepEqual(toasts, [[translations.vi.upd_toast_off, 'success']]);

  serve({ '/api/update/auto-check': () => reply(500, { error: 'Không lưu được lựa chọn trong thư mục dữ liệu của Hub.', code: 'update_save_failed' }) });
  await fire(answer, true);
  assert.deepEqual(asked(), ['POST /api/update/auto-check {"enabled":true}'], 'a choice that could not be saved is not followed by a look');
  assert.deepEqual(toasts, [[translations.vi.upd_save_failed, 'error']], 'a refusal the Hub gives a code is said in the words of the page, not in the Hub\'s');
  serve({ '/api/update/auto-check': () => reply(502, { error: 'Something the page cannot know', code: 'something_new' }) });
  await fire(answer, true);
  assert.deepEqual(toasts, [['Something the page cannot know', 'error']], 'and one it has no words for is shown as the Hub said it');
  serve({ '/api/update/auto-check': () => { throw new Error(''); } });
  await fire(answer, true);
  assert.deepEqual(toasts.map(([message, type]) => [message, type]), [[translations.vi.upd_save_failed, 'error']], 'and a failure that says nothing gets the page\'s');

  const details = handlerOf(elements, 'UpdateNotice', 'onDetails');
  await fire(details);
  const store = useAppStore.getState();
  assert.deepEqual([store.settingsOpen, store.settingsSection], [true, 'updates'], 'Details opens Settings on the Updates section');
  useAppStore.setState({ settingsOpen: false });
});

test('Skip asks the Hub to skip that very release, says so in the language of the page, and a refusal is shown', async () => {
  for (const lang of ['vi', 'en']) {
    const elements = await look(UpdateBanner, {}, update(), lang);
    const skip = handlerOf(elements, 'UpdateNotice', 'onSkip');
    serve({ '/api/update/skip': hubSays(update({ skippedVersion: '3.10.3' })) });
    await fire(skip, '3.10.3');
    assert.deepEqual(asked(), ['POST /api/update/skip {"version":"3.10.3"}'], lang);
    assert.deepEqual(toasts, [[translations[lang].upd_toast_skipped.replace('{version}', '3.10.3'), 'success']], lang);
    serve({ '/api/update/skip': () => reply(409, { error: 'Bản này không còn là bản mới đang được đề nghị.', code: 'update_skip_stale' }) });
    globalThis.__chatmcpInvalidated.length = 0;
    await fire(skip, '3.10.3');
    assert.deepEqual(toasts, [[translations[lang].upd_refused_stale, 'error']], `${lang}: the release has changed, said in the language of the page`);
    assert.ok(globalThis.__chatmcpInvalidated.some((filter) => JSON.stringify(filter?.queryKey) === '["hubState"]'), `${lang}: and the page looks again at what the Hub knows`);
  }
});

test('the Updates section: "Check now" says what it found, a second press says it was too soon, and skip, remind and the box ask the Hub', async () => {
  for (const lang of ['vi', 'en']) {
    const words = translations[lang];
    const elements = await look(UpdatesSection, {}, update(), lang);
    const check = handlerOf(elements, 'UpdatesPanel', 'onCheck');
    serve({ '/api/update/check': { update: update(), checked: true, throttled: false } });
    await fire(check);
    assert.deepEqual(asked(), ['POST /api/update/check {}'], lang);
    assert.deepEqual(toasts, [[words.upd_toast_available.replace('{version}', '3.10.3'), 'success']], `${lang}: a release was found`);
    serve({ '/api/update/check': { update: update({ available: false, latest: '3.10.2' }), checked: true, throttled: false } });
    await fire(check);
    assert.deepEqual(toasts, [[words.upd_toast_uptodate, 'info']], `${lang}: up to date`);
    serve({ '/api/update/check': { update: update(), checked: false, throttled: true } });
    await fire(check);
    assert.deepEqual(toasts, [[words.upd_toast_throttled, 'info']], `${lang}: too soon`);
    serve({ '/api/update/check': { update: update({ error: failure('update_network') }), checked: true, throttled: false } });
    await fire(check);
    assert.deepEqual(toasts, [[words.upd_err_network, 'error']], `${lang}: a check that did not work is told in words`);
    serve({ '/api/update/check': () => reply(503, { error: 'Kiểm tra bản cập nhật chưa khởi tạo.', code: 'update_unavailable' }) });
    await fire(check);
    assert.deepEqual(toasts, [[words.upd_refused_unavailable, 'error']], `${lang}: a Hub without the notice`);

    const skip = handlerOf(elements, 'UpdatesPanel', 'onSkip');
    serve({ '/api/update/skip': hubSays(update({ skippedVersion: '3.10.3' })) });
    await fire(skip, '3.10.3');
    assert.deepEqual(asked(), ['POST /api/update/skip {"version":"3.10.3"}'], lang);
    serve({ '/api/update/skip': hubSays(update()) });
    await fire(skip, null);
    assert.deepEqual(asked(), ['POST /api/update/skip {"version":null}'], `${lang}: null takes the skip back`);
    assert.deepEqual(toasts, [[words.upd_toast_unskipped.replace('{version}', '3.10.3'), 'success']]);

    const toggle = handlerOf(elements, 'UpdatesPanel', 'onToggle');
    serve({ '/api/update/auto-check': hubSays(update()) });
    await fire(toggle, true);
    assert.deepEqual(asked(), ['POST /api/update/auto-check {"enabled":true}', 'POST /api/update/check {}'], `${lang}: ticking the box is a yes: the choice, then a look`);
    serve({ '/api/update/auto-check': hubSays(update()) });
    await fire(toggle, false);
    assert.deepEqual(asked(), ['POST /api/update/auto-check {"enabled":false}'], `${lang}: unticking asks nothing`);
    assert.deepEqual(toasts, [[words.upd_toast_off, 'success']]);
  }
});

test('the box offers nothing of its own to change: it holds no address of the feed', async () => {
  const html = await panel({ update: update() }, 'en');
  assert.doesNotMatch(html, /<input[^>]*type="(?:text|url)"/, 'no field to type an address into');
  assert.doesNotMatch(html, /RELEASE-MANIFEST\.json[^<]*<\/(?:input|textarea)/);
  assert.equal((html.match(/<input/g) ?? []).length, 1, 'one box: the choice');
});

// ---- the download --------------------------------------------------------------------------------------------------------------------------

const INSTALLING = /data-testid="[^"]*(?:install|apply|restart|relaunch)[^"]*"|>\s*(?:Install|Cài đặt|Cài bản|Cập nhật ngay|Update now|Restart)\b/i;

test('a signed release: the strip offers the download with its size, and no way to install', async () => {
  const vi = await strip({ update: signed() });
  assert.equal(text(vi, 'update-download'), 'Tải về (222 MB)');
  assert.doesNotMatch(tag(vi, 'update-download'), /disabled=""/);
  for (const absent of ['update-signature-note', 'update-download-progress', 'update-download-ready', 'update-download-error', 'update-cancel', 'update-recheck']) assert.ok(!has(vi, absent), `${absent} is not there`);
  assert.doesNotMatch(vi, PROOF_LOOK, 'an offer is not drawn like a result that was checked');
  const en = await strip({ update: signed() }, 'en');
  assert.equal(text(en, 'update-download'), 'Download (222 MB)');
  assert.doesNotMatch(en, DIACRITICS);
  assert.doesNotMatch(vi + en, INSTALLING, 'no install control, not even a hidden one');
  assert.match(tag(await strip({ update: signed(), busy: true }), 'update-download'), /disabled=""/, 'it waits while a request is out');
  assert.ok(has(vi, 'update-notes') && has(vi, 'update-copy') && has(vi, 'update-skip'), 'the notes, the copy button and Skip are still there');
});

test('a download in progress: a bar with the bytes that arrived out of the size, and Cancel; nothing to press for Download', async () => {
  const running = signed({ download: { state: 'downloading', version: '3.10.3', received: 50_000_000, total: 232753314 } });
  const en = await strip({ update: running }, 'en');
  const bar = tag(en, 'update-download-progress');
  assert.match(bar, /role="progressbar"/);
  assert.match(bar, /aria-valuemin="0"/);
  assert.match(bar, /aria-valuemax="100"/);
  assert.match(bar, /aria-valuenow="21"/);
  assert.match(bar, /aria-label="Downloading… 21% \(48 MB of 222 MB\)"/, 'the bar is named for a screen reader with what the text says');
  assert.equal(text(en, 'update-download-progress-text'), 'Downloading… 21% (48 MB of 222 MB)');
  assert.equal(text(en, 'update-cancel'), 'Cancel');
  assert.ok(!has(en, 'update-download'), 'the Download button is gone while it runs');
  const vi = await strip({ update: running }, 'vi');
  assert.equal(text(vi, 'update-download-progress-text'), 'Đang tải… 21% (48 MB / 222 MB)');
  assert.equal(text(vi, 'update-cancel'), 'Hủy');
  assert.doesNotMatch(en, DIACRITICS);
  assert.doesNotMatch(vi + en, INSTALLING);
  // the Hub does not know the size yet (it is looking at the release again): no percentage, no bar value
  const preparing = await strip({ update: signed({ download: { state: 'downloading', version: '3.10.3', received: 0, total: null } }) }, 'en');
  assert.doesNotMatch(tag(preparing, 'update-download-progress'), /aria-valuenow/, 'no value while the size is not known');
  assert.equal(text(preparing, 'update-download-progress-text'), 'Preparing the download…');
  assert.ok(has(preparing, 'update-cancel'));
  assert.doesNotMatch(preparing, /w-1\/3/, 'no static third of a bar: with reduced motion that would read as 33%');
  assert.match(preparing, /bg-primary\/40 animate-pulse/, 'a faint full bar that pulses where motion is allowed');
  const verifying = await strip({ update: signed({ download: { state: 'verifying', version: '3.10.3' } }) }, 'en');
  assert.equal(text(verifying, 'update-download-verifying'), 'Checking the file…');
  assert.ok(has(verifying, 'update-cancel') && !has(verifying, 'update-download'));
  assert.doesNotMatch(tag(await strip({ update: running, busy: true }), 'update-cancel'), /disabled=""/, 'Cancel is not held back by the click that is still being answered (the Hub already reports the download): it waits only for its own request');
  assert.match(tag(await strip({ update: running, cancelling: true }), 'update-cancel'), /disabled=""/, 'but it is not pressed twice');
  assert.match(tag(en, 'update-notice'), /aria-atomic="false"/, 'a change in the strip is announced as the part that changed, not the whole strip');
  assert.match(en, /aria-live="off"/, 'and the progress, which changes at every poll, is not read out');
  assert.doesNotMatch(await strip({ update: signed({ download: { state: 'ready', version: '3.10.3', bytes: 232753314 } }) }, 'en'), /aria-live="off"/, 'the end of a download is announced');
});

test('a download that failed says what went wrong, in words, and can be tried again while the signature checks', async () => {
  const says = {
    update_download_stalled: [/Kết nối tới GitHub bị lỗi/, /connection to GitHub failed or stopped/], update_download_interrupted: [/Kết nối tới GitHub bị lỗi/, /connection to GitHub failed or stopped/],
    update_download_size: [/không phải tệp mà danh sách đã ký mô tả/, /not the one the signed list describes/], update_download_hash: [/không phải tệp mà danh sách đã ký mô tả/, /not the one the signed list describes/],
    update_download_bad_size: [/không nêu một bộ cài/, /does not name an installer/],
    update_download_disk_full: [/không đủ chỗ trống/, /not enough free space/], update_download_write: [/không ghi được tệp/, /could not write the file/],
    update_download_save: [/không ghi được tệp/, /could not write the file/], update_download_platform: [/không chạy được bộ cài Windows/, /cannot run the Windows installer/],
    update_download_unsigned: [/không còn chữ ký hợp lệ/, /no longer has a signature that checks/], update_download_stale: [/không còn là bản đang được đề nghị/, /no longer the release on offer/],
    update_download_bad_name: [/không nêu một bộ cài/, /does not name an installer/], update_download_something_new: [/Tải về không thành công\./, /The download did not work\./],
  };
  for (const [code, [vi, en]] of Object.entries(says)) {
    const state = signed({ download: { state: 'failed', version: '3.10.3', code } });
    const viHtml = await strip({ update: state }, 'vi');
    const enHtml = await strip({ update: state }, 'en');
    assert.match(text(viHtml, 'update-download-error'), vi, `${code} in Vietnamese`);
    assert.match(text(enHtml, 'update-download-error'), en, `${code} in English`);
    assert.match(text(enHtml, 'update-download-error'), /^The download did not work:/);
    assert.doesNotMatch(enHtml, DIACRITICS, `${code}: the English strip reads English`);
    assert.ok(has(viHtml, 'update-download'), `${code}: and it can be tried again`);
    assert.doesNotMatch(viHtml, /text-danger|bg-danger|border-danger/, 'a failure of the network is not drawn as a danger');
    assert.doesNotMatch(tag(viHtml, 'update-download-error'), /text-warning/, 'its words are in the colour of the text: the amber is for the icon, because amber text on the strip does not reach 4.5:1 in the light theme');
  }
  const withdrawn = await strip({ update: update({ signature: 'missing', download: { state: 'failed', version: '3.10.3', code: 'update_download_hash' } }) }, 'en');
  assert.ok(has(withdrawn, 'update-download-error') && !has(withdrawn, 'update-download'), 'not when the signature no longer checks');
  assert.match(tag(withdrawn, 'update-signature-note'), /data-signature="missing"/, 'and it says why there is no button');
  assert.match(text(withdrawn, 'update-signature-note'), /This release is not signed yet/);
});

test('a signed release that names no single installer says so and offers nothing to press, in the strip and in Settings', async () => {
  const noInstaller = signed({ installerName: null, installerBytes: null });
  const vi = await strip({ update: noInstaller }, 'vi');
  const en = await strip({ update: noInstaller }, 'en');
  for (const html of [vi, en]) {
    assert.ok(!has(html, 'update-download') && !has(html, 'update-cancel'), 'no button');
    assert.match(tag(html, 'update-signature-note'), /data-signature="valid"/, 'the signature is fine');
    assert.match(tag(html, 'update-signature-note'), /data-reason="installer"/, 'it is the installer that is the matter');
    assert.ok(!has(html, 'update-recheck'), 'looking again does not change a manifest');
  }
  assert.match(text(vi, 'update-signature-note'), /không nêu đúng một bộ cài Windows/);
  assert.match(text(en, 'update-signature-note'), /does not list exactly one Windows installer/);
  assert.doesNotMatch(en, DIACRITICS);
  const settings = await panel({ update: noInstaller }, 'en');
  assert.ok(!has(settings, 'updates-download'));
  assert.match(text(settings, 'updates-signature-note'), /does not list exactly one Windows installer/);
});

test('a release that cannot be downloaded says why, and a signature that was not read can be looked at again', async () => {
  const cases = {
    missing: [update({ signature: 'missing' }), /Bản này chưa được ký/, /This release is not signed yet, so DatGold will not download it/, false],
    invalid: [update({ signature: 'invalid', error: failure('update_signature_invalid') }), /Chữ ký của bản này không khớp, nên DatGold sẽ không tải/, /signature of this release does not check, so DatGold will not download it/, false],
    unknown_key: [update({ signature: 'invalid', error: failure('update_signature_unknown_key') }), /khóa mà phiên bản DatGold này chưa biết/, /key this version of DatGold does not know/, false],
    unreadable: [update({ signature: null, error: failure('update_signature_unreachable', 500) }), /chưa đọc được chữ ký/, /could not read the signature/, true],
    unchecked: [update({ signature: null }), /chưa xem chữ ký/, /has not looked at the signature/, true],
  };
  for (const [kind, [state, vi, en, again]] of Object.entries(cases)) {
    const viHtml = await strip({ update: state }, 'vi');
    const enHtml = await strip({ update: state }, 'en');
    assert.match(tag(viHtml, 'update-signature-note'), new RegExp(`data-signature="${kind}"`), kind);
    assert.match(text(viHtml, 'update-signature-note'), vi, `${kind} in Vietnamese`);
    assert.match(text(enHtml, 'update-signature-note'), en, `${kind} in English`);
    assert.ok(!has(viHtml, 'update-download'), `${kind}: no Download button`);
    assert.equal(has(viHtml, 'update-recheck'), again, `${kind}: ${again ? 'Check now is offered' : 'no button: it is not a thing a second look can change'}`);
    if (again) assert.equal(text(enHtml, 'update-recheck'), 'Check now');
    assert.doesNotMatch(enHtml, DIACRITICS, `${kind}: the English strip reads English`);
    assert.doesNotMatch(viHtml + enHtml, INSTALLING);
    assert.ok(has(viHtml, 'update-notes') && has(viHtml, 'update-copy'), `${kind}: the notes and the copy button stay: the owner can still go and get it himself`);
  }
});

test('Settings shows the signature, the size and the same controls as the strip', async () => {
  const en = await panel({ update: signed() }, 'en');
  assert.match(text(en, 'updates-signature'), /Valid \(key 1a2b3c4d\)/);
  assert.equal(text(en, 'updates-size'), '222 MB');
  assert.equal(text(en, 'updates-download'), 'Download (222 MB)');
  assert.doesNotMatch(en, INSTALLING);
  assert.doesNotMatch(en, DIACRITICS);
  const vi = await panel({ update: signed() }, 'vi');
  assert.match(text(vi, 'updates-signature'), /Hợp lệ \(khóa 1a2b3c4d\)/);
  assert.equal(text(vi, 'updates-download'), 'Tải về (222 MB)');
  const labels = { missing: ['Not signed yet', update({ signature: 'missing' })], invalid: ['Does not check', update({ signature: 'invalid' })], unknown_key: ['Signed with an unknown key', update({ signature: 'invalid', error: failure('update_signature_unknown_key') })],
    unreadable: ['Could not be read', update({ error: failure('update_signature_unreachable') })], unchecked: ['Not looked at in this session', update()] };
  for (const [kind, [label, state]] of Object.entries(labels)) {
    const html = await panel({ update: state }, 'en');
    assert.equal(text(html, 'updates-signature'), label, kind);
    assert.match(tag(html, 'updates-signature'), new RegExp(`data-signature="${kind}"`));
    assert.ok(has(html, 'updates-signature-note'), `${kind}: and the note that says what it means`);
    assert.ok(!has(html, 'updates-download'));
  }
  const running = await panel({ update: signed({ download: { state: 'downloading', version: '3.10.3', received: 50_000_000, total: 232753314 } }) }, 'en');
  assert.match(tag(running, 'updates-download-progress'), /aria-valuenow="21"/);
  assert.equal(text(running, 'updates-download-progress-text'), 'Downloading… 21% (48 MB of 222 MB)');
  assert.equal(text(running, 'updates-cancel'), 'Cancel');
  const ready = await panel({ update: signed({ download: { state: 'ready', version: '3.10.3', bytes: 232753314 } }) }, 'en');
  assert.equal(text(ready, 'updates-download-ready'), 'Downloaded and checked.');
  assert.match(text(ready, 'updates-download-ready-note'), /the desktop app checks the file and its signature again with its own code/);
  const failedPanel = await panel({ update: signed({ download: { state: 'failed', version: '3.10.3', code: 'update_download_disk_full' } }) }, 'en');
  assert.match(text(failedPanel, 'updates-download-error'), /not enough free space/);
  assert.ok(has(failedPanel, 'updates-download'));
  assert.ok(!has(await panel({ update: update({ available: false, latest: '3.10.2' }) }, 'en'), 'updates-signature'), 'nothing newer: nothing to say about a signature');
  assert.doesNotMatch(await panel({ update: signed() }, 'en'), /ChatMCP(?!\/releases|\/tag)/, 'the product is DatGold on this screen');
});

test('Download asks the Hub for that very release; Cancel asks it to stop; both are said in the words of the page, and a refusal is shown', async () => {
  for (const lang of ['vi', 'en']) {
    const words = translations[lang];
    for (const [component, name] of [[UpdateBanner, 'UpdateNotice'], [UpdatesSection, 'UpdatesPanel']]) {
      const elements = await look(component, {}, signed(), lang);
      const download = handlerOf(elements, name, 'onDownload');
      serve({ '/api/update/download': { update: signed({ download: { state: 'downloading', version: '3.10.3', received: 0, total: null } }), started: true } });
      globalThis.__chatmcpInvalidated.length = 0;
      await fire(download, '3.10.3');
      assert.deepEqual(asked(), ['POST /api/update/download {"version":"3.10.3"}'], `${lang} ${name}: the version the page showed, and nothing else`);
      assert.deepEqual(toasts, [[words.upd_toast_dl_started.replace('{version}', '3.10.3'), 'info']], `${lang} ${name}`);
      assert.ok(globalThis.__chatmcpInvalidated.some((filter) => JSON.stringify(filter?.queryKey) === '["hubState"]'), `${lang} ${name}: and the page looks at what the Hub says now`);
      // a second click that the Hub says started nothing is not announced as a start
      serve({ '/api/update/download': { update: signed({ download: { state: 'downloading', version: '3.10.3', received: 5, total: 10 } }), started: false } });
      await fire(download, '3.10.3');
      assert.deepEqual(toasts, [], `${lang} ${name}: nothing was started, so nothing is announced`);
      for (const [code, key] of [['update_download_unsigned', 'upd_dl_err_unsigned'], ['update_download_disk_full', 'upd_dl_err_disk'], ['update_download_platform', 'upd_dl_err_platform'], ['update_download_stale', 'upd_dl_err_stale'], ['update_download_unverified', 'upd_dl_err_network']]) {
        serve({ '/api/update/download': () => reply(409, { error: 'a diagnostic in English or Vietnamese', code }) });
        globalThis.__chatmcpInvalidated.length = 0;
        await fire(download, '3.10.3');
        assert.deepEqual(toasts, [[words[key], 'error']], `${lang} ${name}: ${code} is said in the words of the page`);
        assert.ok(globalThis.__chatmcpInvalidated.some((filter) => JSON.stringify(filter?.queryKey) === '["hubState"]'), `${lang} ${name}: and the page looks again`);
      }
      serve({ '/api/update/download': () => reply(502, { error: 'Something the page cannot know', code: 'something_new' }) });
      await fire(download, '3.10.3');
      assert.deepEqual(toasts, [['Something the page cannot know', 'error']], `${lang} ${name}: a code it has no words for is shown as the Hub said it`);

      const cancel = handlerOf(elements, name, 'onCancel');
      serve({ '/api/update/download-cancel': { update: signed(), cancelled: true } });
      await fire(cancel);
      assert.deepEqual(asked(), ['POST /api/update/download-cancel {}'], `${lang} ${name}`);
      assert.deepEqual(toasts, [[words.upd_toast_dl_cancelled, 'info']], `${lang} ${name}`);
      serve({ '/api/update/download-cancel': { update: signed(), cancelled: false } });
      await fire(cancel);
      assert.deepEqual(toasts, [], `${lang} ${name}: a cancel that stopped nothing says nothing`);
    }
  }
  const elements = await look(UpdateBanner, {}, update(), 'en');
  const again = handlerOf(elements, 'UpdateNotice', 'onCheck');
  serve({ '/api/update/check': { update: signed(), checked: true, throttled: false } });
  await fire(again);
  assert.deepEqual(asked(), ['POST /api/update/check {}'], 'the button that looks at the signature again is "Check now"');
});

test('the dictionary holds every word of the download in both languages, and none of them says more than the code does', () => {
  const keys = Object.keys(translations.vi).filter((key) => /^upd_(?:n_download|dl_|sig_|size_|err_signature|toast_dl_)/.test(key));
  assert.ok(keys.length >= 38, `${keys.length} keys`);
  for (const key of keys) {
    assert.ok(translations.en[key]?.trim(), `en.${key}`);
    assert.doesNotMatch(translations.en[key], DIACRITICS, `en.${key} reads English`);
    assert.doesNotMatch(translations.vi[key] + translations.en[key], /ChatMCP/, `${key} says DatGold`);
    assert.doesNotMatch(translations.en[key] + translations.vi[key], /\b(?:certified|tamper-proof|guarantee[sd]?|verified|secure[sd]?|authentic(?:ated|ity)?)\b/i, `${key}: no word that claims more than it does`);
  }
});

// The desktop shell can install the update (step 3), so what the page offers at "ready" depends on where it runs: outside the shell it says where the update can be installed; inside, there is a button,
// a confirm that says the app closes and opens again, and the reason when work is running. Every state is drawn here with both languages; the clicks are in the e2e test (ui/e2e/updates.spec.mjs).
const READY = signed({ download: { state: 'ready', version: '3.10.3', bytes: 232753314 } });
const IDLE_HUB = { agent: { activeTaskId: null, tasks: [] }, studio: null };
const BUSY_HUB = { agent: { activeTaskId: 'task-1', tasks: [] }, studio: null };
const install = (extra = {}) => ({ shell: true, hub: IDLE_HUB, phase: { phase: 'idle' }, onAsk: noop, onConfirm: noop, onBack: noop, onAgain: noop, ...extra });
/** The steps of the owner's click, about the release that READY holds. */
const ABOUT = '3.10.3';
/** Everything that can be pressed to install: the button and the two answers of the confirm. */
const PRESSABLE = /<button[^>]*data-testid="(?:update|updates)-apply(?:-yes|-no)?"/;

test('a download that is ready says so and what it is; in a plain browser it says where it can be installed and offers nothing to press', async () => {
  const en = await strip({ update: READY }, 'en');
  assert.equal(text(en, 'update-download-ready'), 'Downloaded and checked.');
  assert.match(text(en, 'update-download-ready-note'), /installer of DatGold 3\.10\.3 \(222 MB\) is in DatGold's update folder/);
  assert.match(text(en, 'update-download-ready-note'), /When the download finished, its size and SHA-256 matched the signed list of the release/, 'said of the moment it arrived, not of the file as it is now');
  assert.match(text(en, 'update-download-ready-note'), /the desktop app checks the file and its signature again with its own code/, 'and that the app that installs it does not take the Hub\'s word for it');
  assert.doesNotMatch(text(en, 'update-download-ready-note'), /not available in this version/);
  assert.ok(!has(en, 'update-download') && !has(en, 'update-cancel') && !has(en, 'update-download-progress'));
  assert.equal(text(en, 'update-apply-browser'), 'To install it, open the DatGold desktop app and press "Install and restart" there.', 'a plain browser has nothing to ask: it says where');
  assert.doesNotMatch(en, PRESSABLE, 'and no button');
  assert.doesNotMatch(en, DIACRITICS);
  const vi = await strip({ update: READY }, 'vi');
  assert.equal(text(vi, 'update-download-ready'), 'Đã tải xong và đã kiểm tra.');
  assert.match(text(vi, 'update-download-ready-note'), /ứng dụng trên máy tính kiểm tra lại tệp và chữ ký bằng mã của chính nó/);
  assert.match(text(vi, 'update-download-ready-note'), /Khi tải xong, dung lượng và mã SHA-256 của nó khớp/);
  assert.equal(text(vi, 'update-apply-browser'), 'Để cài bản này, hãy mở ứng dụng DatGold trên máy tính rồi bấm "Cài đặt và khởi động lại" ở đó.');
  assert.doesNotMatch(vi, PRESSABLE);
  assert.doesNotMatch(en + vi, /\b(?:certified|tamper-proof|guarantee|verified|secure|authentic)\b/i, 'no word that claims more than it does');
});

test('inside the desktop shell a download that is ready offers Install and restart, and holds it back, with the reason, while work runs', async () => {
  const en = await strip({ update: READY, install: install() }, 'en');
  assert.equal(text(en, 'update-apply'), 'Install and restart');
  assert.doesNotMatch(tag(en, 'update-apply'), /disabled=""/);
  for (const absent of ['update-apply-browser', 'update-apply-blocked', 'update-apply-confirm', 'update-apply-sending', 'update-apply-error']) assert.ok(!has(en, absent), `${absent} is not there`);
  assert.doesNotMatch(en, DIACRITICS);
  const vi = await strip({ update: READY, install: install() }, 'vi');
  assert.equal(text(vi, 'update-apply'), 'Cài đặt và khởi động lại');
  // work is running: the button is there, disabled, and the reason is next to it and tied to it for a screen reader
  const busy = await strip({ update: READY, install: install({ hub: BUSY_HUB }) }, 'en');
  assert.match(tag(busy, 'update-apply'), /disabled=""/, 'a task is running: the button waits');
  assert.match(tag(busy, 'update-apply'), /aria-describedby="update-apply-blocked"/, 'and says why to a screen reader');
  assert.match(text(busy, 'update-apply-blocked'), /Stop the running tasks first\. The installer will not close DatGold while a task, a terminal or a background worker is running\./);
  assert.match(text(await strip({ update: READY, install: install({ hub: BUSY_HUB }) }, 'vi'), 'update-apply-blocked'), /Hãy dừng các tác vụ đang chạy trước/);
  assert.match(tag(await strip({ update: READY, install: install({ hub: {} }) }), 'update-apply'), /disabled=""/, 'a state with no agent is not an idle Hub');
  assert.match(tag(await strip({ update: READY, install: install(), busy: true }), 'update-apply'), /disabled=""/, 'it waits while a request of the notice is out');
  // nothing else is ready: no install control for a download that is not
  for (const download of [{ state: 'idle' }, { state: 'downloading', version: '3.10.3', received: 1, total: 2 }, { state: 'verifying', version: '3.10.3' }, { state: 'failed', version: '3.10.3', code: 'update_download_hash' }]) {
    const html = await strip({ update: signed({ download }), install: install() }, 'en');
    assert.doesNotMatch(html, PRESSABLE, `no install control while the download is ${download.state}`);
    assert.ok(!has(html, 'update-apply-browser'), `and no sentence about where to install it (${download.state})`);
  }
});

test('the owner is asked once, in words that say the app closes and opens again, and can say not now', async () => {
  const en = await strip({ update: READY, install: install({ phase: { phase: 'confirm', version: ABOUT } }) }, 'en');
  assert.match(text(en, 'update-apply-confirm-text'), /^DatGold will close, install version 3\.10\.3 and open again\. Your settings and projects are stored outside the program files and are not replaced\.$/);
  assert.equal(text(en, 'update-apply-yes'), 'Close and install');
  assert.equal(text(en, 'update-apply-no'), 'Not now');
  assert.ok(!has(en, 'update-apply'), 'the first button gives way to the question');
  assert.match(tag(en, 'update-apply-confirm'), /role="group"/, 'a group a screen reader announces as one');
  assert.doesNotMatch(en, DIACRITICS);
  const vi = await strip({ update: READY, install: install({ phase: { phase: 'confirm', version: ABOUT } }) }, 'vi');
  assert.equal(text(vi, 'update-apply-confirm-text'), 'DatGold sẽ đóng lại, cài phiên bản 3.10.3 rồi mở lại. Cài đặt và dự án của bạn nằm ngoài các tệp chương trình nên không bị thay thế.');
  assert.equal(text(vi, 'update-apply-yes'), 'Đóng và cài đặt');
  assert.equal(text(vi, 'update-apply-no'), 'Để sau');
  assert.doesNotMatch(translations.en.upd_apply_confirm + translations.vi.upd_apply_confirm, /not changed|không bị thay đổi/, 'the question promises no more than the installer does: it replaces the program files and leaves the rest where it is');
  // a task that started while the owner was deciding takes the question back
  const taken = await strip({ update: READY, install: install({ phase: { phase: 'confirm', version: ABOUT }, hub: BUSY_HUB }) }, 'en');
  assert.ok(!has(taken, 'update-apply-confirm') && has(taken, 'update-apply-blocked'), 'a task started meanwhile: the question is withdrawn and the reason is shown');
  // a question about another release than the one that is ready is not put again
  const other = await strip({ update: READY, install: install({ phase: { phase: 'confirm', version: '3.10.2' } }) }, 'en');
  assert.ok(!has(other, 'update-apply-confirm') && has(other, 'update-apply'), 'a question about another release is not the question for this one: the button is offered');
});

test('while the shell is starting the update the page says so, and a refusal is said in words with the button back', async () => {
  const sending = await strip({ update: READY, install: install({ phase: { phase: 'sending', version: ABOUT } }) }, 'en');
  assert.equal(text(sending, 'update-apply-sending'), 'Starting the update…');
  assert.match(tag(sending, 'update-apply-sending'), /role="status"/);
  assert.doesNotMatch(sending, PRESSABLE, 'nothing to press twice');
  assert.equal(text(await strip({ update: READY, install: install({ phase: { phase: 'sending', version: ABOUT } }) }, 'vi'), 'update-apply-sending'), 'Đang bắt đầu cập nhật…');
  const says = {
    tasks_running: [/Tasks are still running\. Stop them and try again/, /Vẫn còn tác vụ đang chạy/], hub_unreachable: [/could not ask its background service/, /không hỏi được dịch vụ nền/],
    not_installed: [/was not made by the installer, so it cannot update itself/, /không do trình cài đặt tạo ra/], no_update: [/not there any more, or is not the one that was offered/, /không còn ở đó, hoặc không phải bản đã được đề nghị/],
    stale: [/not there any more, or is not the one that was offered/, /không còn ở đó/], ambiguous: [/not there any more/, /không còn ở đó/],
    bad_signature: [/could not confirm that the downloaded file is the release that was signed, so it did not run it/, /không xác nhận được tệp đã tải đúng là bản phát hành đã ký/],
    bad_installer: [/did not run it/, /không chạy nó/], bad_manifest: [/did not run it/, /không chạy nó/], staging_unsafe: [/did not run it/, /không chạy nó/],
    no_trusted_key: [/has no release key to check an update with yet/, /chưa có khóa phát hành nào/], not_newer: [/not newer than this version/, /không mới hơn phiên bản này/],
    busy: [/already being started/, /đang được bắt đầu/], launch_failed: [/installer could not be started\. Nothing was changed/, /Không khởi động được trình cài đặt/],
    no_answer: [/desktop app did not answer in time, so the page cannot tell whether the update has started\. If DatGold does not close in a moment, press Install and restart again/, /chưa trả lời kịp nên trang không biết cập nhật đã bắt đầu hay chưa/],
    something_new: [/The update was not started\. Nothing was changed/, /Chưa bắt đầu cập nhật được\. Chưa có gì/],
  };
  for (const [code, [en, vi]] of Object.entries(says)) {
    const phase = { phase: 'refused', version: ABOUT, code };
    const enHtml = await strip({ update: READY, install: install({ phase }) }, 'en');
    const viHtml = await strip({ update: READY, install: install({ phase }) }, 'vi');
    assert.match(text(enHtml, 'update-apply-error'), en, `${code} in English`);
    assert.match(text(viHtml, 'update-apply-error'), vi, `${code} in Vietnamese`);
    // an answer that never came is not "not started": the page does not know, and says so without the label
    if (code === 'no_answer') assert.doesNotMatch(text(enHtml, 'update-apply-error') + text(viHtml, 'update-apply-error'), /^The update was not started|Nothing was changed|Chưa có gì bị thay đổi|Chưa bắt đầu/, 'no_answer claims neither that nothing started nor that nothing changed');
    else assert.match(text(enHtml, 'update-apply-error'), /^The update was not started:/);
    assert.doesNotMatch(enHtml, DIACRITICS, `${code}: the English strip reads English`);
    assert.ok(has(enHtml, 'update-apply'), `${code}: and the button is back`);
    assert.doesNotMatch(enHtml, /text-danger|bg-danger|border-danger/, 'a refusal is not drawn as a danger');
    assert.doesNotMatch(tag(enHtml, 'update-apply-error'), /text-warning/, 'its words are in the colour of the text');
    assert.doesNotMatch(tag(enHtml, 'update-apply-error'), /role=/, 'in the strip the refusal is not a live region of its own: the strip around it is one');
  }
  // beside the reason: the button, a way to download it again where that can help (the advice of the words), and a way to put the refusal away
  for (const [code, offered] of [['no_update', true], ['stale', true], ['ambiguous', true], ['staging_unsafe', true], ['bad_signature', true], ['bad_manifest', true], ['bad_installer', true], ['tasks_running', false], ['hub_unreachable', false], ['no_trusted_key', false], ['not_newer', false], ['launch_failed', false], ['no_answer', false], ['something_new', false]]) {
    const phase = { phase: 'refused', version: ABOUT, code };
    const enHtml = await strip({ update: READY, install: install({ phase }) }, 'en');
    assert.equal(has(enHtml, 'update-apply-again'), offered, `${code}: "Download again" ${offered ? 'is' : 'is not'} offered`);
    assert.ok(has(enHtml, 'update-apply-dismiss'), `${code}: the refusal can be put away`);
    assert.ok(has(enHtml, 'update-apply'), `${code}: and the button is back`);
    if (offered) assert.match(text(enHtml, 'update-apply-error'), /Download it again\.$/, `${code}: the advice the words give is the button that is there`);
  }
  const refusedEn = await strip({ update: READY, install: install({ phase: { phase: 'refused', version: ABOUT, code: 'no_update' } }) }, 'en');
  const refusedVi = await strip({ update: READY, install: install({ phase: { phase: 'refused', version: ABOUT, code: 'no_update' } }) }, 'vi');
  assert.equal(text(refusedEn, 'update-apply-again'), 'Download again');
  assert.equal(text(refusedEn, 'update-apply-dismiss'), 'Dismiss');
  assert.equal(text(refusedVi, 'update-apply-again'), 'Tải lại');
  assert.equal(text(refusedVi, 'update-apply-dismiss'), 'Đóng');
  assert.match(text(refusedVi, 'update-apply-error'), /Hãy tải lại\.$/, 'the Vietnamese advice is the button that is there too');
  for (const id of ['update-apply-again', 'update-apply-dismiss']) assert.doesNotMatch(tag(refusedEn, id), /disabled=""/, `${id} is there to be pressed`);
  assert.match(tag(await strip({ update: READY, install: install({ phase: { phase: 'refused', version: ABOUT, code: 'no_update' } }), busy: true }, 'en'), 'update-apply-again'), /disabled=""/, 'a download again waits while a request of the notice is out');
  // a refusal about another release than the one that is ready is not shown
  const stale = await strip({ update: READY, install: install({ phase: { phase: 'refused', version: '3.10.2', code: 'no_update' } }) }, 'en');
  assert.ok(!has(stale, 'update-apply-error') && has(stale, 'update-apply'), 'a refusal about another release is not shown for this one');
});

test('Settings shows the same install controls as the strip', async () => {
  const browser = await panel({ update: READY }, 'en');
  assert.match(text(browser, 'updates-apply-browser'), /open the DatGold desktop app/);
  assert.doesNotMatch(browser, /<button[^>]*data-testid="updates-apply/);
  const shell = await panel({ update: READY, install: install() }, 'en');
  assert.equal(text(shell, 'updates-apply'), 'Install and restart');
  assert.match(tag(await panel({ update: READY, install: install({ hub: BUSY_HUB }) }, 'en'), 'updates-apply'), /disabled=""/);
  assert.match(text(await panel({ update: READY, install: install({ hub: BUSY_HUB }) }, 'en'), 'updates-apply-blocked'), /Stop the running tasks first/);
  const confirm = await panel({ update: READY, install: install({ phase: { phase: 'confirm', version: ABOUT } }) }, 'vi');
  assert.match(text(confirm, 'updates-apply-confirm-text'), /DatGold sẽ đóng lại, cài phiên bản 3\.10\.3 rồi mở lại/);
  assert.equal(text(confirm, 'updates-apply-yes'), 'Đóng và cài đặt');
  const refused = await panel({ update: READY, install: install({ phase: { phase: 'refused', version: ABOUT, code: 'bad_signature' } }) }, 'en');
  assert.match(text(refused, 'updates-apply-error'), /did not run it/);
  assert.ok(has(refused, 'updates-apply-again') && has(refused, 'updates-apply-dismiss') && has(refused, 'updates-apply'), 'with the same three buttons as the strip');
  assert.equal(text(await panel({ update: READY, install: install({ phase: { phase: 'sending', version: ABOUT } }) }, 'en'), 'updates-apply-sending'), 'Starting the update…');
});

test('in Settings the wait and a refusal are announced by a live region that is there before the words are (a region inserted already holding its words is not announced by every screen reader)', async () => {
  const idle = await panel({ update: READY, install: install() }, 'en');
  assert.match(tag(idle, 'updates-apply-live'), /role="status"/, 'a status region');
  assert.match(tag(idle, 'updates-apply-live'), /aria-atomic="true"/, 'read whole');
  assert.match(tag(idle, 'updates-apply-live'), /class="sr-only"/, 'for a screen reader only: the words are drawn where they belong');
  assert.equal(text(idle, 'updates-apply-live'), '', 'it is there while there is nothing to say');
  for (const phase of [{ phase: 'confirm', version: ABOUT }]) assert.equal(text(await panel({ update: READY, install: install({ phase }) }, 'en'), 'updates-apply-live'), '', 'and stays empty for the question (the group is announced as one)');
  assert.equal(text(await panel({ update: READY, install: install({ hub: BUSY_HUB }) }, 'en'), 'updates-apply-live'), '', 'and for the button that is held back');
  const waiting = await panel({ update: READY, install: install({ phase: { phase: 'sending', version: ABOUT } }) }, 'en');
  assert.equal(text(waiting, 'updates-apply-live'), 'Starting the update…', 'while the shell starts the update it says so');
  assert.doesNotMatch(tag(waiting, 'updates-apply-sending'), /role=/, 'and the visible words are not a second region');
  const refused = await panel({ update: READY, install: install({ phase: { phase: 'refused', version: ABOUT, code: 'bad_signature' } }) }, 'en');
  assert.equal(text(refused, 'updates-apply-live'), text(refused, 'updates-apply-error'), 'for a refusal it holds the very words that are drawn');
  assert.match(text(refused, 'updates-apply-live'), /did not run it/);
  assert.doesNotMatch(tag(refused, 'updates-apply-error'), /role=/, 'which are not a second region either');
  const noAnswer = await panel({ update: READY, install: install({ phase: { phase: 'refused', version: ABOUT, code: 'no_answer' } }) }, 'vi');
  assert.equal(text(noAnswer, 'updates-apply-live'), text(noAnswer, 'updates-apply-error'), 'in both languages');
  // the strip is a live region itself: nothing is added to it
  assert.ok(!has(await strip({ update: READY, install: install({ phase: { phase: 'refused', version: ABOUT, code: 'bad_signature' } }) }, 'en'), 'update-apply-live'), 'no second region in the strip');
  assert.ok(!has(await panel({ update: READY }, 'en'), 'updates-apply-live') || text(await panel({ update: READY }, 'en'), 'updates-apply-live') === '', 'and nothing to announce outside the shell');
});

// ---- what the last update left -------------------------------------------------------------------------------------------------------------------

const applied = (overrides = {}) => ({ ok: true, version: '3.10.3', previous: '3.10.2', state: 'installed', reason: null, rolledBack: false, ...overrides });
const afterUpdate = (extra = {}) => update({ current: '3.10.3', latest: '3.10.3', available: false, applied: applied(), ...extra });
const notice = (props, lang = 'vi') => renderWith(AppliedNotice, { update: afterUpdate(), onDismiss: noop, lang, ...props }, [], [], { lang });

test('after an update the page says which version it updated to, with its notes, once, and it can be dismissed', async () => {
  const en = await notice({}, 'en');
  assert.match(tag(en, 'update-applied'), /data-kind="updated"/);
  assert.match(tag(en, 'update-applied'), /data-version="3\.10\.3"/);
  assert.match(tag(en, 'update-applied'), /role="status"/);
  assert.equal(text(en, 'update-applied-text'), 'Updated to DatGold 3.10.3.');
  const link = tag(en, 'update-applied-notes');
  assert.match(link, /href="https:\/\/github\.com\/pddczpl\/ChatMCP\/releases\/tag\/v3\.10\.3"/, 'the notes of that release, built by the page from the version');
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.equal(text(en, 'update-applied-notes'), "What's new");
  assert.ok(has(en, 'update-applied-copy'), 'with the copy button as well, as the notice has');
  assert.equal(text(en, 'update-applied-dismiss'), 'Dismiss');
  assert.doesNotMatch(en, DIACRITICS);
  const vi = await notice({}, 'vi');
  assert.equal(text(vi, 'update-applied-text'), 'Đã cập nhật lên DatGold 3.10.3.');
  assert.equal(text(vi, 'update-applied-notes'), 'Có gì mới');
  assert.equal(text(vi, 'update-applied-dismiss'), 'Đóng');
  assert.match(tag(await notice({ busy: true }), 'update-applied-dismiss'), /disabled=""/, 'it waits while a request is out');
});

test('an update that did not go through says why, in the words of the page, and which version still runs', async () => {
  const failed = (reason, state = 'unchanged') => afterUpdate({ current: '3.10.2', latest: '3.10.4', available: true, applied: applied({ ok: false, version: '3.10.4', previous: '3.10.2', state, reason, rolledBack: state === 'rolled_back' }) });
  const reasons = {
    shell_not_exited: [/DatGold did not close in time/, /DatGold không đóng kịp/], no_installation: [/installed DatGold could not be found/, /Không tìm thấy DatGold đã cài/], not_newer: [/installer was not newer/, /Bộ cài không mới hơn/],
    disk_full: [/not enough free disk space/, /không đủ chỗ trống/], pending_recovery: [/earlier update had not finished/, /Lần cập nhật trước chưa xong/], tasks_running: [/Tasks were still running/, /Vẫn còn tác vụ đang chạy/],
    foreign_listener: [/Another program was using the port DatGold needs \(3007\)/, /Một chương trình khác đang dùng cổng/], hub_stop_failed: [/background service could not be stopped/, /Không dừng được dịch vụ nền/],
    window_open: [/window could not be closed/, /Không đóng được một cửa sổ/], another_update: [/Another installation or update was running/, /Một lần cài đặt hoặc cập nhật khác/], payload_invalid: [/installer was damaged/, /Bộ cài bị hỏng/],
    install_failed: [/files could not be replaced/, /Không thay được các tệp/],
  };
  for (const [reason, [en, vi]] of Object.entries(reasons)) {
    const enHtml = await notice({ update: failed(reason) }, 'en');
    const viHtml = await notice({ update: failed(reason) }, 'vi');
    assert.match(tag(enHtml, 'update-applied'), /data-kind="not_updated"/, reason);
    assert.match(text(enHtml, 'update-applied-text'), /^The update to DatGold 3\.10\.4 did not go through\. /, reason);
    assert.match(text(enHtml, 'update-applied-text'), en, `${reason} in English`);
    assert.match(text(viHtml, 'update-applied-text'), vi, `${reason} in Vietnamese`);
    assert.match(text(enHtml, 'update-applied-text'), /DatGold 3\.10\.2 is still the version that runs\.$/, `${reason}: and which version still runs`);
    assert.doesNotMatch(enHtml, DIACRITICS, `${reason}: the English strip reads English`);
    assert.doesNotMatch(enHtml, /text-danger|bg-danger|border-danger/, 'not drawn as a danger');
    assert.ok(has(enHtml, 'update-applied-dismiss'), reason);
  }
  assert.match(text(await notice({ update: failed('install_failed', 'rolled_back') }, 'en'), 'update-applied-text'), /The files that had been replaced were put back\./);
  // An installation that stopped halfway needs repair, and the launcher starts no Hub behind the marker of the unfinished update (a Hub started by hand does, and leaves the result file alone while the marker is
  // there: lib/update-applied.mjs): the page can say anything only once a Hub has read the note after the installation was repaired, by the setup (its window, its wizard or its repair form) or by hand. So the
  // words are about what happened (it had to be repaired from its backup: the files it had changed were put back), not "DatGold will not start" or "keep the backup", and the version that runs is named as for any refusal.
  const recovery = text(await notice({ update: failed('install_failed', 'needs_recovery') }, 'en'), 'update-applied-text');
  assert.equal(recovery, 'The update to DatGold 3.10.4 did not go through. The files could not be replaced. DatGold 3.10.2 is still the version that runs. That update stopped halfway and DatGold had to be repaired from its backup: the files it had changed were put back. If anything does not work as it should, run DatGoldSetup.exe again.');
  assert.doesNotMatch(recovery, /by hand/, 'it no longer says "by hand": the setup repairs it, and a person who did it by hand gets the same true sentence');
  assert.doesNotMatch(recovery, /blocking DatGold|will not start|Keep the backup/, 'the app is running when this is drawn: it is not blocked, and there is no backup left to keep');
  const earlierUpdate = text(await notice({ update: failed('pending_recovery', 'needs_recovery') }, 'en'), 'update-applied-text');
  assert.equal(earlierUpdate, 'The update to DatGold 3.10.4 did not go through. An earlier update had not finished, so this one was not started. DatGold 3.10.2 is still the version that runs.', 'an earlier update that was found unfinished: the update that was refused did nothing, and that is all there is to say');
  assert.equal(text(await notice({ update: failed('install_failed', 'needs_recovery') }, 'vi'), 'update-applied-text'), 'Lần cập nhật lên DatGold 3.10.4 không xong. Không thay được các tệp. DatGold 3.10.2 vẫn là phiên bản đang chạy. Lần cập nhật đó dừng giữa chừng và DatGold đã phải được sửa từ bản sao lưu: các tệp mà nó đã thay đổi đã được trả về như cũ. Nếu có gì không hoạt động đúng, hãy chạy lại DatGoldSetup.exe.');
  // what the setup leaves when it repaired the marker of an EARLIER update at the person's click: the update that was refused did nothing, and the files of the earlier one were put back
  assert.equal(text(await notice({ update: failed('pending_recovery', 'rolled_back') }, 'en'), 'update-applied-text'), 'The update to DatGold 3.10.4 did not go through. An earlier update had not finished, so this one was not started. DatGold 3.10.2 is still the version that runs. The files that had been replaced were put back.', 'a repaired earlier update: said as what it is');
  assert.equal(text(await notice({ update: failed('pending_recovery', 'rolled_back') }, 'vi'), 'update-applied-text'), 'Lần cập nhật lên DatGold 3.10.4 không xong. Lần cập nhật trước chưa xong nên lần này không được bắt đầu. DatGold 3.10.2 vẫn là phiên bản đang chạy. Các tệp đã bị thay đã được trả về như cũ.');
  assert.equal(text(await notice({ update: failed('pending_recovery', 'needs_recovery') }, 'vi'), 'update-applied-text'), 'Lần cập nhật lên DatGold 3.10.4 không xong. Lần cập nhật trước chưa xong nên lần này không được bắt đầu. DatGold 3.10.2 vẫn là phiên bản đang chạy.');
  assert.match(text(await notice({ update: failed('install_failed', 'rolled_back') }, 'vi'), 'update-applied-text'), /Các tệp đã bị thay đã được trả về như cũ/);
  assert.doesNotMatch(text(await notice({ update: failed('tasks_running') }, 'en'), 'update-applied-text'), /put back|halfway/, 'a refusal that touched nothing does not say that anything was put back');
  const withPath = await notice({ update: afterUpdate({ applied: applied({ ok: false, version: '3.10.4', state: 'unchanged', reason: 'C:\\Users\\Test User\\secret\\log.txt' }) }) }, 'en');
  assert.doesNotMatch(withPath, /Test User|secret|log\.txt/, 'a path in the reason is never drawn');
});

test('nothing is drawn when the last update left nothing, or left something that is not a result', async () => {
  for (const none of [undefined, null, 5, 'updated', [], {}, { ok: 'yes', version: '3.10.3' }, applied({ version: '3.10.3-rc.1' }), applied({ version: '../x' }), applied({ state: 'exploded' })]) {
    const html = await notice({ update: update({ applied: none }) }, 'en');
    assert.equal(html, '', `nothing for ${JSON.stringify(none)}`);
  }
  assert.equal(await notice({ update: null }, 'en'), '');
  assert.equal(await notice({ update: undefined }, 'en'), '');
});

test('the applied strip asks the Hub to forget it when it is dismissed, and nothing else', async () => {
  const elements = await look(UpdateBanner, {}, afterUpdate(), 'en');
  const dismiss = handlerOf(elements, 'AppliedNotice', 'onDismiss');
  serve({ '/api/update/applied-dismiss': { update: update({ current: '3.10.3', available: false, latest: '3.10.3', applied: null }) } });
  await fire(dismiss);
  assert.deepEqual(asked(), ['POST /api/update/applied-dismiss {}'], 'one empty POST');
  assert.ok(globalThis.__chatmcpInvalidated.some((filter) => JSON.stringify(filter?.queryKey) === '["hubState"]'), 'and the page looks at what the Hub says now');
  serve({ '/api/update/applied-dismiss': () => reply(503, { error: 'Kiểm tra bản cập nhật chưa khởi tạo.', code: 'update_unavailable' }) });
  await fire(dismiss);
  assert.deepEqual(toasts, [[translations.en.upd_refused_unavailable, 'error']], 'a refusal is told in the words of the page');
});

const installOf = (elements, name) => {
  const found = elements.find((element) => typeof element.type === 'function' && element.type.name === name && element.props.install && typeof element.props.install === 'object');
  assert.ok(found, `no ${name} was given an install`);
  return found.props.install;
};
const hubWith = (agent) => ({ agent, studio: null });

async function lookAtTheQuestion(state, lang, hubExtra) {
  globalThis.__chatmcpJsx = [];
  await atTheQuestion.loaded.renderWith(atTheQuestion.loaded.UpdateBanner, {}, [[['hubState'], { update: state, ...hubExtra }]], [], { lang, showToast });
  return globalThis.__chatmcpJsx.slice();
}

test('the container hands the notice the shell, the Hub\'s state and the steps of the click; inside the shell Confirm sends the one message, for the release that was asked about, and nothing else', async () => {
  serve();
  const posted = [];
  const listeners = new Set();
  const host = { postMessage: (message) => posted.push(message), addEventListener: (type, listener) => listeners.add(listener), removeEventListener: (type, listener) => listeners.delete(listener) };
  // outside the shell: no host
  const outside = installOf(await look(UpdateBanner, {}, READY, 'en', {}, hubWith({ activeTaskId: null })), 'UpdateNotice');
  assert.equal(outside.shell, false, 'a plain browser has no window.chrome.webview');
  assert.deepEqual(outside.phase, { phase: 'idle' });
  globalThis.chrome = { webview: host };
  try {
    const idle = hubWith({ activeTaskId: null, tasks: [] });
    const elements = await look(UpdateBanner, {}, READY, 'en', {}, idle);
    const inside = installOf(elements, 'UpdateNotice');
    assert.equal(inside.shell, true, 'inside the shell');
    assert.deepEqual(inside.hub, { update: READY, ...idle }, 'the page hands over the whole state of the Hub, which holds the work the rule looks at');
    assert.equal(posted.length, 0, 'rendering and asking send nothing');
    inside.onAsk(ABOUT); inside.onBack();
    assert.equal(posted.length, 0, 'asking the question, and not now, send nothing');
    await inside.onConfirm(ABOUT);
    assert.equal(posted.length, 0, 'a confirm with no question before it sends nothing: the owner was not asked');
    const settings = installOf(await look(UpdatesSection, {}, READY, 'en', {}, idle), 'UpdatesPanel');
    assert.equal(settings.shell, true, 'Settings is given the same');
    // at the question: a confirm for another release than the one asked about sends nothing
    const question = installOf(await lookAtTheQuestion(READY, 'en', idle), 'UpdateNotice');
    assert.deepEqual(question.phase, { phase: 'confirm', version: ABOUT }, 'premise: this banner is at the question about 3.10.3');
    await question.onConfirm('3.10.4');
    assert.equal(posted.length, 0, 'a confirm for another release than the question was about sends nothing');
    // Confirm: one message, {type, id}, the listener in place first
    const confirming = question.onConfirm(ABOUT);
    assert.equal(posted.length, 1);
    assert.deepEqual(Object.keys(posted[0]).sort(), ['id', 'type']);
    assert.equal(posted[0].type, 'chatmcp.apply-update');
    assert.match(posted[0].id, /^[a-fA-F0-9-]{16,64}$/);
    assert.equal(listeners.size, 1, 'and it waits for the answer');
    for (const listener of listeners) listener({ data: { type: 'chatmcp.update-result', id: posted[0].id, ok: false, code: 'tasks_running' } });
    await confirming;
    assert.equal(listeners.size, 0, 'the answer ends the wait');
    assert.deepEqual(asked(), [], 'the page itself asks the Hub for nothing to install: that is the shell\'s business');
  } finally { delete globalThis.chrome; }
});

test('the dictionary holds every word of the install control and of the hand-over in both languages, and none of them says more than the code does', () => {
  const keys = Object.keys(translations.vi).filter((key) => /^upd_(?:apply|applied)_/.test(key));
  assert.ok(keys.length >= 38, `${keys.length} keys`);
  for (const key of keys) {
    assert.ok(translations.en[key]?.trim(), `en.${key}`);
    assert.doesNotMatch(translations.en[key], DIACRITICS, `en.${key} reads English`);
    assert.doesNotMatch(translations.vi[key] + translations.en[key], /ChatMCP/, `${key} says DatGold`);
    assert.doesNotMatch(translations.en[key] + translations.vi[key], /\b(?:certified|tamper-proof|guarantee[sd]?|verified|secure[sd]?|authentic(?:ated|ity)?)\b/i, `${key}: no word that claims more than it does`);
  }
  for (const reason of ['shell_not_exited', 'no_installation', 'not_newer', 'disk_full', 'pending_recovery', 'tasks_running', 'foreign_listener', 'hub_stop_failed', 'window_open', 'another_update', 'payload_invalid', 'install_failed'])
    assert.ok(translations.vi[`upd_applied_reason_${reason}`] && translations.en[`upd_applied_reason_${reason}`], `words for the reason ${reason}`);
  for (const group of ['tasks', 'hub', 'portable', 'missing', 'unproven', 'nokey', 'older', 'busy', 'launch', 'no_answer', 'other'])
    assert.ok(translations.vi[`upd_apply_err_${group}`] && translations.en[`upd_apply_err_${group}`], `words for the refusal ${group}`);
  // the sentences that used to say the app installs nothing say what is true now
  const old = {
    upd_desc: ['it does not install or run anything.', 'nó không cài và không chạy gì.'], upd_point_only: ['DatGold does not install or run it.', 'DatGold không cài và không chạy bộ cài đó.'],
    upd_dl_desc: ['It does not install or run the installer.', 'Nó không cài và không chạy bộ cài.'], upd_dl_ready_note: ['Installing it from the app is not available in this version.', 'Cài đặt từ trong ứng dụng chưa có ở phiên bản này.'],
  };
  for (const [key, [en, vi]] of Object.entries(old)) {
    assert.ok(!translations.en[key].includes(en), `en.${key} no longer says: ${en}`);
    assert.ok(!translations.vi[key].includes(vi), `vi.${key} no longer says: ${vi}`);
  }
  assert.match(translations.en.upd_q_body, /nothing is installed unless you press Install and restart/);
  assert.match(translations.vi.upd_q_body, /không cài gì trừ khi bạn bấm Cài đặt và khởi động lại/);
  assert.match(translations.en.upd_point_only, /Downloading installs nothing: the installer runs only when you press Install and restart in the desktop app/);
  assert.match(translations.vi.upd_point_only, /Tải về không cài gì: bộ cài chỉ chạy khi bạn bấm Cài đặt và khởi động lại trong ứng dụng trên máy tính/);
});
