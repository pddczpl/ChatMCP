// Review before send against a REAL Hub process (pod-14): the HTTP surface, the bearer, the real local tools.
//
// The test plays the Companion over HTTP exactly as the extension does (pair, poll, claim, sent, reply) and plays the person
// through the dashboard's own routes (with the Hub secret). The tool that runs is the real local.read_file on a real folder.
//
//   * the setting is written through POST /api/browser/privacy/config and read back from /api/state
//   * a held result is visible in /api/state (with the secret) and nowhere else: not without the secret, not in /api/extension-state,
//     not in poll(); claim() of it is refused
//   * Redact more and Approve go through POST /api/browser/outbound/decide; what the Companion then receives is the scrubbed text
//   * cancelling the task through the dashboard route clears the hold and sends nothing
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHub, waitFor } from './e2e/hub-process.mjs';
import { gitInit, makeCalcProject, writeFiles } from './e2e/fixtures.mjs';
import { body } from './fixtures/outbound-corpus.mjs';

let checks = 0;
const check = (condition, label, detail = '') => { assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`); checks += 1; };

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-outbound-hub-'));
const project = path.join(scratch, 'project');
const awsKey = `AKIA${body('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16)}`;
makeCalcProject(project);
writeFiles(project, { 'notes.txt': `Deploy notes\nkey: ${awsKey}\nhost: staging-db-host.internal\n` });
gitInit(project, scratch);
let hub;
try {
  hub = await startHub({ scratch, project });
  const csrfAndBearerPost = (route, payload) => hub.post(route, payload);
  const EXTENSION = 'a'.repeat(32), clientId = randomUUID(), origin = `chrome-extension://${EXTENSION}`;
  let token = null;
  /** What the extension does: JSON POST with its own Origin and, after pairing, its own bearer. */
  const companion = async (route, payload) => {
    const response = await fetch(`${hub.origin}/api/browser/clients/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ clientId, ...payload }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  // ---- pairing and the setting ----------------------------------------------------------------------------------------
  await csrfAndBearerPost('/api/agent/mode', { mode: 'chatgpt-web' });
  const { code } = await csrfAndBearerPost('/api/browser/pair-code', {});
  const paired = await companion('pair', { code, extensionId: EXTENSION });
  check(paired.status === 200 && /^[0-9a-f]{64}$/.test(paired.json.token), 'the Companion paired with its own protocol');
  token = paired.json.token;

  check((await hub.state()).browser.privacy.reviewBeforeSend === false, 'review before send is off by default');
  check((await hub.request('POST', '/api/browser/privacy/config', { reviewBeforeSend: true }, { auth: false })).status === 401, 'the setting needs the Hub secret');
  check((await hub.request('POST', '/api/browser/outbound/decide', { id: 'x', action: 'approve' }, { auth: false })).status === 401, 'a decision needs the Hub secret');
  check((await hub.request('POST', '/api/browser/privacy/config', { reviewBeforeSend: 'yes' })).status === 400, 'a malformed setting is refused');
  const configured = await csrfAndBearerPost('/api/browser/privacy/config', { reviewBeforeSend: true });
  check(configured.browser.privacy.reviewBeforeSend === true && (await hub.state()).browser.privacy.reviewBeforeSend === true, 'the setting is written and read back');
  const decideIdle = await hub.request('POST', '/api/browser/outbound/decide', { id: randomUUID(), action: 'approve' });
  check(decideIdle.status === 404, 'a decision with nothing held answers 404', `${decideIdle.status}`);
  console.log('PASS the setting and the decision route are behind the Hub secret; defaults and validation hold');

  // ---- a task whose first tool result is held -------------------------------------------------------------------------------
  const task = (await csrfAndBearerPost('/api/tasks/start', { prompt: 'Read notes.txt and summarise it.' })).task;
  const poll = async () => (await companion('poll', { taskId: task.id, phase: 'idle', note: '' })).json;
  const first = (await poll()).message;
  check(first && /CHATMCP HUB/.test(first.text), 'the instruction is delivered normally (it is not a tool result)');
  const url = 'https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b';
  const answer = async (message, extra) => {
    const block = `\`\`\`json\n${JSON.stringify({ chatmcp_hub: 'v1', task: message.taskId, turn: message.turn, nonce: message.nonce, ...extra })}\n\`\`\``;
    return companion('reply', { taskId: message.taskId, messageId: message.id, replyId: randomUUID(), text: block, blocks: [block], url });
  };
  check((await companion('claim', { taskId: task.id, messageId: first.id })).status === 200, 'claimed');
  check((await companion('sent', { taskId: task.id, messageId: first.id, url })).status === 200, 'sent');
  const accepted = await answer(first, { kind: 'tool', name: 'local.read_file', arguments: { path: 'notes.txt' } });
  check(accepted.status === 200 && accepted.json.accepted === true, 'the Hub accepted the model reply', JSON.stringify(accepted));

  const held = await waitFor(async () => (await hub.state()).browser.outboundReview, { label: 'a held message in /api/state' });
  check(held.tool === 'local.read_file' && held.kind === 'tool' && held.taskId === task.id, 'the held message is described');
  check(held.preview.includes('[REDACTED:aws-access-key-id]') && !held.preview.includes(awsKey), 'the preview is scrubbed of the credential');
  check(held.preview.includes('staging-db-host.internal'), 'the rest of the file is in the preview, for the person to judge');
  const summary = (await hub.state()).agent.tasks.find((item) => item.id === task.id);
  check(summary.status === 'waiting_approval', 'the task list says the task waits for the owner', summary.status);

  const unauthenticated = await hub.request('GET', '/api/state', null, { auth: false });
  check(unauthenticated.status === 401 && !unauthenticated.text.includes('staging-db-host'), 'without the Hub secret the preview is not readable');
  const extensionState = await fetch(`${hub.origin}/api/extension-state`, { headers: { origin } });
  const extensionText = await extensionState.text();
  check(extensionState.status === 200 && !extensionText.includes('staging-db-host') && !/outboundReview|preview/.test(extensionText), '/api/extension-state carries no preview');
  const pending = (await poll()).message;
  check(pending === null, 'poll() offers nothing while the message is held');
  const refused = await companion('claim', { taskId: task.id, messageId: randomUUID() });
  check(refused.status === 409, 'claim() of a message that is not the pending one is refused', `${refused.status}`);
  console.log('PASS held: visible to the owner only, invisible to poll(), absent from the extension routes');

  // ---- Redact more, Approve ---------------------------------------------------------------------------------------------------
  const redacted = await csrfAndBearerPost('/api/browser/outbound/decide', { id: held.id, action: 'redact_more', redact: ['staging-db-host.internal'] });
  check(redacted.matched === 1 && !redacted.review.preview.includes('staging-db-host') && redacted.review.preview.includes('[REDACTED:manual]'), 'Redact more hides the chosen text');
  check((await poll()).message === null, 'still nothing for the Companion');
  const wrong = await hub.request('POST', '/api/browser/outbound/decide', { id: randomUUID(), action: 'approve' });
  check(wrong.status === 404, 'a wrong id is refused');
  const previewed = (await hub.state()).browser.outboundReview.preview;
  await csrfAndBearerPost('/api/browser/outbound/decide', { id: held.id, action: 'approve' });
  const released = (await poll()).message;
  check(released && released.text === previewed, 'after Approve the Companion receives exactly the previewed text');
  check(!released.text.includes(awsKey) && !released.text.includes('staging-db-host'), 'and nothing the owner hid');
  check((await hub.state()).browser.outboundReview === null, 'the hold is gone');
  check((await companion('claim', { taskId: task.id, messageId: released.id })).status === 200, 'claimed after approval');
  check((await companion('sent', { taskId: task.id, messageId: released.id, url })).status === 200, 'sent after approval');
  await answer(released, { kind: 'final', text: 'Done.' });
  await waitFor(async () => (await hub.state()).agent.tasks.find((item) => item.id === task.id)?.status === 'completed', { label: 'the task to complete' });
  console.log('PASS Redact more and Approve over HTTP; the Companion gets exactly the previewed, scrubbed text');

  // ---- cancellation through the dashboard route ------------------------------------------------------------------------------------
  const second = (await csrfAndBearerPost('/api/tasks/start', { prompt: 'Read notes.txt again.' })).task;
  const pollSecond = async () => (await companion('poll', { taskId: second.id, phase: 'idle', note: '' })).json;
  const opening = (await pollSecond()).message;
  await companion('claim', { taskId: second.id, messageId: opening.id });
  await companion('sent', { taskId: second.id, messageId: opening.id, url });
  await answer(opening, { kind: 'tool', name: 'local.read_file', arguments: { path: 'notes.txt' } });
  const heldAgain = await waitFor(async () => (await hub.state()).browser.outboundReview, { label: 'a second held message' });
  await csrfAndBearerPost('/api/tasks/cancel', { id: second.id });
  check((await hub.state()).browser.outboundReview === null, 'cancelling clears the hold');
  check((await pollSecond()).message === null, 'and nothing is delivered');
  const late = await hub.request('POST', '/api/browser/outbound/decide', { id: heldAgain.id, action: 'approve' });
  check(late.status === 404, 'a late Approve is refused');
  console.log('PASS cancel through /api/tasks/cancel: no hold left, nothing delivered, late Approve refused');
} finally {
  if (hub) await hub.stop().catch(() => hub.killTree());
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`PASS outbound Hub suite (${checks} checks)`);
