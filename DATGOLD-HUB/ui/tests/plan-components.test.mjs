import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, byRole, all, accessibleName, duplicateIds, unnamedControls, brokenReferences } from './support/html.mjs';
import { PermissionGate } from '../../lib/permissions.mjs';

// The page of plan mode (P9 ac-11, docs/PLAN-MODE.md "The page"), as the real components draw it: the approval card of exit_plan_mode (for a request of the Hub's own
// PermissionGate, so the page and the Hub cannot drift apart), the editable Plan tab, the Plan entry of the composer and the line of the banner. What a click does is
// read by calling the handler a component gave its button, against a Hub that answers as the test says. The logic behind them is in plan-view.test.mjs and
// plan-draft.test.mjs; clicks, focus and the real Hub are in e2e/plan-mode.spec.mjs.
const ENTRY = `
  ${renderPrelude}
  import { ConfirmContext } from './src/components/ui/ConfirmDialog';
  import { ApprovalStack as RealStack } from './src/components/approval/ApprovalStack';
  import { PlanTab as RealTab } from './src/components/inspector/PlanTab';
  import { Composer } from './src/components/conversation/Composer';
  import { ConversationView } from './src/components/conversation/ConversationView';
  import { StateBanner } from './src/components/conversation/StateBanner';
  import { usePlanDrafts } from './src/store/usePlanDrafts';
  import { normalizeApproval } from './src/lib/task-view';
  import * as drafts from './src/lib/plan-draft';
  import { translations } from './src/lib/i18n';
  const confirmed = (Real) => (props) => <ConfirmContext.Provider value={(request) => globalThis.__ask(request)}><Real {...props} /></ConfirmContext.Provider>;
  const ApprovalStack = confirmed(RealStack), PlanTab = confirmed(RealTab);
  const Both = (props) => <><RealStack {...props} /><RealTab /></>;
  export { ApprovalStack, PlanTab, Both, Composer, ConversationView, StateBanner, usePlanDrafts, normalizeApproval, drafts, translations };
`;
const CARD = 'components/approval/PlanApprovalCard.tsx';
const rewrite = (file, from, to) => ({ file, from, to });
const plain = await bundleTsx(ENTRY, 'chatmcp-plan-', { recordJsx: true });
// States a click reaches: the editor of the card, its feedback box (with words), the mode menu.
const editing = await bundleTsx(ENTRY, 'chatmcp-plan-edit-', { recordJsx: true, rewrites: [rewrite(CARD, 'const [editing, setEditing] = useState(false);', 'const [editing, setEditing] = useState(true);')] });
const asking = await bundleTsx(ENTRY, 'chatmcp-plan-ask-', { recordJsx: true, rewrites: [
  rewrite(CARD, 'const [asking, setAsking] = useState(false);', 'const [asking, setAsking] = useState(true);'),
  rewrite(CARD, "const [feedback, setFeedback] = useState('');", "const [feedback, setFeedback] = useState(globalThis.__feedback ?? '');"),
] });
const menu = await bundleTsx(ENTRY, 'chatmcp-plan-menu-', { recordJsx: true, rewrites: [rewrite('components/conversation/Composer.tsx', 'const [modeMenuOpen, setModeMenuOpen] = useState(false);', 'const [modeMenuOpen, setModeMenuOpen] = useState(true);')] });
const wanted = await bundleTsx(ENTRY, 'chatmcp-plan-wanted-', { recordJsx: true, rewrites: [rewrite('components/conversation/ConversationView.tsx', 'const [planWanted, setPlanWanted] = useState(false);', 'const [planWanted, setPlanWanted] = useState(true);')] });
after(async () => { for (const bundle of [plain, editing, asking, menu, wanted]) await bundle.dispose(); });
const { drafts, normalizeApproval, translations } = plain.loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const RAW_KEY = /\b(?:agents?|plan)_[a-z_]+\b/;
const TASK = '0b0c5a52-6f0c-4b0e-9d0e-3a4a5b6c7d8e';
const OTHER = '1b0c5a52-6f0c-4b0e-9d0e-3a4a5b6c7d8e';
const PLAN_TEXT = '## Steps\n\n1. Read **calc.js**.\n2. Fix it.';
const step = (text, status = 'todo', evidence = '') => ({ text, status, evidence });
const STEPS = [step('Read calc.js', 'done', 'read_file calc.js'), step('Fix add()', 'doing'), step('Run the tests')];
const plan = (revision, more = {}) => ({ version: 2, taskId: TASK, title: 'Repair', text: PLAN_TEXT, items: STEPS, revision, updatedBy: 'agent', updatedAt: null, approvedAt: null, approvedRevision: null, ...more });

/** The request the Hub's gate makes for a plan, as the page receives it. */
async function hubRequest({ text = PLAN_TEXT, revision = 2, taskId = TASK } = {}) {
  const gate = new PermissionGate({ manager: { secrets: [] }, workspace: null, timeout: 60_000 });
  gate.setTaskPolicy(taskId, { planOnly: true });
  const waiting = gate.askPlanApproval({ taskId, plan: text, revision });
  const request = gate.state().pending[0];
  gate.shutdown();
  await waiting;
  return { ...request, expiresAt: '2099-01-01T00:00:00.000Z' };
}

// ---- a Hub that answers as the test says -----------------------------------------------------------------------------------------------------------
const calls = [];
const toasts = [];
let routes = new Map();
const showToast = (message, type) => { toasts.push([message, type]); };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (route, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push([route, body]);
  const answer = routes.get(route);
  const result = answer ? await answer(body) : { ok: true };
  return result instanceof Response ? result : json(200, result);
};
const serve = (table = {}) => { calls.length = 0; toasts.length = 0; routes = new Map(Object.entries(table).map(([route, answer]) => [route, typeof answer === 'function' ? answer : () => answer])); };
const conflict = () => json(409, { error: 'changed', code: 'plan_conflict', revision: 9, updatedBy: 'agent' });

async function screen(bundle, name, { props = {}, lang = 'en', plans = [], tasks = [], hub, draft, store = {} } = {}) {
  globalThis.__chatmcpJsx = [];
  Object.assign(bundle.loaded.usePlanDrafts.getInitialState(), { drafts: draft ? { [TASK]: draft } : {} });
  bundle.loaded.usePlanDrafts.setState({ drafts: draft ? { [TASK]: draft } : {} });
  const entries = [
    [['hubState'], hub ?? { workspace: { path: '/w' }, workspaces: { activePath: '/w', items: [] }, tasks: [], agent: { mode: 'api', tasks: [] }, studio: { permissions: { mode: 'review', pending: [], recent: [] } }, browser: {}, ai: { profiles: [] } }],
    ...plans.map((value) => [['plan', value.taskId], value]), ...tasks.map((value) => [['task', value.id], value]),
  ];
  const html = await bundle.loaded.renderWith(bundle.loaded[name], props, entries, [], { lang, showToast, selectedTaskId: TASK, ...store });
  return { html, root: parseHtml(html), elements: globalThis.__chatmcpJsx.slice(), drafts: () => bundle.loaded.usePlanDrafts.getState().drafts };
}
const task = (more = {}) => ({ id: TASK, task: 'Repair calc', status: 'waiting_approval', state: 'waiting_approval', messages: [], toolCalls: [], transport: 'api', ...more });
const card = async (options = {}) => {
  const { bundle = plain, request, onPlanAnswered = () => {}, gateMode = 'review', busy, ...rest } = options;
  return screen(bundle, 'ApprovalStack', { plans: [plan(2)], ...rest, props: { approvals: [normalizeApproval(request ?? await hubRequest())], onApprove() {}, onDeny() {}, onPlanAnswered, gateMode, busy } });
};
const tab = (options = {}) => screen(options.bundle ?? plain, 'PlanTab', { plans: [plan(2)], tasks: [task()], ...options });
const testId = (root, id) => all(root).filter((node) => node.attrs['data-testid'] === id);
const buttons = (root) => byTag(root, 'button').map((node) => accessibleName(root, node));
const buttonNode = (root, name) => byTag(root, 'button').find((node) => accessibleName(root, node) === name);
const field = (root, name) => [...byTag(root, 'input'), ...byTag(root, 'textarea')].find((node) => accessibleName(root, node) === name);
/** The handler a component gave to its control `name` ('data-action' of a button, 'data-field' of a field). */
const handler = (shot, name, prop = 'onClick') => {
  const found = shot.elements.find((element) => (element.props['data-action'] === name || element.props['data-field'] === name) && typeof element.props[prop] === 'function');
  assert.ok(found, `no element ${name} has a ${prop}`);
  return found.props[prop];
};
const settle = async () => { for (let turn = 0; turn < 60; turn++) await new Promise((resolve) => setImmediate(resolve)); };
async function click(shot, name, { confirm = true } = {}) {
  const asked = [];
  globalThis.__ask = (request) => { asked.push(request); return Promise.resolve(confirm); };
  handler(shot, name)({ preventDefault() {}, stopPropagation() {} });
  await settle();
  return asked;
}
const english = (shot, label) => {
  assert.doesNotMatch(shot.html.replace(/data-[a-z-]+="[^"]*"/g, ''), DIACRITICS, `${label}: Vietnamese on the English screen`);
  assert.doesNotMatch(shot.root.text, RAW_KEY, `${label}: a raw key`);
};
const accessible = (shot, label) => {
  assert.deepEqual(unnamedControls(shot.root), [], `${label}: unnamed controls`);
  assert.deepEqual(duplicateIds(shot.root), [], `${label}: duplicate ids`);
  assert.deepEqual(brokenReferences(shot.root), [], `${label}: references to nothing`);
};

// ---- the card -----------------------------------------------------------------------------------------------------------------------------------------

test('the card of a plan request shows the plan, its steps, its revision and the three answers', async () => {
  const shot = await card();
  const [section] = testId(shot.root, 'plan-approval');
  assert.ok(section, 'the plan has a card of its own');
  assert.equal(accessibleName(shot.root, section), 'Plan approval');
  assert.match(section.text, /Revision 2/);
  assert.ok(byTag(section, 'strong').some((node) => node.text === 'calc.js'), 'the Markdown is drawn');
  assert.deepEqual(byTag(section, 'ol').map((list) => byTag(list, 'li').length).sort(), [2, 3], 'the list of the text and the steps');
  for (const { text } of STEPS) assert.match(section.text, new RegExp(text.replace(/[()]/g, '\\$&')));
  for (const name of ['Edit plan', 'Request changes', 'Approve and run in Review', 'Approve and run in Autonomous']) assert.ok(buttonNode(shot.root, name) && !('disabled' in buttonNode(shot.root, name).attrs), `the button ${name}`);
  assert.equal(buttonNode(shot.root, 'Approve'), undefined, 'not the two buttons of an ordinary request');
  assert.equal(buttonNode(shot.root, 'Deny'), undefined);
  assert.doesNotMatch(section.text, /"kind"/, 'the detail is not shown as JSON');
  assert.match(section.text, /Auto-deny in/, 'it expires like any other request');
  english(shot, 'the card');
  accessible(shot, 'the card');
});

test('in Vietnamese the card says the same', async () => {
  const shot = await card({ lang: 'vi' });
  assert.equal(accessibleName(shot.root, testId(shot.root, 'plan-approval')[0]), 'Duyệt kế hoạch');
  for (const name of ['Sửa kế hoạch', 'Yêu cầu sửa', 'Duyệt và chạy ở Review', 'Duyệt và chạy ở Tự động']) assert.ok(buttonNode(shot.root, name), name);
  assert.doesNotMatch(shot.root.text, RAW_KEY);
  accessible(shot, 'the Vietnamese card');
});

test('what the plan says is text and Markdown, never markup of the page', async () => {
  const text = 'Run <img src=x onerror=alert(1)> and <script>alert(1)</script>';
  const shot = await card({ request: await hubRequest({ text }), plans: [plan(2, { text, items: [step('<b>bold</b>')] })] });
  const [section] = testId(shot.root, 'plan-approval');
  assert.equal(byTag(section, 'img', 'script', 'b').length, 0);
  assert.match(section.text, /<script>alert\(1\)<\/script>/);
});

test('a plan with characters that cannot be seen is shown as its source, with the characters marked', async () => {
  const text = 'Edit a.js‮ then stop';
  const shot = await card({ request: await hubRequest({ text }), plans: [plan(2, { text })] });
  const [section] = testId(shot.root, 'plan-approval');
  assert.match(section.text, /‹U\+202E›/);
  assert.equal(buttonNode(shot.root, 'Source').attrs['aria-pressed'], 'true');
  const steps = await card({ plans: [plan(2, { items: [step('Read​ it')] })] });
  assert.match(testId(steps.root, 'plan-approval')[0].text, /‹U\+200B›/, 'in a step too');
});

test('until the plan is read, the card shows the request\'s copy and offers no edit', async () => {
  for (const plans of [[], [plan(1, { text: 'Older' })]]) {
    const shot = await card({ plans });
    assert.ok(buttonNode(shot.root, 'Edit plan').attrs.disabled !== undefined);
    assert.ok(buttonNode(shot.root, 'Approve and run in Review').attrs.disabled === undefined);
    assert.doesNotMatch(shot.root.text, /Older/);
  }
});

test('a plan edited after the proposal says so, and the approval answers the revision on the card', async () => {
  const shot = await card({ plans: [plan(4, { updatedBy: 'user', text: 'Edited by me.' })] });
  assert.match(testId(shot.root, 'plan-approval')[0].text, /You edited the plan after the agent proposed it \(revision 2\)/);
  serve();
  await click(shot, 'approve-review');
  assert.deepEqual(calls.filter(([route]) => route.includes('/decide')), [['/api/studio/plan/decide', { taskId: TASK, revision: 4, decision: 'approve', execution: 'review' }]]);
  const agents = await card({ plans: [plan(4)] });
  assert.match(testId(agents.root, 'plan-approval')[0].text, /The agent wrote the plan again after proposing it/);
});

test('Approve sends the execution, says so, and hands the focus on', async () => {
  let answered = 0;
  const shot = await card({ onPlanAnswered: () => { answered += 1; } });
  serve();
  await click(shot, 'approve-autonomous');
  assert.deepEqual(calls[0], ['/api/studio/plan/decide', { taskId: TASK, revision: 2, decision: 'approve', execution: 'autonomous' }]);
  assert.equal(answered, 1);
  assert.deepEqual(toasts, [['Plan approved (revision 2).', 'success']]);
});

test('an approval the Hub refuses because the plan moved on reads the plan again, says that nothing was approved and hands no focus on', async () => {
  let answered = 0;
  const shot = await card({ onPlanAnswered: () => { answered += 1; } });
  serve({ '/api/studio/plan/decide': conflict });
  await click(shot, 'approve-review');
  assert.ok(globalThis.__chatmcpInvalidated.some((filters) => JSON.stringify(filters.queryKey) === JSON.stringify(['plan', TASK])), 'the plan is read again');
  assert.deepEqual(toasts, [['The plan has just changed: nothing was saved or approved. Read it as it is now, then try again.', 'warning']]);
  assert.equal(answered, 0);
  serve({ '/api/studio/plan/decide': () => json(404, { error: 'Gone', code: 'no_plan_request' }) });
  await click(await card(), 'approve-review');
  assert.deepEqual(toasts, [['Gone', 'error']], 'another refusal is the Hub\'s own sentence');
  serve({ '/api/studio/plan/decide': () => { throw new Error(''); } });
  await click(await card(), 'approve-review');
  assert.deepEqual(toasts, [['The answer could not be sent.', 'error']]);
});

test('unsaved edits are saved before they are approved, and the draft goes when they are', async () => {
  const draft = drafts.editText(drafts.openDraft(plan(2)), 'My plan.');
  const shot = await card({ draft });
  const [section] = testId(shot.root, 'plan-approval');
  assert.match(section.text, /Unsaved edits/);
  assert.match(section.text, /My plan\./, 'the card shows what will be approved');
  serve({ '/api/studio/plan/set': plan(3, { text: 'My plan.', updatedBy: 'user' }) });
  await click(shot, 'approve-review');
  assert.deepEqual(calls.slice(0, 2), [
    ['/api/studio/plan/set', { taskId: TASK, title: 'Repair', items: STEPS, baseRevision: 2, text: 'My plan.' }],
    ['/api/studio/plan/decide', { taskId: TASK, revision: 3, decision: 'approve', execution: 'review' }],
  ]);
  assert.deepEqual(shot.drafts(), {});
  assert.deepEqual(toasts, [['Plan approved (revision 3).', 'success']]);
});

test('an edit that was saved is no draft any more, even when the approval after it is refused; one that was not saved still is', async () => {
  const draft = drafts.editText(drafts.openDraft(plan(2)), 'My plan.');
  const late = await card({ draft });
  serve({ '/api/studio/plan/set': plan(3, { text: 'My plan.' }), '/api/studio/plan/decide': () => json(404, { error: 'Gone', code: 'no_plan_request' }) });
  await click(late, 'approve-review');
  assert.deepEqual(late.drafts(), {});
  const refused = await card({ draft });
  serve({ '/api/studio/plan/set': conflict });
  await click(refused, 'approve-review');
  assert.deepEqual(calls.map(([route]) => route).filter((route) => route.includes('decide')), [], 'nothing was approved');
  assert.deepEqual(Object.keys(refused.drafts()), [TASK], 'and the words are kept');
});

test('Approve is off, with the reason, while there is a conflict, a step with no words or no text', async () => {
  const opened = drafts.openDraft(plan(2));
  const cases = {
    'The plan changed while you were editing it. Settle that first.': { draft: drafts.editText(opened, 'Mine'), plans: [plan(3, { text: 'Theirs' })] },
    'A step has no words. Write it or delete it.': { draft: drafts.editStep(opened, 's0', ''), plans: [plan(2)] },
    'The plan has no text. Write it before it is approved or saved.': { plans: [plan(2, { text: '' })] },
  };
  for (const [why, options] of Object.entries(cases)) {
    const shot = await card(options);
    for (const name of ['Approve and run in Review', 'Approve and run in Autonomous']) {
      const node = buttonNode(shot.root, name);
      assert.ok(node.attrs.disabled !== undefined, `${why}: ${name} is off`);
      assert.match(all(shot.root).find((item) => item.attrs.id === node.attrs['aria-describedby']).text, new RegExp(why.replace(/[.]/g, '\\.')));
    }
    english(shot, why);
    accessible(shot, why);
    serve();
    await click(shot, 'approve-review');
    assert.deepEqual(calls, [], `${why}: nothing is sent, whatever calls the handler`);
  }
});

test('the conflict is told on the card too, with the way out', async () => {
  const shot = await card({ draft: drafts.editText(drafts.openDraft(plan(2)), 'Mine'), plans: [plan(3, { text: 'Theirs', updatedBy: 'agent' })] });
  assert.equal(testId(shot.root, 'plan-conflict').length, 1);
  serve();
  await click(shot, 'conflict-theirs');
  assert.deepEqual(shot.drafts(), {});
});

test('a card that is being answered, or has expired, takes no click', async () => {
  const busy = await card({ busy: true });
  for (const name of ['Edit plan', 'Request changes', 'Approve and run in Review', 'Approve and run in Autonomous']) assert.ok(buttonNode(busy.root, name).attrs.disabled !== undefined, name);
  const expired = await card({ request: { ...(await hubRequest()), expiresAt: '2020-01-01T00:00:00.000Z' } });
  assert.match(testId(expired.root, 'plan-approval')[0].text, /Expired/);
  for (const name of ['Request changes', 'Approve and run in Review', 'Approve and run in Autonomous']) assert.ok(buttonNode(expired.root, name).attrs.disabled !== undefined, name);
  serve();
  for (const shot of [busy, expired]) await click(shot, 'approve-review');
  assert.deepEqual(calls, [], 'nothing is sent, whatever calls the handler');
});

test('the card says what the choice does not change: Read Only wins, and Full Access is not the task\'s any more', async () => {
  assert.match((await card({ gateMode: 'readonly' })).root.text, /Read-only is on: the agent still cannot change anything after the approval/);
  assert.match((await card({ gateMode: 'full-access' })).root.text, /FULL ACCESS will not apply to this conversation/);
  for (const gateMode of ['review', 'autonomous']) assert.doesNotMatch((await card({ gateMode })).root.text, /Read-only is on|FULL ACCESS will not apply/);
});

test('a plan of another conversation says that it is another one\'s', async () => {
  const shot = await card({ request: await hubRequest({ taskId: OTHER }), plans: [plan(2, { taskId: OTHER })] });
  assert.match(testId(shot.root, 'plan-approval')[0].text, /Another conversation/);
  serve();
  await click(shot, 'approve-review');
  assert.equal(calls[0][1].taskId, OTHER);
  assert.doesNotMatch((await card()).root.text, /Another conversation/);
});

test('the editor of the card has the title, the text and the steps, each with a name', async () => {
  const shot = await card({ bundle: editing, draft: drafts.openDraft(plan(2)) });
  assert.equal(field(shot.root, 'Plan title').attrs.value, 'Repair');
  assert.equal(field(shot.root, 'Plan text (Markdown)').text, PLAN_TEXT);
  assert.deepEqual([1, 2, 3].map((n) => field(shot.root, `Step ${n}`).text), STEPS.map(({ text }) => text));
  english(shot, 'the editor');
  accessible(shot, 'the editor');
  handler(shot, 'plan-text', 'onChange')({ target: { value: 'Typed.' } });
  assert.equal(shot.drafts()[TASK].text, 'Typed.');
});

test('Edit plan opens a draft of the plan on the card', async () => {
  const shot = await card();
  await click(shot, 'plan-edit');
  assert.equal(shot.drafts()[TASK].basis.revision, 2);
});

test('the card and the Plan tab show one draft of one plan, with no id used twice', async () => {
  const shot = await screen(editing, 'Both', { plans: [plan(2)], tasks: [task()], draft: drafts.editTitle(drafts.openDraft(plan(2)), 'Mine'), props: { approvals: [normalizeApproval(await hubRequest())], onApprove() {}, onDeny() {}, onPlanAnswered() {}, gateMode: 'review' } });
  assert.equal(byTag(shot.root, 'input').filter((node) => node.attrs.value === 'Mine').length, 2);
  accessible(shot, 'both');
});

// ---- request changes -----------------------------------------------------------------------------------------------------------------------------------

test('Request changes asks for words and sends them with the revision on the card', async () => {
  globalThis.__feedback = '  Name the test file first.  ';
  let answered = 0;
  const shot = await card({ bundle: asking, onPlanAnswered: () => { answered += 1; } });
  assert.ok(field(shot.root, 'What should change in the plan?'));
  assert.equal(field(shot.root, 'What should change in the plan?').attrs.maxlength, '4000');
  english(shot, 'the feedback box');
  accessible(shot, 'the feedback box');
  serve();
  await click(shot, 'changes-send');
  assert.deepEqual(calls[0], ['/api/studio/plan/decide', { taskId: TASK, revision: 2, decision: 'request_changes', feedback: 'Name the test file first.' }]);
  assert.equal(answered, 1);
  assert.deepEqual(toasts, [['Your request was sent to the agent.', 'info']]);
});

test('Request changes cannot be sent without words', async () => {
  globalThis.__feedback = '  ';
  const shot = await card({ bundle: asking });
  assert.ok(buttonNode(shot.root, 'Send the request').attrs.disabled !== undefined);
  serve();
  await click(shot, 'changes-send');
  assert.deepEqual(calls, []);
});

test('unsaved edits are not sent with a request for changes, and the card says so', async () => {
  globalThis.__feedback = 'Words';
  const draft = drafts.editText(drafts.openDraft(plan(2)), 'Mine');
  assert.match((await card({ bundle: asking, draft })).root.text, /Your unsaved edits are not sent with it/);
  assert.doesNotMatch((await card({ bundle: asking })).root.text, /Your unsaved edits are not sent with it/);
});

test('a request for changes the Hub refuses keeps the words', async () => {
  globalThis.__feedback = 'Words';
  let answered = 0;
  const shot = await card({ bundle: asking, onPlanAnswered: () => { answered += 1; } });
  serve({ '/api/studio/plan/decide': conflict });
  await click(shot, 'changes-send');
  assert.equal(answered, 0);
  assert.equal(toasts[0][1], 'warning');
});

// ---- other requests and the history --------------------------------------------------------------------------------------------------------------------

test('an ordinary request keeps its card, and so does a plan request that is not one', async () => {
  const request = { id: 'r', taskId: TASK, toolName: 'local.run_command', category: 'execute', summary: 'Run', detail: { kind: 'command', command: 'node -v' } };
  for (const other of [request, { ...(await hubRequest()), detail: { kind: 'plan', plan: 7 } }]) {
    const shot = await card({ request: other });
    assert.equal(testId(shot.root, 'plan-approval').length, 0);
    assert.ok(buttonNode(shot.root, 'Approve') && buttonNode(shot.root, 'Deny'));
  }
});

test('an answered plan request is in the history with what the owner wrote, and is not called a risk', async () => {
  const { detail, ...rest } = await hubRequest();
  const shot = await card({ request: { ...rest, decision: 'denied', feedback: 'Smaller steps.' } });
  assert.match(shot.root.text, /Denied/);
  assert.match(shot.root.text, /Your feedback: Smaller steps\./);
  assert.doesNotMatch(shot.root.text, /High risk|Rủi ro cao/);
  assert.match(shot.root.text, /Plan approval/);
});

// ---- the Plan tab --------------------------------------------------------------------------------------------------------------------------------------

test('the Plan tab shows the plan: its revision and who wrote it, its text, its steps and the agent\'s evidence', async () => {
  const shot = await tab({ plans: [plan(3, { updatedBy: 'user', approvedRevision: 2 })] });
  assert.match(shot.root.text, /Revision 3/);
  assert.match(shot.root.text, /last written by you/);
  assert.match(shot.root.text, /Revision 2 was approved; the plan has changed since/);
  assert.ok(byTag(shot.root, 'strong').some((node) => node.text === 'calc.js'));
  assert.match(shot.root.text, /read_file calc\.js/);
  assert.ok(buttonNode(shot.root, 'Edit plan'));
  english(shot, 'the tab');
  accessible(shot, 'the tab');
  assert.match((await tab({ plans: [plan(3, { approvedRevision: 3 })] })).root.text, /This revision was approved/);
  assert.match((await tab({ plans: [plan(3)] })).root.text, /last written by the agent/);
});

test('a step the agent reports as done without evidence has no check mark, and a step with evidence has one', async () => {
  const marks = async (items) => byRole((await tab({ plans: [plan(2, { items })] })).root, 'img').map((node) => node.attrs['aria-label']);
  assert.deepEqual(await marks([step('A', 'done', 'proof'), step('B', 'done', ' '), step('C', 'doing'), step('D', 'blocked'), step('E')]),
    ['Done, with evidence', 'Reported done by the agent', 'In progress', 'Blocked', 'To do']);
});

test('a draft of one conversation stays when another one\'s is written or dropped', () => {
  const { usePlanDrafts } = plain.loaded;
  const [mine, theirs] = [drafts.openDraft(plan(2)), drafts.openDraft(plan(7))];
  usePlanDrafts.setState({ drafts: {} });
  const { setDraft } = usePlanDrafts.getState();
  setDraft(TASK, mine);
  setDraft(OTHER, theirs);
  assert.deepEqual(usePlanDrafts.getState().drafts, { [TASK]: mine, [OTHER]: theirs });
  setDraft(OTHER, null);
  assert.deepEqual(usePlanDrafts.getState().drafts, { [TASK]: mine });
  setDraft(TASK, null);
  assert.deepEqual(usePlanDrafts.getState().drafts, {});
});

test('a plan that is only a text is a plan, and one with neither text nor steps can be started by the owner', async () => {
  const text = await tab({ plans: [plan(1, { title: '', items: [] })] });
  assert.doesNotMatch(text.root.text, /No plan yet/);
  assert.ok(byTag(text.root, 'strong').some((node) => node.text === 'calc.js'));
  const none = await tab({ plans: [{ taskId: TASK, title: '', items: [], text: '', revision: 0, updatedBy: null }] });
  assert.match(none.root.text, /No plan yet/);
  await click(none, 'plan-edit');
  assert.equal(none.drafts()[TASK].steps.length, 0);
});

test('the plan of a Companion task is only read, and so is the plan of a task the page does not know', async () => {
  for (const tasks of [[task({ transport: 'chatgpt-web' })], []]) {
    const shot = await tab({ tasks });
    assert.match(shot.root.text, /Read calc\.js/);
    assert.equal(buttonNode(shot.root, 'Edit plan'), undefined);
    const drafted = await tab({ tasks, draft: drafts.openDraft(plan(2)) });
    assert.equal(field(drafted.root, 'Plan title'), undefined, 'not even with a draft left');
  }
});

test('the editor of the tab: every field and button has a name, the first step cannot go up and the last one cannot go down', async () => {
  const shot = await tab({ draft: drafts.openDraft(plan(2)) });
  for (const name of ['Plan title', 'Plan text (Markdown)', 'Step 1', 'Step 2', 'Step 3']) assert.ok(field(shot.root, name), name);
  const off = (name) => buttonNode(shot.root, name).attrs.disabled !== undefined;
  assert.deepEqual(['Move step 1 up', 'Move step 1 down', 'Move step 3 up', 'Move step 3 down', 'Delete step 2'].map(off), [true, false, false, true, false]);
  assert.ok(buttonNode(shot.root, 'Add a step'));
  assert.ok(off('Save plan'), 'nothing to save yet');
  assert.equal(all(shot.root).filter((node) => node.attrs['data-testid'] === 'step-evidence').length, 1);
  assert.equal(byTag(shot.root, 'input', 'textarea').some((node) => node.attrs.value === 'read_file calc.js' || node.text === 'read_file calc.js'), false, 'evidence is shown, never a field');
  english(shot, 'the editor of the tab');
  accessible(shot, 'the editor of the tab');
});

test('a click in the editor edits the draft: add, delete, move, reword', async () => {
  const open = () => tab({ draft: drafts.openDraft(plan(2)) });
  const words = (shot) => shot.drafts()[TASK].steps.map(({ text }) => text);
  let shot = await open(); await click(shot, 'step-add'); assert.deepEqual(words(shot), [...STEPS.map(({ text }) => text), '']);
  shot = await open(); await click(shot, 'step-delete-s1'); assert.deepEqual(words(shot), ['Read calc.js', 'Run the tests']);
  shot = await open(); await click(shot, 'step-down-s0'); assert.deepEqual(words(shot), ['Fix add()', 'Read calc.js', 'Run the tests']);
  shot = await open(); await click(shot, 'step-up-s2'); assert.deepEqual(words(shot), ['Read calc.js', 'Run the tests', 'Fix add()']);
  shot = await open(); handler(shot, 'step-s2', 'onChange')({ target: { value: 'Test it' } }); assert.deepEqual(words(shot), ['Read calc.js', 'Fix add()', 'Test it']);
  shot = await open(); handler(shot, 'plan-title', 'onChange')({ target: { value: 'T' } }); assert.equal(shot.drafts()[TASK].title, 'T');
});

test('a line break never gets into a step: Enter adds the next one, and a pasted break is a space', async () => {
  const shot = await tab({ draft: drafts.openDraft(plan(2)) });
  let prevented = 0;
  const enter = (more = {}) => handler(shot, 'step-s0', 'onKeyDown')({ key: 'Enter', nativeEvent: {}, preventDefault: () => { prevented += 1; }, ...more });
  enter({ nativeEvent: { isComposing: true } });
  assert.equal(shot.drafts()[TASK].steps.length, 3, 'Enter that ends a composition is not a new step');
  enter();
  assert.deepEqual(shot.drafts()[TASK].steps.map(({ text }) => text), ['Read calc.js', '', 'Fix add()', 'Run the tests']);
  assert.equal(prevented, 1);
  handler(shot, 'step-s1', 'onChange')({ target: { value: 'a\r\nb\nc' } });
  assert.equal(shot.drafts()[TASK].steps.find(({ id }) => id === 's1').text, 'a b c');
});

test('a step the owner rewords says that the agent\'s mark goes with the old words', async () => {
  const shot = await tab({ draft: drafts.editStep(drafts.openDraft(plan(2)), 's0', 'Read all of it') });
  assert.match(shot.root.text, /The agent's mark and evidence were for the old words: saving drops them/);
  assert.equal(testId(shot.root, 'step-evidence').length, 0);
  assert.doesNotMatch((await tab({ draft: drafts.openDraft(plan(2)) })).root.text, /were for the old words/);
});

test('Save sends the edit on its base and shows what the Hub answered', async () => {
  const shot = await tab({ draft: drafts.editStep(drafts.openDraft(plan(2)), 's2', 'Run all the tests') });
  assert.equal(buttonNode(shot.root, 'Save plan').attrs.disabled, undefined);
  serve({ '/api/studio/plan/set': plan(3, { updatedBy: 'user' }) });
  await click(shot, 'plan-save');
  assert.deepEqual(calls[0], ['/api/studio/plan/set', { taskId: TASK, title: 'Repair', items: [STEPS[0], STEPS[1], step('Run all the tests')], baseRevision: 2 }]);
  assert.deepEqual(shot.drafts(), {});
  assert.deepEqual(toasts, [['Plan saved (revision 3).', 'success']]);
});

test('a save the Hub refuses keeps the draft; because the plan moved on, it is read again', async () => {
  const draft = drafts.editTitle(drafts.openDraft(plan(2)), 'Mine');
  const moved = await tab({ draft });
  serve({ '/api/studio/plan/set': conflict });
  await click(moved, 'plan-save');
  assert.equal(moved.drafts()[TASK].title, 'Mine');
  assert.ok(globalThis.__chatmcpInvalidated.some((filters) => JSON.stringify(filters.queryKey) === JSON.stringify(['plan', TASK])));
  assert.equal(toasts[0][1], 'warning');
  const refused = await tab({ draft });
  serve({ '/api/studio/plan/set': () => json(400, { error: 'Bad', code: 'bad_plan' }) });
  await click(refused, 'plan-save');
  assert.deepEqual(toasts, [['Bad', 'error']]);
  assert.equal(refused.drafts()[TASK].title, 'Mine');
});

test('a draft the Hub would refuse cannot be saved, and the tab says why', async () => {
  for (const [why, draft] of [
    ['A step has no words. Write it or delete it.', drafts.addStep(drafts.openDraft(plan(2))).draft],
    ['A step is longer than 500 characters.', drafts.editStep(drafts.openDraft(plan(2)), 's0', 'x'.repeat(501))],
    ['The plan text is longer than 40000 characters.', drafts.editText(drafts.openDraft(plan(2)), 'x'.repeat(40_001))],
    ['A plan has at most 100 steps.', (() => { const added = drafts.addStep(drafts.openDraft(plan(2, { items: Array.from({ length: 100 }, (_, n) => step(`S${n}`)) }))); return drafts.editStep(added.draft, added.id, 'More'); })()],
  ]) {
    const shot = await tab({ draft });
    assert.ok(buttonNode(shot.root, 'Save plan').attrs.disabled !== undefined, why);
    assert.ok(shot.root.text.includes(why), why);
    serve();
    await click(shot, 'plan-save');
    assert.deepEqual(calls, [], why);
  }
});

test('the conflict banner says who wrote what, shows the new plan, and takes nothing away until the owner chooses', async () => {
  const draft = drafts.editText(drafts.openDraft(plan(2)), 'Mine');
  const now = plan(5, { text: 'Their text', items: [step('Their step')], updatedBy: 'agent' });
  const shot = await tab({ draft, plans: [now] });
  const [banner] = testId(shot.root, 'plan-conflict');
  assert.equal(banner.attrs.role, 'alert');
  assert.match(banner.text, /The agent wrote revision 5 while you were editing revision 2\. Nothing was overwritten\./);
  assert.match(banner.text, /Their text/);
  assert.match(banner.text, /Their step/);
  assert.equal(field(shot.root, 'Plan text (Markdown)').text, 'Mine', 'the owner\'s words are there');
  assert.ok(buttonNode(shot.root, 'Save plan').attrs.disabled !== undefined);
  english(shot, 'the conflict');
  accessible(shot, 'the conflict');
  await click(shot, 'conflict-mine');
  const kept = shot.drafts()[TASK];
  assert.deepEqual([kept.basis.revision, kept.text, kept.steps.map(({ text }) => text)], [5, 'Mine', ['Their step']]);
  const theirs = await tab({ draft, plans: [now] });
  await click(theirs, 'conflict-theirs');
  assert.deepEqual(theirs.drafts(), {});
  assert.match((await tab({ draft, plans: [plan(5, { text: 'x', updatedBy: 'user' })] })).root.text, /Revision 5 was saved in another window of yours while you were editing revision 2/);
  assert.match((await tab({ draft, plans: [plan(5, { text: 'x', updatedBy: null })] })).root.text, /The plan went to revision 5 while you were editing revision 2/);
});

test('closing a clean editor asks nothing; dropping edits asks first', async () => {
  const clean = await tab({ draft: drafts.openDraft(plan(2)) });
  assert.deepEqual(await click(clean, 'plan-close', { confirm: false }), []);
  assert.deepEqual(clean.drafts(), {});
  const dirty = await tab({ draft: drafts.editTitle(drafts.openDraft(plan(2)), 'Mine') });
  const asked = await click(dirty, 'plan-close', { confirm: false });
  assert.equal(asked.length, 1);
  assert.deepEqual(Object.keys(dirty.drafts()), [TASK], 'no: the draft stays');
  await click(dirty, 'plan-close', { confirm: true });
  assert.deepEqual(dirty.drafts(), {});
});

// ---- the composer --------------------------------------------------------------------------------------------------------------------------------------

const composer = (more = {}) => screen(menu, 'Composer', { props: { onSendMessage() {}, currentMode: 'review', onModeChange: (mode) => { throw new Error(`the mode of every chat was changed to ${mode}`); }, onPlanChange() {}, ...more } });
const planItem = (shot) => byRole(shot.root, 'menuitemcheckbox')[0];

test('the composer has a Plan entry beside the modes: a flag of this conversation, and choosing it changes no mode', async () => {
  const chosen = [];
  const shot = await composer({ plan: { offered: true, checked: false, locked: null }, onPlanChange: (on) => chosen.push(on) });
  assert.match(accessibleName(shot.root, planItem(shot)), /^Plan/);
  assert.equal(planItem(shot).attrs['aria-checked'], 'false');
  assert.equal(byRole(shot.root, 'menuitemradio').length, 4, 'the modes are as they were');
  await click(shot, 'composer-plan');
  assert.deepEqual(chosen, [true]);
  const on = await composer({ plan: { offered: true, checked: true, locked: null }, onPlanChange: (value) => chosen.push(value) });
  assert.equal(planItem(on).attrs['aria-checked'], 'true');
  assert.match(byTag(on.root, 'button').find((node) => node.attrs['aria-haspopup'] === 'menu').text, /Plan · Review/, 'the chip says both');
  await click(on, 'composer-plan');
  assert.deepEqual(chosen, [true, false], 'and off again');
  english(on, 'the menu');
  assert.deepEqual(unnamedControls(on.root), ['input'], 'only the file input, which is not shown');
  assert.deepEqual([duplicateIds(on.root), brokenReferences(on.root)], [[], []]);
});

test('the Plan entry is not there when the transport has no plan mode, and cannot be changed when it is locked', async () => {
  assert.equal(planItem(await composer({ plan: { offered: false, checked: false, locked: null } })), undefined);
  assert.equal(planItem(await composer({})), undefined, 'nor when the caller says nothing about it');
  for (const [locked, checked, words] of [['held', true, /read-only until you approve its plan/], ['running', false, /Stop the run first/]]) {
    const chosen = [];
    const shot = await composer({ plan: { offered: true, checked, locked }, onPlanChange: (on) => chosen.push(on) });
    assert.equal(planItem(shot).attrs['aria-disabled'], 'true');
    assert.match(planItem(shot).text, words);
    await click(shot, 'composer-plan');
    assert.deepEqual(chosen, []);
  }
});

const send = (shot) => shot.elements.find((element) => typeof element.type === 'function' && element.type.name === 'Composer').props.onSendMessage;
const composerProps = (shot) => shot.elements.find((element) => typeof element.type === 'function' && element.type.name === 'Composer').props;

test('a conversation starts and continues in plan mode with the flag, and the permission mode is not touched', async () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    const answer = { task: { id: TASK, status: 'running', dialogue: [] } };
    serve({ '/api/tasks/start': answer, '/api/tasks/continue': answer });
    const fresh = await screen(wanted, 'ConversationView', { store: { selectedTaskId: '' } });
    await send(fresh)('Plan it', []);
    const resting = await screen(wanted, 'ConversationView', { tasks: [task({ status: 'completed', state: 'completed', planMode: false, planOnly: false })] });
    await send(resting)('Plan it', []);
    const ordinary = await screen(plain, 'ConversationView', { store: { selectedTaskId: '' } });
    await send(ordinary)('Do it', []);
    const held = await screen(wanted, 'ConversationView', { tasks: [task({ status: 'paused', state: 'paused', planMode: true, planOnly: true })] });
    await send(held)('Go on', []);
    const started = calls.filter(([route]) => route.startsWith('/api/tasks/'));
    assert.deepEqual(started.map(([route, body]) => [route, body.planMode]), [
      ['/api/tasks/start', true], ['/api/tasks/continue', true], ['/api/tasks/start', undefined], ['/api/tasks/continue', undefined],
    ]);
    assert.equal(calls.some(([route]) => route.includes('permissions')), false);
  } finally { delete globalThis.localStorage; }
});

test('with the Browser Companion as the transport the composer is given no Plan entry and nothing is sent', async () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    serve({ '/api/tasks/start': { task: { id: TASK, status: 'running', dialogue: [] } } });
    const hub = { workspace: { path: '/w' }, workspaces: { activePath: '/w', items: [] }, tasks: [], agent: { mode: 'chatgpt-web', tasks: [] }, studio: { permissions: { mode: 'review', pending: [], recent: [] } }, browser: { connected: true, paired: true }, ai: { profiles: [] } };
    const shot = await screen(wanted, 'ConversationView', { hub, store: { selectedTaskId: '' } });
    assert.equal(composerProps(shot).plan.offered, false);
    await send(shot)('Do it', []);
    assert.equal('planMode' in calls.find(([route]) => route === '/api/tasks/start')[1], false);
  } finally { delete globalThis.localStorage; }
});

test('the conversation shows the card of its plan request with the mode of the gate, and the banner says that the plan waits', async () => {
  const request = await hubRequest();
  const hub = { workspace: { path: '/w' }, workspaces: { activePath: '/w', items: [] }, tasks: [], agent: { mode: 'api', tasks: [] }, studio: { permissions: { mode: 'readonly', pending: [request], recent: [] } }, browser: {}, ai: { profiles: [] } };
  const shot = await screen(plain, 'ConversationView', { hub, plans: [plan(2)], tasks: [task({ planMode: true, planOnly: true, planApproval: null })] });
  assert.equal(testId(shot.root, 'plan-approval').length, 1);
  assert.match(shot.root.text, /Read-only is on/);
  assert.match(testId(shot.root, 'plan-line')[0].text, /waits for your answer/);
});

// ---- the banner ----------------------------------------------------------------------------------------------------------------------------------------

const line = (kind, more = {}) => ({ kind, held: kind !== 'approved', revision: 3, execution: null, edited: false, ...more });
const banner = (props, lang = 'en') => screen(plain, 'StateBanner', { props, lang });

test('the banner has a line for plan mode, in every state a held task can be in', async () => {
  for (const [kind, words] of [
    ['planning', /reads and writes a plan; it cannot change anything until you approve it/], ['waiting', /The plan waits for your answer/], ['denied', /You asked for changes to revision 3/],
    ['expired', /revision 3 was not answered in time/], ['unanswerable', /Nobody could be asked about revision 3/],
  ]) {
    for (const status of ['running', 'waiting_approval', 'completed', 'paused', 'failed']) {
      const shot = await banner({ status, plan: line(kind), onResume() {}, onRetry() {} });
      assert.match(testId(shot.root, 'plan-line')[0].text, words, `${kind} while ${status}`);
      assert.match(shot.root.text, /Plan mode/);
      english(shot, kind);
      accessible(shot, kind);
    }
  }
});

test('an approved plan has a line only where there is a banner anyway, and it names the execution the owner chose', async () => {
  assert.equal((await banner({ status: 'completed', plan: line('approved') })).html, '');
  assert.equal((await banner({ status: 'running', plan: line('approved') })).html, '');
  const shot = await banner({ status: 'paused', plan: line('approved', { execution: 'autonomous', edited: true }) });
  assert.match(testId(shot.root, 'plan-line')[0].text, /Revision 3 of the plan was approved after your edit; this conversation runs in Autonomous\./);
  assert.match((await banner({ status: 'paused', plan: line('approved', { execution: 'review' }) })).root.text, /Revision 3 of the plan was approved; this conversation runs in Review\./);
  assert.match((await banner({ status: 'paused', plan: line('approved') })).root.text, /Revision 3 of the plan was approved\./);
});

test('a task with no plan mode has the banner it always had', async () => {
  assert.equal((await banner({ status: 'completed' })).html, '');
  const shot = await banner({ status: 'paused', plan: null, onResume() {} });
  assert.equal(testId(shot.root, 'plan-line').length, 0);
  assert.match(shot.root.text, /Continue/);
  const held = await banner({ status: 'paused', plan: line('denied'), onResume() {} });
  assert.match(held.root.text, /Continue/, 'and a held one keeps its next step');
  assert.equal(buttons((await banner({ status: 'completed', plan: line('denied') })).root).length, 0);
});

// ---- words and wiring -----------------------------------------------------------------------------------------------------------------------------------

test('every word of plan mode is in both languages, and the English ones are English', () => {
  const keys = Object.keys(translations.vi).filter((key) => key.startsWith('plan_'));
  assert.ok(keys.length > 60, `${keys.length} keys`);
  assert.deepEqual(Object.keys(translations.en).filter((key) => key.startsWith('plan_')), keys);
  for (const key of keys) {
    assert.ok(translations.en[key].trim() && translations.vi[key].trim(), key);
    assert.doesNotMatch(translations.en[key], DIACRITICS, key);
    const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();
    assert.deepEqual(names(translations.en[key]), names(translations.vi[key]), `${key}: the same placeholders`);
  }
});

test('the card and the tab read the plan under one key every 2.5 s, and the draft is in a store, not in the tab', () => {
  const read = (file) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const hook = read('components/plan/usePlan.ts');
  assert.match(hook, /queryKey: \['plan', taskId\]/);
  assert.match(hook, /refetchInterval: 2500/);
  assert.match(hook, /usePlanDrafts/);
  for (const file of ['components/inspector/PlanTab.tsx', 'components/approval/PlanApprovalCard.tsx']) assert.match(read(file), /usePlan\(/, file);
});
