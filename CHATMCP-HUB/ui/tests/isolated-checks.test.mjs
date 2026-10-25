import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, all, accessibleName, duplicateIds, unnamedControls, brokenReferences } from './support/html.mjs';

// The checks panel of the Progress tab: the test commands a coding worker waits for the owner to allow (up to three runs, in an isolated Windows Sandbox),
// and the results the Hub recorded. The Hub still runs coding workers; this page no longer starts them, so the panel only ever follows a run that exists.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { IsolatedChecksPanel } from './src/components/inspector/IsolatedChecksPanel';
  export { IsolatedChecksPanel };
`, 'chatmcp-isolated-checks-');
after(dispose);
const { renderWith, IsolatedChecksPanel } = loaded;

const hub = (overrides = {}) => ({ workspace: { path: '/project' }, workspaces: { activePath: '/project', items: [] }, studio: { permissions: { mode: 'review' } }, tasks: [], agent: { tasks: [] }, ...overrides });
const buttons = (root) => byTag(root, 'button').map((node) => ({ node, name: accessibleName(root, node), disabled: 'disabled' in node.attrs }));
const buttonNamed = (root, name) => buttons(root).find((item) => item.name === name);
const within = (root, testId) => all(root).find((node) => node.attrs['data-testid'] === testId);

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

test('every control has a name, every id is used once and every reference points somewhere, in both languages and with a recorded result on screen', async () => {
  const entries = [[['worker-checks', 'wants'], { workerId: 'wants', checks: [{ id: 'c1', from: 'x', command: 'node --test' }] }]];
  const data = { activeRunId: 'run-1', jobs: [{ id: 'run-1', status: 'running', workers: [
    { id: 'wants', status: 'awaiting_test_grant', verifyRequired: true, verificationAttempts: [{ id: 'a1', checkId: 'c1', status: 'completed', exitCode: 0, testOutcomeVerified: true }] }] }] };
  for (const lang of ['vi', 'en']) {
    const root = await checks(data, { lang }, entries);
    assert.ok(within(root, 'isolated-checks-panel'), `${lang}: the panel is there`);
    assert.deepEqual(unnamedControls(root), [], `${lang}: unnamed controls`);
    assert.deepEqual(duplicateIds(root), [], `${lang}: duplicate ids`);
    assert.deepEqual(brokenReferences(root), [], `${lang}: references to nothing`);
  }
});

test('the English panel has no Vietnamese in it, and no raw dictionary key', async () => {
  const diacritics = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
  const entries = [[['worker-checks', 'wants'], { workerId: 'wants', checks: [{ id: 'c1', from: 'x', command: 'node --test' }] }]];
  const data = { activeRunId: 'run-1', jobs: [{ id: 'run-1', status: 'running', workers: [
    { id: 'wants', status: 'awaiting_test_grant', verifyRequired: true, verificationAttempts: [{ id: 'a1', checkId: 'c1', status: 'failed', exitCode: 1, testOutcomeVerified: false }] }] }] };
  const html = await renderWith(IsolatedChecksPanel, {}, [[['coding-runs'], data], ...entries], [], { lang: 'en' });
  assert.doesNotMatch(parseHtml(html).text, diacritics);
  assert.doesNotMatch(html, /\b(?:agent|group|coding|agents)_[a-z_]+\b/, 'a dictionary key was shown instead of text');
});
