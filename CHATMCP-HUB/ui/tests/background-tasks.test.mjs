import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, all, accessibleName, duplicateIds, unnamedControls, brokenReferences } from './support/html.mjs';

// The Background section of the Agents tab (“Công việc nền”): the Hub's list of background runs, grouped by folder and conversation, and the
// workflow cards that belong to a run. Its Vietnamese is what the screen said before its words moved into the dictionary (ui/e2e/agents.spec.mjs
// matches some of it), so these tests pin that text; its English is dictionary text, so on the English screen nothing may read Vietnamese.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { BackgroundTasks } from './src/components/layout/BackgroundTasks';
  import { WorkflowCard } from './src/components/conversation/WorkflowCard';
  import { taskStateLabel } from './src/lib/task-view';
  import { taskStateText } from './src/components/inspector/agentLabels';
  import { translations, translate } from './src/lib/i18n';
  export { BackgroundTasks, WorkflowCard, taskStateLabel, taskStateText, translations, translate };
`, 'chatmcp-background-');
after(dispose);
const { renderWith, BackgroundTasks, WorkflowCard, taskStateLabel, taskStateText, translations, translate } = loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
/** A dictionary key printed instead of its text. Fixture ids below use hyphens, so nothing else can look like one. */
const RAW_KEY = /\b(?:agent|agents|group|coding)_[a-z_]+\b/;

// ---- the Hub's answers, in plain ASCII so that any Vietnamese on the English screen can only come from the component ----
const ALPHA = '/work/alpha', BETA = '/work/beta', GAMMA = '/work/gamma';
const hubState = (overrides = {}) => ({
  workspace: { path: ALPHA },
  workspaces: { activePath: ALPHA, items: [{ path: ALPHA, name: 'alpha' }, { path: BETA, name: 'beta' }, { path: GAMMA, name: 'gamma' }] },
  tasks: [{ id: 'chat-1', task: 'Fix the login page' }, { id: 'chat-2' }, { id: 'chat-3', task: 'Write the docs' }],
  agent: { tasks: [] },
  ...overrides,
});
const subagent = (id, status, extra = {}) => ({ id, taskId: id, parentTaskId: 'task-run-1', title: `Helper ${id}`, status, startedAt: '2026-10-20T10:00:00Z', ...extra });
const run = (id, overrides = {}) => ({
  id, taskId: `task-${id}`, conversationId: 'chat-1', workspacePath: ALPHA, title: `Run ${id}`, status: 'completed',
  startedAt: '2026-10-20T10:00:00Z', finishedAt: '2026-10-20T10:03:05Z', subagents: [], conversationUsage: { inputTokens: 1200, outputTokens: 800 }, ...overrides,
});
const workflow = (overrides = {}) => ({
  id: 'wf-1', name: 'Review and verify', conversationId: 'chat-1', parentRunId: 'run-1', workspacePath: ALPHA, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:01:00Z',
  finishedAt: '2026-10-20T10:04:00Z', status: 'running', error: null, completed: 1, total: 3, activeAgents: 1, failedAgents: 0, usage: { inputTokens: 1500, outputTokens: 700, httpRequests: 4 },
  phases: [
    { id: 'ph-1', name: 'Review', dependsOn: [], status: 'running', completed: 1, total: 2, agents: [
      { id: 'ag-1', taskId: 'sub-r1', role: 'Security', goal: 'Inspect the security evidence', status: 'completed', model: 'mock-coder', startedAt: '2026-10-20T10:00:00Z', finishedAt: '2026-10-20T10:01:00Z', resultPreview: 'Nothing found' },
      { id: 'ag-2', taskId: 'sub-r2', role: 'Correctness', goal: 'Inspect the correctness evidence', status: 'running', model: null, startedAt: '2026-10-20T10:00:00Z', finishedAt: null },
    ] },
    { id: 'ph-2', name: 'Verify', dependsOn: ['ph-1'], status: 'queued', completed: 0, total: 1, agents: [] },
  ],
  ...overrides,
});

// five runs in three folders: running with two helpers, finished with one, paused with none (in a chat that has no text), failed, and one in a state the labels do not know
const busy = {
  tasks: [
    run('run-1', { status: 'running', finishedAt: undefined, subagents: [subagent('sub-a', 'running', { branch: 'chatmcp/sub-a' }), subagent('sub-b', 'completed')] }),
    run('run-2', { subagents: [subagent('sub-c', 'completed')], startedAt: '2026-10-20T09:00:00Z' }),
    run('run-3', { status: 'paused', conversationId: 'chat-2' }),
    run('run-4', { status: 'failed', workspacePath: BETA, conversationId: 'chat-3' }),
    run('run-5', { status: 'preparing', workspacePath: GAMMA, conversationId: 'chat-4', conversationUsage: null }),
  ],
  workflows: [workflow()],
};
const quiet = { tasks: [], workflows: [] };
const mine = { selectedTaskId: 'chat-1', selectedWorkspacePath: ALPHA };

const page = async (data, store = {}, hub = hubState()) => parseHtml(await renderWith(BackgroundTasks, {}, [[['hubState'], hub], [['backgroundRuns'], data]], [], store));
const html = async (data, store = {}, hub = hubState()) => renderWith(BackgroundTasks, {}, [[['hubState'], hub], [['backgroundRuns'], data]], [], store);
const testId = (root, id) => all(root).filter((node) => node.attrs['data-testid'] === id);
const card = (root, runId) => testId(root, 'background-task').find((node) => node.attrs['data-run'] === runId);
const buttons = (root) => byTag(root, 'button').map((node) => ({ node, name: accessibleName(root, node), disabled: 'disabled' in node.attrs }));
const buttonNamed = (root, name) => buttons(root).find((item) => item.name === name);
const workspaceButton = (root, folder) => byTag(root, 'button').find((node) => node.attrs.title === folder);
/** The Hub's list of runs and nothing else cached: the Hub's own state has not answered yet. */
const unanswered = async (data, store = {}) => parseHtml(await renderWith(BackgroundTasks, {}, [[['backgroundRuns'], data]], [], store));
/** A run in a folder whose name is nothing (the root), so that the screen has to make one up. */
const nameless = { tasks: [run('run-9', { workspacePath: '/', conversationId: 'chat-9', subagents: [] })], workflows: [] };

// ---- Vietnamese: what the screen said before ----

test('in Vietnamese the section says what it said before its words moved into the dictionary', async () => {
  const root = await page(busy, mine);
  const text = root.text;
  assert.ok(text.includes('2 đang thực hiện · 5 tác vụ (không tính hội thoại)'), 'the summary line: two in progress, five tasks');
  const scopes = all(root).find((node) => node.attrs['aria-label'] === 'Lọc background tasks');
  assert.deepEqual(byTag(scopes, 'button').map((node) => node.text), ['Tất cả', 'Workspace này', 'Hội thoại này']);
  assert.ok(byTag(scopes, 'button').every((node) => !('disabled' in node.attrs)), 'a folder and a conversation are chosen, so all three scopes are open');
  assert.ok(workspaceButton(root, ALPHA).text.includes('alpha') && workspaceButton(root, ALPHA).text.endsWith('3 task'));
  assert.ok(workspaceButton(root, BETA).text.endsWith('1 task'));
  const chats = testId(root, 'background-conversation').map((node) => byTag(node, 'button')[0].text);
  assert.ok(chats.includes('Fix the login page2') && chats.includes('Cuộc hội thoại1'), `a chat with no text is called "Cuộc hội thoại": ${chats.join(' | ')}`);
  assert.ok(card(root, 'run-1').text.includes('2 subagents') && card(root, 'run-2').text.includes('1 subagent') && !card(root, 'run-2').text.includes('1 subagents') && card(root, 'run-3').text.includes('0 subagents'));
  assert.ok(card(root, 'run-1').text.includes('2.0k tokens (chat)'));
  assert.equal(all(card(root, 'run-1')).find((node) => node.attrs.title?.startsWith('Tokens')).attrs.title, 'Tokens cộng dồn toàn hội thoại, không phải riêng task này');
  assert.ok(!card(root, 'run-5').text.includes('tokens'), 'a run with no usage figures shows none');
});

test('in Vietnamese a run is described with the words of lib/task-view, and a state without a word is shown as the Hub wrote it', async () => {
  const root = await page(busy, mine);
  for (const [id, state] of [['run-1', 'running'], ['run-2', 'completed'], ['run-3', 'paused'], ['run-4', 'failed']]) {
    assert.ok(card(root, id).text.includes(taskStateLabel(state)), `${id}: ${taskStateLabel(state)}`);
  }
  assert.ok(card(root, 'run-2').text.includes('Đã nhận phản hồi kết thúc'), 'a final reply is not called a success');
  assert.ok(card(root, 'run-5').text.includes('preparing'), 'the Hub has no label for "preparing": it is shown as written');
  const detached = await page(busy, mine, hubState({ workspaces: { activePath: ALPHA, items: [{ path: '/work/other', name: 'other' }] } }));
  assert.ok(detached.text.includes('Không có background task nào thuộc phạm vi đang chọn.'), 'tasks exist but none belongs to a folder that is open');
  const empty = await page(quiet);
  assert.ok(empty.text.includes('Chưa có công việc nền. Agent có thể giao task cho subagent trong lúc bạn chat hoặc mở workspace khác.'));
  assert.equal(buttonNamed(empty, 'Workspace này').disabled, false, 'the Hub has a folder open, so “this workspace” can be chosen');
  assert.equal(buttonNamed(empty, 'Hội thoại này').disabled, true, 'and no conversation is selected, so “this conversation” cannot');
  const folderless = await unanswered(nameless);
  assert.ok(workspaceButton(folderless, '/').text.startsWith('Workspace'), 'a folder with no name of its own is called “Workspace”');
  assert.equal(buttonNamed(folderless, 'Workspace này').disabled, true, 'and with no folder known, neither is “this workspace”');
});

test('in Vietnamese the workflow card keeps its words, its English ones included (the e2e matches “3/3 completed”)', async () => {
  const root = await page(busy, mine);
  const flow = testId(root, 'background-workflow')[0];
  assert.ok(flow, 'the workflow sits under the run it belongs to');
  const text = flow.text;
  for (const expected of ['Review and verify', 'Workflow running', '3 agents', '1/3 completed', '2.2k tokens', 'Phases', 'Review', 'Verify',
    'Kết quả cần được kiểm chứng bằng mã nguồn, diff và test thực tế. Các Git worktree không được tự động merge.']) assert.ok(text.includes(expected), expected);
  const stop = buttonNamed(flow, 'Dừng workflow Review and verify');
  assert.ok(stop && stop.node.attrs.title === 'Dừng workflow và các agent con', 'the stop button is named and has its tooltip');
  assert.ok(all(flow).some((node) => node.attrs['aria-label'] === 'Tiến độ workflow'));
  assert.ok(all(flow).some((node) => node.attrs.title === 'Số token được provider báo cáo từ các agent con'));
  const open = parseHtml(await renderWith(WorkflowCard, { workflow: workflow() }, [], [], {}));
  assert.ok(open.text.includes('Đang giao việc cho các agent…'), 'a phase with no agents yet says the work is being handed out');
  assert.match(parseHtml(await renderWith(WorkflowCard, { workflow: workflow({ status: 'completed', completed: 3, activeAgents: 0 }) })).text, /Workflow completed.*3 agents.*3\/3 completed/);
});

// ---- English: the same screen with nothing left in Vietnamese ----

test('the English section has no Vietnamese in it, in its text or in a title or label, and no raw dictionary key', async () => {
  const closed = hubState({ workspaces: { activePath: ALPHA, items: [{ path: '/work/other', name: 'other' }] } });
  const screens = [
    ['busy', () => html(busy, { ...mine, lang: 'en' })],
    ['empty', () => html(quiet, { lang: 'en' })],
    ['tasks of a folder that is not open', () => html(busy, { ...mine, lang: 'en' }, closed)],
    ['a folder with no name, the Hub not answered', () => renderWith(BackgroundTasks, {}, [[['backgroundRuns'], nameless]], [], { lang: 'en' })],
  ];
  for (const [name, render] of screens) {
    const markup = await render();
    assert.doesNotMatch(markup, DIACRITICS, `${name}: Vietnamese on the English screen: ${markup.match(new RegExp(`.{0,40}${DIACRITICS.source}.{0,40}`, 'i'))?.[0]}`);
    assert.doesNotMatch(markup, RAW_KEY, `${name}: a dictionary key was shown instead of text: ${markup.match(RAW_KEY)?.[0]}`);
  }
});

test('the English section says in English what the Vietnamese one says', async () => {
  const root = await page(busy, { ...mine, lang: 'en' });
  const text = root.text;
  assert.ok(text.includes('In progress: 2 · Tasks: 5 (conversations not counted)'), 'the summary line');
  const scopes = all(root).find((node) => node.attrs['aria-label'] === 'Filter background tasks');
  assert.deepEqual(byTag(scopes, 'button').map((node) => node.text), ['All', 'This workspace', 'This conversation']);
  assert.ok(workspaceButton(root, ALPHA).text.endsWith('3 tasks') && workspaceButton(root, BETA).text.endsWith('1 task'), 'a count reads as English: 3 tasks, 1 task');
  const chats = testId(root, 'background-conversation').map((node) => byTag(node, 'button')[0].text);
  assert.ok(chats.includes('Conversation1'), `a chat with no text is called "Conversation": ${chats.join(' | ')}`);
  assert.ok(card(root, 'run-1').text.includes('2 subagents') && card(root, 'run-2').text.includes('1 subagent') && !card(root, 'run-2').text.includes('1 subagents') && card(root, 'run-3').text.includes('0 subagents'));
  assert.ok(card(root, 'run-1').text.includes('2.0k tokens (chat)'));
  assert.equal(all(card(root, 'run-1')).find((node) => node.attrs.title?.startsWith('Tokens')).attrs.title, 'Tokens added up over the whole conversation, not for this task alone');
  const empty = await page(quiet, { lang: 'en' });
  assert.ok(empty.text.includes('No background work yet. The agent can hand tasks to subagents while you chat or have another workspace open.'));
  const detached = await page(busy, { ...mine, lang: 'en' }, hubState({ workspaces: { activePath: ALPHA, items: [{ path: '/work/other', name: 'other' }] } }));
  assert.ok(detached.text.includes('No background task falls within the selected scope.'));
});

test('a run is described in English without calling a final reply a success, and a state without a word is still shown as written', async () => {
  const root = await page(busy, { ...mine, lang: 'en' });
  for (const [id, words] of [['run-1', 'Running'], ['run-2', 'Final reply received'], ['run-3', 'Paused'], ['run-4', 'Failed'], ['run-5', 'preparing']]) {
    assert.ok(card(root, id).text.includes(words), `${id}: ${words} — ${card(root, id).text}`);
  }
  assert.ok(!card(root, 'run-2').text.includes('Completed') && !card(root, 'run-2').text.includes('Succeeded'), 'the Hub only knows that the model sent a closing reply');
});

test('the workflow card on the English screen is English, with a correct plural', async () => {
  const root = await page(busy, { ...mine, lang: 'en' });
  const flow = testId(root, 'background-workflow')[0];
  const stop = buttonNamed(flow, 'Stop workflow Review and verify');
  assert.ok(stop && stop.node.attrs.title === 'Stop the workflow and its subagents');
  assert.ok(all(flow).some((node) => node.attrs['aria-label'] === 'Workflow progress'));
  assert.ok(all(flow).some((node) => node.attrs.title === 'Tokens reported by the provider for the subagents'));
  assert.ok(flow.text.includes('3 agents') && flow.text.includes('1/3 completed') && flow.text.includes('Phases'));
  assert.ok(flow.text.includes('Results need to be checked against the source code, the diff and real tests. Git worktrees are not merged automatically.'));
  const open = parseHtml(await renderWith(WorkflowCard, { workflow: workflow() }, [], [], { lang: 'en' }));
  assert.ok(open.text.includes('Handing out the work to the agents…'));
  const single = parseHtml(await renderWith(WorkflowCard, { workflow: workflow({ total: 1, completed: 0, phases: [] }) }, [], [], { lang: 'en' }));
  assert.ok(single.text.includes('1 agent') && !single.text.includes('1 agents'), 'one agent is not “1 agents” on the English screen');
  assert.doesNotMatch(await renderWith(WorkflowCard, { workflow: workflow() }, [], [], { lang: 'en' }), DIACRITICS);
});

// ---- the dictionary behind it ----

/** The states lib/task-view.ts has a word for: read from its source, so that a state added there without a dictionary entry fails here. */
function labelledStates() {
  const source = fs.readFileSync(new URL('../src/lib/task-view.ts', import.meta.url), 'utf8');
  const block = /const stateLabels[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/\b([a-z_]+):\s*'/g)].map((match) => match[1]);
}

test('every state lib/task-view.ts has a word for has the same Vietnamese word in the dictionary, and an English one', () => {
  const states = labelledStates();
  assert.ok(states.length >= 11 && states.includes('completed') && states.includes('waiting_approval'), `read the states of task-view.ts: ${states.join(', ')}`);
  for (const state of states) {
    assert.equal(translations.vi[`agents_bg_state_${state}`], taskStateLabel(state), `vi: ${state}`);
    const english = translations.en[`agents_bg_state_${state}`];
    assert.ok(english?.trim(), `en: ${state} has no word`);
    assert.doesNotMatch(english, DIACRITICS, `en: ${state} still reads Vietnamese: ${english}`);
  }
  assert.equal(translations.vi.agents_bg_no_state, taskStateLabel(''), 'the word for “no state at all”');
  assert.ok(translations.en.agents_bg_no_state?.trim() && !DIACRITICS.test(translations.en.agents_bg_no_state));
  assert.match(translations.en.agents_bg_state_completed, /^Final reply received$/, 'completed means the model closed the loop, not that the work is right');
});

test('taskStateText speaks the language it is given, reads no state as unknown, and shows a state it has no word for as written', () => {
  for (const lang of ['vi', 'en']) {
    const t = (key, params) => translate(lang, key, params);
    assert.equal(taskStateText('running', t), translations[lang].agents_bg_state_running, lang);
    assert.equal(taskStateText('', t), translations[lang].agents_bg_no_state, `${lang}: an empty state`);
    assert.equal(taskStateText(undefined, t), translations[lang].agents_bg_no_state, `${lang}: no state at all`);
    for (const odd of ['preparing', 'Some New State', 'constructor', 'agents_bg_no_state']) assert.equal(taskStateText(odd, t), odd, `${lang}: ${odd} is shown as the Hub wrote it, not as a key or a prototype member`);
  }
  assert.equal(taskStateText('failed', (key) => translate('vi', key)), taskStateLabel('failed'));
  assert.equal(taskStateText(undefined, (key) => translate('vi', key)), taskStateLabel(undefined), 'the Vietnamese for “no state” is the old one too');
});

test('the counts of the section have a singular and a plural in both languages, and the Vietnamese ones keep the plural they always had', () => {
  for (const key of ['agents_bg_subagents', 'agents_bg_tasks', 'agents_wf_agents']) {
    for (const lang of ['vi', 'en']) {
      for (const form of ['one', 'other']) assert.match(translations[lang][`${key}_${form}`] ?? '', /\{n\}/, `${lang}.${key}_${form} has no {n}`);
    }
  }
  assert.equal(translations.vi.agents_bg_subagents_one, '{n} subagent');
  assert.equal(translations.vi.agents_bg_subagents_other, '{n} subagents');
  assert.equal(translations.vi.agents_bg_tasks_one, translations.vi.agents_bg_tasks_other, 'Vietnamese has no plural: it said “task” for any number');
  assert.equal(translations.vi.agents_wf_agents_one, '{n} agents', 'the Vietnamese screen said “1 agents” and keeps saying so');
  assert.equal(translations.en.agents_wf_agents_one, '{n} agent');
});

// ---- the same screen must be usable with a screen reader ----

test('every control has a name, every id is used once and every reference points somewhere, in both languages', async () => {
  for (const data of [busy, quiet]) {
    for (const lang of ['vi', 'en']) {
      const root = await page(data, { ...mine, lang });
      assert.deepEqual(unnamedControls(root), [], `${lang}: unnamed controls`);
      assert.deepEqual(duplicateIds(root), [], `${lang}: duplicate ids`);
      assert.deepEqual(brokenReferences(root), [], `${lang}: references to nothing`);
    }
  }
  const root = await page(busy, { ...mine, lang: 'en' });
  const named = buttons(root).map((item) => item.name);
  assert.ok(named.includes('Stop workflow Review and verify') && named.includes('Fix the login page2'), `the buttons a reader is offered: ${named.join(' | ')}`);
});
