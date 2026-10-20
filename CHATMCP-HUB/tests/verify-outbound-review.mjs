// Gate for "review before send" (pod-14): the hold, Approve, Redact more, Withhold, cancellation and the timeout.
//
// Same harness as verify-outbound-runner.mjs: the real BrowserRunner driven the way the extension drives it, only the tool server
// stubbed. The question every case asks is the same one: what could chatgpt.com have been handed, and when?
//
//   * off by default; on, per workspace or globally (persisted); catalog and describe replies are not held
//   * a held message is invisible to poll(), refused by claim() and sent(), and no timer ever sends it
//   * Redact more rebuilds the message from the filtered result (header, nonce and the paging copy stay consistent), keeps hiding
//     the same text in later results of the task, and never touches the protocol envelope
//   * Withhold sends a notice instead of the result; Approve releases exactly the previewed text
//   * cancelling the task or letting the hold time out ends the task with nothing sent
import assert from 'node:assert/strict';
import { BrowserRunner } from '../lib/browser-runner.mjs';
import { body } from './fixtures/outbound-corpus.mjs';
import { envelopeOf, makeFlow, textResult } from './fixtures/companion-flow.mjs';

let checks = 0;
const check = (condition, label, detail = '') => { assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`); checks += 1; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rejectsWith = async (promise, code, label) => { await assert.rejects(promise, (error) => error.code === code, label); checks += 1; };

const FILE = 'desktop-commander.read_file';
const files = new Map();
const tools = { [FILE]: ({ path }) => textResult(files.get(path) ?? `contents of ${path}`), 'desktop-commander.list_directory': () => textResult('src\nREADME.md') };
const awsKey = `AKIA${body('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16)}`;

/** A task whose first message was delivered; returns what the model has to answer. */
async function started(flow, prompt = 'Look at the sources.') { await flow.start({ prompt }); return flow.deliver(); }
const ask = (flow, message, path) => flow.reply(message, { kind: 'tool', name: FILE, arguments: { path } });

// ---- 1. off by default, per-workspace and global settings, persistence -------------------------------------------------------
{
  const flow = await makeFlow({ tools });
  try {
    check(flow.runner.privacyState().reviewBeforeSend === false, 'review before send is off by default');
    const message = await started(flow);
    files.set('src/a.ts', `const key = '${awsKey}';`);
    await ask(flow, message, 'src/a.ts');
    check(flow.task.status === 'queued' && flow.task.message.status === 'pending', 'off: the result is queued at once');
    check(flow.runner.browserState().outboundReview === null, 'off: nothing to review');
    const delivered = await flow.deliver();
    check(!delivered.text.includes(awsKey), 'off: the scanner still applies');

    // global on, workspace override off -> not held; override cleared -> held
    const workspace = flow.manager.workspace;
    await flow.runner.configurePrivacy({ reviewBeforeSend: true });
    await flow.runner.configurePrivacy({ workspacePath: workspace, workspaceReview: false });
    check(flow.runner.reviewEnabledFor(workspace) === false, 'a workspace override beats the global setting');
    check(flow.runner.reviewEnabledFor('F:\\somewhere\\else') === true, 'another workspace follows the global setting');
    await ask(flow, delivered, 'src/a.ts');
    check(flow.task.status === 'queued', 'global on + workspace off: not held');
    const next = await flow.deliver();
    await flow.runner.configurePrivacy({ workspacePath: workspace, workspaceReview: null });
    check(flow.runner.reviewEnabledFor(workspace) === true, 'clearing the override returns to the global setting');
    await flow.runner.configurePrivacy({ reviewBeforeSend: false, workspacePath: workspace, workspaceReview: true });
    check(flow.runner.reviewEnabledFor(workspace) === true, 'a workspace can turn it on while the global setting is off');
    check(flow.runner.reviewEnabledFor('F:\\somewhere\\else') === false, '... and another workspace stays off');

    // the setting survives a restart
    const reborn = new BrowserRunner({ manager: flow.manager, directory: flow.directory });
    await reborn.load();
    assert.deepEqual(reborn.privacyState(), flow.runner.privacyState());
    check(reborn.reviewEnabledFor(workspace) === true && reborn.reviewEnabledFor('F:\\somewhere\\else') === false, 'the setting is persisted');
    if (process.platform === 'win32') check(reborn.reviewEnabledFor(workspace.toUpperCase()) === true, 'Windows paths are compared without regard to case');

    for (const bad of [{ reviewBeforeSend: 'yes' }, { workspacePath: '', workspaceReview: true }, { workspacePath: workspace, workspaceReview: 'on' }, { workspacePath: 5, workspaceReview: true }])
      await rejectsWith(flow.runner.configurePrivacy(bad), 'invalid_privacy_config', JSON.stringify(bad));

    // catalog and describe carry no workspace data and are not held even when review is on
    await flow.runner.configurePrivacy({ reviewBeforeSend: true, workspacePath: workspace, workspaceReview: null });
    await flow.reply(next, { kind: 'catalog' });
    check(flow.task.status === 'queued', 'a catalog reply is not held');
    console.log('PASS off by default; global and per-workspace switches, persisted, validated; catalog replies are not held');
  } finally { await flow.close(); }
}

// ---- 2. hold, preview, Redact more, Approve ---------------------------------------------------------------------------------
{
  const flow = await makeFlow({ tools, reviewBeforeSend: true });
  try {
    let message = await started(flow);
    check(flow.task.message.status !== 'held', 'the instruction itself is not held');
    files.set('src/budget.ts', `// Project Zephyr budget: 4M\nconst key = '${awsKey}';\n`);
    await ask(flow, message, 'src/budget.ts');
    const task = flow.task, held = task.message;
    check(task.status === 'waiting_approval' && held.status === 'held', 'the result is held, the task waits for the owner', `${task.status}/${held.status}`);
    for (let i = 0; i < 5; i++) { check((await flow.poll()).message === null, 'poll() offers nothing while a message is held'); await sleep(15); }
    await rejectsWith(flow.runner.claim({ clientId: flow.clientId, taskId: task.id, messageId: held.id }), 'already_claimed', 'claim() of a held message');
    await rejectsWith(flow.runner.sent({ clientId: flow.clientId, taskId: task.id, messageId: held.id, url: 'https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b' }), 'not_claimed', 'sent() of a held message');
    check(held.clientId === null && held.claimedAt === undefined && held.sentAt === null, 'nothing was claimed or sent');

    const view = flow.runner.browserState().outboundReview;
    check(view && view.taskId === task.id && view.turn === held.turn && view.tool === FILE, 'the dashboard state describes the held message');
    check(view.preview === held.text, 'the preview is exactly the text that would be sent');
    check(view.preview.includes('Project Zephyr') && view.preview.includes('[REDACTED:aws-access-key-id]') && !view.preview.includes(awsKey), 'the preview is already scrubbed of the credential');
    check(view.redactions['aws-access-key-id'] === 1 && new Date(view.expiresAt) > new Date(view.at), 'the preview names what was removed and when the hold expires');
    check(!JSON.stringify(flow.runner.state()).includes('Project Zephyr') && !JSON.stringify(await flow.poll()).includes('Project Zephyr'), 'the preview is not part of the task list or of poll()');

    await rejectsWith(flow.runner.decideOutbound({ id: 'not-a-review', action: 'approve' }), 'review_not_pending', 'a wrong id');
    await rejectsWith(flow.runner.decideOutbound({ id: view.id, action: 'send-it' }), 'invalid_review_action', 'an unknown action');
    for (const bad of [[], ['ab'], [5], ['x'.repeat(201)], Array.from({ length: 21 }, (_, i) => `value-${i}`)])
      await rejectsWith(flow.runner.decideOutbound({ id: view.id, action: 'redact_more', redact: bad }), 'invalid_redaction', JSON.stringify(bad).slice(0, 40));
    check(held.status === 'held', 'rejected requests change nothing');

    // Redact more: the text goes, the envelope stays, the message stays held
    const before = envelopeOf(held.text);
    const redacted = await flow.runner.decideOutbound({ id: view.id, action: 'redact_more', redact: ['Project Zephyr'] });
    check(redacted.matched === 1, 'one occurrence was hidden', JSON.stringify(redacted.matched));
    check(held.status === 'held' && task.status === 'waiting_approval', 'still held after Redact more');
    check(!held.text.includes('Zephyr') && held.text.includes('[REDACTED:manual]'), 'the chosen text is gone from the message');
    assert.deepEqual(envelopeOf(held.text), before);
    check(true, 'the envelope is unchanged by Redact more');
    check(flow.runner.browserState().outboundReview.preview === held.text && flow.runner.browserState().outboundReview.manualCount === 1, 'the preview shows the new text');
    check(!JSON.stringify(task.events).includes('Zephyr'), 'the text the owner hid is not written into the events');
    check((await flow.poll()).message === null, 'poll() still offers nothing');

    // Approve releases exactly the previewed text
    const previewed = flow.runner.browserState().outboundReview.preview;
    await flow.runner.decideOutbound({ id: view.id, action: 'approve' });
    check(task.status === 'queued' && held.status === 'pending' && flow.runner.browserState().outboundReview === null, 'Approve releases the message');
    const delivered = await flow.deliver();
    check(delivered.text === previewed, 'what was delivered is exactly what was previewed');
    await rejectsWith(flow.runner.decideOutbound({ id: view.id, action: 'approve' }), 'review_not_pending', 'a second decision');

    // the same text is hidden in later results of the task
    message = delivered;
    files.set('src/more.ts', '// Project Zephyr again\nexport {};\n');
    await ask(flow, message, 'src/more.ts');
    const second = flow.runner.browserState().outboundReview;
    check(second && !second.preview.includes('Zephyr') && second.preview.includes('[REDACTED:manual]'), 'a later result of the task keeps the text hidden');

    // Withhold sends a notice, not the result
    files.set('src/more.ts', '// SECRET-PROJECT-PLAN\n');
    await flow.runner.decideOutbound({ id: second.id, action: 'withhold' });
    const notice = await flow.deliver();
    check(/chose not to send it to ChatGPT/.test(notice.text) && !notice.text.includes('Zephyr') && envelopeOf(notice.text).nonce === task.nonce, 'Withhold delivers a notice with the envelope intact');
    check(notice.text.includes('"withheld": true') && !notice.text.includes('contents of'), 'the notice carries no part of the result');
    console.log('PASS hold: invisible to poll, refused by claim and sent; Redact more keeps the envelope and persists; Approve releases the previewed text; Withhold sends a notice');

    // a paged result: Redact more re-pages it, the old page id dies, Withhold drops the paging copy
    message = notice;
    files.set('src/long.ts', `// Project Zephyr\n${'line of ordinary code;\n'.repeat(200)}`);
    await ask(flow, message, 'src/long.ts');
    const paged = flow.runner.browserState().outboundReview;
    const oldId = /"resultId":"([0-9a-f-]{36})"/.exec(paged.preview)[1];
    check(flow.context.pagedResults.has(oldId), 'the held result is paged');
    await flow.runner.decideOutbound({ id: paged.id, action: 'redact_more', redact: ['ordinary code'] });
    const newView = flow.runner.browserState().outboundReview;
    const newId = /"resultId":"([0-9a-f-]{36})"/.exec(newView.preview)[1];
    check(newId !== oldId && !flow.context.pagedResults.has(oldId) && flow.context.pagedResults.has(newId), 'Redact more re-pages: the old result id no longer serves anything');
    check(!flow.context.pagedResults.get(newId).includes('ordinary code'), 'the paging copy is redacted as well');
    await flow.runner.decideOutbound({ id: newView.id, action: 'withhold' });
    check(!flow.context.pagedResults.has(newId), 'Withhold deletes the paging copy');
    console.log('PASS a paged result is re-paged by Redact more and dropped by Withhold');
  } finally { await flow.close(); }
}

// ---- 3. cancellation ---------------------------------------------------------------------------------------------------------------
{
  const flow = await makeFlow({ tools, reviewBeforeSend: true, reviewTimeoutMs: 40 });
  try {
    const message = await started(flow);
    files.set('src/a.ts', 'export const a = 1;');
    await ask(flow, message, 'src/a.ts');
    const view = flow.runner.browserState().outboundReview;
    const taskId = flow.task.id, context = flow.context;
    await flow.runner.cancel(taskId);
    check(flow.task.status === 'cancelled' && flow.task.message === null, 'cancelling ends the task and drops the held message');
    check(flow.runner.browserState().outboundReview === null && context.review === null, 'no review is left behind');
    check((await flow.runner.poll({ clientId: flow.clientId, taskId })).message === null, 'poll() offers nothing after cancellation');
    await rejectsWith(flow.runner.decideOutbound({ id: view.id, action: 'approve' }), 'review_not_pending', 'approving after cancellation');
    await sleep(120); // well past the 40 ms hold: a timer that outlived the task would now mark it failed
    check(flow.task.status === 'cancelled' && flow.task.errorCode !== 'outbound_review_timeout', 'the review timer died with the task', `${flow.task.status}/${flow.task.errorCode}`);
    console.log('PASS cancellation while held: nothing sent, no review, no timer, a late Approve is refused');
  } finally { await flow.close(); }
}

// ---- 4. timeout ----------------------------------------------------------------------------------------------------------------------
{
  const flow = await makeFlow({ tools, reviewBeforeSend: true, reviewTimeoutMs: 60 });
  try {
    const message = await started(flow);
    files.set('src/a.ts', 'export const a = 1;');
    await ask(flow, message, 'src/a.ts');
    const seen = [];
    const deadline = Date.now() + 400;
    while (Date.now() < deadline && flow.task.status === 'waiting_approval') { seen.push((await flow.poll()).message); await sleep(10); }
    for (let i = 0; i < 3; i++) { seen.push((await flow.poll()).message); await sleep(10); }
    check(seen.length >= 3 && seen.every((item) => item === null), 'no poll during or after the hold ever saw the message', `${seen.length} polls`);
    check(flow.task.status === 'failed' && flow.task.errorCode === 'outbound_review_timeout', 'the hold times out and ends the task', `${flow.task.status}/${flow.task.errorCode}`);
    check(flow.task.unverifiedDelivery?.status === 'held', 'the task records that the result was never delivered, so a continuation says so');
    check(flow.runner.context === null && flow.runner.browserState().outboundReview === null, 'the runner is idle again');
    console.log('PASS timeout: the held message is never offered, the task fails with outbound_review_timeout and is marked for a careful continuation');
  } finally { await flow.close(); }
}

// ---- 5. a Hub restart while a message is held -----------------------------------------------------------------------------------------
{
  const flow = await makeFlow({ tools, reviewBeforeSend: true });
  try {
    const message = await started(flow);
    files.set('src/a.ts', 'export const a = 1;');
    await ask(flow, message, 'src/a.ts');
    const id = flow.task.id;
    check(flow.task.message.status === 'held', 'held before the restart');
    // The files on disk are what a restarted Hub reads: the held text was scrubbed, and it is never offered again.
    const reborn = new BrowserRunner({ manager: flow.manager, directory: flow.directory });
    await reborn.load();
    const task = reborn.tasks.get(id);
    check(task.status === 'paused' && task.errorCode === 'hub_restarted' && task.message === null, 'a restarted Hub pauses the task and drops the held message', `${task.status}/${task.errorCode}`);
    check(task.unverifiedDelivery?.status === 'held', 'the restart records the undelivered result, so the resumer will not continue on its own');
    check(reborn.browserState().outboundReview === null, 'there is nothing to review after a restart');
    console.log('PASS restart while held: the task is paused, the message is gone, automatic resume is blocked');
  } finally { await flow.close(); }
}

console.log(`PASS outbound review suite (${checks} checks)`);
