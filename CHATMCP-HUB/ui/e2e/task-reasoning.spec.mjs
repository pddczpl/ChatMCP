// The thinking effort of ONE task, chosen beside the composer, against the real Hub and the production build of the page: the chip offers what the Hub says the model takes (the
// connection here is a local runtime the catalog cannot know, so the three common levels), the level chosen reaches the model request of that task and of the follow-up that keeps
// it, a follow-up may change it, and the next conversation starts from its connection again (nothing in the request).
import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { waitFor } from '../../tests/e2e/hub-process.mjs';

/** Waits until the conversation has answered `answers` messages and is at rest. */
const answered = (app, id, answers) => waitFor(async () => {
  const task = await app.hub.task(id);
  return task.state === 'completed' && (task.runs ?? []).filter((run) => run.status === 'completed').length >= answers ? task : null;
}, { label: `${answers} answer(s) of the conversation`, timeoutMs: 30_000 });

test('the level chosen beside the composer reaches the model request of the task and of its follow-ups, and a new conversation starts from the connection again', async ({ page, app }) => {
  app.mock.setScenario('canned-answer');
  await onboard(page, app);
  const chip = page.getByTestId('new-task-reasoning');
  const select = chip.getByRole('combobox', { name: 'Mức suy luận của tác vụ', exact: true });
  await expect(chip, 'the Hub does not know a local runtime, so it offers the three levels everyone takes').toBeVisible();
  await expect(select.locator('option')).toHaveText(['Mặc định (Tự động)', 'Tự động', 'Thấp', 'Vừa', 'Cao']);
  await expect(select).toHaveValue('');

  // a new conversation with a level of its own
  await select.selectOption('high');
  const first = 'Say hello with some thought.';
  await send(page, first);
  const started = await taskByPrompt(app, first);
  await answered(app, started.id, 1);
  expect(app.mock.state.lastBody.reasoning_effort, 'the request of the task carries the level that was chosen').toBe('high');
  expect((await app.hub.task(started.id)).reasoningEffort, 'and the task shows it').toBe('high');

  // the conversation is open now: the default of the chip is the level the conversation has
  await expect(chip).toBeVisible();
  await expect(select.locator('option').first()).toHaveText('Mặc định (Cao)');
  await expect(select).toHaveValue('');

  // a follow-up that chooses nothing keeps it
  await send(page, 'And once more.');
  await answered(app, started.id, 2);
  expect(app.mock.state.lastBody.reasoning_effort, 'a follow-up that chooses nothing keeps the level of the conversation').toBe('high');

  // one that chooses another level changes it, for itself and for the ones after it
  await select.selectOption('low');
  await send(page, 'With less thought, please.');
  await answered(app, started.id, 3);
  expect(app.mock.state.lastBody.reasoning_effort, 'a follow-up that chooses another level changes it').toBe('low');
  expect((await app.hub.task(started.id)).reasoningEffort).toBe('low');
  await expect(select.locator('option').first()).toHaveText('Mặc định (Thấp)');
  await expect(select, 'and the choice is spent: the next message starts from the default again').toHaveValue('');

  // a new conversation does not inherit the level of the one before: the chip is back on the connection's own
  await page.getByRole('button', { name: 'Hội thoại mới', exact: true }).click();
  await expect(select.locator('option').first()).toHaveText('Mặc định (Tự động)');
  await expect(select).toHaveValue('');
  const second = 'A new conversation with nothing chosen.';
  await send(page, second);
  const fresh = await taskByPrompt(app, second);
  await answered(app, fresh.id, 1);
  expect(app.mock.state.lastBody.reasoning_effort, 'nothing chosen: the request carries no level').toBeUndefined();
  expect((await app.hub.task(fresh.id)).reasoningEffort, 'and the task follows its connection').toBeNull();
});
