import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, byRole, all, accessibleName, duplicateIds, unnamedControls, brokenReferences } from './support/html.mjs';

// The coding side of the Agents tab: planning, starting, and above all how a worker's result is shown. The rule under test is the one the
// whole product keeps: what an AI says about its own work is its claim; only a check the Hub ran and verified is evidence.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { CodingWorkers } from './src/components/inspector/CodingWorkers';
  import { CodingRunView } from './src/components/inspector/CodingRunView';
  export { CodingWorkers, CodingRunView };
`, 'chatmcp-coding-');
after(dispose);
const { renderWith, CodingWorkers, CodingRunView } = loaded;

const RUN = '11111111-2222-3333-4444-555555555555';
const hub = (overrides = {}) => ({ workspace: { path: '/project' }, workspaces: { activePath: '/project', items: [] }, studio: { permissions: { mode: 'autonomous', executionPolicy: 'host-review' } }, tasks: [], agent: { tasks: [] }, ...overrides });
const attempt = (overrides = {}) => ({ id: 'a1', checkId: 'c1', status: 'completed', exitCode: 0, testOutcomeVerified: true, snapshotHash: 'ab'.repeat(32), ...overrides });
const worker = (overrides = {}) => ({ id: 'task-a', status: 'ready_for_review', branch: 'chatmcp/coder/111111111111/task-a', changedFiles: ['calc.js'], commitSha: 'c'.repeat(40), dependsOn: [], verifyRequired: false, summary: 'Fixed add(). All tests pass and the task is complete.', ...overrides });
const verified = (overrides = {}) => worker({ verifyRequired: true, verificationOutcome: { state: 'ready_for_review', repairs: 0 }, verificationAttempts: [attempt()], ...overrides });
const job = (workers, overrides = {}) => ({ id: RUN, status: 'ready_for_review', baseSha: 'b'.repeat(40), baseBranch: 'main', createdAt: '2026-10-20T10:00:00Z', workers, integration: null, error: null, ...overrides });
const state = (jobs = [], overrides = {}) => ({ activeRunId: null, integrating: false, recoveryFault: null, jobs, ...overrides });
const draftTask = (overrides = {}) => ({ id: 'task-a', prompt: 'Add a note file', verify: false, dependsOn: [], ...overrides });

const page = async (coding, { mode = 'autonomous', store = {}, drafts = {}, errors = [], hubOverrides = {} } = {}) => parseHtml(await renderWith(CodingWorkers, {}, [
  [['hubState'], hub({ studio: { permissions: { mode } }, ...hubOverrides })], ...(coding ? [[['coding-runs'], coding]] : []),
], errors, store, drafts));
const buttons = (root) => byTag(root, 'button').map((node) => ({ node, name: accessibleName(root, node), disabled: 'disabled' in node.attrs }));
const buttonNamed = (root, name) => buttons(root).find((item) => item.name === name);
const within = (root, testId) => all(root).find((node) => node.attrs['data-testid'] === testId);
const workerCard = (root, id) => all(root).find((node) => node.attrs['data-testid'] === 'coding-worker' && node.attrs['data-worker'] === id);
const proofOf = (card) => all({ descendants: () => card.descendants() }).find((node) => node.attrs['data-testid'] === 'agent-proof');
const ready = { drafts: { codingTasks: [draftTask()] } };

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
  const alerts = byRole(root, 'alert').map((node) => node.text);
  assert.ok(alerts.includes('The items wait for each other in a loop, so none of them can run.'), alerts.join(' | '));
  assert.ok(alerts.includes('An ID uses lowercase letters without accents, digits and dashes, and starts with a letter.'));
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

test('while a worker is checking or waiting for a test grant the card says so and offers no review yet', async () => {
  for (const status of ['queued', 'running', 'awaiting_test_grant', 'testing']) {
    const root = await page(state([job([worker({ status, verifyRequired: true, summary: undefined })], { status: 'running' })], { activeRunId: RUN }), ready);
    const card = workerCard(root, 'task-a');
    assert.equal(card.attrs['data-kind'], 'working', status);
    assert.ok(!buttons({ descendants: () => card.descendants() }).some((item) => item.name === 'Xem thay đổi'), status);
  }
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
const view = async (run, { jobs, preselect = null, busy = false, hubBusy = false, store = { lang: 'en' } } = {}) => parseHtml(await renderWith(CodingRunView, {
  run, jobs: jobs ?? [run], onPick() {}, busy, setBusy() {}, hubBusy, refetch: async () => {}, preselect,
}, [[['hubState'], hub()]], [], store));
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
