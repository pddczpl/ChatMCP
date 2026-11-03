import path from 'node:path';
import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { waitForState } from '../../tests/e2e/hub-process.mjs';
import { say, call, sequence } from '../../tests/e2e/scenarios.mjs';
import { git, makeBareRemote, slashes } from '../../tests/e2e/fixtures.mjs';
import fs from 'node:fs/promises';

// A scripted model asks to push the branch it worked on. The real Hub plans the push from the real repository (a bare repository is the `origin`), the page shows the owner
// the commits that would be sent, and "Phê duyệt" / "Từ chối" decide whether the remote gets them. No network, no account.

/** The calc project of the fixture, with an `origin`, `main` published, and a feature branch with two commits that the remote does not have. */
async function prepare(app) {
  const bare = makeBareRemote(app.scratch, app.scratch);
  const run = (...args) => git(app.project, app.scratch, args);
  run('remote', 'add', 'origin', slashes(bare));
  run('push', '-q', '-u', 'origin', 'main');
  run('remote', 'set-head', 'origin', 'main');
  run('checkout', '-q', '-b', 'feature/push-demo');
  await fs.writeFile(path.join(app.project, 'notes.txt'), 'first change\n');
  run('add', 'notes.txt');
  run('commit', '-q', '-m', 'feat: add notes (first)');
  await fs.mkdir(path.join(app.project, 'docs'), { recursive: true });
  await fs.writeFile(path.join(app.project, 'docs', 'guide.txt'), 'second change\n');
  run('add', 'docs/guide.txt');
  run('commit', '-q', '-m', 'docs: add a guide (Tiếng Việt)');
  return { bare, run, remoteHead: () => git(bare, app.scratch, ['rev-parse', '--verify', '-q', 'refs/heads/feature/push-demo'], { allowFailure: true }) };
}

test('the owner sees the commits that would be sent, approves, and the remote gets exactly them', async ({ page, app }, testInfo) => {
  const { run, remoteHead } = await prepare(app);
  const head = run('rev-parse', 'HEAD').stdout;
  app.mock.define('push-branch', sequence([call('git_push', {})], { final: 'Đã đẩy nhánh feature/push-demo lên origin.' }));
  app.mock.setScenario('push-branch');
  await onboard(page, app);
  const prompt = 'Publish my work on the feature branch to origin.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);

  const card = page.getByRole('region', { name: 'Phê duyệt local.git_push' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Thao tác nguy hiểm')).toBeVisible();
  const preview = card.getByTestId('git-push-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId('git-push-remote')).toContainText('origin');
  await expect(preview.getByTestId('git-push-remote')).toContainText(slashes(path.join(app.scratch, 'origin.git')));
  await expect(preview.getByTestId('git-push-route')).toContainText('feature/push-demo → origin/feature/push-demo');
  await expect(preview.getByTestId('git-push-count')).toHaveText('Số commit sẽ được gửi: 2');
  const commits = preview.getByTestId('git-push-commits');
  await expect(commits).toContainText('feat: add notes (first)');
  await expect(commits).toContainText('docs: add a guide (Tiếng Việt)');
  await expect(commits).toContainText(head.slice(0, 7));
  expect((await commits.innerText()).indexOf('feat: add notes (first)')).toBeLessThan((await commits.innerText()).indexOf('docs: add a guide'));
  await expect(preview.getByTestId('git-push-changes')).toContainText('2 tệp');
  await expect(preview.getByText('không ép (no force)', { exact: false })).toBeVisible();
  expect(remoteHead().code, 'asking pushes nothing').not.toBe(0);
  const picture = await card.screenshot();
  await testInfo.attach('git-push-approval-card.png', { body: picture, contentType: 'image/png' });
  if (process.env.GIT_PUSH_CARD_SHOT) await fs.writeFile(process.env.GIT_PUSH_CARD_SHOT, picture);

  await card.getByRole('button', { name: 'Phê duyệt', exact: true }).and(page.locator(':enabled')).click();
  await waitForState(app.hub, task.id, 'completed');
  await expect(page.locator('#panel-conversation').getByText('Đã đẩy nhánh feature/push-demo lên origin.', { exact: true })).toBeVisible();
  expect(remoteHead().stdout, 'the remote has the branch at the commit that was shown').toBe(head);
  expect(run('config', 'branch.feature/push-demo.remote').stdout).toBe('origin');
  expect(run('status', '--porcelain').stdout, 'the working tree is as it was').toBe('');
});

test('"Từ chối" pushes nothing and the model is told it was not allowed', async ({ page, app }) => {
  const { remoteHead } = await prepare(app);
  const seen = [];
  app.mock.define('push-refused', ({ turn, last }) => {
    if (turn === 0) return call('git_push', { remote: 'origin', branch: 'feature/push-demo' });
    seen.push(String(last));
    return say('Mình sẽ không đẩy nhánh vì chưa được cho phép.');
  });
  app.mock.setScenario('push-refused');
  await onboard(page, app);
  const prompt = 'Push feature/push-demo to origin, please.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);

  const card = page.getByRole('region', { name: 'Phê duyệt local.git_push' });
  await expect(card.getByTestId('git-push-commits')).toContainText('feat: add notes (first)');
  await card.getByRole('button', { name: 'Từ chối', exact: true }).click();
  await card.getByRole('button', { name: 'Xác nhận từ chối', exact: true }).click();
  await waitForState(app.hub, task.id, 'completed');
  await expect(page.locator('#panel-conversation').getByText('Mình sẽ không đẩy nhánh vì chưa được cho phép.', { exact: true })).toBeVisible();
  expect(remoteHead().code, 'the remote has nothing').not.toBe(0);
  expect(seen.join('\n')).toMatch(/Permission denied|permission_denied/);
});

test('a push the Hub refuses (main) is never put to the owner', async ({ page, app }) => {
  const { run } = await prepare(app);
  run('checkout', '-q', 'main');
  await fs.writeFile(path.join(app.project, 'on-main.txt'), 'direct to main\n');
  run('add', 'on-main.txt');
  run('commit', '-q', '-m', 'chore: a commit on main');
  const answers = [];
  app.mock.define('push-main', ({ turn, last }) => {
    if (turn === 0) return call('git_push', {});
    answers.push(String(last));
    return say('Không đẩy được lên main.');
  });
  app.mock.setScenario('push-main');
  await onboard(page, app);
  const prompt = 'Push what is on main to origin.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);
  await waitForState(app.hub, task.id, 'completed');
  await expect(page.getByRole('region', { name: 'Phê duyệt local.git_push' })).toHaveCount(0);
  expect(answers.join('\n')).toMatch(/pull request/i);
  expect(run('rev-parse', 'origin/main').stdout).not.toBe(run('rev-parse', 'HEAD').stdout);
  expect(git(path.join(app.scratch, 'origin.git'), app.scratch, ['rev-parse', 'main']).stdout).toBe(run('rev-parse', 'origin/main').stdout);
});
