import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The real components of the update notice, rendered for each state and clicked: the strip under the header (the question that is asked once, and the release on offer with "What's new"
// and "Skip this version") and Settings → Cập nhật / Updates (versions, last check, "Check now", the owner's choice). What is pinned is what a person reads, in both languages, what
// the link may be, and what each button asks of the Hub. The Hub's answers are made up by the test; the components, React Query and the store are the real ones.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { UpdateBanner, UpdateNotice } from './src/components/layout/UpdateBanner';
  import { UpdatesSection, UpdatesPanel } from './src/components/settings/UpdatesSection';
  import { translations } from './src/lib/i18n';
  export { useAppStore, UpdateBanner, UpdateNotice, UpdatesSection, UpdatesPanel, translations };
`, 'chatmcp-updates-components-', { recordJsx: true });
after(dispose);
const { renderWith, useAppStore, UpdateBanner, UpdateNotice, UpdatesSection, UpdatesPanel, translations } = loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const update = (overrides = {}) => ({
  current: '3.10.2', latest: '3.10.3', available: true, checkedAt: '2026-10-26T12:00:00.000Z', lastAttemptAt: '2026-10-26T12:00:00.000Z',
  notesUrl: 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3', installerName: 'DatGoldSetup.exe', skippedVersion: null, error: null, checking: false,
  manualCheckAfter: '2026-10-26T12:01:00.000Z', nextAutomaticCheckAt: null, autoCheck: { enabled: true, saved: true, needsChoice: false }, ...overrides,
});
const asking = (overrides = {}) => update({ autoCheck: { enabled: false, saved: null, needsChoice: true }, ...overrides });
const failure = (code, status = null) => ({ code, message: 'diagnostic in English that is never shown as it is', status, at: '2026-10-26T12:05:00.000Z' });
const NOW = Date.parse('2026-10-26T12:30:00.000Z'); // long after the minute of the state above
const noop = () => {};

// the language is given to the component and to the store: CopyButton, which the panel shares with the rest of the page, reads the store's
const strip = (props, lang = 'vi') => renderWith(UpdateNotice, { update: update(), onAnswer: noop, onSkip: noop, onDetails: noop, lang, ...props }, [], [], { lang });
const panel = (props, lang = 'vi') => renderWith(UpdatesPanel, { update: update(), now: NOW, onCheck: noop, onSkip: noop, onToggle: noop, lang, ...props }, [], [], { lang });
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
  assert.match(text(vi, 'update-question-body'), /không tải gì về và không cài gì/, 'and that this only tells');
  assert.equal(text(vi, 'update-yes'), 'Có, kiểm tra');
  assert.equal(text(vi, 'update-no'), 'Không');
  assert.equal(text(vi, 'update-details'), 'Chi tiết');
  assert.ok(!has(vi, 'update-notice') && !has(vi, 'update-notes') && !has(vi, 'update-copy') && !has(vi, 'update-skip'), 'and nothing of the other strip');
  assert.doesNotMatch(vi, PROOF_LOOK);
  const en = await strip({ update: asking() }, 'en');
  assert.equal(text(en, 'update-yes'), 'Yes, check');
  assert.equal(text(en, 'update-no'), 'No');
  assert.match(text(en, 'update-question-body'), /GitHub sees your IP address and the line "DatGold\/3\.10\.2"/);
  assert.match(text(en, 'update-question-body'), /nothing is downloaded and nothing is installed/);
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
  assert.match(points, /short chain of GET requests/, 'a check is not one request');
  assert.match(points, /starts at github\.com/);
  assert.match(points, /release-assets\.githubusercontent\.com/, 'the file server of GitHub is named: it is the host a firewall rule has to allow');
  assert.match(points, /DatGold\/3\.10\.2/);
  const pointsVi = await panel({ update: update() }, 'vi');
  assert.match(pointsVi, /chuỗi ngắn các yêu cầu GET/);
  assert.match(pointsVi, /release-assets\.githubusercontent\.com/);
  assert.match(points, /never more often than every 15 minutes/);
  assert.match(points, /download the installer from the releases page yourself and compare its SHA-256/);
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
async function look(component, props, state, lang = 'vi', store = {}) {
  globalThis.__chatmcpJsx = [];
  await renderWith(component, props, [[['hubState'], { update: state }]], [], { lang, showToast, ...store });
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
