// The acceptance panel made the owner build every choice from an empty list (reported 2026-10-28: "Objective acceptance là gì?"). The Hub still decides what is accepted: a criterion is matched to a
// receipt the Hub itself recorded when the work really happened, and only the owner's confirmation writes it. The page now shows the latest receipt of the right kind already chosen in each list,
// and one button confirms the whole plan in the order the Hub needs. Production page, real Hub, scripted model: it reads calc.js, edits it, reads it again and runs node test.js. (An edit clears
// the inspections and checks made before it, so the Hub holds a receipt of each kind only when the model looked again after the edit: the plan of a model that did not cannot be accepted.)
import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { answerApprovals } from '../../tests/e2e/hub-process.mjs';
import { call, sequence, shaOf } from '../../tests/e2e/scenarios.mjs';

const PROMPT = '1. Inspect source files and project requirements, capture independently verified read evidence before editing any source code.\n2. Implement a bounded source patch and test the changed code thoroughly with real command exit status and actual Git review evidence.';

test('the receipts are chosen already, and one click confirms the whole plan on them; the Hub then holds every objective as verified', async ({ page, app }) => {
  app.mock.define('repair-read-test', sequence([
    call('read_file', { path: 'calc.js' }),
    ({ last }) => call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', expected_sha256: shaOf(last) }),
    call('read_file', { path: 'calc.js' }),
    call('run_command', { command: 'node test.js', description: 'Chạy kiểm thử của hàm add()' }),
  ], { final: 'Đã sửa add() trong calc.js và chạy node test.js: thành công.' }));
  app.mock.setScenario('repair-read-test');
  await onboard(page, app);
  app.mock.setScenario('repair-read-test'); // the connection check of the first-run dialog is not part of the script
  await send(page, PROMPT);
  const started = await taskByPrompt(app, PROMPT);
  await answerApprovals(app.hub, started.id, () => true); // the edit and the command the scripted model asks for
  const before = await app.hub.task(started.id);
  expect(before.goalPlan.objectives.map((objective) => objective.id), 'the Hub made a plan of two objectives').toEqual(['objective-1', 'objective-2']);
  expect(before.goalPlan.objectives.every((objective) => objective.status !== 'verified'), 'and nothing is accepted yet: the model ending is not an acceptance').toBe(true);
  expect(new Set(before.objectiveReceipts.map((receipt) => receipt.kind)).has('inspect'), 'the Hub recorded what it saw happen').toBe(true);

  const panel = page.getByTestId('objective-acceptance');
  await expect(panel).toBeVisible();
  await panel.locator('summary').click();
  await expect(panel.locator('summary')).toContainText('0/2 đã xác minh');
  // Every list shows a receipt already (the latest of the kind the criterion needs): none is left on the empty choice.
  for (const key of ['objective-1:0', 'objective-2:0', 'objective-2:1', 'objective-2:2']) {
    await expect(page.getByLabel(`Bằng chứng chấp nhận ${key}`), key).not.toHaveValue('');
  }
  await expect(page.getByLabel('Bằng chứng chấp nhận objective-2:1')).toHaveValue(/^edit:/);
  await expect(page.getByLabel('Bằng chứng chấp nhận objective-2:2')).toHaveValue(/^verify:/);
  const all = page.getByTestId('objective-accept-all');
  await expect(all).toHaveText('Xác nhận tất cả đề xuất (4)');
  await expect(all).toBeEnabled();

  await all.click();
  await expect.poll(async () => (await app.hub.task(started.id)).goalPlan.objectives.map((objective) => objective.status), { message: 'the Hub accepted the plan' }).toEqual(['verified', 'verified']);
  const after = await app.hub.task(started.id);
  for (const objective of after.goalPlan.objectives) {
    expect(objective.evidence.every((entry) => entry.acceptedBy === 'local_owner'), 'every acceptance is the owner\'s').toBe(true);
    expect(objective.evidence.length).toBe(objective.acceptanceCriteria.length);
  }
  await expect(panel.locator('summary')).toContainText('2/2 đã xác minh');
  await expect(all).toHaveText('Xác nhận tất cả đề xuất (0)');
  await expect(all).toBeDisabled();
});

test('a model that did not look again after its edit left no inspection: nothing is suggested for it, the button is off, and the plan stays open', async ({ page, app }) => {
  app.mock.define('repair-no-reread', sequence([
    call('read_file', { path: 'calc.js' }),
    ({ last }) => call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', expected_sha256: shaOf(last) }),
    call('run_command', { command: 'node test.js', description: 'Chạy kiểm thử của hàm add()' }),
  ], { final: 'Đã sửa add() và chạy node test.js: thành công.' }));
  app.mock.setScenario('repair-no-reread');
  await onboard(page, app);
  app.mock.setScenario('repair-no-reread');
  await send(page, PROMPT);
  const started = await taskByPrompt(app, PROMPT);
  await answerApprovals(app.hub, started.id, () => true);
  const detail = await app.hub.task(started.id);
  expect(detail.objectiveReceipts.map((receipt) => receipt.kind).sort(), 'the edit cleared the first reading: the Hub holds an edit and a check, no inspection').toEqual(['edit', 'verify']);

  const panel = page.getByTestId('objective-acceptance');
  await expect(panel).toBeVisible();
  await panel.locator('summary').click();
  await expect(page.getByLabel('Bằng chứng chấp nhận objective-1:0'), 'a criterion no receipt can match shows the empty choice').toHaveValue('');
  await expect(page.getByLabel('Bằng chứng chấp nhận objective-2:1')).toHaveValue(/^edit:/);
  const all = page.getByTestId('objective-accept-all');
  await expect(all, 'objective-1 cannot be completed, so objective-2 is not reached either').toHaveText('Xác nhận tất cả đề xuất (0)');
  await expect(all).toBeDisabled();
  expect((await app.hub.task(started.id)).goalPlan.objectives.every((objective) => objective.status !== 'verified')).toBe(true);
});
