// The small tools of the end-to-end proof of the in-app updater (scripts/tests/updater-e2e/, run by the CI job "Windows in-app updater, end to end"): the injection of a version into a build, the manifest the
// Publish workflow would write, the byte that is turned in a staged installer, the throwaway keys, and the signing through the owner's own command line. Nothing here needs Windows, a build or an installed app: what
// the job does with them on a hosted runner is the job's own proof; this suite holds the tools to what the job relies on.
//
//   1. a version is put into exactly the places a build reads it from, nothing else changes in those files (the bytes are the same with the old version put back), the result agrees with the one-version rule of
//      tests/verify-docs.mjs, and a tree that does not fit (a place missing, two places that disagree, a place twice, a version that is not x.y.z) is refused BEFORE any file is written;
//   2. the manifest is the one the Publish workflow writes (a byte order mark, CRLF), the Hub's own reader accepts it, and nothing is made from input that is not a release;
//   3. turning one byte of a file twice gives the file back, once changes that byte and no other;
//   4. the throwaway keys are made by scripts/new-release-key.mjs itself, the key list that a test build is given fits what the build script checks, and no private key is in it;
//   5. a manifest is signed by scripts/sign-release.mjs, the signature checks with the Hub's reader, the signature of another key does not (the shell reads that as bad_signature), and the tool compares the installer.
// The CI job runs these tools for real; this is what keeps them from being wrong in a way that costs a 20-minute round.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseManifest } from '../lib/update-check.mjs';
import { SignatureError, parseReleaseKeys, verifyManifest } from '../lib/release-signature.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(HUB_ROOT, '..');
const TOOLS = path.join(REPO_ROOT, 'scripts', 'tests', 'updater-e2e');
if (!fs.existsSync(path.join(REPO_ROOT, 'scripts'))) {
  console.log('CHATMCP_TEST_SKIP: scripts/ was not found next to CHATMCP-HUB (the tools of the end-to-end proof need the whole repository)');
  process.exit(0);
}
const load = (name) => import(pathToFileURL(path.join(TOOLS, name)).href);
const { VERSION_FILES, readBuildVersion, setBuildVersion } = await load('set-build-version.mjs');
const { buildReleaseManifest, entryFromToolOutput, flipByte, keyListText, makeTestKeys, signWithTool } = await load('release-files.mjs');
const { assertDisposableRunner, assertHostedRunnerEnvironment, isSameProcessRunning, processInfo, splitWindowsCommandLine } = await load('lib/windows.mjs');
const { Evidence } = await load('lib/evidence.mjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-updater-e2e-tools-'));
let count = 0;
const folder = (name = 'folder') => { const directory = path.join(scratch, `${name}-${count += 1}`); fs.mkdirSync(directory, { recursive: true }); return directory; };
const repoVersion = JSON.parse(fs.readFileSync(path.join(HUB_ROOT, 'package.json'), 'utf8')).version;

/** The files a build reads its version from, copied from this very repository into a folder of their own. */
function copyVersionFiles(destination) {
  for (const relative of VERSION_FILES) {
    const target = path.join(destination, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, ...relative.split('/')), target);
  }
  return destination;
}
const read = (root, relative) => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
const write = (root, relative, text) => fs.writeFileSync(path.join(root, ...relative.split('/')), text);
const snapshot = (root) => Object.fromEntries(VERSION_FILES.map((relative) => [relative, read(root, relative)]));

try {
  // ----------------------------------------------------------------------------------------------------------------------------- 1. the version of a build
  {
    assert.match(repoVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(VERSION_FILES.length >= 9, `the places a build reads its version from: ${VERSION_FILES.join(', ')}`);
    const root = copyVersionFiles(folder('tree'));
    const before = snapshot(root);
    assert.equal(readBuildVersion(root), repoVersion, 'the tree as it is committed says one version');
    const done = setBuildVersion(root, '9.8.7');
    assert.deepEqual({ from: done.from, to: done.to }, { from: repoVersion, to: '9.8.7' });
    assert.deepEqual([...done.files].sort(), [...VERSION_FILES].sort(), 'every one of the places was written');
    const after = snapshot(root);
    for (const relative of VERSION_FILES) {
      assert.ok(after[relative].includes('9.8.7'), `${relative} says the new version`);
      assert.equal(after[relative].split('9.8.7').join(repoVersion), before[relative], `${relative}: with the old version put back it is the same bytes (line endings, byte order mark and everything else untouched)`);
    }
    assert.equal(readBuildVersion(root), '9.8.7');
    ok('a version is put into the places a build reads it from, and into nothing else (the bytes come back with the old version put back)');

    // the one-version rule of tests/verify-docs.mjs, on the tree that was written
    const hub = JSON.parse(read(root, 'CHATMCP-HUB/package.json'));
    assert.equal(hub.version, '9.8.7');
    assert.equal(read(root, 'CHATMCP-HUB/lib/manager.mjs').match(/export const VERSION = '([^']+)'/)?.[1], '9.8.7', 'lib/manager.mjs VERSION');
    const uiBuild = read(root, 'CHATMCP-HUB/hub.mjs').match(/export const UI_BUILD = '([^']+)'/)?.[1];
    assert.equal(uiBuild, '9.8.7-react-agent', 'hub.mjs UI_BUILD');
    assert.equal(read(root, 'CHATMCP-HUB/web/react-app.js').match(/const BUILD = '([^']+)'/)?.[1], uiBuild, 'web/react-app.js BUILD = hub.mjs UI_BUILD (the dashboard would refuse to talk to the Hub)');
    assert.equal(read(root, 'CHATMCP-HUB/ui/src/lib/api.ts').match(/const UI_BUILD = '([^']+)';/)?.[1], uiBuild, 'ui/src/lib/api.ts UI_BUILD = hub.mjs UI_BUILD (the UI would be refused with 409)');
    assert.equal(read(root, 'CHATMCP-HUB/web/react-app.js').match(/const uiVersion = '([^']+)'/)?.[1], '9.8.7', 'web/react-app.js uiVersion');
    const ui = JSON.parse(read(root, 'CHATMCP-HUB/ui/package.json'));
    const lock = JSON.parse(read(root, 'CHATMCP-HUB/ui/package-lock.json'));
    assert.deepEqual([ui.version, lock.version, lock.packages[''].version], ['9.8.7', '9.8.7', '9.8.7'], 'the UI package and its lock file');
    for (const project of ['desktop-shell/ChatMCP.csproj', 'installer/ChatMCP.Installer.csproj']) {
      assert.equal(read(root, project).match(/<Version>([^<]+)<\/Version>/)?.[1], '9.8.7', `${project} <Version> (the version of the program, and of the setup the shell compares with)`);
    }
    ok('and what was written is one version everywhere, by the rules of tests/verify-docs.mjs (package.json, manager.mjs, the three UI_BUILD places, the UI package and its lock, the two programs)');
  }

  // a second pass on the same tree: from the version that is there now
  {
    const root = copyVersionFiles(folder('twice'));
    setBuildVersion(root, '9.8.7');
    const second = setBuildVersion(root, '10.0.1');
    assert.deepEqual({ from: second.from, to: second.to }, { from: '9.8.7', to: '10.0.1' });
    assert.equal(readBuildVersion(root), '10.0.1');
    ok('a tree can be given a version again (the second pass starts from the first)');
  }

  // a version that is not a release is refused, and nothing is written
  {
    const root = copyVersionFiles(folder('invalid'));
    const before = snapshot(root);
    for (const bad of ['3.10', '3.10.3-test', 'v3.10.3', '03.10.3', '3.10.3+1', '3.10.3 ', '3.10.3\n', '', null, undefined, 3, '1.2.3.4']) {
      assert.throws(() => setBuildVersion(root, bad), /release version/i, `${JSON.stringify(bad)} is not a release version`);
    }
    assert.deepEqual(snapshot(root), before, 'a refusal wrote nothing');
    ok('only a release version x.y.z is accepted (a suffix, a v, a leading zero, four parts and non-text are refused) and a refusal writes nothing');
  }

  // a tree that does not fit is refused as a whole
  {
    const untouched = (root, before) => assert.deepEqual(snapshot(root), before, 'a refusal wrote nothing, not even into the files that did fit');

    let root = copyVersionFiles(folder('missing-place'));
    write(root, 'CHATMCP-HUB/lib/manager.mjs', read(root, 'CHATMCP-HUB/lib/manager.mjs').replace(/export const VERSION = '[^']+';/, '// the version moved elsewhere'));
    let before = snapshot(root);
    assert.throws(() => setBuildVersion(root, '9.8.7'), /CHATMCP-HUB\/lib\/manager\.mjs/, 'a place that is not there names its file');
    untouched(root, before);

    root = copyVersionFiles(folder('disagree'));
    write(root, 'CHATMCP-HUB/lib/manager.mjs', read(root, 'CHATMCP-HUB/lib/manager.mjs').replace(`'${repoVersion}'`, "'3.0.0'"));
    before = snapshot(root);
    assert.throws(() => setBuildVersion(root, '9.8.7'), /disagree/i, 'two places with two versions are not one tree');
    assert.throws(() => readBuildVersion(root), /disagree/i);
    untouched(root, before);

    root = copyVersionFiles(folder('twice-in-a-file'));
    write(root, 'CHATMCP-HUB/hub.mjs', `${read(root, 'CHATMCP-HUB/hub.mjs')}\nexport const UI_BUILD = '${repoVersion}-react-agent';\n`);
    before = snapshot(root);
    assert.throws(() => setBuildVersion(root, '9.8.7'), /CHATMCP-HUB\/hub\.mjs/, 'a place that is there twice is not a place the tool knows');
    untouched(root, before);

    root = copyVersionFiles(folder('no-file'));
    fs.rmSync(path.join(root, 'installer', 'ChatMCP.Installer.csproj'));
    assert.throws(() => setBuildVersion(root, '9.8.7'), /ChatMCP\.Installer\.csproj/, 'a file that is not there names itself');
    ok('a tree with a place missing, with two places that disagree, with a place twice, or with a file missing is refused as a whole and named (nothing is written)');
  }

  // ----------------------------------------------------------------------------------------------------------------------------- 2. the manifest
  {
    const bytes = Buffer.from('the installer');
    const installer = { name: 'DatGoldSetup.exe', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const manifest = buildReleaseManifest({ version: '3.10.4', commit: 'ab'.repeat(20), installer, workflowRun: '12345' });
    assert.ok(Buffer.isBuffer(manifest));
    assert.deepEqual([...manifest.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell writes a byte order mark with -Encoding utf8, and the signature covers it');
    assert.ok(manifest.toString('utf8').includes('\r\n'), 'and CRLF');
    const read1 = parseManifest(manifest.toString('utf8'));
    assert.equal(read1.version, '3.10.4');
    assert.equal(read1.commit, 'ab'.repeat(20));
    assert.equal(read1.installerName, 'DatGoldSetup.exe');
    assert.equal(read1.installer.bytes, bytes.length);
    assert.equal(read1.installer.sha256, installer.sha256);
    assert.deepEqual(buildReleaseManifest({ version: '3.10.4', commit: 'ab'.repeat(20), installer, workflowRun: '12345' }), manifest, 'the same input gives the same bytes (a signature made once stays good)');
    ok('the manifest is what the Publish workflow writes (byte order mark, CRLF), the Hub reads it as the release it is, and it is always the same bytes for the same input');

    const base = { version: '3.10.4', commit: 'ab'.repeat(20), installer, workflowRun: '1' };
    assert.throws(() => buildReleaseManifest({ ...base, version: '3.10.4-test' }), /release version/i);
    assert.throws(() => buildReleaseManifest({ ...base, commit: 'abc' }), /commit/i);
    assert.throws(() => buildReleaseManifest({ ...base, installer: { ...installer, sha256: 'zz' } }), /sha-?256/i);
    assert.throws(() => buildReleaseManifest({ ...base, installer: { ...installer, bytes: -1 } }), /bytes/i);
    assert.throws(() => buildReleaseManifest({ ...base, installer: { ...installer, name: '..\\evil.exe' } }), /name/i);
    assert.throws(() => buildReleaseManifest({ ...base, installer: { ...installer, name: 'setup.zip' } }), /name/i);
    ok('a manifest is not made from a version, a commit, a digest, a size or a name that the Hub would refuse');
  }

  // ----------------------------------------------------------------------------------------------------------------------------- 3. one byte
  {
    const file = path.join(folder('flip'), 'DatGoldSetup.exe');
    const original = randomBytes(4096);
    fs.writeFileSync(file, original);
    flipByte(file, 1000);
    const flipped = fs.readFileSync(file);
    assert.equal(flipped.length, original.length, 'the size is the signed size');
    const differing = [...flipped].map((value, index) => (value === original[index] ? -1 : index)).filter((index) => index >= 0);
    assert.deepEqual(differing, [1000], 'one byte, and only that one');
    assert.notEqual(createHash('sha256').update(flipped).digest('hex'), createHash('sha256').update(original).digest('hex'));
    flipByte(file, 1000);
    assert.ok(fs.readFileSync(file).equals(original), 'turned twice, the file is the file again');
    assert.throws(() => flipByte(file, 4096), /offset/i);
    assert.throws(() => flipByte(file, -1), /offset/i);
    assert.throws(() => flipByte(path.join(path.dirname(file), 'nothing-here.exe'), 0), /ENOENT|not a file|exist/i);
    assert.ok(fs.readFileSync(file).equals(original), 'a refusal changed nothing');
    ok('one byte of a staged installer is turned in place (same size, other digest), turned again it is the original, and a place outside the file is refused');
  }

  // ----------------------------------------------------------------------------------------------------------------------------- 4. the keys
  const keyDirectory = folder('keys');
  const keys = await makeTestKeys(keyDirectory);
  {
    assert.notEqual(keys.run.kid, keys.other.kid, 'two keys');
    for (const key of [keys.run, keys.other]) {
      assert.ok(fs.existsSync(key.keyFile), 'the private key file is where the tool made it');
      const listText = fs.readFileSync(key.listFile, 'utf8');
      const parsed = parseReleaseKeys(listText);
      assert.equal(parsed.keys.length, 1, 'a list of one key the Hub and the shell accept');
      assert.equal(parsed.keys[0].kid, key.kid);
      assert.equal(parsed.ignored.length, 0);
      // what Build-Installer.ps1 -ReleaseKeysFile checks (scripts/InstallerPayload.ps1, Resolve-InstallerReleaseKeysFile)
      assert.ok(listText.length >= 2 && listText.length <= 16384);
      const document = JSON.parse(listText);
      const usable = document.keys.filter((entry) => entry.use === 'release' && typeof entry.spki === 'string' && /^[A-Za-z0-9+/]{122}==$/.test(entry.spki));
      assert.equal(usable.length, 1, 'an entry that says use "release" with a public key of the size of a P-256 SubjectPublicKeyInfo');
      assert.ok(!/PRIVATE/i.test(listText), 'a key list holds public keys only');
      assert.ok(!listText.includes(key.keyFile), 'and does not say where the private key is');
    }
    assert.equal(keyListText([{ kid: keys.run.kid, use: 'release', spki: JSON.parse(fs.readFileSync(keys.run.listFile, 'utf8')).keys[0].spki }]), fs.readFileSync(keys.run.listFile, 'utf8'));
    ok('two throwaway keys are made by scripts/new-release-key.mjs, each with a key list that the Hub, the shell and the build script accept, and no private key is in a list');

    const sample = ['A P-256 release key was made.', '', 'key id (kid):  0123abcd', 'public key (base64 SPKI):', 'X'.repeat(124), '', 'Entry for CHATMCP-HUB/lib/release-keys.json (replace the placeholder with it, in a small pull request):',
      JSON.stringify({ kid: '0123abcd', use: 'release', spki: 'X'.repeat(124) }, null, 2), '', 'The private key is in somewhere.'].join('\n');
    assert.deepEqual(entryFromToolOutput(sample), { kid: '0123abcd', use: 'release', spki: 'X'.repeat(124) });
    assert.throws(() => entryFromToolOutput('nothing useful here'), /entry/i);
    assert.throws(() => entryFromToolOutput(sample.replace('"use": "release"', '"use": "placeholder"')), /release/i);
    ok('the entry is read from the output of the tool, and output without an entry for a release key is refused');
  }

  // ----------------------------------------------------------------------------------------------------------------------------- 5. signing
  {
    const directory = folder('signing');
    const installerFile = path.join(directory, 'DatGoldSetup.exe');
    const installerBytes = randomBytes(2048);
    fs.writeFileSync(installerFile, installerBytes);
    const installer = { name: 'DatGoldSetup.exe', bytes: installerBytes.length, sha256: createHash('sha256').update(installerBytes).digest('hex') };
    const manifest = buildReleaseManifest({ version: '3.10.4', commit: 'cd'.repeat(20), installer, workflowRun: '42' });
    const manifestFile = path.join(directory, 'RELEASE-MANIFEST.json');
    fs.writeFileSync(manifestFile, manifest);
    const trusted = parseReleaseKeys(fs.readFileSync(keys.run.listFile, 'utf8')).keys;

    const signed = await signWithTool({ tag: 'v3.10.4', keyFile: keys.run.keyFile, keysFile: keys.run.listFile, manifestFile, installerFile, outDirectory: path.join(directory, 'by-run') });
    assert.equal(path.basename(signed.signatureFile), 'RELEASE-MANIFEST.json.sig');
    assert.ok(signed.bytes.equals(fs.readFileSync(signed.signatureFile)));
    assert.equal(verifyManifest(manifest, signed.bytes, trusted).kid, keys.run.kid, 'the signature checks with the Hub\'s own reader, over the exact bytes (byte order mark included)');
    assert.ok(fs.readFileSync(manifestFile).equals(manifest), 'the tool left the manifest as it was');
    ok('the manifest is signed by scripts/sign-release.mjs with the key of the run, and the signature checks over the exact bytes');

    const forged = await signWithTool({ tag: 'v3.10.4', keyFile: keys.other.keyFile, keysFile: keys.other.listFile, manifestFile, installerFile, outDirectory: path.join(directory, 'by-other') });
    let refused = null;
    try { verifyManifest(manifest, forged.bytes, trusted); } catch (error) { refused = error; }
    assert.ok(refused instanceof SignatureError, 'a signature by another key is refused by the key list of the run');
    assert.equal(refused.reason, 'unknown_kid');
    ok('the same manifest signed by ANOTHER key is refused by the key list of the run (the shell says bad_signature)');

    const different = path.join(directory, 'other-setup.exe');
    fs.writeFileSync(different, randomBytes(2048));
    await assert.rejects(() => signWithTool({ tag: 'v3.10.4', keyFile: keys.run.keyFile, keysFile: keys.run.listFile, manifestFile, installerFile: different, outDirectory: path.join(directory, 'refused') }), /installer|sha/i);
    assert.ok(!fs.existsSync(path.join(directory, 'refused', 'RELEASE-MANIFEST.json.sig')), 'and nothing was signed');
    await assert.rejects(() => signWithTool({ tag: 'v3.10.5', keyFile: keys.run.keyFile, keysFile: keys.run.listFile, manifestFile, installerFile, outDirectory: path.join(directory, 'wrong-tag') }), /tag|3\.10\./i);
    ok('and the tool compares the installer with the manifest and the tag with the version: another file or another tag signs nothing');
  }

  // ----------------------------------------------------------------------------------------------------------------------------- 6. the guards
  // run.mjs installs, updates and force-closes DatGold, and rehearse-page.mjs --policy writes a machine-wide WebView2 policy: both are for a disposable GitHub-hosted runner and for nothing else. They
  // refuse before they read a file, make a folder or start a program. Every case below is one that MUST be refused: nothing here can start the proof, whatever machine this suite runs on (a hosted
  // runner's own variables are overridden in each case), and the folders it is given do not exist, so that a guard that regressed would still find nothing to install.
  {
    const hosted = { win32: 'win32' };
    assert.doesNotThrow(() => assertHostedRunnerEnvironment({ env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_WORKFLOW: 'CI' }, platform: hosted.win32 }), 'POSITIVE CONTROL: a hosted Windows runner running CI is accepted');
    const refusals = [
      ['Linux', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_WORKFLOW: 'CI' }, 'linux', /not Windows/],
      ['a developer machine (no variable of a runner)', {}, 'win32', /not a GitHub-hosted runner/],
      ['a self-hosted runner', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', GITHUB_WORKFLOW: 'CI' }, 'win32', /not a GitHub-hosted runner/],
      ['a workflow that is not a runner at all', { GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'github-hosted' }, 'win32', /not a GitHub-hosted runner/],
      ['a publish workflow', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_WORKFLOW: 'Publish ChatMCP v9.9.9' }, 'win32', /publish workflow/],
    ];
    for (const [label, env, platform, pattern] of refusals) {
      assert.throws(() => assertHostedRunnerEnvironment({ env, platform }), pattern, `${label} is refused`);
      assert.throws(() => assertHostedRunnerEnvironment({ env, platform }), /Refusing to run/, `${label}: in the words of a refusal`);
    }
    ok('the environment guard accepts a hosted Windows runner and refuses Linux, a developer machine, a self-hosted runner, a workflow that is not a runner and a publish workflow');

    // the guard of the installation asks the environment FIRST: on a machine that is not a hosted runner it says so and looks at nothing else (a folder that exists here would be named if it were read)
    const present = folder('an-installation-that-is-there');
    await assert.rejects(() => assertDisposableRunner({ env: {}, platform: 'win32', paths: { installDirectory: present, dataDirectory: present, uninstallKey: 'HKCU\\Software\\NoSuchKeyDatGoldRehearsal' }, hubPort: 3007 }),
      (error) => /Refusing to run/.test(error.message) && /not a GitHub-hosted runner/.test(error.message) && !/exists/.test(error.message), 'asks about the machine first, and reads no folder of an installation when the machine is the wrong one');
    ok('the guard of the installation asks the environment first: on a machine that is not a hosted runner it refuses for that and reads no folder, key or port');

    const refusedRun = path.join(scratch, 'refused-evidence');
    const nothing = path.join(scratch, 'nothing-here');
    const environments = [
      ['no variable of a runner', { GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', GITHUB_WORKFLOW: '' }],
      ['a self-hosted runner', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', GITHUB_WORKFLOW: 'CI' }],
      ['a publish workflow', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_WORKFLOW: 'Publish ChatMCP v9.9.9' }],
    ];
    for (const [label, env] of environments) {
      // The children get NO path: if a guard ever regressed, the rehearsal could not find `dotnet` and would stop before it wrote a policy, and the proof would not find anything it starts by name. The
      // programs this suite starts itself are named by their full path, as run.mjs's own are.
      const child = { ...process.env, ...env };
      for (const key of Object.keys(child)) if (/^path$/i.test(key)) delete child[key];
      child.PATH = '';
      const proof = spawnSync(process.execPath, [path.join(TOOLS, 'run.mjs'), '--work', nothing, '--keys', nothing, '--evidence', refusedRun], { env: child, encoding: 'utf8', timeout: 60_000 });
      assert.equal(proof.status, 1, `run.mjs on ${label}: exit code 1 (${proof.stderr.slice(0, 300)})`);
      assert.match(proof.stderr, /Refusing to run/, `run.mjs on ${label}: says it refuses`);
      assert.ok(!fs.existsSync(refusedRun), `run.mjs on ${label}: made no folder (the guard comes before the evidence folder, the reading of any file and every program)`);
      const rehearsal = spawnSync(process.execPath, [path.join(TOOLS, 'rehearse-page.mjs'), '--webview2', '--policy'], { env: child, encoding: 'utf8', timeout: 60_000 });
      assert.equal(rehearsal.status, 2, `rehearse-page.mjs --policy on ${label}: exit code 2 (${rehearsal.stderr.slice(0, 300)})`);
      assert.match(rehearsal.stderr, /Refusing to run/, `rehearse-page.mjs --policy on ${label}: says it refuses`);
    }
    ok('run.mjs and rehearse-page.mjs --policy refuse off a hosted runner (no runner, self-hosted, publish workflow) before they make a folder, read a file or start a program');

    // the guard is the first thing the program does: before the evidence folder and before the paths of the installation are even asked for
    const source = fs.readFileSync(path.join(TOOLS, 'run.mjs'), 'utf8');
    const guardAt = source.indexOf('assertHostedRunnerEnvironment()');
    assert.ok(guardAt > 0, 'run.mjs calls the environment guard');
    assert.ok(guardAt < source.indexOf('new Evidence('), 'before it makes the evidence folder');
    assert.ok(guardAt < source.indexOf('installedPaths()'), 'before it asks where DatGold would be installed');
    assert.ok(guardAt < source.indexOf('await main()'), 'and before main()');
    assert.ok(!/await main\(\);\s*\n\s*\} catch/.test(source.slice(0, guardAt)), 'nothing that cleans up can run before the guard');
    ok('in run.mjs the environment guard is the first statement after the arguments: before the evidence folder, the paths of the installation and main()');
  }

  // ----------------------------------------------------------------------------------------------------------------------------- 7. what a failure leaves
  {
    const directory = path.join(folder('partial'), 'evidence');
    const evidence = new Evidence(directory);
    evidence.phase('install', 'the first phase');
    const partial = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
    assert.equal(partial.outcome, 'running', 'a run that is cut off (a timeout, a cancel) still leaves a report of how far it got');
    assert.deepEqual(partial.phases.map((phase) => phase.name), ['install']);
    evidence.check(true, 'a fact');
    evidence.phase('attach', 'the second');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8')).checks.length, 1);
    assert.throws(() => evidence.check(false, 'a fact that does not hold', 'because'), /FAILED: a fact that does not hold/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8')).checks.at(-1).ok, false, 'a failed check is on disk the moment it fails');
    ok('the evidence report is written as the run goes (each phase and each failed check), not only at the end: a run that is cut off still says how far it got');
  }
  {
    // the words of a command line, as the program that is started reads them: what the proof compares with the vector of native-shared/UpdateContract.cs
    const exe = 'C:\\Users\\runner admin\\AppData\\Local\\ChatMCP\\hub\\updates\\3.10.4\\DatGoldSetup.exe';
    const install = 'C:\\Users\\runner admin\\AppData\\Local\\Programs\\ChatMCP';
    const result = 'C:\\Users\\runner admin\\AppData\\Local\\ChatMCP\\hub\\update-result.json';
    assert.deepEqual(splitWindowsCommandLine(`"${exe}" --quiet --update --install-dir "${install}" --wait-pid 4711 --relaunch --result "${result}"`),
      [exe, '--quiet', '--update', '--install-dir', install, '--wait-pid', '4711', '--relaunch', '--result', result], 'the vector of the shell, with paths that have a space in them');
    assert.deepEqual(splitWindowsCommandLine('C:\\a\\b.exe x\ty  z'), ['C:\\a\\b.exe', 'x', 'y', 'z'], 'an unquoted program, white space of any kind between words');
    assert.deepEqual(splitWindowsCommandLine('p.exe a\\\\"b c" d'), ['p.exe', 'a\\b c', 'd'], 'two backslashes before a quote are one backslash, and the quote opens a quoted run');
    assert.deepEqual(splitWindowsCommandLine('p.exe "C:\\dir\\" next'), ['p.exe', 'C:\\dir" next'], 'one backslash before a quote makes the quote a letter of the word');
    assert.deepEqual(splitWindowsCommandLine('p.exe C:\\plain\\path\\ end'), ['p.exe', 'C:\\plain\\path\\', 'end'], 'backslashes that no quote follows are plain');
    assert.deepEqual(splitWindowsCommandLine('  '), []);
    assert.deepEqual(splitWindowsCommandLine(undefined), []);
    ok('a Windows command line is split into its words the way a program reads it (quotes, backslashes before a quote, white space), so that the arguments of the setup are compared word by word');
  }
  if (process.platform === 'win32') {
    const own = processInfo(process.pid);
    assert.ok(own && /node/i.test(own.path) && typeof own.created === 'string');
    assert.equal(typeof own.parentProcessId, 'number', 'the parent of a process is told, so that "started by the setup" is a fact and not a guess');
    assert.ok(own.parentProcessId > 0 && own.parentProcessId !== process.pid);
    assert.equal(isSameProcessRunning(process.pid, own.created), true, 'the same process, by its id and its creation time');
    assert.equal(isSameProcessRunning(process.pid, '1999-01-01T00:00:00.0000000+00:00'), false, 'another process that got the same id (an id is reused) is not the same process');
    assert.equal(isSameProcessRunning(4_294_000, own.created), false, 'and a process that is not there is not running');
    ok('a process is told by its id AND its creation time, so an id that was given to another program is not mistaken for the one that was waited for');
  }

  // ----------------------------------------------------------------------------------------------------------------------------- 8. the build script's cleanup
  {
    const script = fs.readFileSync(path.join(TOOLS, 'Build-TestPair.ps1'), 'utf8').replace(/\r\n/g, '\n');
    const cleanup = script.slice(script.lastIndexOf('} finally {'));
    assert.match(cleanup, /\$ErrorActionPreference = 'Continue'/, 'the cleanup is not run under Stop: a native command that writes to stderr would then replace the error that brought it there');
    assert.ok(cleanup.indexOf("$ErrorActionPreference = 'Continue'") < cleanup.indexOf('worktree remove'), 'before the first command of the cleanup');
    assert.ok(!/worktree prune/.test(script), 'it does not prune the work trees of the whole repository (a developer machine has dozens, not all of them ours)');
    const startAt = script.indexOf('= Start-Process');
    assert.ok(startAt > 0, 'the builds are started with Start-Process');
    assert.match(script.slice(0, startAt), /Remove-Item -LiteralPath 'Env:\\PSModulePath'/, 'the builds are started without the module path of a PowerShell 7 that started this script (Get-FileHash would be lost): it is taken off BEFORE they start');
    assert.match(script.slice(startAt), /\$env:PSModulePath = \$savedModulePath/, 'and given back to this session afterwards');
    ok('Build-TestPair.ps1: the cleanup cannot replace the real error, does not prune the repository, and starts the builds without the module path of PowerShell 7');
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`${checks} checks passed`);
