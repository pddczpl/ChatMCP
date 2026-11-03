// The approval card shows the REAL change (P8 ux-7), and the call that follows the answer is held to it. On the production objects: the real LocalTools, the real PermissionGate and,
// for the second half, a real HubManager (assembleStudio) with its guarded session.callTool, real files and hooks that are real child processes. Only the model is scripted.
//
//  A. what the card holds: for write_file, edit_file, files_apply_patch and files_write_batch, per file its path, the hash of the bytes it was made from, the counts and the hunks of the
//     plan; the legacy text of the request stays small; nothing is written or created by asking
//  B. the bounds: 20 files, 200 rows of a file, a cut line, a budget of characters for the whole card; what is left out is counted
//  C. secrets: a token in a changed line, in a context line and in a removed line is masked in the card, in the event, in the pending state and in the history; the content of a protected file
//     is never in the card; a registered secret too
//  D. which calls ask does not change, and nothing is previewed where nobody is asked
//  E. the call that follows the answer: a file that changed (or appeared, or went away) after the card was drawn is not written, `executed:false`, `stale_after_approval`, the model is
//     told; a card is for one call; a deny still denies; a hook's question draws the card as well
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { delay } from '../lib/runtime.mjs';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { PermissionGate } from '../lib/permissions.mjs';
import { HookRunner } from '../lib/hooks.mjs';
import { PREVIEW_LIMITS, argumentsDigest, buildChangePreview } from '../lib/approval-preview.mjs';
import { diffHunks, hunksDigest } from '../lib/line-diff.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the approval preview suite exceeded its own time budget'); process.exit(2); }, 240_000).unref();

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(bundleRoot, 'tests', 'fixtures', 'hook-program.mjs');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-approval-preview-')));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const text = (result) => (result.content ?? []).map((part) => part.text ?? '').join('\n');
// Secrets in this file are built at run time, never written as literals.
const OPENAI_KEY = `sk-${'Ab12Cd34'.repeat(4)}`;
const GITHUB_TOKEN = `ghp_${'Zx9Yw8Vu7T'.repeat(4)}`;
const PASSWORD = 'Hunter2-Hunter2-Only';
const REGISTERED = 'registered-secret-value-4711';
const ENV_MARKER = 'ENV_ONLY_MARKER_7f3a91';
const SECRETS = [OPENAI_KEY, GITHUB_TOKEN, PASSWORD, REGISTERED, ENV_MARKER];
const leaks = (value) => SECRETS.filter((secret) => JSON.stringify(value).includes(secret));

// ------------------------------------------------------------------ A-D. the gate with the real local tools
const area = path.join(root, 'gate-area');
const stateDirectory = path.join(root, 'gate-state');
await fs.mkdir(area, { recursive: true });
const put = async (name, content) => { await fs.mkdir(path.dirname(path.join(area, name)), { recursive: true }); await fs.writeFile(path.join(area, name), content); return Buffer.isBuffer(content) ? content : Buffer.from(content); };
const read = (name) => fs.readFile(path.join(area, name), 'utf8');
const exists = (name) => fs.access(path.join(area, name)).then(() => true, () => false);
const manager = { workspace: area, secrets: [REGISTERED] };
const studio = new StudioWorkspace({ manager, directory: path.join(stateDirectory, 'studio') });
const localTools = new LocalTools({ workspace: studio, stateDirectory });
const newGate = (mode = 'review') => { const gate = new PermissionGate({ manager, workspace: studio, timeout: 60_000 }); gate.attachLocalTools(localTools); gate.configure({ mode }); return gate; };
/** Asks and answers: the request as the owner saw it, what the gate said, and every event it emitted. */
async function ask(gate, name, args, { approve = true, taskId = 'task-1', forceAsk = false } = {}) {
  const events = [];
  gate.subscribe((event) => events.push(event));
  const run = gate.authorize({ name, args, definition: {}, taskId, forceAsk });
  let settled = null;
  run.then((value) => { settled = { value }; }, (thrown) => { settled = { thrown }; });
  for (let i = 0; i < 400 && !settled && gate.state().pending.length === 0; i += 1) await delay(5);
  if (settled?.thrown) throw settled.thrown;
  if (settled) return { kind: 'unasked', result: settled.value, events };
  const request = structuredClone(gate.state().pending[0]);
  gate.decide(request.id, approve);
  return { kind: 'prompt', request, result: await run, events };
}
const rowsOf = (file) => file.hunks.flatMap((hunk) => hunk.rows);

{
  // A. edit_file, one edit
  const original = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const buffer = await put('src/app.js', original);
  const gate = newGate();
  const edit = await ask(gate, 'local.edit_file', { path: 'src/app.js', old_string: 'const b = 2;', new_string: 'const b = 20;' });
  assert.equal(edit.kind, 'prompt');
  const card = edit.request.detail.preview;
  assert.equal(card.fileCount, 1);
  assert.equal(card.hiddenFiles, 0);
  assert.equal(card.truncated, false);
  assert.equal(card.error, undefined);
  const [file] = card.files;
  assert.equal(file.path, 'src/app.js');
  assert.equal(file.action, 'edit');
  assert.equal(file.baseSha, sha(buffer), 'the hash of the bytes the card was made from');
  assert.deepEqual([file.additions, file.deletions, file.unchanged], [1, 1, false]);
  assert.equal(hunksDigest(file.hunks), hunksDigest(diffHunks(original, original.replace('b = 2', 'b = 20')).hunks), 'the hunks are those of the change');
  assert.deepEqual(rowsOf(file).map((row) => row.kind), ['context', 'removed', 'added', 'context']);
  assert.deepEqual([file.shownRows, file.hiddenRows, file.truncated], [4, 0, false]);
  assert.equal(edit.request.detail.kind, 'edit', 'the old fields of the card are still there');
  assert.equal(edit.request.detail.old_string, 'const b = 2;');
  assert.ok(!edit.request.preview.includes('"rows"'), 'the legacy text of the request does not carry the rows');
  assert.ok(edit.request.preview.length < 3000);
  assert.equal(await read('src/app.js'), original, 'asking changes nothing (the answer was no... yes, but nothing ran here)');
  ok('edit_file: the card holds the path, the hash of the file, the counts and the hunks of the change; the old fields stay; the legacy text is small');

  // several edits at once
  const listed = await ask(newGate(), 'local.edit_file', { path: 'src/app.js', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'c = 3', new_string: 'c = 30' }] });
  const [two] = listed.request.detail.preview.files;
  assert.deepEqual([two.additions, two.deletions, two.hunks.length], [2, 2, 1]);
  assert.equal(listed.request.detail.kind, 'edit');
  // files_apply_patch
  const patch = await ask(newGate(), 'local.files_apply_patch', { path: 'src/app.js', old_text: 'const c = 3;', new_text: 'const c = 33;' });
  const [patched] = patch.request.detail.preview.files;
  assert.equal(patched.action, 'edit');
  assert.equal(patch.request.detail.kind, 'edit');
  assert.equal(patch.request.detail.path, 'src/app.js');
  assert.equal(patched.baseSha, sha(buffer));
  // write_file: a new file, and a file it replaces (CRLF and BOM are kept, so the rows have the real endings)
  const fresh = await ask(newGate(), 'local.write_file', { path: 'deep/new/dir/x.txt', content: 'one\ntwo\n' });
  const [created] = fresh.request.detail.preview.files;
  assert.deepEqual([created.action, created.baseSha, created.additions, created.deletions], ['create', null, 2, 0]);
  assert.equal(await exists('deep'), false, 'asking about a new file creates no folder');
  const windows = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('keep\r\nold\r\n')]);
  await fs.writeFile(path.join(area, 'win.txt'), windows);
  const overwrite = await ask(newGate(), 'local.write_file', { path: 'win.txt', content: 'keep\nnew\n', overwrite: true });
  const [replaced] = overwrite.request.detail.preview.files;
  assert.deepEqual([replaced.action, replaced.baseSha], ['overwrite', sha(windows)]);
  assert.deepEqual(rowsOf(replaced).map((row) => row.text), ['keep\r\n', 'old\r\n', 'new\r\n'], 'the file keeps its CRLF and the card says so');
  assert.equal(replaced.hunks[0].invisibleOnly, false);
  // a file that is not text
  await fs.writeFile(path.join(area, 'blob.bin'), Buffer.from([0, 1, 2, 3, 4]));
  const blob = await ask(newGate(), 'local.write_file', { path: 'blob.bin', content: 'text now\n', overwrite: true });
  assert.equal(blob.request.detail.preview.files[0].oldUnreadable, true);
  // files_write_batch
  const batch = await ask(newGate(), 'local.files_write_batch', { files: [{ path: 'b/one.txt', content: '1\n' }, { path: 'src/app.js', content: 'const a = 1;\n', overwrite: true }] });
  assert.equal(batch.request.detail.preview.fileCount, 2);
  assert.deepEqual(batch.request.detail.preview.files.map((item) => [item.path, item.action]), [['b/one.txt', 'create'], ['src/app.js', 'overwrite']]);
  assert.deepEqual([batch.request.detail.preview.files[1].additions, batch.request.detail.preview.files[1].deletions], [0, 2]);
  assert.equal(batch.request.detail.kind, 'batch');
  assert.equal(batch.request.detail.count, 2);
  assert.ok(!JSON.stringify(batch.request.detail.files).includes('const a'), 'the list of files of a batch carries no content');
  ok('edit_file with several edits, files_apply_patch, write_file (new, replacing with CRLF + BOM, replacing a file that is not text) and files_write_batch all draw the card from their plan; asking creates no folder');

  // a call that would be refused says so, and nothing else
  const missing = await ask(newGate(), 'local.edit_file', { path: 'src/app.js', old_string: 'nowhere', new_string: 'x' });
  assert.equal(missing.request.detail.preview.error.code, 'not_found');
  assert.deepEqual(missing.request.detail.preview.files, []);
  assert.equal(missing.result.guard, undefined, 'a call that would fail is held to nothing');
  const ambiguous = await ask(newGate(), 'local.edit_file', { path: 'src/app.js', old_string: 'const', new_string: 'let' });
  assert.equal(ambiguous.request.detail.preview.error.code, 'ambiguous_match');
  const absent = await ask(newGate(), 'local.edit_file', { path: 'src/none.js', old_string: 'a', new_string: 'b' });
  assert.equal(absent.request.detail.preview.error.code, 'not_found');
  const exists2 = await ask(newGate(), 'local.write_file', { path: 'src/app.js', content: 'x' });
  assert.equal(exists2.request.detail.preview.error.code, 'file_exists');
  ok('a call that would be refused when it runs gets a card that says why (not found, ambiguous, no such file, file exists) and no files');
}

{
  // B. the bounds
  const gate = newGate();
  const many = await ask(gate, 'local.files_write_batch', { files: Array.from({ length: 25 }, (_, n) => ({ path: `many/f${String(n).padStart(2, '0')}.txt`, content: `file ${n}\n` })) });
  const card = many.request.detail.preview;
  assert.equal(card.files.length, PREVIEW_LIMITS.files);
  assert.equal(PREVIEW_LIMITS.files, 20);
  assert.deepEqual([card.fileCount, card.hiddenFiles, card.truncated], [25, 5, true]);
  assert.deepEqual(card.files.map((item) => item.path), Array.from({ length: 20 }, (_, n) => `many/f${String(n).padStart(2, '0')}.txt`), 'the first twenty, in order');
  assert.equal(many.request.detail.count, 25, 'the list of the batch says how many files there are');
  assert.equal(many.result.guard.files.length, 25, 'the call is held to all twenty-five files, also to the five that are not on the card');
  assert.ok(many.result.guard.files.every((item) => item.baseSha === null));

  const thousand = Array.from({ length: 1000 }, (_, n) => `line ${n + 1}\n`).join('');
  const big = await ask(newGate(), 'local.write_file', { path: 'big.txt', content: thousand });
  const [file] = big.request.detail.preview.files;
  assert.equal(PREVIEW_LIMITS.rows, 200);
  assert.deepEqual([file.shownRows, file.hiddenRows, file.truncated, file.additions], [200, 800, true, 1000], 'the counts are those of the whole file, the rows are the first 200');
  assert.equal(rowsOf(file).length, 200);
  assert.equal(file.hunks.at(-1).cut, 800);
  assert.equal(big.request.detail.preview.truncated, true);

  await put('wide.txt', 'short\n');
  const wide = await ask(newGate(), 'local.write_file', { path: 'wide.txt', content: `${'x'.repeat(5000)}😀\r\nshort\r\n`, overwrite: true });
  const [cut] = rowsOf(wide.request.detail.preview.files[0]).filter((row) => row.kind === 'added');
  assert.equal(PREVIEW_LIMITS.rowChars, 400);
  assert.ok(cut.text.length <= 402, 'a line of 5000 characters is cut (400 characters and its line ending)');
  assert.equal(cut.omitted, 5002 - 400);
  assert.ok(cut.text.endsWith('\n'), 'and keeps its own line ending');
  const emoji = await ask(newGate(), 'local.write_file', { path: 'emoji.txt', content: `${'x'.repeat(399)}😀tail\n` });
  const [emojiRow] = rowsOf(emoji.request.detail.preview.files[0]);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emojiRow.text), 'a character is never cut in two');

  // the budget for the whole card: twenty files of 250 long lines
  const line = `${'y'.repeat(399)}\n`;
  const heavy = await ask(newGate(), 'local.files_write_batch', { files: Array.from({ length: 20 }, (_, n) => ({ path: `heavy/h${n}.txt`, content: line.repeat(250) })) });
  const shownChars = heavy.request.detail.preview.files.flatMap(rowsOf).reduce((total, row) => total + row.text.length, 0);
  assert.equal(PREVIEW_LIMITS.chars, 120_000);
  assert.ok(shownChars <= PREVIEW_LIMITS.chars + 401, `${shownChars} characters of rows`);
  assert.equal(heavy.request.detail.preview.truncated, true);
  assert.ok(heavy.request.detail.preview.files.at(-1).hiddenRows > 0, 'the last files of a heavy card show less and say how much');
  assert.ok(JSON.stringify(heavy.request).length < 400_000, 'the whole request stays bounded');
  const longMessage = buildChangePreview([], { code: 'x', message: 'm'.repeat(900) }).error.message;
  assert.equal(PREVIEW_LIMITS.messageChars, 500);
  assert.equal(longMessage.length, 501, 'the message of a refusal is cut at 500 characters');
  assert.equal(buildChangePreview([], { message: 'no code given' }).error.code, 'local_error', 'a refusal that has no code says so');
  const exact = await ask(newGate(), 'local.write_file', { path: 'exact.txt', content: `${'z'.repeat(400)}\n${'y'.repeat(401)}\n` });
  const [exactRow, longerRow] = rowsOf(exact.request.detail.preview.files[0]);
  assert.deepEqual([exactRow.text.length, 'omitted' in exactRow], [401, false], 'a line of exactly 400 characters is not cut');
  assert.deepEqual([longerRow.text.length, longerRow.omitted], [401, 1], 'a line of 401 is cut by one');
  ok('bounds: 20 files of 25 (the call is held to all 25), 200 rows of a 1000-line file with the counts of the whole file, a line cut at 400 characters (never inside a character), 120,000 characters for twenty heavy files, the request stays under 400 KB');
}

{
  // C. secrets
  await put('src/conf.js', `const url = "https://example.test";\nconst old = "${GITHUB_TOKEN}";\nconst key = "${OPENAI_KEY}";\nconst z = 1;\nconst r = "${REGISTERED}";\n`);
  const gate = newGate();
  const run = await ask(gate, 'local.edit_file', { path: 'src/conf.js', edits: [
    { old_string: `const old = "${GITHUB_TOKEN}";\n`, new_string: '' },
    { old_string: 'const z = 1;', new_string: `const z = 2;\nconst password = "${PASSWORD}";` },
  ] });
  const card = run.request.detail.preview.files[0];
  const shown = rowsOf(card);
  assert.ok(shown.some((row) => row.text.includes('[REDACTED]')), 'a secret is replaced by a marker');
  assert.ok(shown.some((row) => row.kind === 'context' && row.text.includes('[REDACTED]')), 'also in a line that is only context');
  assert.ok(shown.some((row) => row.kind === 'removed' && row.text.includes('[REDACTED]')), 'also in a line that is taken away');
  assert.ok(shown.some((row) => row.kind === 'added' && row.text.includes('password') && row.text.includes('[REDACTED]')), 'also in a line that is put in');
  assert.deepEqual(leaks(run.request), [], 'no secret in the request');
  assert.deepEqual(leaks(run.events), [], 'no secret in any event');
  assert.deepEqual(leaks(gate.state()), [], 'no secret in the pending state or the history');
  assert.equal(card.baseSha, sha(await fs.readFile(path.join(area, 'src/conf.js'))), 'the hash is of the real bytes');
  const written = await ask(newGate(), 'local.write_file', { path: 'out/new.js', content: `const t = "${OPENAI_KEY}";\nconst r = "${REGISTERED}";\n` });
  assert.deepEqual(leaks(written.request), [], 'no secret in the card of a new file');
  assert.deepEqual(leaks(written.events), []);
  assert.ok(rowsOf(written.request.detail.preview.files[0]).every((row) => row.text.includes('[REDACTED]')));
  ok('secrets: a token in a line put in, taken away and kept, a password and a registered secret are masked in the card, the request, the events, the pending state and the history');

  // a private key over several lines: a line of its body looks like any base64, so only its place tells; the rows keep their place
  const BODY = ['MIIEowIBAAKCAQEAv7xTZ3KxNf2jT1', 'Zm9vYmFyYmF6cXV4cXV1eA9d8c7b6a5f4e', 'dGhpcyBpcyBub3QgYSByZWFsIGtleQ0123'];
  const FRAME = ['-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----'];
  await put('keys/key.txt', `intro\n${FRAME[0]}\n${BODY.join('\n')}\n${FRAME[1]}\noutro\n`);
  const around = await ask(newGate(), 'local.edit_file', { path: 'keys/key.txt', edits: [{ old_string: 'intro', new_string: 'INTRO' }, { old_string: 'outro', new_string: 'OUTRO' }] });
  const aroundRows = rowsOf(around.request.detail.preview.files[0]);
  assert.deepEqual(aroundRows.map((row) => row.kind), ['removed', 'added', 'context', 'context', 'context', 'context', 'context', 'removed', 'added'], 'the key sits between the two changes, as context');
  assert.deepEqual(aroundRows.slice(2, 7).map((row) => row.text), [`${FRAME[0]}\n`, '[REDACTED]\n', '[REDACTED]\n', '[REDACTED]\n', `${FRAME[1]}\n`], 'the frame stays, every line of the body is masked, each keeps its line ending');
  assert.deepEqual(BODY.filter((line) => JSON.stringify(around.request).includes(line) || JSON.stringify(around.events).includes(line)), [], 'no line of the body is anywhere in the request or the events');
  const inside = await ask(newGate(), 'local.edit_file', { path: 'keys/key.txt', old_string: `${BODY[1]}\n`, new_string: '' });
  const insideRows = rowsOf(inside.request.detail.preview.files[0]);
  assert.ok(insideRows.some((row) => row.kind === 'removed' && row.text === '[REDACTED]\n'), 'a body line that is taken away is masked');
  assert.deepEqual([inside.request.detail.preview.files[0].additions, inside.request.detail.preview.files[0].deletions], [0, 1], 'the counts are those of the real change');
  assert.equal(inside.request.detail.preview.privateKeys, true, 'the card says that the call touches private key material');
  assert.equal(inside.request.detail.old_string, undefined, 'and the words the model wrote (they can be a line of the body) are left out');
  assert.equal(inside.request.detail.hidden, true);
  assert.ok(!JSON.stringify(inside.request).includes(BODY[1]) && !JSON.stringify(inside.events).includes(BODY[1]), 'a line of the body that the model typed as old_string is nowhere');
  const gone = await ask(newGate(), 'local.edit_file', { path: 'keys/key.txt', old_string: `${FRAME[0]}\n${BODY.join('\n')}\n${FRAME[1]}\n`, new_string: '' });
  assert.equal(gone.request.detail.preview.privateKeys, true, 'a key that is deleted is still key material');
  assert.deepEqual(rowsOf(gone.request.detail.preview.files[0]).filter((row) => row.kind === 'removed').map((row) => row.text), [`${FRAME[0]}\n`, '[REDACTED]\n', '[REDACTED]\n', '[REDACTED]\n', `${FRAME[1]}\n`], 'the key that goes away: its frame is shown, its body is not');
  const publicKey = await ask(newGate(), 'local.write_file', { path: 'keys/public.txt', content: '-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAL\n-----END PUBLIC KEY-----\n' });
  assert.equal(publicKey.request.detail.preview.privateKeys, undefined, 'a public key is not key material');
  assert.ok(rowsOf(publicKey.request.detail.preview.files[0]).some((row) => row.text.includes('MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAL')), 'and is shown');
  const ordinary = await ask(newGate(), 'local.edit_file', { path: 'src/app.js', old_string: 'const a = 1;', new_string: 'const a = 11;' });
  assert.equal(ordinary.request.detail.preview.privateKeys, undefined, 'an ordinary call does not say it');
  assert.equal(ordinary.request.detail.old_string, 'const a = 1;');
  const fresh = await ask(newGate(), 'local.write_file', { path: 'keys/new.txt', content: `${FRAME[0]}\n${BODY.join('\n')}\n${FRAME[1]}\n` });
  assert.deepEqual(rowsOf(fresh.request.detail.preview.files[0]).map((row) => row.text), [`${FRAME[0]}\n`, '[REDACTED]\n', '[REDACTED]\n', '[REDACTED]\n', `${FRAME[1]}\n`], 'a new file with a key');
  assert.equal(fresh.request.detail.preview.privateKeys, true, 'a key that appears is key material');
  await put('keys/rot.txt', `${FRAME[0]}\n${BODY[0]}\n${FRAME[1]}\n`);
  const rotation = await ask(newGate(), 'local.write_file', { path: 'keys/rot.txt', content: `${FRAME[0]}\n${BODY[2]}\n${FRAME[1]}\n`, overwrite: true });
  const rotated = rowsOf(rotation.request.detail.preview.files[0]);
  assert.deepEqual(rotated.map((row) => [row.kind, row.text]), [['context', `${FRAME[0]}\n`], ['removed', '[REDACTED]\n'], ['added', '[REDACTED]\n'], ['context', `${FRAME[1]}\n`]], 'a key that is replaced by another still shows that the line changed');
  assert.deepEqual(leaks(rotation.request).concat(BODY.filter((line) => JSON.stringify(rotation.request).includes(line))), []);
  ok('a private key: the frame stays, every line of the body is masked wherever the card shows it (context, taken away, put in), the counts are still those of the real change');

  // a protected file: asked with nothing to show, and the content is nowhere
  const gate1 = newGate();
  const blocked = await ask(gate1, 'local.write_file', { path: '.env', content: `${ENV_MARKER}=1\n` });
  assert.equal(blocked.kind, 'unasked', 'a protected file is refused without a question');
  assert.equal(blocked.result.allowed, false);
  assert.deepEqual(leaks(blocked.events), []);
  assert.deepEqual(leaks(gate1.state()), [], 'the history of a refused write to a protected file does not keep what the model tried to write');
  assert.equal(gate1.state().recent.at(-1).decision, 'blocked');
  const blockedEdit = await ask(gate1, 'local.edit_file', { path: 'secrets/id_rsa', old_string: ENV_MARKER, new_string: `${ENV_MARKER}2` });
  assert.equal(blockedEdit.result.allowed, false);
  assert.deepEqual(leaks(gate1.state()), [], 'nor does the history of a refused edit');
  const hidden = await ask(newGate(), 'local.files_write_batch', { files: [{ path: 'fine.txt', content: 'fine\n' }, { path: 'config/.env', content: `${ENV_MARKER}=1\n` }, { path: 'id_rsa', content: `${ENV_MARKER}\n` }] });
  assert.equal(hidden.request.detail.preview.error.code, 'protected_path', 'a batch with a protected file would be refused when it runs');
  assert.deepEqual(hidden.request.detail.preview.files, []);
  assert.deepEqual(leaks(hidden.request), [], 'the content of a protected file is not in the request');
  assert.deepEqual(leaks(hidden.events), []);
  assert.equal(hidden.result.guard, undefined);
  assert.ok(!JSON.stringify(hidden.request).includes('fine\\n'), 'and neither is the content of the other files of that batch');
  const gate2 = newGate();
  await ask(gate2, 'local.files_write_batch', { files: [{ path: 'config/.env', content: `${ENV_MARKER}=1\n` }] });
  assert.deepEqual(leaks(gate2.state()), [], 'nor in the history');
  ok('a protected file: refused without a question, and inside a batch the card says that the call would be refused and holds none of the content, nor does the history');
}

{
  // D. which calls ask does not change, and nothing is previewed where nobody is asked
  await put('d.txt', 'one\ntwo\n');
  const previews = [];
  const real = localTools.previewChanges.bind(localTools);
  localTools.previewChanges = async (...args) => { previews.push(args[0]); return real(...args); };
  try {
    const edit = ['local.edit_file', { path: 'd.txt', old_string: 'one', new_string: 'ONE' }];
    assert.equal((await ask(newGate('review'), ...edit)).kind, 'prompt');
    assert.equal(previews.length, 1);
    assert.equal((await ask(newGate('autonomous'), ...edit)).kind, 'unasked');
    assert.equal((await ask(newGate('readonly'), ...edit)).result.allowed, false);
    const full = newGate('review');
    full.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });
    assert.equal((await ask(full, ...edit)).kind, 'unasked');
    assert.equal((await ask(newGate('review'), 'local.read_file', { path: 'd.txt' })).kind, 'unasked');
    assert.equal((await ask(newGate('review'), 'local.delete_path', { path: 'd.txt' }, { approve: false })).kind, 'prompt');
    assert.deepEqual(previews, ['local.edit_file'], 'only the question about a file change was previewed: not the ones that were not asked, not the one about a deletion');
    assert.equal((await ask(newGate('autonomous'), ...edit, { forceAsk: true })).kind, 'prompt', 'a hook that forces a question draws the card too');
    assert.deepEqual(previews, ['local.edit_file', 'local.edit_file']);
    // an invalid call is refused before anyone is asked, so there is nothing to preview
    assert.equal(await localTools.previewChanges('local.edit_file', { path: 'd.txt', old_string: 'x' }), null);
    assert.equal(await localTools.previewChanges('local.edit_file', { path: 'd.txt' }), null);
    assert.equal(await localTools.previewChanges('local.write_file', { path: 'd.txt' }), null);
    assert.equal(await localTools.previewChanges('local.read_file', { path: 'd.txt' }), null);
    assert.equal(await localTools.previewChanges('local.delete_path', { path: 'd.txt' }), null);
    assert.equal(await localTools.previewChanges('local.move_path', { source: 'd.txt', destination: 'e.txt' }), null);
    assert.equal(await localTools.previewChanges('local.nope', {}), null);
    await assert.rejects(localTools.previewChanges('local.edit_file', { path: 'd.txt', old_string: 'one', new_string: 'ONE' }, { signal: AbortSignal.abort(new Error('stopped')) }), /stopped/, 'a stopped task stops the preview');
    // approving gives a guard, denying gives none
    const approved = await ask(newGate(), ...edit);
    assert.deepEqual(approved.result.guard.files, [{ path: 'd.txt', baseSha: sha(Buffer.from('one\ntwo\n')) }]);
    assert.equal(approved.result.guard.tool, 'edit_file');
    assert.match(approved.result.guard.argsSha256, /^[0-9a-f]{64}$/);
    assert.equal(approved.result.asked, true);
    const denied = await ask(newGate(), ...edit, { approve: false });
    assert.equal(denied.result.allowed, false);
    assert.equal(denied.result.guard, undefined, 'a refusal carries no guard');
    assert.equal(await read('d.txt'), 'one\ntwo\n');
  } finally { localTools.previewChanges = real; }
  ok('the same calls ask as before (Review asks, Autonomous, Full Access and Read Only do not; a hook can force a question); only a question about a file change is previewed; an approval carries the guard and a refusal none; a stopped task stops the preview');
}

// ------------------------------------------------------------------ the call that follows the answer
async function makeRepo(name) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'chatmcp-ci@example.invalid'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'ChatMCP CI'], { cwd: dir, stdio: 'ignore' });
  await fs.writeFile(path.join(dir, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: dir, stdio: 'ignore' });
  return fs.realpath(dir);
}
const work = await makeRepo('project');
const hubDirectory = path.join(root, 'hub');
const hub = new HubManager({ bundleRoot, dataDirectory: hubDirectory, log: () => {} });
await hub.load(work);
assembleStudio(hub, { bundleRoot });
await hub.permissions.load();
await hub.startLocal(work);
const gate = hub.permissions;
const hubTools = hub.localTools;
const TASK = randomUUID();
hub.acquireTask(TASK);
const session = await hub.createAgentSession();
const call = (name, args, extra = {}) => session.callTool(name, args, extra);
const file = (name) => path.join(work, name);
const nextPending = async () => { for (let i = 0; i < 500; i += 1) { if (gate.state().pending[0]) return structuredClone(gate.state().pending[0]); await delay(10); } throw new Error('no approval request'); };
const answer = async (approve) => { const request = await nextPending(); gate.decide(request.id, approve); return request; };
const refusedWith = (result, code) => { assert.equal(result.isError, true, text(result)); assert.equal(result.structuredContent.executed, false, `${code}: executed must be false`); assert.equal(result.structuredContent.error.code, code, text(result)); };
const hooksFile = path.join(hubDirectory, 'hooks.json');
const writeHooks = (events) => fs.writeFile(hooksFile, JSON.stringify({ hooks: events }, null, 2));

try {
  gate.configure({ mode: 'review' });
  {
    // E. a file that changed after the card was drawn is not written
    const original = 'alpha\nbeta\ngamma\n';
    await fs.writeFile(file('notes.txt'), original);
    const run = call('local.edit_file', { path: 'notes.txt', old_string: 'beta', new_string: 'BETA' });
    const request = await nextPending();
    assert.equal(request.detail.preview.files[0].baseSha, sha(Buffer.from(original)));
    const elsewhere = 'alpha\nbeta\ngamma\nadded elsewhere\n';
    await fs.writeFile(file('notes.txt'), elsewhere);
    gate.decide(request.id, true);
    const result = await run;
    refusedWith(result, 'stale_after_approval');
    assert.match(text(result), /notes\.txt/, 'the model is told which file');
    assert.match(text(result), /chưa ghi gì/, 'and that nothing was written');
    assert.equal(await fs.readFile(file('notes.txt'), 'utf8'), elsewhere, 'the newer version stays');
    assert.deepEqual(leaks(result), []);

    // asked again, the card is of the file as it is now, and what is written is what was shown
    const again = call('local.edit_file', { path: 'notes.txt', old_string: 'beta', new_string: 'BETA' });
    const second = await nextPending();
    const shownDigest = hunksDigest(second.detail.preview.files[0].hunks);
    assert.equal(second.detail.preview.files[0].baseSha, sha(Buffer.from(elsewhere)));
    gate.decide(second.id, true);
    const done = await again;
    assert.equal(done.isError, false, text(done));
    const after = await fs.readFile(file('notes.txt'), 'utf8');
    assert.equal(after, 'alpha\nBETA\ngamma\nadded elsewhere\n');
    assert.equal(hunksDigest(diffHunks(elsewhere, after).hunks), shownDigest, 'the hunks of what was written are the hunks of the card');
    assert.equal(done.structuredContent.sha256, sha(Buffer.from(after)));
    ok('a file edited after the card was drawn: refused with stale_after_approval, executed:false, the model told which file and that nothing was written, the newer version kept; asked again, the card is of the new file and the write is exactly the card');

    // deny still denies, an unrelated file does not matter
    await fs.writeFile(file('notes.txt'), original);
    await fs.writeFile(file('other.txt'), 'other\n');
    const denied = call('local.edit_file', { path: 'notes.txt', old_string: 'beta', new_string: 'BETA' });
    await answer(false);
    refusedWith(await denied, 'permission_denied');
    assert.equal(await fs.readFile(file('notes.txt'), 'utf8'), original);
    const unrelated = call('local.edit_file', { path: 'notes.txt', old_string: 'beta', new_string: 'BETA' });
    const third = await nextPending();
    await fs.writeFile(file('other.txt'), 'other changed\n');
    gate.decide(third.id, true);
    assert.equal((await unrelated).isError, false, 'a file that is not in the call may change');
    assert.equal(await fs.readFile(file('notes.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
    ok('a "no" still stops the call and a change to a file that is not in the call does not');
  }

  {
    // a file that appears, one that goes away, write_file over a file, a patch
    const appears = call('local.write_file', { path: 'appears.txt', content: 'mine\n' });
    const shown = await nextPending();
    assert.equal(shown.detail.preview.files[0].action, 'create');
    await fs.writeFile(file('appears.txt'), 'theirs\n');
    gate.decide(shown.id, true);
    refusedWith(await appears, 'stale_after_approval');
    assert.equal(await fs.readFile(file('appears.txt'), 'utf8'), 'theirs\n', 'a file that appeared after the card is not overwritten');

    await fs.writeFile(file('goes.txt'), 'x\ny\n');
    const goes = call('local.edit_file', { path: 'goes.txt', old_string: 'x', new_string: 'X' });
    const second = await nextPending();
    await fs.rm(file('goes.txt'));
    gate.decide(second.id, true);
    refusedWith(await goes, 'stale_after_approval');
    assert.equal(await fs.access(file('goes.txt')).then(() => true, () => false), false, 'and a file that went away is not made again');

    await fs.writeFile(file('over.txt'), 'old\n');
    const over = call('local.write_file', { path: 'over.txt', content: 'new\n', overwrite: true });
    const third = await nextPending();
    await fs.writeFile(file('over.txt'), 'changed under you\n');
    gate.decide(third.id, true);
    refusedWith(await over, 'stale_after_approval');
    assert.equal(await fs.readFile(file('over.txt'), 'utf8'), 'changed under you\n');

    await fs.writeFile(file('patch.txt'), 'p1\np2\n');
    const patch = call('local.files_apply_patch', { path: 'patch.txt', old_text: 'p2', new_text: 'P2' });
    const fourth = await nextPending();
    await fs.writeFile(file('patch.txt'), 'p1\np2\np3\n');
    gate.decide(fourth.id, true);
    refusedWith(await patch, 'stale_after_approval');

    // the same file, byte for byte, is not stale (touching it is not changing it)
    await fs.writeFile(file('same.txt'), 's1\ns2\n');
    const same = call('local.edit_file', { path: 'same.txt', old_string: 's1', new_string: 'S1' });
    const fifth = await nextPending();
    await fs.writeFile(file('same.txt'), 's1\ns2\n');
    gate.decide(fifth.id, true);
    assert.equal((await same).isError, false);
    ok('write_file over a file, a file that appeared, a file that went away and files_apply_patch: all refused with stale_after_approval and nothing written; rewriting the same bytes is not a change');
  }

  {
    // a batch: all or nothing, and the files past the twenty of the card are held too
    const files = Array.from({ length: 25 }, (_, n) => ({ path: `batch/f${String(n).padStart(2, '0')}.txt`, content: `file ${n}\n` }));
    const run = call('local.files_write_batch', { files });
    const request = await nextPending();
    assert.equal(request.detail.preview.files.length, 20);
    await fs.mkdir(file('batch'), { recursive: true });
    await fs.writeFile(file('batch/f23.txt'), 'created by someone else after the card\n');
    gate.decide(request.id, true);
    refusedWith(await run, 'stale_after_approval');
    const left = await fs.readdir(file('batch'));
    assert.deepEqual(left, ['f23.txt'], 'nothing of the batch was written, not even the files of the card');

    await fs.rm(file('batch'), { recursive: true, force: true });
    const run2 = call('local.files_write_batch', { files: files.slice(0, 3) });
    const request2 = await nextPending();
    gate.decide(request2.id, true);
    const done = await run2;
    assert.equal(done.isError, false, text(done));
    assert.equal((await fs.readdir(file('batch'))).length, 3, 'with nothing changed the whole batch is written');
    for (const item of files.slice(0, 3)) assert.equal(await fs.readFile(file(item.path), 'utf8'), item.content);
    ok('a batch is held to all of its files, also the ones past the twenty of the card: one that appeared after the card stops the whole batch and nothing is written; unchanged, every file is written');
  }

  {
    // a card is for one call
    await fs.writeFile(file('card.txt'), 'c1\nc2\n');
    const preview = await hubTools.previewChanges('local.edit_file', { path: 'card.txt', old_string: 'c1', new_string: 'C1' });
    const direct = await hubTools.call('local.edit_file', { path: 'card.txt', old_string: 'c1', new_string: 'C1' }, { guard: preview.guard });
    assert.equal(direct.isError, false, 'the call the card was drawn for runs');
    await fs.writeFile(file('card.txt'), 'c1\nc2\n');
    const otherArgs = await hubTools.call('local.edit_file', { path: 'card.txt', old_string: 'c1', new_string: 'DIFFERENT' }, { guard: preview.guard });
    refusedWith(otherArgs, 'stale_after_approval');
    const otherTool = await hubTools.call('local.write_file', { path: 'card.txt', content: 'x', overwrite: true }, { guard: preview.guard });
    refusedWith(otherTool, 'stale_after_approval');
    assert.equal(await fs.readFile(file('card.txt'), 'utf8'), 'c1\nc2\n', 'a card made for another call lets nothing through');
    const otherFile = await hubTools.previewChanges('local.edit_file', { path: 'card.txt', old_string: 'c2', new_string: 'C2' });
    await fs.writeFile(file('card2.txt'), 'c2\n');
    const sneaky = await hubTools.call('local.edit_file', { path: 'card2.txt', old_string: 'c2', new_string: 'C2' }, { guard: otherFile.guard });
    refusedWith(sneaky, 'stale_after_approval');
    // a call that came without a card is held to nothing (Autonomous, Full Access)
    // a card that is for this call but does not hold the file it now names (a name that leads somewhere else) lets nothing through
    const foreign = { tool: 'edit_file', argsSha256: argumentsDigest({ path: 'card.txt', old_string: 'c1', new_string: 'C1' }), files: [{ path: 'not-this-one.txt', baseSha: sha(Buffer.from('c1\nc2\n')) }] };
    refusedWith(await hubTools.call('local.edit_file', { path: 'card.txt', old_string: 'c1', new_string: 'C1' }, { guard: foreign }), 'stale_after_approval');
    assert.equal(await fs.readFile(file('card.txt'), 'utf8'), 'c1\nc2\n');
    // a card whose tool is not the tool of the call, with the digest of the arguments that the call has; and a card that holds no files
    const writeArgs = { path: 'card.txt', content: 'x', overwrite: true };
    const mismatched = { tool: 'edit_file', argsSha256: argumentsDigest(writeArgs), files: [{ path: 'card.txt', baseSha: sha(Buffer.from('c1\nc2\n')) }] };
    refusedWith(await hubTools.call('local.write_file', writeArgs, { guard: mismatched }), 'stale_after_approval');
    refusedWith(await hubTools.call('local.write_file', writeArgs, { guard: { tool: 'write_file', argsSha256: argumentsDigest(writeArgs) } }), 'stale_after_approval');
    assert.equal(await fs.readFile(file('card.txt'), 'utf8'), 'c1\nc2\n');
    const free = await hubTools.call('local.edit_file', { path: 'card.txt', old_string: 'c1', new_string: 'C1' });
    assert.equal(free.isError, false);
    // the key order of the arguments does not matter
    const keyed = await hubTools.previewChanges('local.write_file', { path: 'k.txt', content: 'k\n', overwrite: false });
    assert.equal((await hubTools.call('local.write_file', { overwrite: false, content: 'k\n', path: 'k.txt' }, { guard: keyed.guard })).isError, false);
    ok('a card is for one call: other arguments, another tool or another file let nothing through, the order of the keys does not matter, and a call without a card is held to nothing');
  }

  {
    // a hook's question draws the card, and the card holds the call that follows
    gate.configure({ mode: 'autonomous' });
    const askJson = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } });
    await writeHooks({ PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: process.execPath, args: [HOOK, JSON.stringify({ stdout: askJson('please look') })] }] }] });
    await fs.writeFile(file('hooked.txt'), 'h1\nh2\n');
    const run = call('local.edit_file', { path: 'hooked.txt', old_string: 'h1', new_string: 'H1' });
    const request = await nextPending();
    assert.match(request.reason, /please look/);
    assert.equal(request.detail.preview.files[0].path, 'hooked.txt', 'the question of a hook shows the change');
    await fs.writeFile(file('hooked.txt'), 'h1\nh2\nh3\n');
    gate.decide(request.id, true);
    refusedWith(await run, 'stale_after_approval');
    assert.equal(await fs.readFile(file('hooked.txt'), 'utf8'), 'h1\nh2\nh3\n');
    // no hook, Autonomous: nobody is asked and nothing is held
    await fs.rm(hooksFile, { force: true });
    const free = await call('local.edit_file', { path: 'hooked.txt', old_string: 'h1', new_string: 'H1' });
    assert.equal(free.isError, false, text(free));
    gate.configure({ mode: 'review' });
    ok('a PreToolUse hook that forces a question in Autonomous draws the card, and the call is held to it; without a hook nobody is asked and nothing is held');
  }
} finally {
  hub.releaseTask(TASK);
  await hub.shutdown().catch(() => {});
  await new HookRunner({ hubDirectory }).close().catch(() => {});
  await delay(300);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
}

console.log(`PASS: ${checks} approval preview checks`);
process.exit(0);
