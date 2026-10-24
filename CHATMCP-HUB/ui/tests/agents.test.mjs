import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, byRole, all, accessibleName, duplicateIds, unnamedControls, brokenReferences } from './support/html.mjs';

// The read-only side of the Agents tab: the analysis the AI plans, the group the owner builds, and the checks panel they share.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { AgentGroups } from './src/components/inspector/AgentGroups';
  import { IsolatedChecksPanel } from './src/components/inspector/IsolatedChecksPanel';
  export { AgentGroups, IsolatedChecksPanel };
`, 'chatmcp-agents-');
after(dispose);
const { renderWith, AgentGroups, IsolatedChecksPanel } = loaded;

const hub = (overrides = {}) => ({ workspace: { path: '/project' }, workspaces: { activePath: '/project', items: [] }, studio: { permissions: { mode: 'review' } }, tasks: [], agent: { tasks: [] }, ...overrides });
const quiet = [[['hubState'], hub()], [['dynamic-delegates'], { activeRunId: null, last: null }], [['delegates'], { running: false, last: null, events: [] }]];
const withEntries = (...replace) => quiet.map(([key, data]) => replace.find(([other]) => other[0] === key[0]) ?? [key, data]).concat(replace.filter(([other]) => !quiet.some(([key]) => key[0] === other[0])));
const page = async (entries, store = {}, drafts = {}, errors = []) => parseHtml(await renderWith(AgentGroups, {}, entries, errors, store, drafts));
const issueTexts = (root) => all(root).filter((node) => node.attrs['data-testid'] === 'field-issue').map((node) => node.text);
const buttons = (root) => byTag(root, 'button').map((node) => ({ node, name: accessibleName(root, node), disabled: 'disabled' in node.attrs }));
const buttonNamed = (root, name) => buttons(root).find((item) => item.name === name);
const within = (root, testId) => all(root).find((node) => node.attrs['data-testid'] === testId);
const subtree = (node) => ({ tag: '#root', attrs: {}, children: [node], parent: null, descendants: () => [node, ...node.descendants()], get text() { return node.text; } });

const analysis = (overrides = {}) => ({ id: 'run-1', status: 'completed', kind: 'dynamic-readonly', workers: [{ id: 'survey', role: 'researcher', status: 'completed', summary: 'The project has two modules. All tests pass.' }], error: null, ...overrides });

test('an analysis that is running cannot be started a second time after the tab is reopened', async () => {
  // a goal is typed, so that only the Hub’s own flag can be what keeps the button off
  const root = await page(withEntries([['dynamic-delegates'], { activeRunId: 'run-1', last: analysis({ status: 'running', workers: [] }) }]), {}, { goal: 'Why is it slow?' });
  const start = buttonNamed(root, 'Đang phân tích…');
  assert.ok(start?.disabled, 'the start button reads "analysing" and is off');
  assert.ok(buttonNamed(root, 'Dừng phân tích') && !buttonNamed(root, 'Dừng phân tích').disabled, 'and the run can be stopped');
  assert.equal(buttonNamed(root, 'Bắt đầu phân tích'), undefined);
  assert.ok(byRole(root, 'status').some((node) => node.text.includes('Các trợ lý đang làm việc')));
  assert.equal(within(root, 'analysis-result').attrs['data-kind'], 'working');
});

test('a failed analysis keeps the real error and a plain status, and is never read as a success', async () => {
  const root = await page(withEntries([['dynamic-delegates'], { activeRunId: null, last: analysis({
    status: 'needs_attention', error: 'Provider unavailable', workers: [{ id: 'audit-1', role: 'reviewer', status: 'failed', error: 'No evidence available' }],
  }) }]));
  const result = within(root, 'analysis-result');
  assert.equal(result.attrs['data-tone'], 'warning');
  assert.equal(result.attrs['data-kind'], 'attention');
  const text = result.text;
  for (const expected of ['Cần bạn kiểm tra', 'Rà soát', 'Không hoàn tất', 'Provider unavailable', 'No evidence available']) assert.ok(text.includes(expected), expected);
  assert.ok(byRole(root, 'alert').some((node) => node.text === 'Provider unavailable'));
  assert.ok(byRole(root, 'alert').some((node) => node.text === 'No evidence available'));
});

test('what a finished analysis says is the AI’s report: labelled as such, neutral, and nothing in it is green', async () => {
  for (const [lang, label, title, note] of [
    ['vi', 'Báo cáo của AI', 'AI báo cáo · Hub chưa kiểm chứng', 'Hãy mở các tệp được trích dẫn để đối chiếu'],
    ['en', 'AI report', 'AI report · not checked by the Hub', 'Open the files it cites to compare'],
  ]) {
    const root = await page(withEntries([['dynamic-delegates'], { activeRunId: null, last: analysis({ conclusion: 'Combined: it is fine.' }) }]), { lang });
    const result = within(root, 'analysis-result');
    assert.equal(result.attrs['data-tone'], 'neutral', lang);
    assert.equal(result.attrs['data-kind'], 'ai-report', lang);
    const proof = all(subtree(result)).find((node) => node.attrs['data-testid'] === 'agent-proof');
    assert.ok(proof.text.includes(title) && proof.text.includes(note), `${lang}: the evidence line says whose words these are`);
    assert.equal(proof.attrs['data-tone'], 'neutral', `${lang}: and it is not coloured as proof`);
    const reports = all(subtree(result)).filter((node) => node.attrs['data-testid'] === 'ai-report');
    assert.ok(reports.length >= 2, 'the worker’s text and the combined text are both reports');
    assert.ok(reports.every((node) => node.text.startsWith(label) || node.text.startsWith(lang === 'vi' ? 'Tổng hợp kết quả' : 'Combined findings')), `${lang}: each report carries a label`);
    const classes = all(subtree(result)).map((node) => node.attrs.class ?? '').join(' ');
    assert.doesNotMatch(classes, /\b(?:text|bg|border)-success\b/, `${lang}: nothing in the result is green`);
  }
});

test('the hand-made group starts with three helpers written in the language on screen', async () => {
  const vi = await page(quiet);
  const en = await page(quiet, { lang: 'en' });
  assert.equal(byTag(within(vi, 'manual-agents'), 'textarea').length, 3);
  assert.ok(byTag(within(vi, 'manual-agents'), 'textarea')[0].text.startsWith('Đề xuất kế hoạch'));
  assert.ok(byTag(within(en, 'manual-agents'), 'textarea')[0].text.startsWith('Propose an implementation plan'));
  assert.ok(buttonNamed(vi, 'Bắt đầu với nhóm này') && !buttonNamed(vi, 'Bắt đầu với nhóm này').disabled);
  assert.ok(buttonNamed(en, 'Start with this group') && !buttonNamed(en, 'Start with this group').disabled);
});

test('what the owner typed is what the form shows, so a visit to another tab loses nothing', async () => {
  const drafts = { goal: 'Why is the page slow?', groupNodes: [{ id: 'solo', role: 'tester', question: 'Run the checks you can find', dependsOn: [] }], groupConcurrency: 3 };
  const root = await page(quiet, { lang: 'en' }, drafts);
  assert.equal(byTag(root, 'textarea').find((node) => node.attrs.id === 'agent-goal').text, 'Why is the page slow?');
  const manual = within(root, 'manual-agents');
  assert.equal(byTag(manual, 'textarea').length, 1);
  assert.equal(byTag(manual, 'textarea')[0].text, 'Run the checks you can find');
  assert.ok(byTag(manual, 'option').some((node) => node.attrs.selected !== undefined && node.text === 'Tester'), 'the chosen role');
});

test('a helper group the Hub would refuse says why next to the field and cannot be started', async () => {
  const drafts = { groupNodes: [
    { id: 'plan', role: 'planner', question: 'Plan', dependsOn: ['ghost'] },
    { id: 'plan', role: 'reviewer', question: 'Review', dependsOn: [] },
  ] };
  const root = await page(quiet, { lang: 'en' }, drafts);
  const manual = within(root, 'manual-agents');
  const alerts = issueTexts(manual);
  assert.ok(alerts.includes('This ID is already used by another item.'), alerts.join(' | '));
  assert.ok(alerts.includes('No item has the ID “ghost”.'));
  assert.deepEqual(byRole(manual, 'alert').filter((node) => alerts.includes(node.text)), [], 'the problems are descriptions of their fields, not alerts');
  assert.ok(buttonNamed(manual, 'Start with this group').disabled);
  assert.ok(manual.text.includes('Fix the fields marked with a problem before starting.'));
  const marked = byTag(manual, 'input', 'textarea').filter((node) => node.attrs['aria-invalid'] === 'true');
  assert.ok(marked.length >= 2, 'the fields in trouble are marked invalid');
});

test('a running group is stopped from where it is shown, and the Hub’s own flag keeps the start button off', async () => {
  const root = await page(withEntries([['delegates'], { running: true, last: { id: 'g1', status: 'running', workers: [], conclusion: '' }, events: [] }]));
  const manual = within(root, 'manual-agents');
  assert.ok(buttonNamed(manual, 'Dừng nhóm') && !buttonNamed(manual, 'Dừng nhóm').disabled);
  assert.ok(buttonNamed(manual, 'Đang phân tích…').disabled);
});

test('a finished group shows the Hub’s workers and its combined text as the AI’s report', async () => {
  const last = { id: 'g1', status: 'completed', readonly: true, conclusion: 'Plan: do A then B.', workers: [
    { id: 'plan', role: 'planner', status: 'completed', summary: 'Plan text' }, { id: 'review', role: 'reviewer', status: 'failed', error: 'Timed out' },
  ] };
  const root = await page(withEntries([['delegates'], { running: false, last, events: [] }]), { lang: 'en' });
  const result = within(root, 'group-result');
  assert.equal(result.attrs['data-tone'], 'neutral');
  const proof = all(subtree(result)).find((node) => node.attrs['data-testid'] === 'agent-proof');
  assert.equal(proof.attrs['data-tone'], 'neutral', 'the evidence line of a group result is not coloured as proof either');
  assert.ok(result.text.includes('Planner · Finished') && result.text.includes('Reviewer · Did not finish'));
  assert.ok(byRole(result, 'alert').some((node) => node.text === 'Timed out'));
  const combined = all(subtree(result)).filter((node) => node.attrs['data-testid'] === 'ai-report').at(-1);
  assert.ok(combined.text.startsWith('AI report · Combined findings') && combined.text.includes('Plan: do A then B.'), 'the combined text is still the AI’s, and says so');
  const vi = await page(withEntries([['delegates'], { running: false, last, events: [] }]));
  assert.ok(all(subtree(within(vi, 'group-result'))).filter((node) => node.attrs['data-testid'] === 'ai-report').at(-1).text.startsWith('Báo cáo của AI · Tổng hợp kết quả'));
});

test('a group or an analysis the Hub saved as "running" while nothing is running was cut off, and is not shown as working', async () => {
  const group = { id: 'g1', status: 'running', workers: [{ id: 'plan', role: 'planner', status: 'running' }, { id: 'review', role: 'reviewer', status: 'queued' }], conclusion: '' };
  const cut = await page(withEntries([['delegates'], { running: false, last: group, events: [] }]), { lang: 'en' });
  const result = within(cut, 'group-result');
  assert.equal(result.attrs['data-kind'], 'attention');
  assert.equal(result.attrs['data-tone'], 'warning');
  assert.ok(result.text.includes('Planner · Interrupted'), result.text);
  assert.ok(!result.text.includes('Working'), 'nothing in it still says it is working');
  const going = await page(withEntries([['delegates'], { running: true, last: group, events: [] }]), { lang: 'en' });
  assert.equal(within(going, 'group-result').attrs['data-kind'], 'working');
  const analysisCut = await page(withEntries([['dynamic-delegates'], { activeRunId: null, last: analysis({ status: 'running', workers: [{ id: 's', role: 'researcher', status: 'running' }] }) }]), { lang: 'en' });
  assert.equal(within(analysisCut, 'analysis-result').attrs['data-kind'], 'attention');
  assert.ok(within(analysisCut, 'analysis-result').text.includes('Researcher · Interrupted'));
});

// ---- what the Hub would refuse because something else is running ----
const busyHub = (overrides) => withEntries([['hubState'], hub(overrides)]);

test('an analysis is not offered while the main agent, a coding run, a group or a model change is going on, and the tab says which', async () => {
  const cases = [
    ['analysis-block-agent-busy', busyHub({ agent: { activeTaskId: 't1', tasks: [] } }), /main agent is working/],
    ['analysis-block-agent-busy', busyHub({ taskId: 't1' }), /main agent is working/],
    ['analysis-block-coding-running', withEntries([['coding-runs'], { activeRunId: 'run-9', integrating: false, jobs: [] }]), /code edit is running/],
    ['analysis-block-group-running', busyHub({ studio: { permissions: { mode: 'review' }, delegates: { running: true } } }), /group of helpers is running/],
    ['analysis-block-ai-busy', busyHub({ ai: { busy: true } }), /AI connection is being changed/],
  ];
  for (const [testId, entries, words] of cases) {
    const root = await page(entries, { lang: 'en' }, { goal: 'Why is it slow?' });
    assert.match(within(root, testId).text, words, testId);
    assert.ok(buttonNamed(root, 'Start analysis').disabled, `${testId}: start is off`);
    assert.equal(byRole(root, 'alert').filter((node) => node.attrs['data-testid'] === testId).length, 0, 'it is information, not an error');
  }
  const idle = await page(quiet, { lang: 'en' }, { goal: 'Why is it slow?' });
  assert.equal(buttonNamed(idle, 'Start analysis').disabled, false);
  assert.equal(byTag(idle, 'div').filter((node) => node.attrs['data-testid']?.startsWith('analysis-block-')).length, 0, 'a quiet Hub says nothing');
});

test('a hand-made group is refused only while the main agent works, and says so; a running coding run does not stop it', async () => {
  const busy = await page(busyHub({ agent: { activeTaskId: 't1', tasks: [] } }), { lang: 'en' });
  assert.match(within(busy, 'group-block-agent-busy').text, /main agent is working/);
  assert.ok(buttonNamed(within(busy, 'manual-agents'), 'Start with this group').disabled);
  const coding = await page(withEntries([['coding-runs'], { activeRunId: 'run-9', integrating: false, jobs: [] }]), { lang: 'en' });
  assert.equal(within(coding, 'group-block-agent-busy'), undefined);
  assert.equal(buttonNamed(within(coding, 'manual-agents'), 'Start with this group').disabled, false, 'the Hub only checks the main agent for this');
});

test('a status that cannot be loaded is shown as an error, not as an empty tab', async () => {
  const root = await page([[['hubState'], hub()], [['delegates'], { running: false, last: null }]], {}, {}, [[['dynamic-delegates'], 'Hub is not answering']]);
  assert.ok(byRole(root, 'alert').some((node) => node.text === 'Không tải được trạng thái: Hub is not answering'));
  assert.equal(within(root, 'analysis-result'), undefined);
});

test('with another folder in view the forms are off but a run in progress can still be stopped', async () => {
  const other = [[['hubState'], hub({ workspaces: { activePath: '/elsewhere', items: [] } })], [['dynamic-delegates'], { activeRunId: 'run-1', last: analysis({ status: 'running', workers: [] }) }], [['delegates'], { running: true, last: null }]];
  const root = await page(other, { selectedWorkspacePath: '/elsewhere' });
  assert.ok(byRole(root, 'status').some((node) => node.text.includes('/project') && node.text.includes('/elsewhere')));
  const fieldsets = byTag(root, 'fieldset');
  assert.ok(fieldsets.length >= 2 && fieldsets.every((node) => 'disabled' in node.attrs), 'every form of the section is inside a disabled fieldset');
  for (const name of ['Dừng phân tích', 'Dừng nhóm']) {
    const stop = buttonNamed(root, name);
    assert.ok(stop && !stop.disabled, `${name} stays usable`);
    let node = stop.node;
    while ((node = node.parent)) assert.ok(!(node.tag === 'fieldset' && 'disabled' in node.attrs), `${name} is not inside a disabled fieldset`);
  }
  const idle = await page(withEntries(), { selectedWorkspacePath: '/elsewhere' }, { goal: 'x' });
  assert.ok(buttonNamed(idle, 'Bắt đầu phân tích').disabled, 'a goal can be typed but the analysis cannot be started from the wrong folder');
  assert.ok(buttonNamed(idle, 'Bắt đầu với nhóm này').disabled);
});

test('every control has a name, every id is used once and every reference points somewhere, in both languages and with results on screen', async () => {
  const results = withEntries([['dynamic-delegates'], { activeRunId: null, last: analysis({ conclusion: 'Done' }) }], [['delegates'], { running: false, last: { id: 'g', status: 'completed', workers: [{ id: 'plan', role: 'planner', status: 'completed', summary: 'x' }], conclusion: 'y' } }]);
  for (const entries of [quiet, results]) {
    for (const lang of ['vi', 'en']) {
      const root = await page(entries, { lang });
      assert.deepEqual(unnamedControls(root), [], `${lang}: unnamed controls`);
      assert.deepEqual(duplicateIds(root), [], `${lang}: duplicate ids`);
      assert.deepEqual(brokenReferences(root), [], `${lang}: references to nothing`);
    }
  }
});

test('the remove buttons of the helpers can be told apart', async () => {
  const root = await page(quiet, { lang: 'en' });
  const names = buttons(within(root, 'manual-agents')).map((item) => item.name).filter((name) => name.startsWith('Remove helper'));
  assert.deepEqual(names, ['Remove helper 1', 'Remove helper 2', 'Remove helper 3']);
});

test('the English screen has no Vietnamese in it, and no raw dictionary key', async () => {
  const diacritics = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
  const busy = withEntries([['dynamic-delegates'], { activeRunId: 'r', last: analysis({ status: 'needs_attention', error: 'E', workers: [{ id: 'a', role: 'security', status: 'blocked', summary: 'S' }] }) }], [['delegates'], { running: true, last: null }]);
  for (const entries of [quiet, busy]) {
    const html = await renderWith(AgentGroups, {}, entries, [], { lang: 'en' }, { groupNodes: [{ id: 'A', role: 'tester', question: 'q', dependsOn: ['x', 'x'] }] });
    const text = parseHtml(html).text;
    assert.doesNotMatch(text, diacritics);
    assert.doesNotMatch(html, /\b(?:agent|group|coding|agents)_[a-z_]+\b/, 'a dictionary key was shown instead of text');
  }
});

// ---- the checks panel the coding section and the Progress tab share ----
const jobWith = (workers) => ({ activeRunId: 'run-1', jobs: [{ id: 'run-1', status: 'running', workers }] });
const checks = async (data, store = {}, entries = []) => parseHtml(await renderWith(IsolatedChecksPanel, {}, [[['coding-runs'], data], ...entries], [], store));

test('a worker that did not ask for verification has no checks to allow, and the Hub is not asked about it', async () => {
  const root = await checks(jobWith([{ id: 'plain', status: 'running', verifyRequired: false }]));
  assert.equal(within(root, 'isolated-checks-panel'), undefined);
});

test('a worker that asked for verification and is running gets the checks panel', async () => {
  const root = await checks(jobWith([{ id: 'wants', status: 'awaiting_test_grant', verifyRequired: true }]), { lang: 'en' }, [[['worker-checks', 'wants'], { workerId: 'wants', checks: [{ id: 'c1', from: 'chatmcp.checks/basic.json', command: 'node --test' }] }]]);
  const panel = within(root, 'isolated-checks-panel');
  assert.ok(panel.text.includes('Tests that need your permission') && panel.text.includes('Tests for task wants') && panel.text.includes('node --test'));
  assert.ok(buttonNamed(panel, 'Review and allow the test'));
});

test('a recorded result says "verified" only when the Hub verified it', async () => {
  const attempts = [
    { id: 'a1', checkId: 'c1', status: 'completed', exitCode: 0, testOutcomeVerified: true, snapshotHash: 'ab'.repeat(32) },
    { id: 'a2', checkId: 'c1', status: 'completed', exitCode: 0, testOutcomeVerified: false },
  ];
  const root = await checks({ activeRunId: null, jobs: [{ id: 'run-1', status: 'ready_for_review', workers: [{ id: 'w', status: 'ready_for_review', verificationAttempts: attempts }] }] }, { lang: 'en' });
  const rows = byTag(within(root, 'isolated-checks-panel'), 'div').filter((node) => node.attrs.class?.includes('rounded-lg border border-line p-2.5'));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].text.includes('The Hub verified that this test passed'));
  assert.ok(rows[1].text.includes('No verified evidence that the test passed'));
  assert.ok(!rows[1].text.includes('Hub verified that this test passed'));
});

test('the panel is about the run on screen, not the newest one: another run’s workers are not asked about', async () => {
  // the older run still has a worker the Hub saved as running (the Hub that ran it is gone): nobody is asked about it, there is no broker to ask
  const older = { id: 'run-0', status: 'interrupted', workers: [{ id: 'old', status: 'ready_for_review', verifyRequired: true, verificationAttempts: [{ id: 'o1', checkId: 'c9', status: 'completed', exitCode: 0, testOutcomeVerified: true }] },
    { id: 'ghost', status: 'running', verifyRequired: true }] };
  const newer = { id: 'run-1', status: 'running', workers: [{ id: 'wants', status: 'awaiting_test_grant', verifyRequired: true }] };
  const data = { activeRunId: 'run-1', jobs: [older, newer] };
  const entries = [[['worker-checks', 'wants'], { workerId: 'wants', checks: [{ id: 'c1', from: 'x', command: 'node --test' }] }],
    [['worker-checks', 'ghost'], { workerId: 'ghost', checks: [{ id: 'c2', from: 'y', command: 'node --test ghost' }] }]];
  const shown = parseHtml(await renderWith(IsolatedChecksPanel, { run: older }, [[['coding-runs'], data], ...entries], [], { lang: 'en' }));
  const panel = within(shown, 'isolated-checks-panel');
  assert.ok(panel.text.includes('old') && panel.text.includes('The Hub verified that this test passed'), 'the recorded checks are the shown run’s');
  assert.ok(!panel.text.includes('Tests for task wants'), 'and the live run is not on screen, so nobody is asked about its workers');
  assert.ok(!panel.text.includes('Tests for task ghost'), 'nor about a worker that only the saved record says is still running');
  // without a run to follow (the Progress tab) it keeps following the active run
  const followed = await checks(data, { lang: 'en' }, entries);
  assert.ok(within(followed, 'isolated-checks-panel').text.includes('Tests for task wants'));
  assert.ok(!within(followed, 'isolated-checks-panel').text.includes('The Hub verified that this test passed'));
});

test('while the Hub waits for the owner’s permission the panel says for how long and what happens otherwise', async () => {
  const root = await checks(jobWith([{ id: 'wants', status: 'awaiting_test_grant', verifyRequired: true }]), { lang: 'en' }, [[['worker-checks', 'wants'], { workerId: 'wants', checks: [{ id: 'c1', from: 'x', command: 'node --test' }] }]]);
  const panel = within(root, 'isolated-checks-panel');
  assert.match(panel.text, /about 90 seconds/);
  assert.match(panel.text, /Needs your attention/);
  assert.match(panel.text, /not committed/);
  // only while a worker is waiting: the recorded results of a finished run are not a countdown
  const finished = await checks({ activeRunId: null, jobs: [{ id: 'run-1', status: 'ready_for_review', workers: [{ id: 'w', status: 'ready_for_review', verificationAttempts: [{ id: 'a1', checkId: 'c1', status: 'completed', testOutcomeVerified: true }] }] }] }, { lang: 'en' });
  assert.doesNotMatch(within(finished, 'isolated-checks-panel').text, /90 seconds/);
});

test('an allowed check is shown as allowed with the Hub’s own numbers, and cannot be allowed again until that runs out', async () => {
  const data = jobWith([{ id: 'wants', status: 'awaiting_test_grant', verifyRequired: true }]);
  const entries = [[['worker-checks', 'wants'], { workerId: 'wants', checks: [{ id: 'c1', from: 'x', command: 'node --test' }, { id: 'c2', from: 'y', command: 'node --test b' }] }]];
  const soon = Date.now() + 20 * 60 * 1000;
  const root = parseHtml(await renderWith(IsolatedChecksPanel, {}, [[['coding-runs'], data], ...entries], [], { lang: 'en' }, { checkGrants: { 'wants:c1': { expiresAt: soon, maxAttempts: 3 } } }));
  const rows = byTag(within(root, 'isolated-checks-panel'), 'div').filter((node) => node.attrs['data-check']);
  assert.deepEqual(rows.map((row) => [row.attrs['data-check'], row.attrs['data-grant']]), [['c1', 'active'], ['c2', 'none']]);
  assert.match(rows[0].text, /Allowed: up to 3 runs in the Windows Sandbox, until \d{1,2}:\d{2}/);
  assert.match(rows[0].text, /result appears below when the Hub has run it/i, 'allowed is not passed');
  assert.equal(buttonNamed(rows[0], 'Review and allow the test'), undefined, 'no second grant for the same check');
  assert.ok(buttonNamed(rows[1], 'Review and allow the test'), 'the other check is still waiting for the owner');
  const expired = parseHtml(await renderWith(IsolatedChecksPanel, {}, [[['coding-runs'], data], ...entries], [], { lang: 'en' }, { checkGrants: { 'wants:c1': { expiresAt: Date.now() - 1000, maxAttempts: 3 } } }));
  const old = byTag(within(expired, 'isolated-checks-panel'), 'div').find((node) => node.attrs['data-check'] === 'c1');
  assert.equal(old.attrs['data-grant'], 'expired');
  assert.match(old.text, /earlier permission has run out/);
  assert.ok(buttonNamed(old, 'Review and allow the test'), 'and it can be asked again');
});

test('with another folder in view nobody can be allowed to run a test from here', async () => {
  const data = jobWith([{ id: 'wants', status: 'awaiting_test_grant', verifyRequired: true }]);
  const listed = [['worker-checks', 'wants'], { workerId: 'wants', checks: [{ id: 'c1', from: 'x', command: 'node --test' }] }];
  const other = await checks(data, { lang: 'en', selectedWorkspacePath: '/elsewhere' }, [listed, [['hubState'], hub({ workspaces: { activePath: '/elsewhere', items: [] } })]]);
  assert.ok(buttonNamed(within(other, 'isolated-checks-panel'), 'Review and allow the test').disabled);
  const here = await checks(data, { lang: 'en' }, [listed, [['hubState'], hub()]]);
  assert.equal(buttonNamed(within(here, 'isolated-checks-panel'), 'Review and allow the test').disabled, false);
});

test('the checks panel is silent when there is nothing to show or the list cannot be read', async () => {
  assert.equal(within(await checks({ activeRunId: null, jobs: [] }), 'isolated-checks-panel'), undefined);
  const root = parseHtml(await renderWith(IsolatedChecksPanel, {}, [], [[['coding-runs'], 'down']]));
  assert.equal(within(root, 'isolated-checks-panel'), undefined);
});
