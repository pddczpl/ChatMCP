// ChatGPT Web Companion privacy in the real React page, served by a real Hub: the honest risk wording and "review before send".
// The Companion is played over HTTP with its own pairing (the extension itself is covered by companion-ipc.spec.mjs); the tool that
// runs is the real local.read_file on the test workspace. Nothing in the Hub or the page is stubbed.
import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { waitFor } from '../../tests/e2e/hub-process.mjs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EXTENSION = 'a'.repeat(32);
const CHAT = 'https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b';
// assembled at run time: the repository holds no string that looks like a leaked key
const AWS_KEY = ['AKIA', 'IOSFODNN', '7EXAMPLE'].join('');

async function pairCompanion(app) {
  const hub = app.hub;
  await hub.post('/api/agent/mode', { mode: 'chatgpt-web' });
  const { code } = await hub.post('/api/browser/pair-code', {});
  const clientId = randomUUID();
  const origin = `chrome-extension://${EXTENSION}`;
  const post = async (route, payload, token) => {
    const response = await fetch(`${hub.origin}/api/browser/clients/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ clientId, ...payload }),
    });
    return { status: response.status, json: await response.json() };
  };
  const { token } = (await post('pair', { code, extensionId: EXTENSION })).json;
  return {
    poll: async (taskId) => (await post('poll', { taskId, phase: 'idle', note: '' }, token)).json,
    claim: (taskId, messageId) => post('claim', { taskId, messageId }, token),
    sent: (taskId, messageId) => post('sent', { taskId, messageId, url: CHAT }, token),
    reply: (message, body) => {
      const block = `\`\`\`json\n${JSON.stringify({ chatmcp_hub: 'v1', task: message.taskId, turn: message.turn, nonce: message.nonce, ...body })}\n\`\`\``;
      return post('reply', { taskId: message.taskId, messageId: message.id, replyId: randomUUID(), text: block, blocks: [block], url: CHAT }, token);
    },
  };
}

test('the ChatGPT Web risk wording is visible in Settings before switching, and review before send is off by default and can be saved', async ({ page, app }) => {
  await onboard(page, app);
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Cài đặt', exact: true }).click();
  const card = page.getByTestId('agent-transport-settings');
  await expect(card.getByRole('button', { name: 'Kênh agent: Model API' })).toHaveAttribute('aria-pressed', 'true');
  // visible while the Model API is still selected: the person reads it BEFORE choosing the channel
  const risk = card.getByTestId('chatgpt-web-risk-note');
  await expect(risk).toBeVisible();
  await expect(risk).toContainText('chatgpt.com');
  await expect(risk).toContainText('Điều khoản sử dụng của OpenAI');
  await expect(risk).toContainText('đình chỉ');
  await expect(risk).toContainText('lịch sử ChatGPT');
  await expect(risk).toContainText('nỗ lực tối đa');
  await expect(risk).not.toContainText(/chính thức|official/i);

  const toggle = card.getByTestId('review-before-send-toggle');
  await expect(toggle).not.toBeChecked();
  expect((await app.hub.state()).browser.privacy.reviewBeforeSend).toBe(false);
  await toggle.click(); // a controlled box: it shows the saved value once the Hub confirms
  await expect.poll(async () => (await app.hub.state()).browser.privacy.reviewBeforeSend).toBe(true);
  await expect(toggle).toBeChecked();

  const select = card.getByTestId('review-before-send-workspace');
  await expect(select).toHaveValue('');
  await select.selectOption('off');
  await expect.poll(async () => (await app.hub.state()).browser.privacy.workspaces.map((item) => item.review)).toEqual([false]);
  await select.selectOption('');
  await expect.poll(async () => (await app.hub.state()).browser.privacy.workspaces.length).toBe(0);
  await toggle.click();
  await expect.poll(async () => (await app.hub.state()).browser.privacy.reviewBeforeSend).toBe(false);
});

test('a held tool result appears as a review card; Redact more, Approve and Withhold decide what ChatGPT receives', async ({ page, app }) => {
  await onboard(page, app);
  await fs.writeFile(path.join(app.project, 'notes.txt'), `Deploy notes\nkey: ${AWS_KEY}\nhost: staging-db-host.internal\nplan: SECRET-PROJECT-PLAN\n`);
  const companion = await pairCompanion(app);
  await app.hub.post('/api/browser/privacy/config', { reviewBeforeSend: true });
  const prompt = 'Read notes.txt and summarise it.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);

  // the task view carries the honest note, with the whole list one click away
  const taskNote = page.getByTestId('chatgpt-web-task-risk-note');
  await expect(taskNote).toBeVisible();
  await expect(taskNote).toContainText('Điều khoản sử dụng của OpenAI');

  const first = (await companion.poll(task.id)).message;
  expect(first.text).toContain('CHATMCP HUB');
  await companion.claim(task.id, first.id);
  await companion.sent(task.id, first.id);
  expect((await companion.reply(first, { kind: 'tool', name: 'local.read_file', arguments: { path: 'notes.txt' } })).json.accepted).toBe(true);

  const review = page.getByTestId('outbound-review-card');
  await expect(review).toBeVisible();
  await expect(review).toContainText('Chưa có gì được gửi');
  const preview = review.getByTestId('outbound-review-preview');
  await expect(preview).toContainText('[REDACTED:aws-access-key-id]');
  await expect(preview).toContainText('staging-db-host.internal');
  await expect(page.locator('body')).not.toContainText(AWS_KEY);
  expect((await companion.poll(task.id)).message).toBeNull();

  // Redact more: type the text; the preview is rebuilt; the message stays held
  await review.getByTestId('outbound-review-extra').fill('staging-db-host.internal');
  await review.getByTestId('outbound-review-redact').click();
  await expect(preview).toContainText('[REDACTED:manual]');
  await expect(preview).not.toContainText('staging-db-host.internal');
  expect((await companion.poll(task.id)).message).toBeNull();

  // Approve: the Companion receives exactly the text that was previewed
  const previewed = await preview.textContent();
  await review.getByTestId('outbound-review-approve').click();
  await expect(page.getByTestId('outbound-review-card')).toHaveCount(0);
  const released = (await companion.poll(task.id)).message;
  expect(released.text).toBe(previewed);
  expect(released.text).not.toContain(AWS_KEY);
  expect(released.text).not.toContain('staging-db-host.internal');
  await companion.claim(task.id, released.id);
  await companion.sent(task.id, released.id);

  // Withhold: ChatGPT receives a notice instead of the file
  await companion.reply(released, { kind: 'tool', name: 'local.read_file', arguments: { path: 'notes.txt' } });
  await expect(review).toBeVisible();
  await review.getByTestId('outbound-review-withhold').click();
  await expect(page.getByTestId('outbound-review-card')).toHaveCount(0);
  const notice = (await companion.poll(task.id)).message;
  expect(notice.text).toContain('chose not to send it to ChatGPT');
  expect(notice.text).not.toContain('SECRET-PROJECT-PLAN');

  // nothing was held without review: the setting is the only difference
  await waitFor(async () => (await app.hub.state()).browser.outboundReview === null);
});
