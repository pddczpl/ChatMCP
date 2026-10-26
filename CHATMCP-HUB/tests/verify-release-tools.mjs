// The two scripts the owner uses to sign a release (scripts/new-release-key.mjs, scripts/sign-release.mjs) and the library behind them (tools/release-tools.mjs, which the mutation runner can reach
// because it is inside the Hub folder; it is not shipped, the installer's payload takes lib/ and not tools/).
//
// The private key is the one secret of the whole updater, so the safeguards around it are what this suite holds the tools to, with keys made when it runs:
//   1. a private key is never made, read or written inside a Git work tree (a path that merely LOOKS outside it, with .. or through a junction or a link, is inside), never over an existing file,
//      and its file is restricted to the current user BEFORE the key is written (icacls on Windows, mode 600 elsewhere); where that fails the file is removed and nothing is left;
//   2. nothing prints a private key, and only a public key and its id are shown;
//   3. a signature is made only for a file that is a release manifest of the tag, over its exact bytes (a BOM and CRLF are kept), only with a key that is listed in lib/release-keys.json unless
//      the owner says otherwise, only for an installer that matches when one is given, and it is checked before it is written; the file has the name the release needs;
//   4. nothing is uploaded and no program but icacls and whoami is started: the command that uploads is printed for the owner to run.
// The command lines are run as child processes when the scripts are next to the Hub (the mutation runner copies the Hub folder alone, so there the library is the whole test).
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedManifest, startUpdateFeed } from './e2e/update-feed-server.mjs';
import { KEY_FILE, SIGNATURE_ASSET, parseReleaseKeys } from '../lib/release-signature.mjs';
import { ToolError, UPLOAD_REPOSITORY, createReleaseKey, enclosingWorkTree, signRelease, uploadCommand } from '../tools/release-tools.mjs';
import { keyFileText, throwawayKey } from './support/release-keys.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(HUB_ROOT, '..');
const NEW_KEY = path.join(REPO_ROOT, 'scripts', 'new-release-key.mjs');
const SIGN = path.join(REPO_ROOT, 'scripts', 'sign-release.mjs');
const outside = fs.existsSync(NEW_KEY) && fs.existsSync(SIGN);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-release-tools-'));
let count = 0;
const folder = (name = 'folder') => { const directory = path.join(scratch, `${name}-${count += 1}`); fs.mkdirSync(directory, { recursive: true }); return directory; };

assert.equal(enclosingWorkTree(scratch), null, `the temporary folder ${scratch} must not be inside a Git work tree for these tests to mean anything`);

/** Runs `action` and returns the ToolError it must throw. */
async function refused(action, pattern, label) {
  let error = null;
  try { await action(); } catch (caught) { error = caught; }
  assert.ok(error, `${label}: it must be refused`);
  assert.ok(error instanceof ToolError, `${label}: a ToolError, not ${error?.constructor?.name}: ${error?.message}`);
  assert.match(error.message, pattern, label);
  return error;
}
const childEnvironment = (env) => ({ ...process.env, DATGOLD_RELEASE_KEY: '', DATGOLD_RELEASE_KEY_PASSPHRASE: '', ...env });
const run = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: childEnvironment(env) });
/** For a script that talks to a stand-in served by THIS process: spawnSync would block the event loop that has to answer it. */
const runAsync = (script, args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { windowsHide: true, env: childEnvironment(env) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 60_000);
  child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
const PEM_BODY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

// ------------------------------------------------------------------------------------------------------------------------------- 1. where a key may be
{
  const tree = folder('tree');
  fs.mkdirSync(path.join(tree, '.git'));
  const nested = path.join(tree, 'a', 'b');
  assert.equal(enclosingWorkTree(path.join(tree, 'key.pem')), fs.realpathSync.native(tree), 'a file in a work tree');
  assert.equal(enclosingWorkTree(path.join(nested, 'key.pem')), fs.realpathSync.native(tree), 'a file in a folder that does not exist yet, in a work tree');
  const worktree = folder('worktree');
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../elsewhere');
  assert.equal(enclosingWorkTree(path.join(worktree, 'key.pem')), fs.realpathSync.native(worktree), 'a linked work tree has a .git FILE, which counts');
  const free = folder('free');
  assert.equal(enclosingWorkTree(path.join(free, 'key.pem')), null, 'a folder with no .git above it');
  assert.equal(enclosingWorkTree(path.join(free, '..', path.basename(tree), 'key.pem')), fs.realpathSync.native(tree), 'a path with .. that leads into a work tree');
  // a link out of a free folder into the work tree: the key would be written inside it
  const link = path.join(free, 'link');
  try { fs.symlinkSync(tree, link, 'junction'); } catch { /* a platform that cannot make one is checked below */ }
  if (fs.existsSync(link)) assert.equal(enclosingWorkTree(path.join(link, 'key.pem')), fs.realpathSync.native(tree), 'through a junction or a link into a work tree');
  // a source copy without .git: the roots the caller names count too
  const unpacked = folder('unpacked');
  assert.equal(enclosingWorkTree(path.join(unpacked, 'sub', 'key.pem'), { extraRoots: [unpacked] }), unpacked, 'a root named by the caller (the folder these scripts live in) counts without a .git');
  assert.equal(enclosingWorkTree(path.join(free, 'key.pem'), { extraRoots: [unpacked] }), null);
  ok('a key is kept out of every Git work tree: a .git folder or a .git file above the path, a path with .. or through a junction that leads in, a folder that does not exist yet, and the root of the folder these scripts live in even without .git');
}

// ------------------------------------------------------------------------------------------------------------------------------- 2. making a key
{
  const directory = folder('keys');
  const file = path.join(directory, 'datgold-release.pem');
  const made = await createReleaseKey({ file });
  assert.match(made.kid, /^[0-9a-f]{8}$/);
  assert.equal(made.file, file);
  assert.deepEqual(Object.keys(made).sort(), ['encrypted', 'entry', 'file', 'kid', 'spki'], 'what is returned holds nothing of the private key');
  assert.deepEqual(made.entry, { kid: made.kid, use: 'release', spki: made.spki });
  assert.equal(JSON.stringify(made).includes('PRIVATE'), false);
  const pem = fs.readFileSync(file, 'utf8');
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----/, 'a PKCS#8 PEM');
  const privateKey = createPrivateKey(pem);
  assert.equal(privateKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  assert.equal(spki.toString('base64'), made.spki, 'the public key it shows is the one of the file');
  assert.equal(createHash('sha256').update(spki).digest('hex').slice(0, 8), made.kid);
  assert.equal(parseReleaseKeys(keyFileText([made.entry])).keys.length, 1, 'and the entry it shows is one the key file takes');
  assert.equal(made.encrypted, false);
  if (process.platform === 'win32') {
    const listing = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [file], { encoding: 'utf8', windowsHide: true }).stdout;
    assert.equal((listing.match(/:\(/g) ?? []).length, 1, `exactly one access entry on the file:\n${listing}`);
    assert.ok(!/Everyone|BUILTIN\\Users|Authenticated Users|NT AUTHORITY\\SYSTEM|Administrators/i.test(listing), `no other account has access:\n${listing}`);
  } else {
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'mode 600: nobody but the owner');
  }
  const before = fs.readFileSync(file);
  await refused(() => createReleaseKey({ file }), /already exists/i, 'a key file that exists');
  assert.ok(fs.readFileSync(file).equals(before), 'and the key that was there is untouched: an overwrite would be a key lost');
  const dangling = path.join(directory, 'dangling.pem');
  let linked = true;
  try { fs.symlinkSync(path.join(directory, 'nowhere'), dangling); } catch { linked = false; }
  if (linked) await refused(() => createReleaseKey({ file: dangling }), /already exists/i, 'a link that points nowhere');

  // where it may not go
  const tree = folder('repo');
  fs.mkdirSync(path.join(tree, '.git'));
  fs.mkdirSync(path.join(tree, 'keys'));
  const elsewhere = folder('elsewhere');
  for (const where of [path.join(tree, 'key.pem'), path.join(tree, 'keys', 'key.pem'), path.join(elsewhere, '..', path.basename(tree), 'key.pem')]) {
    await refused(() => createReleaseKey({ file: where }), /inside the Git work tree/i, `a key in a work tree (${path.basename(where)})`);
    assert.equal(fs.existsSync(where), false, 'and nothing is created');
  }
  await refused(() => createReleaseKey({ file: path.join(REPO_ROOT, 'never-created.pem'), extraRoots: [REPO_ROOT] }), /inside the Git work tree/i, 'the folder these scripts live in');
  await refused(() => createReleaseKey({ file: path.join(directory, 'missing-folder', 'key.pem') }), /does not exist/i, 'a folder that is not there');
  assert.equal(fs.existsSync(path.join(directory, 'missing-folder')), false, 'and none is made for it: a typo does not leave a stray folder');
  for (const bad of ['', '   ', null, undefined, 5]) await refused(() => createReleaseKey({ file: bad }), /path/i, `a path that is ${JSON.stringify(bad)}`);

  // a passphrase protects the file
  const protectedFile = path.join(directory, 'protected.pem');
  const secret = await createReleaseKey({ file: protectedFile, passphrase: 'correct horse battery staple' });
  assert.equal(secret.encrypted, true);
  assert.match(fs.readFileSync(protectedFile, 'utf8'), /^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
  assert.throws(() => createPrivateKey(fs.readFileSync(protectedFile, 'utf8')), 'it does not open without the passphrase');
  assert.equal(createPrivateKey({ key: fs.readFileSync(protectedFile, 'utf8'), passphrase: 'correct horse battery staple' }).asymmetricKeyType, 'ec');

  // the file is restricted BEFORE the key is written, and where that cannot be done nothing is left
  const calls = [];
  const SID = 'S-1-5-21-111-222-333-1001';
  const fake = (listing, { failAt = null, noSid = false, whoamiStatus = 0, listingStatus = 0 } = {}) => (program, args) => {
    const name = path.basename(program).toLowerCase();
    calls.push({ name, args, size: fs.existsSync(args[0]) ? fs.statSync(args[0]).size : -1 });
    if (failAt && args.includes(failAt)) return { status: 5, stdout: '', stderr: 'Access is denied.' };
    if (name === 'whoami.exe') return { status: whoamiStatus, stdout: noSid ? 'nothing useful' : `"PC\\me","${SID}"\r\n`, stderr: '' };
    if (args.length === 1) return { status: listingStatus, stdout: listing, stderr: '' };
    return { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files\r\n', stderr: '' };
  };
  const only = (file) => `${file} PC\\me:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
  const win = path.join(directory, 'win.pem');
  calls.length = 0;
  await createReleaseKey({ file: win, platform: 'win32', run: fake(only(win)) });
  const icacls = calls.filter((call) => call.name === 'icacls.exe');
  assert.deepEqual(icacls.map((call) => call.args.slice(1)), [['/inheritance:r'], ['/grant:r', `*${SID}:F`], []], 'inheritance removed, the current user (by SID) granted, then the result read back');
  assert.ok(icacls.every((call) => call.size === 0 || call.args.length === 1), 'the file was still empty when its access was restricted: the key is written after');
  assert.ok(fs.statSync(win).size > 100, 'and the key is there afterwards');
  const crowded = path.join(directory, 'crowded.pem');
  await refused(() => createReleaseKey({ file: crowded, platform: 'win32', run: fake(`${crowded} PC\\me:(F)\r\n  NT AUTHORITY\\SYSTEM:(F)\r\n`) }), /more than/i, 'an access list with a second entry');
  assert.equal(fs.existsSync(crowded), false, 'the file is removed when its access could not be restricted');
  const denied = path.join(directory, 'denied.pem');
  await refused(() => createReleaseKey({ file: denied, platform: 'win32', run: fake('', { failAt: '/inheritance:r' }) }), /restrict/i, 'icacls that fails');
  assert.equal(fs.existsSync(denied), false, 'nothing is left when icacls fails');
  const anonymous = path.join(directory, 'anonymous.pem');
  await refused(() => createReleaseKey({ file: anonymous, platform: 'win32', run: () => ({ status: 0, stdout: 'nothing useful', stderr: '' }) }), /restrict|account/i, 'a user that cannot be named');
  assert.equal(fs.existsSync(anonymous), false);
  // each thing that can go wrong with the restriction is a refusal of its own (everything else in the answers is as it should be, so that nothing else can be what refuses), and leaves nothing
  const mishaps = [
    ['icacls that cannot remove the inheritance', { failAt: '/inheritance:r' }, /could not restrict/i],
    ['icacls that cannot grant the current user', { failAt: '/grant:r' }, /could not restrict/i],
    ['an account that cannot be named (no SID in what whoami says)', { noSid: true }, /which account/i],
    ['a whoami that fails although it names an account', { whoamiStatus: 1 }, /which account/i],
    ['an access list that cannot be read back', { listingStatus: 5 }, /read back/i],
    ['an access list with no entry at all', { listing: 'nothing here' }, /read back/i],
  ];
  for (const [label, options, pattern] of mishaps) {
    const mishap = path.join(directory, `mishap-${count += 1}.pem`);
    await refused(() => createReleaseKey({ file: mishap, platform: 'win32', run: fake(options.listing ?? only(mishap), options) }), pattern, label);
    assert.equal(fs.existsSync(mishap), false, `${label}: nothing is left`);
  }
  // the file is read back, and a file that holds another key than the one that was made is a failure that leaves nothing
  const swapped = path.join(directory, 'swapped.pem');
  const writeSync = fs.writeSync;
  const impostor = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeSync = (descriptor) => writeSync(descriptor, impostor);
  try { await refused(() => createReleaseKey({ file: swapped }), /did not read back/i, 'a file that holds another key than the one that was made'); } finally { fs.writeSync = writeSync; }
  assert.equal(fs.existsSync(swapped), false, 'and it is removed');
  const posix = path.join(directory, 'posix.pem');
  calls.length = 0;
  await createReleaseKey({ file: posix, platform: 'linux', run: fake('') });
  assert.equal(calls.length, 0, 'elsewhere no program is started');
  ok('createReleaseKey makes a P-256 PKCS#8 key (a passphrase encrypts it) and returns only the public key, its id and the entry for the key file; the file is made with the key written AFTER its access was restricted to the current user (icacls by SID, read back; mode 600 elsewhere) and is removed when that fails; it never overwrites a file, a link or anything, and refuses a folder that is not there, a work tree and the folder the scripts live in');
}

// ------------------------------------------------------------------------------------------------------------------------------- 3. signing
const feed = await startUpdateFeed();
try {
  const key = throwawayKey();
  const keyDirectory = folder('signing-keys');
  const keyFile = path.join(keyDirectory, 'release.pem');
  fs.writeFileSync(keyFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const keysFile = path.join(keyDirectory, 'release-keys.json');
  fs.writeFileSync(keysFile, keyFileText([key.entry]));
  const installer = Buffer.from('not a program, just the bytes of a file for a test'.repeat(40));
  const installerFile = path.join(keyDirectory, 'DatGoldSetup.exe');
  fs.writeFileSync(installerFile, installer);
  const sha = createHash('sha256').update(installer).digest('hex');
  const manifestOf = (overrides = {}) => feedManifest({ version: '3.11.0', assets: [{ name: 'DatGoldSetup.exe', sha256: sha, bytes: installer.length }, { name: 'DatGold-Browser-Companion.zip', sha256: 'c'.repeat(64), bytes: 48568 }], ...overrides });
  const writeManifest = (bytes) => { const file = path.join(folder('manifest'), 'RELEASE-MANIFEST.json'); fs.writeFileSync(file, bytes); return file; };
  const crlfBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(manifestOf(), null, 2).replace(/\n/g, '\r\n'))]);
  const base = { tag: 'v3.11.0', keyFile, keysFile, out: path.join(folder('out'), SIGNATURE_ASSET) };
  const checkSignature = (outFile, bytes) => {
    const document = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.deepEqual(Object.keys(document), ['alg', 'kid', 'sig']);
    assert.equal(verify('sha256', bytes, { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(document.sig, 'base64')), true, 'plain node:crypto agrees that this is a signature of exactly these bytes');
    assert.equal(document.kid, key.kid);
  };

  // a local file, signed as it is: a BOM and CRLF are part of what was published
  const local = writeManifest(crlfBom);
  const signed = await signRelease({ ...base, manifestFile: local });
  assert.equal(signed.outFile, base.out);
  assert.equal(path.basename(signed.outFile), SIGNATURE_ASSET);
  checkSignature(signed.outFile, crlfBom);
  assert.equal(signed.manifest.version, '3.11.0');
  assert.equal(signed.kid, key.kid);
  assert.equal(feed.requests.length, 0, 'a local file asks nothing');
  assert.equal(signed.command, uploadCommand({ tag: 'v3.11.0', signatureFile: signed.outFile }), 'and the command to upload it is made, not run');
  assert.ok(signed.command.startsWith(`gh release upload v3.11.0 "${signed.outFile}" --repo ${UPLOAD_REPOSITORY}`), signed.command);
  assert.equal(UPLOAD_REPOSITORY, 'pddczpl/ChatMCP');
  assert.ok(!/--clobber/.test(signed.command), 'a signature that is already there is not replaced unless the owner adds --clobber');

  // a tag: the manifest is fetched, and the bytes that arrived are the bytes that are signed
  feed.publish(manifestOf(), { bom: true });
  const fetched = await signRelease({ ...base, out: path.join(folder('out'), SIGNATURE_ASSET), releaseBase: feed.origin });
  assert.ok(feed.requests.length >= 1 && feed.requests.every((request) => request.method === 'GET'));
  const served = Buffer.from(`\uFEFF${JSON.stringify(manifestOf(), null, 2)}\r\n`);
  checkSignature(fetched.outFile, served);
  assert.ok(fs.readFileSync(path.join(path.dirname(fetched.outFile), 'RELEASE-MANIFEST.json')).equals(served), 'the manifest that was signed is kept beside the signature, byte for byte');
  assert.equal(fs.existsSync(path.join(path.dirname(signed.outFile), 'RELEASE-MANIFEST.json')), false, 'a file the owner gave is not copied');

  // what is refused
  const manifestFile = writeManifest(Buffer.from(JSON.stringify(manifestOf())));
  await refused(() => signRelease({ ...base, manifestFile, tag: 'v3.11.1' }), /3\.11\.0.*3\.11\.1|tag/i, 'a manifest of another version than the tag');
  for (const tag of ['3.11.0', 'v3.11', 'v3.11.0-rc.1', 'latest', '', 'v3.11.0/../x', null]) await refused(() => signRelease({ ...base, manifestFile, tag }), /tag/i, `a tag of ${JSON.stringify(tag)}`);
  await refused(() => signRelease({ ...base, manifestFile: writeManifest(Buffer.from('<!doctype html><title>Not Found</title>')) }), /manifest/i, 'a page of HTML instead of a manifest');
  await refused(() => signRelease({ ...base, manifestFile: writeManifest(Buffer.from('')) }), /0 bytes/, 'an empty file');
  const padded = Buffer.from(JSON.stringify({ ...manifestOf(), padding: 'x'.repeat(70_000) }));
  assert.ok(padded.length > 64 * 1024, 'the padded manifest is over what the installed apps read');
  await refused(() => signRelease({ ...base, manifestFile: writeManifest(padded) }), /bytes/, 'a manifest larger than the 64 KiB that the installed apps read: a signature on it would be useless');
  await refused(() => signRelease({ ...base, manifestFile: writeManifest(Buffer.from(JSON.stringify({ ...manifestOf(), commit: 'nope' }))) }), /manifest/i, 'a manifest that is not valid');
  await refused(() => signRelease({ ...base, manifestFile: path.join(scratch, 'there-is-no-such-file.json') }), /read|manifest/i, 'a manifest that is not there');
  const other = throwawayKey();
  const otherFile = path.join(keyDirectory, 'other.pem');
  fs.writeFileSync(otherFile, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const unlisted = await refused(() => signRelease({ ...base, manifestFile, keyFile: otherFile }), /not listed|release-keys/i, 'a key that the key file does not list: the installed apps would reject the signature');
  assert.equal(fs.existsSync(base.out) && JSON.parse(fs.readFileSync(base.out, 'utf8')).kid === other.kid, false, 'and no signature is written for it');
  assert.ok(unlisted.message.includes(other.kid), 'the message names the key id');
  const allowed = await signRelease({ ...base, manifestFile, keyFile: otherFile, allowUnlistedKey: true, out: path.join(folder('out'), SIGNATURE_ASSET) });
  assert.equal(allowed.kid, other.kid, 'unless the owner says that this is intended');
  const placeholderOnly = path.join(keyDirectory, 'placeholder-keys.json');
  fs.writeFileSync(placeholderOnly, keyFileText([{ kid: '00000000', use: 'placeholder', spki: null }]));
  await refused(() => signRelease({ ...base, manifestFile, keysFile: placeholderOnly }), /not listed|release-keys/i, 'a key file that holds only the placeholder');
  assert.ok(parseReleaseKeys(fs.readFileSync(KEY_FILE, 'utf8')).keys.every((entry) => entry.kid !== key.kid), 'the key of this test is not in the real key file, which is what the default is');
  for (const bad of ['report.txt', 'RELEASE-MANIFEST.json', 'release-manifest.json.sig.txt', 'x.sig']) {
    await refused(() => signRelease({ ...base, manifestFile, out: path.join(folder('out'), bad) }), /named|name/i, `an output named ${bad}: the release file must be named ${SIGNATURE_ASSET}`);
  }
  const directoryOut = folder('out-directory');
  assert.equal((await signRelease({ ...base, manifestFile, out: directoryOut })).outFile, path.join(directoryOut, SIGNATURE_ASSET), 'a folder as the output gets the right name');
  const insideTree = folder('signed-tree');
  fs.mkdirSync(path.join(insideTree, '.git'));
  await refused(() => signRelease({ ...base, manifestFile, keyFile: path.join(insideTree, 'release.pem') }), /inside the Git work tree/i, 'a private key that is in a work tree');
  await refused(() => signRelease({ ...base, manifestFile, keyFile: path.join(keyDirectory, 'no-such-key.pem') }), /key/i, 'a key file that is not there');
  fs.writeFileSync(path.join(keyDirectory, 'garbage.pem'), 'not a key');
  await refused(() => signRelease({ ...base, manifestFile, keyFile: path.join(keyDirectory, 'garbage.pem') }), /key/i, 'a file that is not a key');
  const p384 = path.join(keyDirectory, 'p384.pem');
  fs.writeFileSync(p384, generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await refused(() => signRelease({ ...base, manifestFile, keyFile: p384 }), /P-256/i, 'a key of another curve');
  const protectedFile = path.join(keyDirectory, 'protected.pem');
  fs.writeFileSync(protectedFile, key.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'a passphrase' }));
  await refused(() => signRelease({ ...base, manifestFile, keyFile: protectedFile }), /passphrase/i, 'a protected key without its passphrase');
  await refused(() => signRelease({ ...base, manifestFile, keyFile: protectedFile, passphrase: 'wrong' }), /passphrase/i, 'and with the wrong one');
  assert.equal((await signRelease({ ...base, manifestFile, keyFile: protectedFile, passphrase: 'a passphrase', out: path.join(folder('out'), SIGNATURE_ASSET) })).kid, key.kid, 'with the right one it signs');
  feed.mode('status', { status: 404 });
  await refused(() => signRelease({ ...base, releaseBase: feed.origin }), /404/, 'a tag that has no manifest');
  feed.mode('html');
  await refused(() => signRelease({ ...base, releaseBase: feed.origin }), /manifest/i, 'a page of HTML where the manifest should be');
  feed.mode('chain');
  for (const releaseBase of ['https://github.com', 'http://example.com', 'http://127.0.0.1.evil.example', 'ftp://127.0.0.1', 'not a url']) {
    await refused(() => signRelease({ ...base, releaseBase }), /loopback|base/i, `a release base of ${releaseBase}: only a stand-in on this machine`);
  }

  // an installer given by the owner has to be the one the manifest lists
  assert.equal((await signRelease({ ...base, manifestFile, installerFile, out: path.join(folder('out'), SIGNATURE_ASSET) })).installerChecked, true, 'the installer that matches');
  const wrongInstaller = path.join(keyDirectory, 'Other.exe');
  fs.writeFileSync(wrongInstaller, Buffer.concat([installer, Buffer.from('x')]));
  await refused(() => signRelease({ ...base, manifestFile, installerFile: wrongInstaller }), /installer/i, 'an installer that is not the listed one (size)');
  fs.writeFileSync(wrongInstaller, Buffer.from(installer.map((byte, index) => (index === 3 ? byte ^ 1 : byte))));
  await refused(() => signRelease({ ...base, manifestFile, installerFile: wrongInstaller }), /installer/i, 'an installer with one bit changed (same size, other hash)');
  await refused(() => signRelease({ ...base, manifestFile: writeManifest(Buffer.from(JSON.stringify(manifestOf({ assets: [{ name: 'A.exe', sha256: 'a'.repeat(64), bytes: 1 }, { name: 'B.exe', sha256: 'b'.repeat(64), bytes: 1 }] })))), installerFile }), /installer/i, 'a manifest with two programs: which one is the installer');
  assert.equal((await signRelease({ ...base, manifestFile, out: path.join(folder('out'), SIGNATURE_ASSET) })).installerChecked, false, 'without one nothing is claimed about it');
  const source = fs.readFileSync(path.join(HUB_ROOT, 'tools', 'release-tools.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/['"`]gh(?:\.exe)?['"`]/.test(source) && !/spawn(?:Sync)?\(\s*['"`]gh/.test(source), 'nothing runs gh');
  assert.deepEqual([...source.matchAll(/spawnSync\(([^,]+),/g)].map((match) => match[1].trim()), ['program'], 'the one place that starts a program takes it from the caller, and the only programs are icacls and whoami by their full path');
  ok('signRelease signs the bytes it is given, a BOM and CRLF included, from a file or from the tag (and keeps what it fetched beside the signature); it refuses a tag that is not vX.Y.Z, a manifest that is HTML, empty, invalid or of another version, a key outside the key file (unless the owner allows it), a private key in a work tree, a file that is not a P-256 key, a protected key without its passphrase, an output with the wrong name, a base that is not a stand-in on this machine, and an installer that does not match the manifest; it uploads nothing');

  // ------------------------------------------------------------------------------------------------------------------------------- 4. the command lines
  if (!outside) console.log('  skip - the scripts are not next to the Hub folder (a copy of the Hub alone): the command lines are not run');
  else {
    const home = folder('cli');
    const target = path.join(home, 'release.pem');
    const made = run(NEW_KEY, [target]);
    assert.equal(made.status, 0, made.stderr + made.stdout);
    assert.ok(!PEM_BODY.test(made.stdout + made.stderr), 'nothing printed is a private key');
    const privateText = fs.readFileSync(target, 'utf8');
    const body = privateText.split(/\r?\n/).filter((line) => line && !line.startsWith('-----'));
    assert.ok(body.every((line) => !(made.stdout + made.stderr).includes(line)), 'and no line of its body either');
    const spki = createPublicKey(createPrivateKey(privateText)).export({ type: 'spki', format: 'der' });
    assert.ok(made.stdout.includes(spki.toString('base64')) && made.stdout.includes(createHash('sha256').update(spki).digest('hex').slice(0, 8)), 'it shows the public key and its id');
    assert.match(made.stdout, /"use": "release"/, 'and the entry for CHATMCP-HUB/lib/release-keys.json');
    assert.match(made.stdout, /offline|backup|back up/i, 'and says to keep the file offline');
    assert.match(made.stdout, /next key/i, 'and says to keep a second key for the next one');
    const again = run(NEW_KEY, [target]);
    assert.equal(again.status, 1, 'a second run on the same path is refused');
    assert.ok(fs.readFileSync(target, 'utf8') === privateText && !PEM_BODY.test(again.stdout + again.stderr));
    assert.equal(run(NEW_KEY, [path.join(REPO_ROOT, 'never-created.pem')]).status, 1, 'a path in this repository is refused');
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'never-created.pem')), false);
    assert.equal(run(NEW_KEY, [path.join(HUB_ROOT, 'tests', '..', '..', 'x.pem')]).status, 1, 'and so is one with ..');
    assert.equal(run(NEW_KEY, []).status, 2, 'no path is a bad use');
    assert.equal(run(NEW_KEY, ['a', 'b']).status, 2, 'two paths are a bad use');
    assert.equal(run(NEW_KEY, ['--help']).status, 0, '--help is not a failure');
    const viaEnvironment = run(NEW_KEY, [path.join(home, 'protected.pem')], { DATGOLD_RELEASE_KEY_PASSPHRASE: 'from the environment' });
    assert.equal(viaEnvironment.status, 0, viaEnvironment.stderr);
    assert.match(fs.readFileSync(path.join(home, 'protected.pem'), 'utf8'), /ENCRYPTED PRIVATE KEY/, 'the passphrase comes from the environment, never from the command line');
    assert.ok(!/from the environment/.test(viaEnvironment.stdout + viaEnvironment.stderr), 'and is not printed');

    // sign it with what it made (the key file lists it)
    const listed = path.join(home, 'release-keys.json');
    fs.writeFileSync(listed, keyFileText([{ kid: JSON.parse(made.stdout.slice(made.stdout.indexOf('{'), made.stdout.indexOf('}') + 1)).kid, use: 'release', spki: spki.toString('base64') }]));
    const manifestPath = writeManifest(crlfBom);
    const out = path.join(home, 'signature', SIGNATURE_ASSET);
    fs.mkdirSync(path.dirname(out));
    const signedRun = run(SIGN, ['--tag', 'v3.11.0', '--manifest', manifestPath, '--key', target, '--keys-file', listed, '--out', out]);
    assert.equal(signedRun.status, 0, signedRun.stderr + signedRun.stdout);
    assert.ok(!PEM_BODY.test(signedRun.stdout + signedRun.stderr) && body.every((line) => !(signedRun.stdout + signedRun.stderr).includes(line)), 'signing prints nothing of the private key');
    assert.equal(verify('sha256', crlfBom, { key: createPublicKey(createPrivateKey(privateText)), dsaEncoding: 'ieee-p1363' }, Buffer.from(JSON.parse(fs.readFileSync(out, 'utf8')).sig, 'base64')), true);
    assert.match(signedRun.stdout, new RegExp(`gh release upload v3\\.11\\.0 "${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" --repo pddczpl/ChatMCP`), 'the upload command is printed');
    assert.match(signedRun.stdout, /nothing (?:was|has been) uploaded/i, 'and the output says that it did not run it');
    assert.match(signedRun.stdout, /--clobber/, 'with the way to replace a signature that is already there');
    assert.match(signedRun.stdout, /3\.11\.0/, 'it shows what it signed');
    const viaKeyVariable = run(SIGN, ['--tag', 'v3.11.0', '--manifest', manifestPath, '--keys-file', listed, '--out', path.join(folder('cli-out'), SIGNATURE_ASSET)], { DATGOLD_RELEASE_KEY: target });
    assert.equal(viaKeyVariable.status, 0, viaKeyVariable.stderr);
    const fromFeed = await runAsync(SIGN, ['--tag', 'v3.11.0', '--key', target, '--keys-file', listed, '--release-base', feed.origin, '--out', path.join(folder('cli-out'), SIGNATURE_ASSET)]);
    assert.equal(fromFeed.status, 0, fromFeed.stderr + fromFeed.stdout);
    assert.equal(run(SIGN, ['--tag', 'v3.11.0', '--manifest', manifestPath, '--key', target, '--out', path.join(folder('cli-out'), SIGNATURE_ASSET)]).status, 1, 'with the real key file, in which this key is not listed: refused');
    assert.equal(run(SIGN, ['--tag', 'v3.11.1', '--manifest', manifestPath, '--key', target, '--keys-file', listed]).status, 1, 'a tag that is not the manifest\'s version: refused');
    assert.equal(run(SIGN, ['--manifest', manifestPath, '--key', target]).status, 2, 'no tag: a bad use');
    assert.equal(run(SIGN, ['--tag', 'v3.11.0', '--manifest', manifestPath]).status, 2, 'no key: a bad use');
    assert.equal(run(SIGN, ['--tag', 'v3.11.0', '--bogus']).status, 2, 'an option it does not know: a bad use');
    assert.equal(run(SIGN, ['--tag', 'v3.11.0', '--key', target, '--release-base', 'https://github.com']).status, 2, 'a release base that is not on this machine: a bad use, and nothing is asked');
    assert.equal(run(SIGN, ['--help']).status, 0);
    const protectedRun = run(SIGN, ['--tag', 'v3.11.0', '--manifest', manifestPath, '--key', path.join(home, 'protected.pem'), '--keys-file', listed]);
    assert.equal(protectedRun.status, 1, 'a protected key without its passphrase in the environment');
    ok('the command lines: new-release-key prints the public key, its id and the entry for the key file (and that the file is to be kept offline with a second key for the next one) and never a line of the private key, refuses a second run, a path in the repository (also with ..) and a bad use, and takes a passphrase from the environment only; sign-release signs a file or a tag (against a stand-in), prints the upload command and says that nothing was uploaded, and exits 2 for a bad use');
  }
} finally {
  await feed.close();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(`PASS: ${checks} release-tools groups`);
