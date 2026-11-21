import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bundleTsx, renderPrelude, ui } from './support/bundle.mjs';

// Switching to a folder that is already in the Hub's list (a folder row of the sidebar, a conversation of another folder, a row of the background
// panel) is the owner's choice the moment they click. The screen used to record it only after the Hub had answered POST /api/workspaces/activate,
// and a message sent in between started its task in the folder the screen still held, the old one. CI run 44813034061 (ubuntu, e2e/agents.spec.mjs)
// did exactly that: the Hub took 117 ms to answer the activation, the page sent POST /api/tasks/start 104 ms after the click, and its body named
// the primary workspace while the header (drawn after the answer) named the second one.
//
// These tests hold the Hub's answer to the activation back and look at what the screen holds meanwhile, then let it go (or refuse it).
//
// Adding a folder (the sidebar's +, a typed folder, the header, Settings, the Git worktree picker) had the other half of the problem: the choice
// was recorded while the cached Hub state did not have the folder yet, and the sidebar puts a choice that is not in the cached list back to the
// cached active folder. In a real browser (the + test of e2e/agents.spec.mjs, run on the old screen) the folder just added stayed unchosen for good
// while the Hub had it active, and the header named the old one. A server render runs no effect, so here the test checks what the effect is given:
// the cached list and the store as the click left them.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { SessionSidebar as RealSessionSidebar } from './src/components/sessions/SessionSidebar';
  import { BackgroundTasks } from './src/components/layout/BackgroundTasks';
  import { ConversationView } from './src/components/conversation/ConversationView';
  import { ConfirmContext } from './src/components/ui/ConfirmDialog';
  const SessionSidebar = (props) => <ConfirmContext.Provider value={() => Promise.resolve(false)}><RealSessionSidebar {...props} /></ConfirmContext.Provider>;
  export { SessionSidebar, BackgroundTasks, ConversationView, useAppStore };
`, 'chatmcp-workspace-choice-', { recordJsx: true });
after(dispose);
const { renderWith, SessionSidebar, BackgroundTasks, ConversationView, useAppStore } = loaded;

const ALPHA = '/work/alpha', BETA = '/work/beta', GAMMA = '/work/gamma';
/** The Hub's list once gamma is in it. */
const WITH_GAMMA = (activePath) => ({ activePath, items: [{ path: ALPHA, name: 'alpha' }, { path: BETA, name: 'beta' }, { path: GAMMA, name: 'gamma' }] });
const hubState = () => ({
  workspace: { path: ALPHA },
  workspaces: { activePath: ALPHA, items: [{ path: ALPHA, name: 'alpha' }, { path: BETA, name: 'beta' }] },
  tasks: [
    { id: 'chat-1', task: 'Fix the login page', status: 'completed', state: 'completed', workspacePath: ALPHA },
    { id: 'chat-3', task: 'Write the docs', status: 'completed', state: 'completed', workspacePath: BETA },
  ],
  agent: { mode: 'api', tasks: [] },
  studio: { permissions: { mode: 'review', pending: [], recent: [] } },
  browser: {},
  ai: { profiles: [] },
});
const backgroundRuns = () => ({
  tasks: [{ id: 'run-1', taskId: 'task-run-1', conversationId: 'chat-3', workspacePath: BETA, title: 'Run 1', status: 'completed', startedAt: '2026-10-20T10:00:00Z', subagents: [] }],
  workflows: [{ id: 'wf-1', name: 'Review', conversationId: 'chat-3', parentRunId: 'run-1', workspacePath: BETA, status: 'completed', completed: 1, total: 1, activeAgents: 0, failedAgents: 0, usage: {}, phases: [] }],
});

// ---- a Hub whose answers to an activation wait until the test lets them go ----
const calls = [];
const held = [];
const toasts = [];
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (route, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push({ route, body });
  if (route === '/api/workspaces/activate') {
    return new Promise((resolve) => held.push({
      answer: (list = { activePath: body.path, items: [] }) => resolve(reply(200, list)),
      refuse: () => resolve(reply(403, { error: 'This folder has not been selected through the workspace picker.', code: 'unregistered_workspace' })),
    }));
  }
  if (route === '/api/tasks/start') return reply(200, { task: { id: 'task-new', status: 'queued' } });
  if (route === '/api/tasks/continue') return reply(200, { task: { id: body.id, status: 'queued' } });
  if (route === '/api/workspace/browse') return reply(200, { path: GAMMA });
  if (route === '/api/workspaces/add') return reply(200, { workspace: { path: body.path, name: 'gamma' }, workspaces: WITH_GAMMA(ALPHA) });
  return reply(200, {});
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const settle = async () => { for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve)); };

/** Where the screen is before the click: the primary folder, one of its conversations open. */
beforeEach(() => {
  calls.length = 0; held.length = 0; toasts.length = 0;
  useAppStore.setState({ selectedWorkspacePath: ALPHA, selectedTaskId: 'chat-1', selectedBaseRef: 'refs/heads/feature' });
});
const now = () => { const { selectedWorkspacePath, selectedTaskId, selectedBaseRef } = useAppStore.getState(); return { selectedWorkspacePath, selectedTaskId, selectedBaseRef }; };
async function render(Component, extra = [], hub = hubState()) {
  globalThis.__chatmcpJsx = [];
  await renderWith(Component, {}, [[['hubState'], hub], ...extra], [], { ...now(), showToast: (message, type) => toasts.push([message, type]) });
  return globalThis.__chatmcpJsx.slice();
}
const handlerOf = (elements, match, prop = 'onClick') => {
  const found = elements.find((element) => match(element) && typeof element.props[prop] === 'function');
  assert.ok(found, `no element gave a ${prop}`);
  return found.props[prop];
};
const titled = (title) => (element) => element.type === 'button' && element.props.title === title;
const component = (name) => (element) => typeof element.type === 'function' && element.type.name === name;

/** The owner types a message right after the click: the conversation screen as the store now draws it sends it. */
async function sendNow(text) {
  const send = handlerOf(await render(ConversationView), component('Composer'), 'onSendMessage');
  const sent = await send(text, []);
  return { sent, start: calls.find((call) => call.route === '/api/tasks/start'), follow: calls.find((call) => call.route === '/api/tasks/continue') };
}

test('a folder chosen in the sidebar is the screen\'s at once: a message sent before the Hub answers the activation starts in that folder', async () => {
  // the steps of e2e/agents.spec.mjs: the folder row, "Hội thoại mới", type and send, each before the Hub has answered the activation
  const sidebar = await render(SessionSidebar);
  handlerOf(sidebar, titled(BETA))();
  await settle();
  assert.equal(held.length, 1, 'the Hub was asked to activate the folder and has not answered');
  assert.deepEqual(calls.map((call) => [call.route, call.body]), [['/api/workspaces/activate', { path: BETA }]]);
  handlerOf(sidebar, (element) => element.props?.variant === 'primary')();
  const { sent, start } = await sendNow('Summarize another workspace independently.');
  assert.equal(sent, true);
  assert.equal(start?.body.workspacePath, BETA, 'the task starts in the folder the owner chose, not in the one the Hub still had active');
  held[0].answer();
  await settle();
  assert.deepEqual(now(), { selectedWorkspacePath: BETA, selectedTaskId: 'task-new', selectedBaseRef: '' }, 'the Hub\'s late answer leaves the new conversation open');
  assert.deepEqual(toasts, []);
});

test('a folder the Hub refuses to activate puts the screen back where it was, with the Hub\'s words', async () => {
  handlerOf(await render(SessionSidebar), titled(BETA))();
  await settle();
  assert.deepEqual(now(), { selectedWorkspacePath: BETA, selectedTaskId: '', selectedBaseRef: '' }, 'recorded at the click: the folder, no conversation, no base ref');
  held[0].refuse();
  await settle();
  assert.deepEqual(now(), { selectedWorkspacePath: ALPHA, selectedTaskId: 'chat-1', selectedBaseRef: 'refs/heads/feature' }, 'the folder, the conversation and the base ref the owner had');
  assert.deepEqual(toasts, [['This folder has not been selected through the workspace picker.', 'error']]);
});

test('a refusal that comes after the owner moved on does not take the screen back', async () => {
  handlerOf(await render(SessionSidebar), titled(BETA))();
  await settle();
  await sendNow('Started before the refusal.');
  assert.equal(now().selectedTaskId, 'task-new');
  held[0].refuse();
  await settle();
  assert.deepEqual(now(), { selectedWorkspacePath: BETA, selectedTaskId: 'task-new', selectedBaseRef: '' }, 'the conversation the owner started stays open');
});

test('a conversation of another folder chosen in the sidebar is open at once: a follow-up sent before the Hub answers goes to it', async () => {
  handlerOf(await render(SessionSidebar), titled('Write the docs'))();
  await settle();
  assert.equal(held.length, 1);
  assert.deepEqual(calls.map((call) => [call.route, call.body]), [['/api/workspaces/activate', { path: BETA }]]);
  assert.deepEqual(now(), { selectedWorkspacePath: BETA, selectedTaskId: 'chat-3', selectedBaseRef: '' });
  const { sent, start, follow } = await sendNow('And the changelog too.');
  assert.equal(sent, true);
  assert.equal(start, undefined);
  assert.equal(follow?.body.id, 'chat-3', 'the follow-up goes to the conversation the owner opened, not to the one open before the click');
  held[0].refuse();
  await settle();
  assert.deepEqual(now(), { selectedWorkspacePath: BETA, selectedTaskId: 'chat-3', selectedBaseRef: '' }, 'as before: a conversation stays open when the Hub does not activate its folder');
  assert.deepEqual(toasts, []);
});

test('the background panel\'s folder, conversation and agent rows are the screen\'s at once too', async () => {
  const rows = [
    ['the folder row', (elements) => handlerOf(elements, titled(BETA)), { selectedWorkspacePath: BETA, selectedTaskId: '' }],
    ['the conversation row', (elements) => handlerOf(elements, titled('Write the docs')), { selectedWorkspacePath: BETA, selectedTaskId: 'chat-3' }],
    ['a workflow agent', (elements) => { const open = handlerOf(elements, component('WorkflowCard'), 'onOpenAgent'); return () => open('agent-7'); }, { selectedWorkspacePath: BETA, selectedTaskId: 'agent-7' }],
  ];
  for (const [row, pick, expected] of rows) {
    calls.length = 0; held.length = 0; toasts.length = 0;
    useAppStore.setState({ selectedWorkspacePath: ALPHA, selectedTaskId: 'chat-1', selectedBaseRef: 'refs/heads/feature' });
    pick(await render(BackgroundTasks, [[['backgroundRuns'], backgroundRuns()]]))();
    await settle();
    assert.equal(held.length, 1, `${row}: the Hub was asked to activate the folder and has not answered`);
    assert.deepEqual({ ...now(), selectedBaseRef: undefined }, { ...expected, selectedBaseRef: undefined }, `${row}: recorded at the click`);
    held[0].refuse();
    await settle();
    assert.deepEqual(now(), { selectedWorkspacePath: ALPHA, selectedTaskId: 'chat-1', selectedBaseRef: 'refs/heads/feature' }, `${row}: a refusal puts the screen back`);
    assert.equal(toasts.length, 1, `${row}: and says so`);
  }
});

test('a folder added with the sidebar\'s + is in the cached list and is the chosen one, even when an older poll of the Hub state answers after', async () => {
  const pick = handlerOf(await render(SessionSidebar), (element) => element.type === 'button' && element.props['aria-label'] === 'Thêm workspace');
  const client = globalThis.__chatmcpClient;
  client.setQueryData(['hubState'], hubState());
  // a poll that left before the Hub knew the folder and answers late, with the list as it was
  let late;
  const poll = client.fetchQuery({ queryKey: ['hubState'], staleTime: 0, queryFn: () => new Promise((resolve) => { late = resolve; }) }).catch(() => {});
  pick();
  await settle();
  assert.deepEqual(calls.map((call) => call.route), ['/api/workspace/browse', '/api/workspaces/add', '/api/workspaces/activate']);
  held[0].answer(WITH_GAMMA(GAMMA));
  await settle();
  late(hubState());
  await poll;
  await settle();
  assert.deepEqual(client.getQueryData(['hubState']).workspaces, WITH_GAMMA(GAMMA), 'the cached list is the Hub\'s answer to the activation, not the older poll');
  assert.deepEqual(now(), { selectedWorkspacePath: GAMMA, selectedTaskId: '', selectedBaseRef: '' });
  // drawn again from that cache and that store, the sidebar has gamma as its current folder, so its effect leaves the choice alone
  const again = await render(SessionSidebar, [], client.getQueryData(['hubState']));
  assert.equal(again.find(titled(GAMMA))?.props['aria-pressed'], true);
  assert.equal(again.find(titled(ALPHA))?.props['aria-pressed'], false);
  assert.deepEqual(toasts, []);
});

test('no screen waits for the Hub\'s activation before it records the choice: every activation is in lib/workspace-choice.ts, or opens its conversation first', () => {
  const src = path.join(ui, 'src');
  const found = [];
  for (const name of fs.readdirSync(src, { recursive: true })) {
    const file = path.join(src, name);
    if (!/\.tsx?$/.test(file)) continue;
    const count = (fs.readFileSync(file, 'utf8').match(/\bactivateWorkspace\(/g) || []).length;
    if (count) found.push([path.relative(src, file).replace(/\\/g, '/'), count]);
  }
  assert.deepEqual(found.sort(), [
    ['components/sessions/SessionSidebar.tsx', 1], // selectConversation: the conversation is opened first, and stays open when the Hub refuses
    ['lib/workspace-choice.ts', 2], // (lib/api.ts defines it as `activateWorkspace: (folder) =>`, which this does not count)
  ]);
});
