import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, all, accessibleName, duplicateIds, unnamedControls, brokenReferences } from './support/html.mjs';

// The header of a conversation: the ribbon above it (PhaseRibbon: its title, its state, what the Hub counted) and the banner in it when a
// conversation stopped without a normal answer (StateBanner). Their Vietnamese is what the screen said before their words moved into the dictionary
// (ui/tests/conversation-components.test.mjs and the e2e match some of it), so these tests pin that text; their English is dictionary text, so on
// the English screen nothing they write may read Vietnamese. What the Hub itself wrote (an error message, a note) is shown as written in both.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { StateBanner } from './src/components/conversation/StateBanner';
  import * as ribbon from './src/components/layout/PhaseRibbon';
  import { taskStateLabel } from './src/lib/task-view';
  import { translations, translate } from './src/lib/i18n';
  import { formatTime, formatNumber } from './src/lib/format';
  export { StateBanner, ribbon, taskStateLabel, translations, translate, formatTime, formatNumber };
`, 'chatmcp-banner-ribbon-');
after(dispose);
const { renderWith, StateBanner, ribbon, taskStateLabel, translations, translate, formatTime, formatNumber } = loaded;
const { PhaseRibbon, ribbonRows } = ribbon;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
/** A dictionary key printed instead of its text. Nothing a fixture below says looks like one. */
const RAW_KEY = /\b(?:agent|agents|group|coding)_[a-z_]+\b/;

/** Every state of lib/task-view.ts, and the one a state the Hub has no word for becomes. */
const STATES = ['created', 'queued', 'blocked', 'planning', 'running', 'waiting_approval', 'verifying', 'paused', 'completed', 'failed', 'cancelled', 'uncertain', 'unknown'];
const RESTING = ['created', 'blocked', 'paused', 'failed', 'cancelled', 'uncertain', 'unknown'];
const ACTIVE = ['queued', 'planning', 'running', 'waiting_approval', 'verifying'];

const STARTED = '2026-10-20T10:00:00Z', FINISHED = '2026-10-20T10:03:05Z';
const task = (status, extra = {}) => ({
  id: 'task-1', status, messages: [], task: 'Fix the login page', startedAt: STARTED, finishedAt: FINISHED,
  usage: { httpRequests: 3, inputTokens: 12345, outputTokens: 678, inputUsageReported: 3, outputUsageReported: 3 }, ...extra,
});
/** A task with something to say in every row of the details: counts, a window the Hub does not know, a partial cost, a requirement and a check still open. */
const everything = (extra = {}) => task('completed', {
  usage: { httpRequests: 4, inputTokens: 12345, outputTokens: 678, cachedInputTokens: 900, cacheWriteTokens: 50, reasoningTokens: 120, inputUsageReported: 3, inputUsageMissing: 1, outputUsageReported: 4, outputUsageMissing: 0 },
  contextPolicy: { source: 'conservative_fallback', capacityTokens: 32768, maxHistoryTokens: 20000, compactAtTokens: 16000, reservedOutputTokens: 8000, plannedOutputTokens: 4000, approximate: true },
  modelCost: { schema: 1, knownSubtotalUsd: 0.0123, pricedResponses: 2, unpricedResponses: 1, unknownResponses: 0, totalUsd: null, complete: false },
  completionOutcome: { execution: 'done', requirements: 'unverified', verification: 'none', unresolvedObjectiveIds: ['o1', 'o2'], missingChecks: [], note: 'Nothing checked the requirement.' },
  verificationOutcome: { ready: false, missing: ['run the tests', 'read the diff'] },
  ...extra,
});

const markup = (Component, props, lang) => renderWith(Component, props, [], [], { lang });
const banner = (props, lang = 'en') => markup(StateBanner, props, lang);
const bannerPage = async (props, lang = 'vi') => parseHtml(await banner(props, lang));
const ribbonPage = async (value, lang = 'vi', props = {}) => parseHtml(await markup(PhaseRibbon, { task: value, ...props }, lang));
const t = (lang) => (key, params) => translate(lang, key, params);
const fmt = (lang) => (value) => formatNumber(value, lang);
const buttonNamed = (root, name) => byTag(root, 'button').find((node) => accessibleName(root, node) === name);

// ---- Vietnamese: what the screen said before ----

const BANNER_VI = {
  uncertain: 'Kiểm tra thay đổi trước khi tiếp tục: một thao tác có thể đã chạy nhưng chưa có kết quả.',
  cancelled: 'Việc dừng không hoàn tác những thay đổi đã thực hiện.',
  paused: 'Gửi chỉ dẫn mới hoặc tiếp tục cùng cuộc hội thoại.',
  failed: 'Xem nhật ký để biết chi tiết.', created: 'Xem nhật ký để biết chi tiết.', blocked: 'Xem nhật ký để biết chi tiết.', unknown: 'Xem nhật ký để biết chi tiết.',
};

test('in Vietnamese the banner says what it said before its words moved into the dictionary', async () => {
  for (const status of RESTING) {
    const sentence = BANNER_VI[status];
    const retry = status === 'failed';
    const resumable = ['paused', 'cancelled', 'uncertain', 'failed'].includes(status);
    const root = await bannerPage({ status, onResume() {}, onRetry() {} });
    // title, then the sentence, then the one next step (a state that cannot be continued has none)
    assert.equal(root.text, `${taskStateLabel(status)}${sentence}${resumable ? (retry ? 'Thử lại' : 'Tiếp tục') : ''}`, status);
    assert.equal(byTag(root, 'button').length, resumable ? 1 : 0, `${status}: the next step`);
  }
  assert.equal(taskStateLabel('cancelled'), 'Đã dừng', 'the title is the old word for the state');
});

test('in Vietnamese the banner shows what the Hub wrote instead of its own sentence, offers nothing when there is no handler, and shows nothing for a running or finished task', async () => {
  const root = await bannerPage({ status: 'failed', message: 'Model API error 429: slow down', onRetry() {} });
  assert.ok(root.text.includes('Model API error 429: slow down') && !root.text.includes('Xem nhật ký'), 'the Hub’s account replaces the generic sentence');
  assert.equal(byTag(await bannerPage({ status: 'paused' }), 'button').length, 0, 'no handler, no button');
  assert.equal(byTag(await bannerPage({ status: 'failed', onResume() {} }), 'button').length, 0, 'a failed task is retried, not resumed');
  for (const status of ['completed', ...ACTIVE, undefined, '']) assert.equal(await markup(StateBanner, { status, onResume() {}, onRetry() {} }, 'vi'), '', `${status}: nothing`);
});

test('in Vietnamese the ribbon says what it said before: the title, the state, the facts of the run and Stop', async () => {
  const when = formatTime(STARTED, 'vi');
  const running = await ribbonPage(task('running', { finishedAt: undefined }), 'vi', { onCancel() {} });
  assert.equal(running.text, `Fix the login pageĐang thực hiệnBắt đầu ${when} · 3 yêu cầu model · vào 12k · ra 678 tokenChi tiếtDừng agent`, 'a running task: no duration yet, Stop at the end');
  const done = await ribbonPage(task('completed'), 'vi', { onCancel() {} });
  assert.equal(done.text, `Fix the login pageĐã nhận phản hồi kết thúcBắt đầu ${when} · 3 m 05 s · 3 yêu cầu model · vào 12k · ra 678 tokenChi tiết`, 'a finished one: Stop is gone');
  for (const status of STATES) assert.ok((await ribbonPage(task(status), 'vi')).text.includes(taskStateLabel(status)), `${status}: ${taskStateLabel(status)}`);
  assert.ok((await ribbonPage(task('failed', { task: '', prompt: '', messages: [], usage: undefined }), 'vi')).text.startsWith('Cuộc hội thoại'), 'a conversation with no text is called “Cuộc hội thoại”');
  const toggle = buttonNamed(done, 'Chi tiết');
  assert.ok(toggle && toggle.attrs['aria-expanded'] === 'false', 'the facts are one click away, not on screen');
  assert.equal(buttonNamed(await ribbonPage(task('completed', { usage: undefined })), 'Chi tiết'), undefined, 'nothing to show, no toggle');
  // a count the provider did not (fully) report is "+" or "không có" in the line, never a quiet number
  const partial = await ribbonPage(task('completed', { startedAt: undefined, finishedAt: undefined, usage: { httpRequests: 2, inputTokens: 100, inputUsageReported: 1, inputUsageMissing: 1, outputUsageMissing: 2, outputUsageReported: 0 } }));
  assert.equal(partial.text, 'Fix the login pageĐã nhận phản hồi kết thúc2 yêu cầu model · vào 100+ · ra không có tokenChi tiết');
});

test('in Vietnamese the details say what they said before', () => {
  const n = fmt('vi');
  assert.deepEqual(ribbonRows(everything(), t('vi'), 'vi'), [
    ['Yêu cầu HTTP tới model', '4'],
    ['Token đầu vào (nhà cung cấp báo)', `${n(12345)} (+ chưa rõ)`, 'Chỉ tính token do nhà cung cấp báo. Thiếu báo cáo là chưa rõ, không phải bằng 0.'],
    ['Token đầu ra (nhà cung cấp báo)', n(678)],
    ['Cache đã dùng', n(900)], ['Cache đã ghi', n(50)], ['Token suy luận', n(120)],
    ['Cửa sổ ngữ cảnh', `${n(32768)} (chưa rõ, ước lượng thận trọng)`,
      `Lịch sử tối đa ${n(20000)} token. Đầu ra: yêu cầu có thể dùng tới ${n(8000)} token; lịch sử được lập cho ${n(4000)}. Không phải số token đã tính phí.`],
    ['Chi phí ghi nhận', 'USD 0.012300 (tạm tính, tổng chưa rõ)', 'Chỉ gồm giá do chủ máy nhập và số liệu nhà cung cấp báo. Retry và lỗi có thể phát sinh phí chưa rõ.'],
    ['Yêu cầu chưa xác minh', '2', 'Nothing checked the requirement.'],
    ['Kiểm tra còn thiếu', '2', 'run the tests; read the diff'],
  ]);
  // the branches the full task does not take: no report at all, a window that is configured, a cost that is complete, planned output left out
  assert.deepEqual(ribbonRows(task('completed', {
    usage: { httpRequests: 1, inputUsageMissing: 2, inputUsageReported: 0, outputUsageMissing: 1, outputUsageReported: 0 },
    contextPolicy: { source: 'configured', capacityTokens: 128000, maxHistoryTokens: 90000, compactAtTokens: 70000, reservedOutputTokens: 8000, approximate: false },
    modelCost: { schema: 1, knownSubtotalUsd: 0.00123, pricedResponses: 1, unpricedResponses: 0, unknownResponses: 0, totalUsd: 0.00123, complete: true },
  }), t('vi'), 'vi'), [
    ['Yêu cầu HTTP tới model', '1'],
    ['Token đầu vào (nhà cung cấp báo)', 'không có', 'Chỉ tính token do nhà cung cấp báo. Thiếu báo cáo là chưa rõ, không phải bằng 0.'],
    ['Token đầu ra (nhà cung cấp báo)', 'không có'],
    ['Cửa sổ ngữ cảnh', `${n(128000)} (đã cấu hình)`, `Lịch sử tối đa ${n(90000)} token. Đầu ra: yêu cầu có thể dùng tới ${n(8000)} token; lịch sử được lập cho ${n(8000)}. Không phải số token đã tính phí.`],
    ['Chi phí ghi nhận', 'USD 0.001230', 'Chỉ gồm giá do chủ máy nhập và số liệu nhà cung cấp báo. Retry và lỗi có thể phát sinh phí chưa rõ.'],
  ]);
  assert.deepEqual(ribbonRows(task('completed', { usage: undefined }), t('vi'), 'vi'), [], 'a task the Hub counted nothing for has no details');
});

// ---- English: the same screen with nothing left in Vietnamese ----

const BANNER_EN = {
  uncertain: 'Check the changes before continuing: an action may have run but has no result yet.',
  cancelled: 'Stopping does not undo the changes already made.',
  paused: 'Send new instructions or continue the same conversation.',
  failed: 'See the log for details.', created: 'See the log for details.', blocked: 'See the log for details.', unknown: 'See the log for details.',
};
const STATE_EN = { created: 'Just created', blocked: 'Waiting for what it depends on', paused: 'Paused', failed: 'Failed', cancelled: 'Stopped', uncertain: 'Outcome unclear', unknown: 'unknown' };

test('the English banner has no Vietnamese in it, in its text or in a title or label, and no raw dictionary key', async () => {
  for (const status of RESTING) {
    for (const props of [{ status, onResume() {}, onRetry() {} }, { status }]) {
      const html = await banner(props);
      assert.doesNotMatch(html, DIACRITICS, `${status}: Vietnamese on the English screen: ${html.match(new RegExp(`.{0,40}${DIACRITICS.source}.{0,40}`, 'i'))?.[0]}`);
      assert.doesNotMatch(html, RAW_KEY, `${status}: a dictionary key was shown instead of text: ${html.match(RAW_KEY)?.[0]}`);
    }
  }
});

test('the English banner says in English what the Vietnamese one says, with one next step', async () => {
  for (const status of RESTING) {
    const retry = status === 'failed';
    const resumable = ['paused', 'cancelled', 'uncertain', 'failed'].includes(status);
    const root = await bannerPage({ status, onResume() {}, onRetry() {} }, 'en');
    assert.equal(root.text, `${STATE_EN[status]}${BANNER_EN[status]}${resumable ? (retry ? 'Retry' : 'Continue') : ''}`, status);
  }
  const resume = await bannerPage({ status: 'paused', onResume() {} }, 'en');
  assert.equal(accessibleName(resume, byTag(resume, 'button')[0]), 'Continue', 'the one next step is named in English');
  const hub = await bannerPage({ status: 'cancelled', message: 'Đã dừng theo yêu cầu.', onResume() {} }, 'en');
  assert.ok(hub.text.includes('Đã dừng theo yêu cầu.') && !hub.text.includes('Stopping does not undo'), 'what the Hub wrote is shown as the Hub wrote it: the Hub has one language');
  for (const status of ['completed', ...ACTIVE]) assert.equal(await banner({ status, onResume() {} }), '', `${status}: nothing`);
});

test('the English ribbon has no Vietnamese in it, in its text or in a title or label, and no raw dictionary key', async () => {
  const screens = [];
  for (const status of STATES) screens.push([status, task(status), { onCancel() {} }]);
  screens.push(['no title', task('failed', { task: '', messages: [] }), {}], ['no usage', task('completed', { usage: undefined }), {}], ['no start', task('completed', { startedAt: undefined, finishedAt: undefined }), {}]);
  for (const [name, value, props] of screens) {
    const html = await markup(PhaseRibbon, { task: value, ...props }, 'en');
    assert.doesNotMatch(html, DIACRITICS, `${name}: Vietnamese on the English screen: ${html.match(new RegExp(`.{0,40}${DIACRITICS.source}.{0,40}`, 'i'))?.[0]}`);
    assert.doesNotMatch(html, RAW_KEY, `${name}: a dictionary key was shown instead of text: ${html.match(RAW_KEY)?.[0]}`);
  }
});

test('the English ribbon says in English what the Vietnamese one says', async () => {
  const when = formatTime(STARTED, 'en');
  const running = await ribbonPage(task('running', { finishedAt: undefined }), 'en', { onCancel() {} });
  assert.equal(running.text, `Fix the login pageRunningStarted ${when} · 3 model requests · in 12k · out 678 tokensDetailsStop agent`);
  const done = await ribbonPage(task('completed'), 'en', { onCancel() {} });
  assert.equal(done.text, `Fix the login pageFinal reply receivedStarted ${when} · 3 m 05 s · 3 model requests · in 12k · out 678 tokensDetails`, 'a closing reply is not a verdict, in any language');
  for (const status of STATES) {
    const words = status === 'completed' ? 'Final reply received' : status === 'running' ? 'Running' : STATE_EN[status] ?? translations.en[`agents_bg_state_${status}`];
    assert.ok((await ribbonPage(task(status), 'en')).text.includes(words), `${status}: ${words}`);
  }
  assert.ok((await ribbonPage(task('failed', { task: '', prompt: '', messages: [], usage: undefined }), 'en')).text.startsWith('Conversation'), 'a conversation with no text is called “Conversation”');
  const stop = buttonNamed(running, 'Stop agent');
  assert.ok(stop, `Stop is named in English: ${byTag(running, 'button').map((node) => accessibleName(running, node)).join(' | ')}`);
  assert.equal(buttonNamed(done, 'Stop agent'), undefined, 'a finished task cannot be stopped');
  assert.equal(buttonNamed(done, 'Details').attrs['aria-expanded'], 'false');
  const one = await ribbonPage(task('completed', { usage: { httpRequests: 1, inputTokens: 5, outputTokens: 7 } }), 'en');
  assert.ok(one.text.includes('1 model request ·') && !one.text.includes('1 model requests'), 'one request is not “1 model requests” on the English screen');
  assert.ok(one.text.includes('in 5 · out 7 tokens'));
  const partial = await ribbonPage(task('completed', { startedAt: undefined, finishedAt: undefined, usage: { httpRequests: 2, inputTokens: 100, inputUsageReported: 1, inputUsageMissing: 1, outputUsageMissing: 2, outputUsageReported: 0 } }), 'en');
  assert.equal(partial.text, 'Fix the login pageFinal reply received2 model requests · in 100+ · out unavailable tokensDetails', 'a count the provider did not report is not a quiet number');
});

test('the English details say what the Vietnamese ones say, in the old English words', () => {
  const n = fmt('en');
  assert.deepEqual(ribbonRows(everything(), t('en'), 'en'), [
    ['Model HTTP requests', '4'],
    ['Input tokens (provider-reported)', `${n(12345)} (+ unknown)`, 'Only provider-reported tokens. A missing report is unknown, not zero.'],
    ['Output tokens (provider-reported)', n(678)],
    ['Cache hit', n(900)], ['Cache write', n(50)], ['Reasoning tokens', n(120)],
    ['Context window', `${n(32768)} (unknown, conservative estimate)`,
      `History up to ${n(20000)} tokens. Output: the request may use up to ${n(8000)} tokens; history is planned for ${n(4000)}. Not billed usage.`],
    ['Recorded cost', 'USD 0.012300 (known subtotal, total unknown)', 'Owner-supplied prices and provider-reported usage only. Retries and errors can produce unknown charges.'],
    ['Requirements unverified', '2', 'Nothing checked the requirement.'],
    ['Checks missing', '2', 'run the tests; read the diff'],
  ]);
  assert.deepEqual(ribbonRows(task('completed', {
    usage: { httpRequests: 1, inputUsageMissing: 2, inputUsageReported: 0, outputUsageMissing: 1, outputUsageReported: 0 },
    contextPolicy: { source: 'configured', capacityTokens: 128000, maxHistoryTokens: 90000, compactAtTokens: 70000, reservedOutputTokens: 8000, approximate: false },
    modelCost: { schema: 1, knownSubtotalUsd: 0.00123, pricedResponses: 1, unpricedResponses: 0, unknownResponses: 0, totalUsd: 0.00123, complete: true },
  }), t('en'), 'en').map(([label, value]) => `${label}: ${value}`), [
    'Model HTTP requests: 1', 'Input tokens (provider-reported): unavailable', 'Output tokens (provider-reported): unavailable',
    `Context window: ${n(128000)} (configured)`, 'Recorded cost: USD 0.001230',
  ]);
  for (const row of ribbonRows(everything(), t('en'), 'en')) for (const text of row) assert.doesNotMatch(text, DIACRITICS, `Vietnamese in an English row: ${text}`);
});

// ---- the dictionary behind it ----

test('the words of the banner and the ribbon are in both languages, the English ones are English, and the plural of a count is right', () => {
  const keys = Object.keys(translations.vi).filter((key) => key.startsWith('agents_banner_') || key.startsWith('agents_ribbon_'));
  assert.ok(keys.length >= 30, `the banner and the ribbon have ${keys.length} keys`);
  for (const key of keys) {
    assert.ok(translations.en[key]?.trim(), `en.${key} has no text`);
    assert.doesNotMatch(translations.en[key], DIACRITICS, `en.${key} still reads Vietnamese: ${translations.en[key]}`);
  }
  assert.equal(translations.vi.agents_ribbon_requests_one, '{n} yêu cầu model');
  assert.equal(translations.vi.agents_ribbon_requests_other, '{n} yêu cầu model', 'Vietnamese has no plural');
  assert.equal(translations.en.agents_ribbon_requests_one, '{n} model request');
  assert.equal(translations.en.agents_ribbon_requests_other, '{n} model requests');
  assert.equal(translations.vi.agents_bg_untitled_chat, 'Cuộc hội thoại', 'the ribbon’s name for a conversation with no text is the one the Background section has');
  assert.equal(translations.en.agents_bg_untitled_chat, 'Conversation');
});

// ---- both are read by a screen reader, and React needs the same hooks on every render ----

test('every control has a name, every id is used once and every reference points somewhere, in both languages', async () => {
  for (const lang of ['vi', 'en']) {
    for (const root of [
      await bannerPage({ status: 'paused', onResume() {} }, lang), await bannerPage({ status: 'failed', onRetry() {} }, lang),
      await ribbonPage(task('running'), lang, { onCancel() {} }), await ribbonPage(everything(), lang),
    ]) {
      assert.deepEqual(unnamedControls(root), [], `${lang}: unnamed controls`);
      assert.deepEqual(duplicateIds(root), [], `${lang}: duplicate ids`);
      assert.deepEqual(brokenReferences(root), [], `${lang}: references to nothing`);
    }
  }
});

test('the banner asks for its words before it decides to show nothing, so that every render calls the same hooks', () => {
  // A conversation goes from running (no banner) to stopped (a banner) and back in the same mounted component. A hook called only after the early
  // return breaks the rules of hooks, and React does not always say so (a render that calls no hook at all is never reported), nor can a server
  // render see it, so the order is read from the source.
  const source = fs.readFileSync(new URL('../src/components/conversation/StateBanner.tsx', import.meta.url), 'utf8');
  const hook = source.indexOf('useTranslation()');
  const early = source.indexOf('return null');
  assert.ok(hook > 0, 'StateBanner reads the language through useTranslation()');
  assert.ok(early > 0 && hook < early, 'and does so before its first early return');
});
