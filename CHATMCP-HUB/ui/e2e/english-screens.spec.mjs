import { test, expect, onboard, send, taskByPrompt, openWorkTab, openSettings, closeSettings } from './fixtures.mjs';
import { say, call } from '../../tests/e2e/scenarios.mjs';
import { setMode, waitForState, continueTask } from '../../tests/e2e/hub-process.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

// The English screens against the real Hub and the scripted model: the Agents tab (the background tasks), the ribbon and the banner above the conversation,
// the sidebar, the bars above and below the conversation, the approvals and the channel notice. Each is read for Vietnamese, in its text and in its titles,
// labels and placeholders. (This was the last test of the Agents tab's spec, which also had the two sections that hand out work; they are gone.)

/** What a missing dictionary string would look like on screen: its key (the unit tests use the same pattern on server-rendered HTML). */
const RAW_KEY = /\b(?:agent|agents|group|coding)_[a-z_]+\b/;
const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

/** A screenshot with animations finished (a theme change or a dialog closing is still moving for a moment). */
async function shot(page, testInfo, name, target = page) {
  await page.waitForTimeout(250);
  await target.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled' });
}

/**
 * A panel of the English screen holds no Vietnamese: not in its text, and not in a title, an accessible label or a placeholder either (those
 * never show up in the text of a panel, and they are where a string that was forgotten is most likely to hide).
 */
async function expectEnglishOnly(panel, label) {
  expect(await panel.innerText(), `${label} still holds Vietnamese`).not.toMatch(VIETNAMESE);
  const attributes = await panel.evaluate((root) => [...root.querySelectorAll('[title],[aria-label],[placeholder]')]
    .map((element) => ['title', 'aria-label', 'placeholder'].map((name) => element.getAttribute(name)).filter(Boolean).join(' | ')));
  expect(attributes.filter((text) => VIETNAMESE.test(text)), `${label}: a title, a label or a placeholder still holds Vietnamese`).toEqual([]);
}

test('in English, and in the light theme, the Agents tab and the screens around the conversation read in one language', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  // something for the Agents tab to list: an ordinary chat, sent while the screen is still Vietnamese (the send button is named there)
  const prompt = 'Please say hello in one short line.';
  await send(page, prompt);
  const chat = await taskByPrompt(app, prompt);
  await waitForState(app.hub, chat.id, 'completed');
  const dialog = await openSettings(page, 'Giao diện & ngôn ngữ');
  await dialog.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);

  await openWorkTab(page, 'Agents');
  // the tab is the list of background tasks and has no switch to sections that hand out work
  await expect(page.getByRole('tablist', { name: 'Agent sections' })).toHaveCount(0);

  // Background: the list first, then a card opened (its detail holds the longest sentences), all of it in one language
  const background = page.getByRole('tabpanel', { name: 'Agents' });
  await expect(background.getByTestId('background-task')).toHaveCount(1);
  await expect(background).toContainText('In progress: 0 · Tasks: 1 (conversations not counted)');
  await expect(background.getByLabel('Filter background tasks').getByRole('button')).toHaveText(['All', 'This workspace', 'This conversation']);
  const task = background.getByTestId('background-task');
  await expect(task).toContainText('Final reply received');
  await expect(task).toContainText('0 subagents');
  await expect(background.getByTestId('background-workspace')).toContainText('1 task');
  await expectEnglishOnly(background, 'Background (list)');
  await task.getByRole('button', { name: prompt }).click();
  await expect(task.getByRole('button', { name: prompt })).toHaveAttribute('aria-expanded', 'true');
  await expect(task).toContainText('Workspace: ');
  await expect(task).toContainText(`Conversation: ${prompt}`);
  await expect(task.getByRole('button', { name: 'Open this conversation', exact: true })).toBeVisible();
  await expectEnglishOnly(background, 'Background (a card opened)');
  expect(await background.evaluate((panel) => panel.outerHTML), 'the Agents tab shows a dictionary key instead of its words').not.toMatch(RAW_KEY);
  await shot(page, testInfo, 'english-background', background);

  // the toggle is named in the language on screen
  await page.getByTitle('Switch light / dark theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectEnglishOnly(background, 'Background (light theme)');
  await shot(page, testInfo, 'english-light');

  // The conversation that chat made: the ribbon above it in English (its state, then the facts under Details), and after a second run that is held
  // back and stopped from the ribbon, the banner it leaves. What the Hub wrote about a stop (task.error) is the Hub's own Vietnamese sentence and is
  // shown as written, so the banner is read for its title and its button; the ribbon is read whole.
  const ribbon = page.getByTestId('task-status');
  await expect(ribbon).toHaveAttribute('data-status', 'completed');
  await expect(ribbon).toContainText('Final reply received');
  await expect(ribbon).toContainText(prompt);
  await expectEnglishOnly(ribbon, 'Ribbon (completed)');
  await ribbon.getByRole('button', { name: 'Details', exact: true }).click();
  const budget = ribbon.getByTestId('agent-request-budget');
  await expect(budget).toContainText('Model HTTP requests');
  await expect(budget).toContainText('Input tokens (provider-reported)');
  await expect(budget).toContainText('Context window');
  await expectEnglishOnly(ribbon, 'Ribbon (details open)');
  await shot(page, testInfo, 'english-ribbon', ribbon);

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  app.mock.define('held-answer', async () => { await held; return say('Xong.'); });
  app.mock.setScenario('held-answer');
  try {
    await continueTask(app.hub, chat.id, 'Say it once more.');
    const stop = ribbon.getByRole('button', { name: 'Stop agent', exact: true });
    await expect(stop).toBeVisible();
    await expect(ribbon).toContainText(/Reading and planning|Running/);
    await expectEnglishOnly(ribbon, 'Ribbon (running)');
    await expect(page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Continue', exact: true }) })).toHaveCount(0);
    await stop.click();
    // the toast that click leaves behind is English too (it was Vietnamese on this screen)
    await expect(page.getByText('Stop requested for the task', { exact: true })).toBeVisible();
    const stopped = await waitForState(app.hub, chat.id, ['cancelled', 'paused']);
    const word = { cancelled: 'Stopped', paused: 'Paused' }[stopped.state];
    const banner = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Continue', exact: true }) });
    await expect(banner).toHaveCount(1);
    await expect(banner.getByText(word, { exact: true })).toBeVisible();
    await expect(ribbon).toContainText(word);
    await expect(stop).toHaveCount(0);
    await shot(page, testInfo, 'english-banner', banner);

    // the banner's one next step, in English: the same conversation runs again, the banner goes away and the ribbon says what the model did
    release();
    app.mock.define('answer', () => say('Xong.'));
    app.mock.setScenario('answer');
    await banner.getByRole('button', { name: 'Continue', exact: true }).click();
    await waitForState(app.hub, chat.id, 'completed');
    await expect(banner).toHaveCount(0);
    await expect(ribbon).toContainText('Final reply received');
    await expectEnglishOnly(ribbon, 'Ribbon (continued)');
    // the button wrote the person's next message itself, and on this screen it is English (the Hub keeps it as the user's message)
    const asked = (await app.hub.task(chat.id)).dialogue.filter((entry) => entry.role === 'user').at(-1)?.text;
    expect(asked).toBe('Continue the task in the same conversation. Check the current state before acting; do not re-run an action whose result is unclear.');
  } finally {
    release();
  }

  // The sidebar, read whole (its text, its titles, its labels and its placeholder), a group folded and unfolded, and the two questions it asks before
  // it lets go of a folder or a conversation: real browser dialogs, answered with "no" so that nothing is removed.
  const sidebar = page.locator('aside').filter({ has: page.getByRole('button', { name: 'New Session', exact: true }) });
  await expect(sidebar).toHaveCount(1);
  await expectEnglishOnly(sidebar, 'Sidebar');
  // The bar above the conversation, the one below it and the Git branch picker the first one holds are English too (they were Vietnamese on this screen)
  const picker = page.getByRole('button', { name: 'Choose a Git branch and worktree', exact: true });
  const header = page.locator('header').filter({ has: picker });
  await expect(header).toHaveCount(1);
  await expectEnglishOnly(header, 'Header');
  await expect(header.getByRole('button', { name: 'Collapse conversations', exact: true })).toHaveAttribute('title', 'Conversation list (Ctrl+B)');
  await expect(header.getByRole('button', { name: 'Search or command', exact: true })).toBeVisible();
  await expectEnglishOnly(page.getByTestId('status-bar'), 'Status bar');
  await expect(page.getByTestId('status-bar')).toHaveAttribute('aria-label', 'Status');
  await picker.click();
  await expect(page.getByLabel('Git source branch', { exact: true })).toContainText('Current HEAD');
  await expect(page.getByText('Existing Git worktrees', { exact: true })).toBeVisible();
  await expectEnglishOnly(header, 'Header (the Git picker open)');
  await picker.click();
  const folder = path.basename(app.project);
  await expect(sidebar.getByLabel('Search conversations', { exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Add workspace', exact: true })).toHaveAttribute('title', 'Choose a folder with Windows Explorer');
  await sidebar.getByRole('button', { name: `Collapse group ${folder}`, exact: true }).click();
  await expect(sidebar.getByRole('button', { name: /^Delete conversation: / })).toHaveCount(0);
  await sidebar.getByRole('button', { name: `Expand group ${folder}`, exact: true }).click();
  await expect(sidebar.getByRole('button', { name: `Delete conversation: ${prompt}`, exact: true })).toHaveAttribute('title', 'Delete the conversation and its task history (files are not deleted)');
  const removeFolder = sidebar.getByRole('button', { name: `Remove workspace ${folder}`, exact: true });
  await expect(removeFolder).toHaveAttribute('title', 'Remove from DatGold — the folder on disk is not deleted');
  const question = async (target) => {
    const seen = new Promise((resolve) => page.once('dialog', (dialog) => { resolve(dialog.message()); void dialog.dismiss(); }));
    await target.click();
    return seen;
  };
  const conversations = await sidebar.getByRole('button', { name: /^Delete conversation: / }).count();
  expect(await question(removeFolder)).toBe(`Remove the workspace "${folder}" from DatGold?\n\n${conversations} conversation${conversations === 1 ? '' : 's'} and the workspace’s background tasks will be hidden from the interface. The history stays saved and comes back when you add the same folder again.\n\nThis does NOT delete the folder, files, Git branches or worktrees on this computer.`);
  expect(await question(sidebar.getByRole('button', { name: `Delete conversation: ${prompt}`, exact: true })))
    .toBe(`Delete the conversation "${prompt}"?\n\nThe history of its task turns will be removed from DatGold. This cannot be undone.\n\nThis does NOT delete project files, Git branches or worktrees.`);
  await expect(sidebar.getByRole('button', { name: `Delete conversation: ${prompt}`, exact: true })).toHaveCount(1);
  expect((await app.hub.task(chat.id)).id).toBe(chat.id);

  // The permission mode and the approvals: the toast of each click, and the history that stays under the conversation
  app.mock.define('write-after-asking', (ctx) => {
    if (ctx.turn > 0) return say('Xong.');
    const args = { path: ctx.prompt.includes('second') ? 'SECOND.md' : 'FIRST.md', content: 'hello\n' };
    return ctx.tools.includes('write_file') ? call('write_file', args) : call('mcp_call', { name: 'local.write_file', arguments_json: JSON.stringify(args) });
  });
  app.mock.setScenario('write-after-asking');
  await page.getByTitle('Agent Execution Mode', { exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Review/ }).click();
  await expect(page.getByText('Switched to review mode', { exact: true })).toBeVisible();
  const sendHere = async (text) => {
    // the work panel on the right has text boxes of its own: this is the one under the conversation
    await page.locator('#panel-conversation textarea').fill(text);
    await page.locator('#panel-conversation').getByRole('button', { name: 'Send', exact: true }).click();
  };
  const pending = page.getByRole('region', { name: /^Approval: local\./ });
  await sendHere('Please write the first file.');
  await expect(pending).toHaveCount(1);
  await page.getByRole('button', { name: 'Approve', exact: true }).and(page.locator(':enabled')).click();
  await expect(page.getByText('Action approved', { exact: true })).toBeVisible();
  await waitForState(app.hub, chat.id, 'completed');
  await expect(page.getByText('Approval history (1)', { exact: true })).toBeVisible();
  await sendHere('Please write the second file.');
  await expect(pending).toHaveCount(1);
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm denial', exact: true }).click();
  await expect(page.getByText('Action denied', { exact: true })).toBeVisible();
  await waitForState(app.hub, chat.id, 'completed');
  await expect(page.getByText('Approval history (2)', { exact: true })).toBeVisible();
  await expect(fs.stat(path.join(app.project, 'FIRST.md'))).resolves.toBeTruthy();
  await expect(fs.stat(path.join(app.project, 'SECOND.md'))).rejects.toThrow();

  // The channel: with the Hub set to ChatGPT Web, the open conversation says the next turn changes channel (and names the new one in bold), and a new
  // conversation shows the ChatGPT Web banner, with its hint in the tooltip
  await app.hub.post('/api/agent/mode', { mode: 'chatgpt-web' });
  const notice = page.getByTestId('transport-switch-notice');
  await expect(notice).toBeVisible();
  expect(await notice.innerText()).toBe('The next turn uses ChatGPT Web Companion. DatGold keeps the link to the earlier turns and passes on a summary of the context, but it does not assume the two models share a history. File writes that were not verified are not replayed automatically.');
  await expect(notice.locator('strong')).toHaveText('ChatGPT Web Companion');
  await expectEnglishOnly(notice, 'Channel notice');
  await sidebar.getByRole('button', { name: 'New Session', exact: true }).click();
  const web = page.getByTestId('chatgpt-web-mode-banner');
  await expect(web).toBeVisible();
  await expect(web.locator('span').first()).toHaveText('ChatGPT Web (text-only) · Pair the DatGold Hub Companion before sending a task');
  await expect(web.locator('span').first()).toHaveAttribute('title', 'The Web Companion channel only sends text through the ChatGPT tab for now; use the Model API to send images or attached files.');
  await expect(web.getByRole('button', { name: 'Set up', exact: true })).toBeVisible();
  await expectEnglishOnly(web, 'ChatGPT Web banner');
  await app.hub.post('/api/agent/mode', { mode: 'api' });
  await expect(web).toHaveCount(0);
});
