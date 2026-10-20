import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, byRole, all, accessibleName, duplicateIds, unnamedControls, brokenReferences } from './support/html.mjs';

// The coding side of the Agents tab: planning, starting, and above all how a worker's result is shown. The rule under test is the one the
// whole product keeps: what an AI says about its own work is its claim; only a check the Hub ran and verified is evidence.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { CodingWorkers } from './src/components/inspector/CodingWorkers';
  import { CodingRunView, RecoveryStatus } from './src/components/inspector/CodingRunView';
  import { ContextPanel, ReviewPanel } from './src/components/inspector/CodingReview';
  import { DiffView } from './src/components/inspector/DiffView';
  import { AiReport } from './src/components/inspector/agent-parts';
  import { ConfirmDialog } from './src/components/inspector/ConfirmDialog';
  export { CodingWorkers, CodingRunView, RecoveryStatus, ContextPanel, ReviewPanel, DiffView, AiReport, ConfirmDialog };
`, 'chatmcp-coding-');
after(dispose);
const { renderWith, CodingWorkers, CodingRunView, RecoveryStatus, ContextPanel, ReviewPanel, DiffView, AiReport, ConfirmDialog } = loaded;

const RUN = '11111111-2222-3333-4444-555555555555';
const hub = (overrides = {}) => ({ workspace: { path: '/project' }, workspaces: { activePath: '/project', items: [] }, studio: { permissions: { mode: 'autonomous', executionPolicy: 'host-review' } }, tasks: [], agent: { tasks: [] }, ...overrides });
const attempt = (overrides = {}) => ({ id: 'a1', checkId: 'c1', status: 'completed', exitCode: 0, testOutcomeVerified: true, snapshotHash: 'ab'.repeat(32), ...overrides });
const worker = (overrides = {}) => ({ id: 'task-a', status: 'ready_for_review', branch: 'chatmcp/coder/111111111111/task-a', changedFiles: ['calc.js'], commitSha: 'c'.repeat(40), dependsOn: [], verifyRequired: false, summary: 'Fixed add(). All tests pass and the task is complete.', ...overrides });
const verified = (overrides = {}) => worker({ verifyRequired: true, verificationOutcome: { state: 'ready_for_review', repairs: 0 }, verificationAttempts: [attempt()], ...overrides });
// A run belongs to the folder it was made in, which is the folder the Hub works on in these pages unless a test says otherwise (hub() below).
const job = (workers, overrides = {}) => ({ id: RUN, status: 'ready_for_review', workspace: '/project', baseSha: 'b'.repeat(40), baseBranch: 'main', createdAt: '2026-10-20T10:00:00Z', workers, integration: null, error: null, ...overrides });
const state = (jobs = [], overrides = {}) => ({ activeRunId: null, integrating: false, recoveryFault: null, jobs, ...overrides });
const draftTask = (overrides = {}) => ({ id: 'task-a', prompt: 'Add a note file', verify: false, dependsOn: [], ...overrides });

const page = async (coding, { mode = 'autonomous', store = {}, drafts = {}, errors = [], hubOverrides = {} } = {}) => parseHtml(await renderWith(CodingWorkers, {}, [
  [['hubState'], hub({ studio: { permissions: { mode } }, ...hubOverrides })], ...(coding ? [[['coding-runs'], coding]] : []),
], errors, store, drafts));
const issueTexts = (root) => all(root).filter((node) => node.attrs['data-testid'] === 'field-issue').map((node) => node.text);
const buttons = (root) => byTag(root, 'button').map((node) => ({ node, name: accessibleName(root, node), disabled: 'disabled' in node.attrs }));
const buttonNamed = (root, name) => buttons(root).find((item) => item.name === name);
const within = (root, testId) => all(root).find((node) => node.attrs['data-testid'] === testId);
const workerCard = (root, id) => all(root).find((node) => node.attrs['data-testid'] === 'coding-worker' && node.attrs['data-worker'] === id);
const proofOf = (card) => all({ descendants: () => card.descendants() }).find((node) => node.attrs['data-testid'] === 'agent-proof');
const ready = { drafts: { codingTasks: [draftTask()] } };
// The run view on its own, told by the page whether the Hub is running this run (`active`), whether the page itself is busy and whether the Hub says a run or merge is going on.
const view = async (run, { jobs, preselect = null, busy = false, hubBusy = false, active = false, blocked = false, primary = '/project', store = { lang: 'en' } } = {}) => parseHtml(await renderWith(CodingRunView, {
  run, jobs: jobs ?? [run], onPick() {}, busy, setBusy() {}, hubBusy, active, blocked, primary, refetch: async () => {}, preselect,
}, [[['hubState'], hub()]], [], store));

// ---------------------------------------------------------------------------------------------------------------------
// Whether coding workers can be started, and why not
// ---------------------------------------------------------------------------------------------------------------------
test('in Review mode the Hub would refuse the run, so the tab says why before the button is pressed', async () => {
  for (const [mode, label] of [['review', 'Review'], ['readonly', 'Chỉ đọc']]) {
    const root = await page(state(), { mode, ...ready });
    const notice = within(root, 'coding-needs-autonomous');
    assert.ok(notice.text.includes(label) && notice.text.includes('chế độ quyền là Tự động'), mode);
    assert.ok(buttonNamed(root, 'Bắt đầu sửa mã').disabled, `${mode}: start is off`);
    assert.ok(!buttonNamed(root, 'Mở cài đặt quyền').disabled, `${mode}: and the way to the setting is there`);
  }
  const en = await page(state(), { mode: 'review', store: { lang: 'en' }, ...ready });
  assert.ok(within(en, 'coding-needs-autonomous').text.includes('only allowed in Autonomous permission mode. The mode is Review'));
  assert.ok(buttonNamed(en, 'Open permission settings'));
});

test('in Autonomous mode a filled-in task can be started, and nothing warns about permissions', async () => {
  const root = await page(state(), ready);
  assert.equal(within(root, 'coding-needs-autonomous'), undefined);
  assert.equal(buttonNamed(root, 'Bắt đầu sửa mã').disabled, false);
  assert.equal(buttonNamed(root, 'Mở cài đặt quyền'), undefined);
});

test('an empty task cannot be started, and a task the Hub would refuse says why', async () => {
  assert.ok(buttonNamed(await page(state(), { drafts: { codingTasks: [draftTask({ prompt: '' })] } }), 'Bắt đầu sửa mã').disabled);
  const root = await page(state(), { store: { lang: 'en' }, drafts: { codingTasks: [
    draftTask({ id: 'task-a', dependsOn: ['task-b'] }), draftTask({ id: 'task-b', dependsOn: ['task-a'] }), draftTask({ id: 'Bad Id' }),
  ] } });
  const alerts = issueTexts(root);
  assert.ok(alerts.includes('The items wait for each other in a loop, so none of them can run.'), alerts.join(' | '));
  assert.ok(alerts.includes('An ID uses lowercase letters without accents, digits and dashes, and starts with a letter.'));
  // typing is not an emergency: the problems are read when the field is reached (its description), not shouted as alerts on every key
  assert.deepEqual(byRole(root, 'alert').filter((node) => alerts.includes(node.text)), []);
  const marked = byTag(root, 'input', 'textarea').filter((node) => node.attrs['aria-invalid'] === 'true');
  assert.ok(marked.length >= 2);
  for (const field of marked) assert.ok(all(root).some((node) => node.attrs.id === field.attrs['aria-describedby'] && node.text.trim()), `${field.attrs.id} points at its problem`);
  assert.ok(buttonNamed(root, 'Start code edits').disabled);
  assert.ok(root.text.includes('Fix the fields marked with a problem before starting.'));
});

test('a run in progress (from the Hub, not only from this page) keeps the start button off and offers Stop', async () => {
  const root = await page(state([job([worker({ status: 'running', summary: undefined })], { status: 'running' })], { activeRunId: RUN }), ready);
  assert.ok(buttonNamed(root, 'Đang sửa mã…').disabled);
  assert.ok(buttonNamed(root, 'Dừng sửa mã') && !buttonNamed(root, 'Dừng sửa mã').disabled);
  assert.ok(root.text.includes('Đang có một lần sửa mã hoặc gộp thay đổi chạy'));
  assert.equal(workerCard(root, 'task-a').attrs['data-kind'], 'working');
});

test('an unreadable recovery journal is an alert, and nothing new can be started over it', async () => {
  const root = await page(state([], { recoveryFault: 'Unreadable saved coding jobs' }), ready);
  const alert = byRole(root, 'alert').find((node) => node.text.includes('Unreadable saved coding jobs'));
  assert.ok(alert.text.includes('Các thao tác bị gián đoạn sẽ không tự chạy lại'));
  assert.ok(buttonNamed(root, 'Bắt đầu sửa mã').disabled);
});

test('a plan the owner asked for is previewed with its count, and the note says nothing has run', async () => {
  const root = await page(state(), { store: { lang: 'en' }, drafts: { codingGoal: 'x', codingPlanCount: 3, codingTasks: [draftTask(), draftTask({ id: 'task-2' }), draftTask({ id: 'task-3' })] } });
  assert.ok(byRole(root, 'status').some((node) => node.text === 'The preview has 3 tasks. No agent has run and Git is untouched.'));
  assert.equal(byTag(root, 'textarea').filter((node) => node.attrs.id?.startsWith('coding-task-')).length, 3);
  assert.ok(buttonNamed(root, 'Add task') && buttonNamed(root, 'Remove task 3'));
});

test('at most four tasks, and the last one cannot be removed', async () => {
  const four = await page(state(), { store: { lang: 'en' }, drafts: { codingTasks: ['a', 'b', 'c', 'd'].map((id) => draftTask({ id: `task-${id}` })) } });
  assert.ok(buttonNamed(four, 'Add task').disabled);
  const one = await page(state(), { store: { lang: 'en' }, ...ready });
  assert.ok(buttonNamed(one, 'Remove task 1').disabled);
});

// ---------------------------------------------------------------------------------------------------------------------
// States of the results
// ---------------------------------------------------------------------------------------------------------------------
test('no run yet is said plainly, and a list that cannot be loaded is an error and not an empty list', async () => {
  const empty = await page(state(), ready);
  assert.ok(empty.text.includes('Chưa có lần sửa mã nào'));
  assert.equal(within(empty, 'coding-result'), undefined);
  const failed = await page(null, { ...ready, errors: [[['coding-runs'], 'Hub is not answering']] });
  assert.ok(byRole(failed, 'alert').some((node) => node.text === 'Không tải được các lần sửa mã: Hub is not answering'));
  assert.ok(!failed.text.includes('Chưa có lần sửa mã nào'));
});

test('with several runs the owner can pick one; the active run is shown first, else the newest', async () => {
  const older = job([worker({ id: 'old-one' })], { id: 'aaaaaaaa-0000-0000-0000-000000000000', createdAt: '2026-10-19T09:00:00Z' });
  const newer = job([worker({ id: 'new-one' })], { id: 'bbbbbbbb-0000-0000-0000-000000000000', createdAt: '2026-10-20T09:00:00Z' });
  const root = await page(state([older, newer]), ready);
  assert.ok(workerCard(root, 'new-one') && !workerCard(root, 'old-one'));
  const pick = byTag(root, 'select').find((node) => node.attrs.id === 'coding-run-pick');
  assert.equal(byTag(pick, 'option').length, 2);
  assert.equal(accessibleName(root, pick), 'Lần chạy');
  const active = await page(state([older, newer], { activeRunId: older.id }), ready);
  assert.ok(workerCard(active, 'old-one') && !workerCard(active, 'new-one'));
  assert.equal(byTag(await page(state([newer]), ready), 'select').filter((node) => node.attrs.id === 'coding-run-pick').length, 0, 'one run needs no picker');
});

// ---------------------------------------------------------------------------------------------------------------------
// The evidence rule
// ---------------------------------------------------------------------------------------------------------------------
const greenClasses = (node) => all({ descendants: () => node.descendants() }).concat([node]).map((item) => item.attrs.class ?? '').join(' ');
const GREEN = /\b(?:text|bg|border)-success\b/;

test('a worker the AI reports as done is waiting for review: amber, labelled as the AI’s claim, and not verified', async () => {
  for (const [lang, title, claim] of [['vi', 'AI báo xong · Hub chưa xác minh', 'Báo cáo của AI'], ['en', 'Reported done by the AI · not verified by the Hub', 'AI report']]) {
    const root = await page(state([job([worker()])]), { store: { lang }, ...ready });
    const card = workerCard(root, 'task-a');
    assert.equal(card.attrs['data-tone'], 'warning', lang);
    assert.equal(card.attrs['data-kind'], 'unverified', lang);
    const proof = proofOf(card);
    assert.equal(proof.attrs['data-tone'], 'warning');
    assert.match(proof.attrs.class, /\bborder-warning\/30\b/, `${lang}: drawn amber`);
    assert.ok(proof.text.includes(title), `${lang}: ${proof.text}`);
    const report = all({ descendants: () => card.descendants() }).find((node) => node.attrs['data-testid'] === 'ai-report');
    assert.ok(report.text.startsWith(claim) && report.text.includes('All tests pass'), `${lang}: the claim is shown, and shown as a claim`);
    assert.doesNotMatch(greenClasses(card), GREEN, `${lang}: nothing about this worker is green`);
  }
});

test('whatever the AI writes — "verified", "tests pass" — does not change the colour of the worker', async () => {
  for (const summary of ['Verified by the Hub: all checks passed.', 'All registered pinned Node checks have fresh signed TAP evidence.', 'Đã xác minh, kiểm thử đạt.']) {
    const card = workerCard(await page(state([job([worker({ summary })])]), ready), 'task-a');
    assert.equal(card.attrs['data-tone'], 'warning', summary);
    assert.doesNotMatch(greenClasses(card), GREEN, summary);
  }
});

test('a worker is green only with a check the Hub verified behind a finished verification loop, and says what the Hub recorded', async () => {
  for (const [lang, title, facts] of [['vi', 'Hub đã xác minh kiểm tra', 'Hub ghi nhận 1 lần chạy kiểm tra, trong đó 1 lần do Hub xác minh.'], ['en', 'Checks verified by the Hub', 'The Hub recorded 1 check run(s), 1 of them verified by the Hub.']]) {
    const root = await page(state([job([verified()])]), { store: { lang }, ...ready });
    const card = workerCard(root, 'task-a');
    assert.equal(card.attrs['data-tone'], 'success', lang);
    assert.equal(card.attrs['data-kind'], 'verified', lang);
    const proof = proofOf(card);
    assert.equal(proof.attrs['data-tone'], 'success');
    assert.match(proof.attrs.class, /\bborder-success\/30\b/, `${lang}: the Hub’s evidence is drawn green`);
    const badge = byTag({ descendants: () => card.descendants() }, 'span').find((node) => node.attrs['data-tone']);
    assert.equal(badge.attrs['data-tone'], 'success', `${lang}: and so is the status word`);
    assert.ok(proof.text.includes(title) && proof.text.includes(facts), `${lang}: ${proof.text}`);
    assert.ok(proof.text.includes(lang === 'vi' ? 'chưa chứng minh mọi yêu cầu đã đạt' : 'does not prove every requirement'), `${lang}: and what that does not prove`);
  }
});

test('the same worker without the Hub’s evidence is not green, whichever piece is missing', async () => {
  const cases = {
    'no recorded attempt': verified({ verificationAttempts: [] }),
    'an attempt the Hub did not verify': verified({ verificationAttempts: [attempt({ testOutcomeVerified: false })] }),
    'the loop did not finish': verified({ verificationOutcome: { state: 'needs_attention' } }),
    'verification was not asked for': verified({ verifyRequired: false }),
  };
  for (const [name, entry] of Object.entries(cases)) {
    const card = workerCard(await page(state([job([entry])]), ready), 'task-a');
    assert.notEqual(card.attrs['data-tone'], 'success', name);
    assert.doesNotMatch(greenClasses(card), GREEN, name);
  }
});

test('a failed check, a failed worker and one that needs attention are red or amber, each in its own words', async () => {
  const cases = [
    ['check-failed', 'danger', 'Có kiểm tra thất bại', verified({ verificationAttempts: [attempt(), attempt({ id: 'a2', status: 'failed', exitCode: 1, testOutcomeVerified: false })] })],
    ['failed', 'danger', 'Công việc không hoàn tất', worker({ status: 'failed', error: 'Model returned nothing', summary: null })],
    ['attention', 'warning', 'Cần bạn kiểm tra', worker({ status: 'needs_attention', error: 'Check result is blocked', verifyRequired: true })],
    ['attention', 'warning', 'Cần bạn kiểm tra', worker({ status: 'interrupted', error: 'Interrupted by host restart' })],
    ['stopped', 'neutral', 'Đã dừng', worker({ status: 'cancelled' })],
    ['no-changes', 'neutral', 'Không có thay đổi', worker({ status: 'no_changes', changedFiles: [] })],
  ];
  for (const [kind, tone, title, entry] of cases) {
    const card = workerCard(await page(state([job([entry])]), ready), 'task-a');
    assert.equal(card.attrs['data-kind'], kind, entry.status);
    assert.equal(card.attrs['data-tone'], tone, entry.status);
    assert.ok(proofOf(card).text.includes(title), `${entry.status}: ${proofOf(card).text}`);
    if (entry.error) assert.ok(byRole({ descendants: () => card.descendants() }, 'alert').some((node) => node.text === entry.error), 'the real error is shown');
  }
});

test('while a worker is working the card says so and offers no review yet; one waiting for the owner says what it waits for', async () => {
  for (const [status, kind, tone] of [['queued', 'working', 'neutral'], ['running', 'working', 'neutral'], ['awaiting_test_grant', 'awaiting-grant', 'warning'], ['testing', 'working', 'neutral']]) {
    const root = await page(state([job([worker({ status, verifyRequired: true, summary: undefined })], { status: 'running' })], { activeRunId: RUN }), ready);
    const card = workerCard(root, 'task-a');
    assert.equal(card.attrs['data-kind'], kind, status);
    assert.equal(card.attrs['data-tone'], tone, status);
    assert.ok(!buttons({ descendants: () => card.descendants() }).some((item) => item.name === 'Xem thay đổi'), status);
  }
  const waiting = workerCard(await page(state([job([worker({ status: 'awaiting_test_grant', verifyRequired: true, summary: undefined })], { status: 'running' })], { activeRunId: RUN }), { store: { lang: 'en' }, ...ready }), 'task-a');
  assert.match(proofOf(waiting).text, /Waiting for your permission to run the test/);
  assert.match(proofOf(waiting).text, /about 90 seconds/, 'and for how long');
  assert.doesNotMatch(greenClasses(waiting), GREEN);
});

test('the workers of a run that is not going any more are stopped, whatever status the Hub saved for them', async () => {
  const workers = [worker({ id: 'a', status: 'running', summary: undefined }), worker({ id: 'b', status: 'queued', summary: undefined }), worker({ id: 'c', status: 'awaiting_test_grant', verifyRequired: true, summary: undefined })];
  // the Hub has no active run: the run was interrupted (a restart) or stopped, and nothing will finish these
  const stopped = await page(state([job(workers, { status: 'interrupted' })]), ready);
  assert.deepEqual(['a', 'b', 'c'].map((id) => workerCard(stopped, id).attrs['data-kind']), ['stopped', 'stopped', 'stopped']);
  assert.equal(proofOf(workerCard(stopped, 'a')).text.includes('Đang làm việc'), false, 'nothing says it is still working');
  // the same workers in the run the Hub is running are working
  const going = await page(state([job(workers, { status: 'running' })], { activeRunId: RUN }), ready);
  assert.deepEqual(['a', 'b', 'c'].map((id) => workerCard(going, id).attrs['data-kind']), ['working', 'working', 'awaiting-grant']);
  // and so does the run view on its own, told whether the Hub is running it
  assert.equal(workerCard(await view(job(workers, { status: 'running' }), { active: false }), 'a').attrs['data-kind'], 'stopped');
  assert.equal(workerCard(await view(job(workers, { status: 'running' }), { active: true }), 'a').attrs['data-kind'], 'working');
});

// ---------------------------------------------------------------------------------------------------------------------
// Reading, merging, publishing
// ---------------------------------------------------------------------------------------------------------------------
test('a ready worker offers its diff and file contents, and cannot be published before the diff is read', async () => {
  const root = await page(state([job([worker()])]), { store: { lang: 'en' }, ...ready });
  const card = workerCard(root, 'task-a');
  const own = buttons({ descendants: () => card.descendants() });
  assert.ok(own.find((item) => item.name === 'Read the changes' && !item.disabled));
  assert.ok(own.find((item) => item.name === 'View file contents' && !item.disabled));
  const publish = own.find((item) => item.name === 'Create a draft on GitHub');
  assert.ok(publish.disabled, 'locked until the diff is read');
  assert.ok(card.text.includes('Read the changes before creating a draft.'));
  assert.equal(publish.node.attrs['aria-describedby'], `publish-hint-task-a`, 'and the reason is attached to the button');
  assert.ok(byTag(root, 'p').some((node) => node.attrs.id === 'publish-hint-task-a'));
});

test('a worker that is not ready for review has no diff, no files and no publish button', async () => {
  const card = workerCard(await page(state([job([worker({ status: 'failed', error: 'x' })])]), ready), 'task-a');
  const names = buttons({ descendants: () => card.descendants() }).map((item) => item.name);
  assert.deepEqual(names, []);
});

test('merging needs a ready worker ticked and its diff read; publishing the merge needs the merge itself', async () => {
  const root = await page(state([job([worker(), worker({ id: 'task-b', branch: 'chatmcp/coder/111111111111/task-b' })])]), { store: { lang: 'en' }, ...ready });
  const integration = within(root, 'coding-integration');
  assert.ok(buttonNamed(integration, 'Merge the selected tasks').disabled);
  assert.ok(buttonNamed(integration, 'Push the merge to GitHub').disabled);
  assert.equal(buttonNamed(integration, 'Read the merged changes'), undefined, 'there is no merge to read yet');
  // both workers can be ticked (a run just started from this tab ticks the ready ones)
  const boxes = byTag(root, 'input').filter((node) => node.attrs.type === 'checkbox' && node.attrs['aria-label']?.startsWith('Select task'));
  assert.deepEqual(boxes.map((node) => node.attrs['aria-label']), ['Select task task-a for merging', 'Select task task-b for merging']);
  assert.ok(boxes.every((node) => !('disabled' in node.attrs)));
});

test('only one merge per run: once it exists the merge button is off and the merge can be read', async () => {
  const merged = job([worker()], { integration: { branch: 'chatmcp/integration/111111111111', status: 'ready_for_review', merged: ['task-a'], sha: 'd'.repeat(40) } });
  const root = await page(state([merged]), { store: { lang: 'en' }, ...ready });
  const integration = within(root, 'coding-integration');
  assert.ok(integration.text.includes('Merge: Waiting for your review · chatmcp/integration/111111111111'));
  assert.ok(buttonNamed(integration, 'Merge the selected tasks').disabled);
  assert.ok(buttonNamed(integration, 'Read the merged changes') && !buttonNamed(integration, 'Read the merged changes').disabled);
  assert.ok(buttonNamed(integration, 'Push the merge to GitHub').disabled, 'still locked: the merge’s diff has not been read');
});

test('a merge that conflicted shows the Hub’s own error and is amber, not green', async () => {
  const conflict = job([worker()], { integration: { branch: 'chatmcp/integration/111111111111', status: 'conflict', merged: [], failedWorker: 'task-a', error: 'CONFLICT (content): Merge conflict in calc.js' } });
  const root = await page(state([conflict]), ready);
  const integration = within(root, 'coding-integration');
  assert.ok(byRole(integration, 'alert').some((node) => node.text.includes('Merge conflict in calc.js')));
  assert.ok(integration.text.includes('Cần xử lý xung đột'));
  assert.doesNotMatch(greenClasses(integration), GREEN);
});

test('an interrupted run can be looked at, and recorded only after its log was read', async () => {
  const interrupted = job([worker({ status: 'interrupted', error: 'Worker interrupted by host restart.' })], { status: 'interrupted', error: 'Checkpoint and jobs.json disagree' });
  const root = await page(state([interrupted]), ready);
  const result = within(root, 'coding-result');
  assert.equal(result.attrs['data-status'], 'interrupted');
  assert.ok(byRole(result, 'alert').some((node) => node.text === 'Checkpoint and jobs.json disagree'));
  assert.ok(buttonNamed(result, 'Xem nhật ký khôi phục'));
  assert.equal(buttonNamed(result, 'Ghi nhận lần chạy bị gián đoạn'), undefined, 'recording needs the log first');
});

test('a worker’s published pull request is shown as text', async () => {
  const card = workerCard(await page(state([job([worker({ prUrl: 'https://github.com/o/r/pull/9' })])]), ready), 'task-a');
  assert.ok(card.text.includes('PR: https://github.com/o/r/pull/9'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Another folder in view, language, accessibility
// ---------------------------------------------------------------------------------------------------------------------
test('with another folder in view the coding forms are off and the notice names both folders', async () => {
  const root = await page(state([job([worker()])]), { store: { selectedWorkspacePath: '/elsewhere' }, hubOverrides: { workspaces: { activePath: '/elsewhere', items: [] } }, ...ready });
  assert.ok(byRole(root, 'status').some((node) => node.text.includes('/project') && node.text.includes('/elsewhere')));
  assert.ok(byTag(root, 'fieldset').every((node) => 'disabled' in node.attrs) && byTag(root, 'fieldset').length >= 1);
  assert.ok(buttonNamed(root, 'Bắt đầu sửa mã').disabled);
  assert.equal(within(root, 'coding-needs-autonomous'), undefined, 'the folder is the reason; permissions are not mentioned on top of it');
});

// ---------------------------------------------------------------------------------------------------------------------
// Whose runs are on screen: the runs of the folder in view, and a line that says so when others exist
// ---------------------------------------------------------------------------------------------------------------------
const OTHER_FOLDERS = {
  en: 'Only the code edits of the folder in view are shown. 3 run(s) belong to other folders and are not shown here.',
  vi: 'Chỉ hiện các lần sửa mã của thư mục đang xem. 3 lần sửa mã thuộc thư mục khác nên không hiện ở đây.',
};

test('only the runs of the folder in view are shown, and the page says how many belong to other folders', async () => {
  const mine = job([worker({ id: 'mine' })], { id: 'aaaaaaaa-0000-0000-0000-000000000000', createdAt: '2026-10-19T09:00:00Z' });
  const theirs = job([worker({ id: 'theirs' })], { id: 'bbbbbbbb-0000-0000-0000-000000000000', createdAt: '2026-10-20T09:00:00Z', workspace: '/elsewhere' });
  const unplaced = job([worker({ id: 'unplaced' })], { id: 'cccccccc-0000-0000-0000-000000000000', createdAt: '2026-10-20T10:00:00Z', workspace: null });
  const noField = job([worker({ id: 'nofield' })], { id: 'dddddddd-0000-0000-0000-000000000000', createdAt: '2026-10-20T11:00:00Z' });
  delete noField.workspace;
  for (const lang of ['en', 'vi']) {
    const root = await page(state([mine, theirs, unplaced, noField]), { store: { lang }, ...ready });
    // the newest runs overall are not this folder's: the page opens on the folder's own run
    assert.ok(workerCard(root, 'mine'), lang);
    for (const id of ['theirs', 'unplaced', 'nofield']) assert.equal(workerCard(root, id), undefined, `${lang}: ${id} belongs to no folder in view`);
    assert.equal(within(root, 'coding-result').attrs['data-run'], mine.id);
    assert.equal(byTag(root, 'select').filter((node) => node.attrs.id === 'coding-run-pick').length, 0, `${lang}: one run of this folder needs no picker`);
    const note = within(root, 'coding-other-folders');
    assert.equal(note.text, OTHER_FOLDERS[lang], lang);
    assert.equal(note.attrs.role, 'status');
    assert.equal(note.attrs['data-tone'], 'neutral', 'information, not an error');
    assert.ok(!root.text.includes(lang === 'en' ? 'No code edits yet' : 'Chưa có lần sửa mã nào'), `${lang}: the folder has a run, so it is not called empty`);
  }
});

test('the picker lists the runs of the folder in view and no other; the active run is shown first when it is this folder’s', async () => {
  const older = job([worker({ id: 'old-one' })], { id: 'aaaaaaaa-0000-0000-0000-000000000000', createdAt: '2026-10-19T09:00:00Z' });
  const other = job([worker({ id: 'other-one' })], { id: 'bbbbbbbb-0000-0000-0000-000000000000', createdAt: '2026-10-19T12:00:00Z', workspace: '/elsewhere' });
  const newer = job([worker({ id: 'new-one' })], { id: 'cccccccc-0000-0000-0000-000000000000', createdAt: '2026-10-20T09:00:00Z' });
  const root = await page(state([older, other, newer]), ready);
  const pick = byTag(root, 'select').find((node) => node.attrs.id === 'coding-run-pick');
  assert.equal(byTag(pick, 'option').length, 2, 'two runs of this folder, the third is somebody else’s');
  assert.deepEqual(byTag(pick, 'option').map((node) => node.attrs.value), [newer.id, older.id]);
  assert.ok(workerCard(root, 'new-one') && !workerCard(root, 'other-one'));
  // the Hub is running a run of another folder (it cannot be, but the page does not take it on faith): it is not this folder’s to show
  const odd = await page(state([older, other, newer], { activeRunId: other.id }), ready);
  assert.ok(workerCard(odd, 'new-one') && !workerCard(odd, 'other-one'));
  const active = await page(state([older, other, newer], { activeRunId: older.id }), ready);
  assert.ok(workerCard(active, 'old-one') && !workerCard(active, 'new-one'));
});

test('when every run is of the folder in view nothing is said about other folders', async () => {
  const root = await page(state([job([worker({ id: 'task-b' })], { id: 'aaaaaaaa-0000-0000-0000-000000000000' }), job([worker()])]), ready);
  assert.equal(within(root, 'coding-other-folders'), undefined);
  assert.ok(workerCard(root, 'task-a'));
  assert.equal(within(await page(state(), ready), 'coding-other-folders'), undefined, 'and with no run at all');
});

test('with another folder in view the runs of the Hub’s folder are not shown: the page says how many there are and why, and has nothing of them to read', async () => {
  // (the Hub lists runs oldest first: the Hub’s newest run, with a check on record, is the last of the list)
  const main = job([worker({ id: 'main-worker', verifyRequired: true, verificationAttempts: [attempt()], verificationOutcome: { state: 'ready_for_review' } })]);
  const earlier = job([worker({ id: 'main-earlier' })], { id: 'aaaaaaaa-0000-0000-0000-000000000000', createdAt: '2026-10-19T09:00:00Z' });
  const third = job([worker({ id: 'third-worker' })], { id: 'bbbbbbbb-0000-0000-0000-000000000000', workspace: '/third', createdAt: '2026-10-19T12:00:00Z' });
  for (const [lang, sentence, hint] of [
    ['en', 'Only the code edits of the folder in view are shown. 2 run(s) of the Hub’s main folder (/project) are not shown here, because you are looking at a different folder.', 'The Hub edits code only in its main folder, so the folder in view has no code edits.'],
    ['vi', 'Chỉ hiện các lần sửa mã của thư mục đang xem. 2 lần sửa mã của thư mục chính của Hub (/project) không hiện ở đây, vì bạn đang xem thư mục khác.', 'Hub chỉ sửa mã ở thư mục chính của nó, nên thư mục đang xem chưa có lần sửa mã nào.'],
  ]) {
    const root = await page(state([earlier, third, main]), { store: { lang, selectedWorkspacePath: '/elsewhere' }, ...ready });
    for (const id of ['main-worker', 'main-earlier', 'third-worker']) assert.equal(workerCard(root, id), undefined, `${lang}: ${id} is not of the folder in view`);
    assert.equal(within(root, 'coding-result'), undefined, lang);
    assert.equal(within(root, 'coding-other-folders').text, sentence, lang);
    assert.ok(root.text.includes(hint), `${lang}: the empty block does not send the owner to a form that is off`);
    assert.doesNotMatch(root.text, lang === 'en' ? /Describe the work above/ : /Mô tả việc cần làm ở trên/, lang);
    // the recorded checks of the main folder’s run are not shown under another folder either
    assert.equal(within(root, 'isolated-checks-panel'), undefined, `${lang}: the checks panel would otherwise fall back to the newest run of any folder`);
    assert.ok(buttonNamed(root, lang === 'en' ? 'Start code edits' : 'Bắt đầu sửa mã').disabled, lang);
  }
  // the same runs with the Hub’s own folder in view: its two runs are there and the third folder’s is the one counted
  const home = await page(state([earlier, third, main]), { store: { lang: 'en' }, ...ready });
  assert.ok(workerCard(home, 'main-worker') && !workerCard(home, 'third-worker'));
  assert.equal(within(home, 'coding-other-folders').text, 'Only the code edits of the folder in view are shown. 1 run(s) belong to other folders and are not shown here.');
  assert.ok(within(home, 'isolated-checks-panel'), 'the recorded check of the run on screen is shown, as before');
});

test('a folder with runs of other folders only, in view while the Hub works elsewhere, is told so without naming the Hub’s folder as having runs it has not', async () => {
  const third = job([worker({ id: 'third-worker' })], { workspace: '/third' });
  const root = await page(state([third]), { store: { lang: 'en', selectedWorkspacePath: '/elsewhere' }, ...ready });
  assert.equal(within(root, 'coding-other-folders').text, 'Only the code edits of the folder in view are shown. 1 run(s) belong to other folders and are not shown here.');
});

test('until the Hub has said which folder it works on the page does not guess whose runs are whose', async () => {
  // (no hubState in the cache at all: the answer the page needs to place the runs has not come)
  const root = parseHtml(await renderWith(CodingWorkers, {}, [[['coding-runs'], state([job([worker()])])]], [], { lang: 'en' }, ready.drafts));
  assert.ok(root.text.includes('Loading code edits…'));
  assert.equal(workerCard(root, 'task-a'), undefined);
  assert.equal(within(root, 'coding-other-folders'), undefined);
  assert.ok(!root.text.includes('No code edits yet'), 'an empty list would be a claim');
});

test('a run of the folder in view, while the Hub works on another folder, is a record to read and nothing to act on: the Hub would refuse every call', async () => {
  const merged = { branch: 'chatmcp/integration/111111111111', status: 'ready_for_review', merged: ['task-a'], sha: 'd'.repeat(40) };
  const old = job([worker({ summary: 'Fixed add().' })], { workspace: '/elsewhere', integration: merged });
  const calls = ['Read the changes', 'View file contents', 'Create a draft on GitHub', 'Merge the selected tasks', 'Read the merged changes', 'Push the merge to GitHub', 'View the recovery log'];
  const root = await page(state([old]), { store: { lang: 'en', selectedWorkspacePath: '/elsewhere' }, ...ready });
  assert.ok(workerCard(root, 'task-a'), 'the record is there');
  assert.equal(within(root, 'coding-run-foreign').text, 'This run belongs to the folder in view, not to the Hub’s main folder (/project). The Hub reads and merges only the runs of its main folder, so reading the changes and the files and everything that changes something are off here.');
  for (const name of calls) assert.ok(buttonNamed(root, name)?.disabled, `${name} is off`);
  assert.equal(within(root, 'coding-other-folders'), undefined, 'and nothing is hidden');
  // the control: the Hub’s own folder in view, with the same run, reads and changes as usual and says nothing of the kind
  const own = await page(state([{ ...old, workspace: '/project' }]), { store: { lang: 'en' }, ...ready });
  assert.equal(within(own, 'coding-run-foreign'), undefined);
  for (const name of ['Read the changes', 'View file contents', 'Read the merged changes', 'View the recovery log']) assert.equal(buttonNamed(own, name)?.disabled, false, `${name} works in the Hub’s own folder`);
});

test('the run view told that another folder is in view switches off reading as well as changing, and says why', async () => {
  const run = job([worker()]);
  const names = ['Read the changes', 'View file contents', 'Create a draft on GitHub', 'Merge the selected tasks', 'View the recovery log'];
  const blocked = await view(run, { blocked: true, preselect: { runId: RUN, ids: ['task-a'] } });
  for (const name of names) assert.ok(buttonNamed(blocked, name)?.disabled, name);
  assert.match(within(blocked, 'coding-run-foreign').text, /\(\/project\)/, 'it names the Hub’s folder');
  const free = await view(run, { preselect: { runId: RUN, ids: ['task-a'] } });
  assert.equal(within(free, 'coding-run-foreign'), undefined);
  assert.equal(buttonNamed(free, 'Read the changes').disabled, false);
});

test('every control has a name, every id is used once, every reference points somewhere, in both languages and in every state', async () => {
  const states = {
    empty: state(),
    review: state([job([worker(), verified({ id: 'task-v' }), worker({ id: 'task-f', status: 'failed', error: 'x' })])]),
    merged: state([job([worker()], { integration: { branch: 'chatmcp/integration/x', status: 'ready_for_review', merged: ['task-a'], sha: 'd'.repeat(40) } })]),
    running: state([job([worker({ status: 'testing', verifyRequired: true })], { status: 'running' })], { activeRunId: RUN }),
    several: state([job([worker()], { id: 'aaaaaaaa-0000-0000-0000-000000000000' }), job([worker()])]),
  };
  for (const [name, coding] of Object.entries(states)) {
    for (const lang of ['vi', 'en']) {
      const root = await page(coding, { mode: 'review', store: { lang }, drafts: { codingTasks: [draftTask(), draftTask({ id: 'task-2', dependsOn: ['task-a'] })], codingGoal: 'Do the thing' } });
      assert.deepEqual(unnamedControls(root), [], `${name}/${lang}: unnamed controls`);
      assert.deepEqual(duplicateIds(root), [], `${name}/${lang}: duplicate ids`);
      assert.deepEqual(brokenReferences(root), [], `${name}/${lang}: references to nothing`);
    }
  }
});

test('the English screen has no Vietnamese in it and shows no raw dictionary key, with every status the Hub can report', async () => {
  const diacritics = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
  const statuses = ['queued', 'running', 'awaiting_test_grant', 'testing', 'ready_for_review', 'no_changes', 'failed', 'needs_attention', 'blocked', 'cancelled', 'interrupted'];
  const root = await page(state([job(statuses.map((status, index) => worker({ id: `w${index}`, status, error: status === 'failed' ? 'E' : undefined })), { status: 'partial_failure', integration: { branch: 'b', status: 'conflict', error: 'E' } })]), { mode: 'review', store: { lang: 'en' }, drafts: { codingTasks: [draftTask({ id: 'Bad' })] } });
  assert.doesNotMatch(root.text, diacritics);
  const html = await renderWith(CodingWorkers, {}, [[['hubState'], hub()], [['coding-runs'], state([job(statuses.map((status, index) => worker({ id: `w${index}`, status })))])]], [], { lang: 'en' });
  assert.doesNotMatch(html, /\b(?:agent|group|coding|agents)_[a-z_]+\b/, 'a dictionary key was shown instead of text');
});

// ---------------------------------------------------------------------------------------------------------------------
// The run view on its own: what is ticked, and what the run’s own status looks like
// ---------------------------------------------------------------------------------------------------------------------
const boxesOf = (root) => byTag(root, 'input').filter((node) => node.attrs.type === 'checkbox');

test('workers ticked by a run that has just started are ticked, but merging still waits for each diff to be read', async () => {
  const run = job([worker(), worker({ id: 'task-b' })]);
  const root = await view(run, { preselect: { runId: RUN, ids: ['task-a', 'task-b'] } });
  assert.deepEqual(boxesOf(root).map((node) => 'checked' in node.attrs), [true, true]);
  assert.ok(buttonNamed(within(root, 'coding-integration'), 'Merge the selected tasks').disabled, 'ticked is not reviewed');
  // a selection kept for another run is not this run’s
  const other = await view(run, { preselect: { runId: 'someone-else', ids: ['task-a'] } });
  assert.deepEqual(boxesOf(other).map((node) => 'checked' in node.attrs), [false, false]);
});

test('only a worker that is ready for review can be ticked', async () => {
  const root = await view(job([worker(), worker({ id: 'task-f', status: 'failed' }), worker({ id: 'task-r', status: 'running' }), worker({ id: 'task-n', status: 'no_changes' })]));
  const states = Object.fromEntries(boxesOf(root).map((node) => [/Select task (\S+) for merging/.exec(node.attrs['aria-label'])[1], 'disabled' in node.attrs]));
  assert.deepEqual(states, { 'task-a': false, 'task-f': true, 'task-r': true, 'task-n': true });
});

test('while a run or a merge is going on nothing in the finished run can be acted on', async () => {
  for (const flags of [{ busy: true }, { hubBusy: true }]) {
    const root = await view(job([worker()]), { ...flags, preselect: { runId: RUN, ids: ['task-a'] } });
    const names = buttons(root).filter((item) => ['Read the changes', 'View file contents', 'Create a draft on GitHub', 'Merge the selected tasks', 'View the recovery log'].includes(item.name));
    assert.equal(names.length, 5);
    assert.ok(names.every((item) => item.disabled), JSON.stringify(flags));
  }
});

test('the status word of a run is red when it failed, amber when it needs the owner, and otherwise plain — never green', async () => {
  const tones = {};
  for (const status of ['ready_for_review', 'completed', 'running', 'failed', 'partial_failure', 'needs_attention', 'interrupted', 'cancelled']) {
    const root = await view(job([worker()], { status }));
    tones[status] = byTag(within(root, 'coding-result'), 'span').find((node) => node.attrs['data-tone']).attrs['data-tone'];
  }
  assert.deepEqual(tones, { ready_for_review: 'neutral', completed: 'neutral', running: 'neutral', failed: 'danger', partial_failure: 'warning', needs_attention: 'warning', interrupted: 'warning', cancelled: 'neutral' });
});

test('a run with nothing to merge has no merge block', async () => {
  assert.equal(within(await view(job([worker({ status: 'failed', error: 'x' })], { status: 'failed' })), 'coding-integration'), undefined);
  assert.equal(within(await view(job([worker({ status: 'no_changes', changedFiles: [] })])), 'coding-integration'), undefined);
  assert.ok(within(await view(job([worker()])), 'coding-integration'));
});

test('before the Hub has said which permission mode it is in, start is off but the tab does not claim a mode it does not know', async () => {
  const root = await page(state(), { ...ready, hubOverrides: { studio: undefined } });
  assert.equal(within(root, 'coding-needs-autonomous'), undefined, 'no notice about a mode nobody has reported');
  assert.ok(buttonNamed(root, 'Bắt đầu sửa mã').disabled);
});

// ---------------------------------------------------------------------------------------------------------------------
// What the Hub would refuse for another reason: the main agent or a group is running
// ---------------------------------------------------------------------------------------------------------------------
test('while the main agent is working the Hub refuses coding workers, so the tab says so and start is off', async () => {
  for (const overrides of [{ agent: { activeTaskId: 'task-1', tasks: [] } }, { taskId: 'task-1' }]) {
    const root = await page(state(), { store: { lang: 'en' }, ...ready, hubOverrides: overrides });
    assert.match(within(root, 'coding-block-agent-busy').text, /main agent is working/, JSON.stringify(overrides));
    assert.ok(buttonNamed(root, 'Start code edits').disabled, JSON.stringify(overrides));
  }
});

test('while a helper group is running the Hub refuses coding workers, so the tab says so and start is off', async () => {
  const root = await page(state(), { store: { lang: 'en' }, ...ready, hubOverrides: { studio: { permissions: { mode: 'autonomous' }, delegates: { running: true } } } });
  assert.match(within(root, 'coding-block-group-running').text, /group of helpers is running/);
  assert.ok(buttonNamed(root, 'Start code edits').disabled);
  assert.equal(within(root, 'coding-block-agent-busy'), undefined);
});

test('the reasons are told in order: the mode first, then the main agent, and a quiet Hub says nothing at all', async () => {
  const both = await page(state(), { store: { lang: 'en' }, mode: 'review', ...ready, hubOverrides: { agent: { activeTaskId: 'task-1', tasks: [] } } });
  assert.ok(within(both, 'coding-needs-autonomous'));
  assert.equal(within(both, 'coding-block-agent-busy'), undefined, 'one reason at a time: the one the owner has to fix first');
  const quiet = await page(state(), { store: { lang: 'en' }, ...ready });
  assert.equal(within(quiet, 'coding-block-agent-busy'), undefined);
  assert.equal(within(quiet, 'coding-block-group-running'), undefined);
  assert.equal(buttonNamed(quiet, 'Start code edits').disabled, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// A run the Hub would not merge, and a worker that stopped before it committed
// ---------------------------------------------------------------------------------------------------------------------
test('a run the Hub would not merge says so next to the merge button, and the button is off', async () => {
  for (const status of ['cancelled', 'failed', 'interrupted']) {
    const root = await view(job([worker()], { status }), { preselect: { runId: RUN, ids: ['task-a'] } });
    const integration = within(root, 'coding-integration');
    assert.match(integration.text, new RegExp(`only merges a run that is ready for review or partly failed; this one is`), status);
    assert.ok(buttonNamed(integration, 'Merge the selected tasks').disabled, status);
    assert.equal(buttonNamed(integration, 'Merge the selected tasks').node.attrs['aria-describedby'], 'coding-merge-status-hint', status);
  }
  for (const status of ['ready_for_review', 'partial_failure']) {
    const integration = within(await view(job([worker()], { status })), 'coding-integration');
    assert.doesNotMatch(integration.text, /only merges a run/, status);
  }
});

test('a worker that stopped before it committed shows where its working copy is, and says its changes are not committed', async () => {
  const path = '/state/runs/1111/trees/task-a';
  for (const status of ['needs_attention', 'failed', 'interrupted', 'cancelled']) {
    const card = workerCard(await view(job([worker({ status, worktree: path, error: 'Coding worker did not complete', summary: undefined })], { status: 'partial_failure' })), 'task-a');
    assert.match(card.text, /Anything it changed is not committed/, status);
    assert.ok(card.text.includes(path), status);
  }
  for (const status of ['ready_for_review', 'no_changes', 'blocked', 'queued']) {
    const card = workerCard(await view(job([worker({ status, worktree: path, summary: undefined })], { status: 'partial_failure' })), 'task-a');
    assert.doesNotMatch(card.text, /not committed/, status);
    assert.ok(!card.text.includes(path), status);
  }
  const vi = workerCard(await view(job([worker({ status: 'needs_attention', worktree: path })]), { store: { lang: 'vi' } }), 'task-a');
  assert.ok(vi.text.includes('chưa được lưu thành commit') && vi.text.includes(path));
  // a record that has no working copy named says nothing about one, and never shows an empty "{path}"
  for (const record of [{}, { worktree: '' }, { worktree: null }]) {
    const bare = workerCard(await view(job([worker({ status: 'needs_attention', summary: undefined, ...record })])), 'task-a');
    assert.doesNotMatch(bare.text, /not committed|\{path\}/, JSON.stringify(record));
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Reading what a worker changed: the diff, the file contents, the AI’s text
// ---------------------------------------------------------------------------------------------------------------------
const rowsOf = (root) => byTag(root, 'pre').flatMap((pre) => byTag(pre, 'div')).map((node) => [node.attrs['data-line'], node.text]);
const render = async (Component, props, store = { lang: 'en' }) => parseHtml(await renderWith(Component, props, [], [], store));

test('a line of a diff is read by where it is: file headers only before a hunk, and a removed "-- note" stays a removed line', async () => {
  const diff = ['diff --git a/q.sql b/q.sql', 'index 1111111..2222222 100644', '--- a/q.sql', '+++ b/q.sql', '@@ -1,5 +1,5 @@', ' select 1;',
    '--- a note that was removed', '+-- a note that was added', '+++ a line that starts with two plus signs', ' end', '\\ No newline at end of file',
    'diff --git a/b.txt b/b.txt', 'new file mode 100644', '--- /dev/null', '+++ b/b.txt', '@@ -0,0 +1 @@', '+hello'].join('\n');
  const root = await render(DiffView, { diff, label: 'Diff' });
  assert.deepEqual(rowsOf(root).map(([kind]) => kind), ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add', 'ctx', 'ctx', 'meta', 'meta', 'meta', 'meta', 'hunk', 'add']);
  assert.equal(rowsOf(root)[6][1], '--- a note that was removed', 'and the text of every line is what Git printed');
});

test('a diff with a hidden or direction-changing character shows it as a marker and says so; a plain one says nothing', async () => {
  const sneaky = await render(DiffView, { diff: ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1 +1 @@', '-if (ok) {', '+if (isAdmin‮) { // x​'].join('\n'), label: 'Diff' });
  const rows = rowsOf(sneaky);
  assert.equal(rows.at(-1)[1], '+if (isAdmin‹U+202E›) { // x‹U+200B›');
  assert.ok(!sneaky.text.includes('‮') && !sneaky.text.includes('​'), 'the characters themselves are gone from the screen');
  assert.match(sneaky.text, /hidden or direction-changing characters/);
  assert.equal(byTag(sneaky, 'span').filter((node) => node.attrs['data-hidden']).map((node) => node.attrs['data-hidden']).join(','), 'U+202E,U+200B');
  const plain = await render(DiffView, { diff: ['@@ -1 +1 @@', '-a', '+b'].join('\n'), label: 'Diff' });
  assert.doesNotMatch(plain.text, /hidden or direction-changing/);
  const vi = await render(DiffView, { diff: '@@ -1 +1 @@\n+a‮b', label: 'Diff' }, { lang: 'vi' });
  assert.match(vi.text, /ký tự ẩn hoặc ký tự đổi chiều chữ/);
});

test('the contents of a worker’s files are a named region, and what could not be shown is told in plain words', async () => {
  const context = { workerId: 'task-a', files: [{ path: 'src/a.js', sha256: 'ab'.repeat(32), lines: [{ line: 1, text: 'let a = 1;' }, { line: 2, text: 'x‮y' }] }],
    skipped: [{ path: '.env', reason: 'sensitive_path' }, { path: 'logo.png', reason: 'binary' }, { path: 'big.js', reason: 'too_large' }, { path: 'gone.js', reason: 'deleted' },
      { path: 'many.js', reason: 'file_limit' }, { path: 'odd.txt', reason: 'invalid_utf8' }, { path: 'new.js', reason: 'a_reason_nobody_knew' }] };
  const root = await render(ContextPanel, { context, onClose() {} });
  const pre = byTag(root, 'pre')[0];
  assert.equal(pre.attrs.role, 'region');
  assert.equal(accessibleName(root, pre), 'src/a.js');
  assert.ok(pre.text.includes('2: x‹U+202E›y'));
  assert.match(root.text, /Files not shown: \.env \(may hold secrets\), logo\.png \(binary file\), big\.js \(too large\), gone\.js \(deleted\), many\.js \(over the number of files shown\), odd\.txt \(not UTF-8 text\), new\.js \(a_reason_nobody_knew\)/);
  assert.match(root.text, /hidden or direction-changing characters/);
  const vi = await render(ContextPanel, { context, onClose() {} }, { lang: 'vi' });
  assert.match(vi.text, /\.env \(có thể chứa bí mật\)/);
});

test('the review of a branch reads its diff with the same care, and the AI’s own text shows hidden characters too', async () => {
  const review = { branch: 'chatmcp/coder/x/task-a', revision: 'a'.repeat(40), diff: '@@ -1 +1 @@\n-a\n+b‮' };
  const root = await render(ReviewPanel, { review, onClose() {} });
  assert.deepEqual(rowsOf(root).map(([kind]) => kind), ['hunk', 'del', 'add']);
  assert.match(root.text, /hidden or direction-changing/);
  const report = await render(AiReport, { text: 'Fixed it.‮ All tests pass.' });
  assert.match(report.text, /Fixed it\.‹U\+202E› All tests pass\./);
  assert.match(report.text, /hidden or direction-changing/);
  assert.doesNotMatch((await render(AiReport, { text: 'Fixed it.' })).text, /hidden or direction-changing/);
});

test('the phrase a question asks for is part of the name of the box it is typed in, and the rule for it is the box’s description', async () => {
  const props = { open: true, onOpenChange() {}, title: 'Merge?', description: 'It merges.', confirmLabel: 'Confirm', cancelLabel: 'Cancel', onConfirm() {} };
  for (const [lang, name, hint] of [['en', 'Type the exact phrase to confirm INTEGRATE WORKTREES', /stays off until what you type matches exactly/], ['vi', 'Nhập đúng cụm từ để xác nhận INTEGRATE WORKTREES', /chỉ bật khi những gì bạn nhập khớp hoàn toàn/]]) {
    const root = await render(ConfirmDialog, { ...props, phrase: 'INTEGRATE WORKTREES' }, { lang });
    const input = byTag(root, 'input')[0];
    assert.equal(accessibleName(root, input), name, lang);
    assert.equal(input.attrs['aria-describedby'], 'confirm-phrase-hint', lang);
    assert.match(all(root).find((node) => node.attrs.id === 'confirm-phrase-hint').text, hint, lang);
    assert.deepEqual(brokenReferences(root), [], lang);
    assert.ok(buttonNamed(root, lang === 'en' ? 'Confirm' : 'Confirm').disabled, `${lang}: off until the phrase is typed`);
  }
  assert.equal(byTag(await render(ConfirmDialog, props), 'input').length, 0, 'a question without a phrase has no box');
  assert.equal(buttonNamed(await render(ConfirmDialog, props), 'Confirm').disabled, false);
  assert.equal(byTag(await render(ConfirmDialog, { ...props, open: false, phrase: 'X' }), 'input').length, 0, 'and a closed one renders nothing of its body');
});

test('a recovery log that was not found does not claim a status', async () => {
  const none = await render(RecoveryStatus, { recovery: { runId: RUN, found: false, entries: 0 } });
  assert.match(none.text, /Log: none · Status: — · Entries: 0\./);
  assert.doesNotMatch(none.text, /undefined/);
  const found = await render(RecoveryStatus, { recovery: { runId: RUN, found: true, status: 'interrupted', entries: 3 } });
  assert.match(found.text, /Log: found · Status: Interrupted · Entries: 3\./);
});

// ---------------------------------------------------------------------------------------------------------------------
// The Hub’s own words about how a worker’s verification ended, apart from the AI’s
// ---------------------------------------------------------------------------------------------------------------------
const inside = (card) => all({ descendants: () => card.descendants() });
const noteOf = (card) => inside(card).find((node) => node.attrs['data-testid'] === 'hub-note');
const reportOf = (card) => inside(card).find((node) => node.attrs['data-testid'] === 'ai-report');
const BLOCKED = { code: 'blocked', text: 'Verified coding blocked: Repair/test retry budget exhausted.', detail: 'Repair/test retry budget exhausted.' };
const VERIFIED_NOTE = { code: 'verified', text: 'All registered pinned Node checks have fresh signed TAP evidence.' };

test('the Hub’s note stands beside the evidence line, labelled as the Hub’s, and the AI’s report keeps only the AI’s words', async () => {
  const entry = worker({ status: 'needs_attention', verifyRequired: true, summary: 'I fixed add() and ran the tests.', verificationNote: BLOCKED });
  for (const [lang, text, label] of [
    ['en', 'Hub note: The Hub stopped the verification loop. The reason it gave, as written: Repair/test retry budget exhausted.', 'Hub note'],
    ['vi', 'Ghi chú của Hub: Hub đã dừng vòng kiểm thử. Lý do Hub ghi, nguyên văn: Repair/test retry budget exhausted.', 'Ghi chú của Hub'],
  ]) {
    const card = workerCard(await page(state([job([entry])]), { store: { lang }, ...ready }), 'task-a');
    const note = noteOf(card);
    assert.equal(note.text, text, lang);
    assert.equal(note.attrs['data-code'], 'blocked');
    const report = reportOf(card);
    assert.ok(report.text.includes('I fixed add() and ran the tests.'), lang);
    assert.ok(!report.text.includes('Repair/test') && !report.text.includes(label), `${lang}: the Hub’s words are not in the AI’s report`);
    // the order on the card: what the Hub recorded first (the evidence line, then its note), what the AI said after
    const order = inside(card).map((node) => node.attrs['data-testid']).filter(Boolean);
    assert.ok(order.indexOf('agent-proof') < order.indexOf('hub-note') && order.indexOf('hub-note') < order.indexOf('ai-report'), `${lang}: ${order.join(' > ')}`);
    assert.equal(card.attrs['data-tone'], 'warning', 'the note changes no colour');
    assert.doesNotMatch(greenClasses(card), GREEN, lang);
  }
});

test('every note the Hub sends is told in both languages, and none of them is drawn as proof', async () => {
  const cases = [
    [worker({ status: 'needs_attention', verifyRequired: true, verificationNote: { code: 'no_checks', text: 'No supported pinned Node test definition was discovered.' } }),
      'Hub note: The Hub found no supported pinned Node test in this project, so it ran no isolated check.', 'Ghi chú của Hub: Hub không tìm thấy lệnh kiểm thử Node nào được hỗ trợ trong dự án này, nên không chạy kiểm thử cách ly nào.'],
    [worker({ status: 'needs_attention', verifyRequired: true, verificationNote: { code: 'grant_timeout', text: 'Owner did not approve all isolated test grants in the allotted window.' } }),
      'Hub note: The Hub waited for you to allow the isolated checks and the time ran out, so it ran none.', 'Ghi chú của Hub: Hub chờ bạn cho phép các lệnh kiểm thử cách ly nhưng đã hết thời gian chờ, nên không chạy kiểm thử nào.'],
    [verified({ verificationNote: VERIFIED_NOTE }),
      'Hub note: Every registered pinned Node check has fresh signed TAP evidence.', 'Ghi chú của Hub: Mọi lệnh kiểm thử Node đã đăng ký đều có bằng chứng TAP có chữ ký còn mới.'],
  ];
  for (const [entry, en, vi] of cases) {
    for (const [lang, text] of [['en', en], ['vi', vi]]) {
      const card = workerCard(await page(state([job([entry])]), { store: { lang }, ...ready }), 'task-a');
      const note = noteOf(card);
      assert.equal(note.text, text, `${entry.verificationNote.code}/${lang}`);
      assert.doesNotMatch(note.attrs.class ?? '', GREEN, 'the note itself is never green, even beside a green evidence line');
      assert.doesNotMatch(greenClasses(note), GREEN);
    }
  }
});

test('the note that every check has evidence is not repeated where the Hub’s own record does not say so', async () => {
  const mismatches = {
    'the commit failed after the verification': verified({ status: 'failed', error: 'git commit failed', verificationNote: VERIFIED_NOTE }),
    'a later attempt failed': verified({ verificationAttempts: [attempt(), attempt({ id: 'a2', status: 'failed', exitCode: 1, testOutcomeVerified: false })], verificationNote: VERIFIED_NOTE }),
    'an attempt the Hub did not verify': verified({ verificationAttempts: [attempt({ testOutcomeVerified: false })], verificationNote: VERIFIED_NOTE }),
    'no attempt on record': verified({ verificationAttempts: [], verificationNote: VERIFIED_NOTE }),
    'the Hub restarted': verified({ status: 'interrupted', verificationNote: VERIFIED_NOTE }),
    'the loop did not end as ready': verified({ verificationOutcome: { state: 'needs_attention' }, verificationNote: VERIFIED_NOTE }),
    'verification was not asked for': verified({ verifyRequired: false, verificationNote: VERIFIED_NOTE }),
  };
  for (const lang of ['en', 'vi']) {
    for (const [name, entry] of Object.entries(mismatches)) {
      const card = workerCard(await page(state([job([entry])]), { store: { lang }, ...ready }), 'task-a');
      assert.notEqual(card.attrs['data-kind'], 'verified', `(premise) ${name}`);
      assert.equal(noteOf(card), undefined, `${lang}: ${name}: the note is not shown as proof`);
      assert.doesNotMatch(card.text, /fresh signed TAP evidence|bằng chứng TAP/, `${lang}: ${name}`);
    }
  }
  // the AI saying the same thing in its own report is still the AI’s: shown as its report, with no Hub note beside it
  const said = workerCard(await page(state([job([worker({ summary: VERIFIED_NOTE.text })])]), ready), 'task-a');
  assert.equal(noteOf(said), undefined);
  assert.ok(reportOf(said).text.includes(VERIFIED_NOTE.text));
});

test('a note that is not understood is shown as the Hub wrote it, and what could make it misleading is not shown at all', async () => {
  const card = async (note) => workerCard(await page(state([job([worker({ status: 'needs_attention', verificationNote: note })])]), { store: { lang: 'en' }, ...ready }), 'task-a');
  assert.equal(noteOf(await card({ code: 'something_new', text: 'The Hub says so.' })).text, 'Hub note: The Hub says so.', 'a code the page has no line for');
  assert.equal(noteOf(await card({ code: 'something_new' })), undefined, 'and nothing at all when there is no text either');
  assert.equal(noteOf(await card({ code: 'blocked', text: 'Verified coding blocked: Check result is blocked.' })).text, 'Hub note: Verified coding blocked: Check result is blocked.', 'a blocked note without its detail falls back to the Hub’s sentence');
  for (const bad of [undefined, null, 'blocked', [], {}, { code: 5 }]) assert.equal(noteOf(await card(bad)), undefined, JSON.stringify(bad));
  // text the Hub wrote is read like any other text from outside: what cannot be seen is shown as a marker
  const hidden = noteOf(await card({ code: 'blocked', text: 'x', detail: 'Stopped‮ by the loop' }));
  assert.ok(hidden.text.includes('Stopped‹U+202E› by the loop') && !hidden.text.includes('‮'));
  assert.match((await card({ code: 'blocked', text: 'x', detail: 'Stopped‮ by the loop' })).text, /hidden or direction-changing/);
});

test('a worker with no note shows none, and a note on a worker the page shows as stopped or working is the Hub’s all the same', async () => {
  const plain = workerCard(await page(state([job([worker()])]), ready), 'task-a');
  assert.equal(noteOf(plain), undefined);
  for (const status of ['running', 'failed', 'cancelled']) {
    const card = workerCard(await page(state([job([worker({ status, summary: undefined, verificationNote: { code: 'no_checks', text: 'x' } })], { status: 'partial_failure' })]), { store: { lang: 'en' }, ...ready }), 'task-a');
    assert.ok(noteOf(card).text.startsWith('Hub note: The Hub found no supported pinned Node test'), status);
  }
});

test('what the verification option really needs is said where it is chosen', async () => {
  const en = await page(state(), { store: { lang: 'en' }, ...ready });
  const note = within(en, 'coding-task').text;
  for (const part of ['Windows Sandbox', 'registered', 'about 90 seconds', 'Needs your attention', 'not committed']) assert.ok(note.includes(part), `${part}: ${note}`);
  assert.doesNotMatch(note, /the task is marked as needing your check/, 'the old, softer promise is gone');
  const vi = await page(state(), ready);
  const text = within(vi, 'coding-task').text;
  for (const part of ['Windows Sandbox', '90 giây', 'Cần bạn kiểm tra']) assert.ok(text.includes(part), part);
});
