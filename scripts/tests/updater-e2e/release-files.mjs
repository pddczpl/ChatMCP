// The files of a release that the end-to-end proof of the in-app updater makes, tampers with and signs (tests/verify-updater-e2e-tools.mjs holds them to what the CI job relies on):
//   * buildReleaseManifest   RELEASE-MANIFEST.json as the Publish workflow writes it (Windows PowerShell, -Encoding utf8: a byte order mark, CRLF), for the setup of the build under test;
//   * flipByte               one byte of a staged installer turned in place (turned again, the file is the file), which is what a program that runs as the person could do to the folder of updates;
//   * makeTestKeys           two throwaway signing keys, made by scripts/new-release-key.mjs itself, and the key list that a test build is given (Build-Installer.ps1 -ReleaseKeysFile);
//   * signWithTool           the signature of a manifest, made by scripts/sign-release.mjs itself (the owner's tool), which compares the installer with the manifest before it signs.
// The two command lines are the owner's, not copies of them: the job proves the tools too.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NEW_KEY_TOOL = path.join(REPOSITORY, 'scripts', 'new-release-key.mjs');
const SIGN_TOOL = path.join(REPOSITORY, 'scripts', 'sign-release.mjs');

// the byte order mark that Windows PowerShell writes, as a character code: an invisible character in the source is one that an editor can drop
const BOM = String.fromCharCode(0xfeff);
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN = /^\d{1,20}$/;

// ------------------------------------------------------------------------------------------------------------------------------- the manifest

/**
 * The bytes of RELEASE-MANIFEST.json for `version`, with the one installer of the build under test. The same shape as the Publish workflow writes (version, companionVersion, commit, workflowRun, assets,
 * signedInEdgeVerified, authenticodeSigned), with the byte order mark and the CRLF that Windows PowerShell gives a file written with -Encoding utf8: the signature covers exactly these bytes, so the proof
 * signs, serves, downloads and verifies them with the BOM in them. Input that the Hub's reader would refuse is refused here.
 */
export function buildReleaseManifest({ version, commit, installer, workflowRun = '0', companionVersion = '1.5.2' } = {}) {
  if (typeof version !== 'string' || !RELEASE.test(version)) throw new TypeError(`${JSON.stringify(version)} is not a release version x.y.z.`);
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new TypeError('The commit must be 40 hexadecimal characters.');
  if (typeof workflowRun !== 'string' || !RUN.test(workflowRun)) throw new TypeError('The workflow run must be a number written as text.');
  if (!installer || typeof installer !== 'object') throw new TypeError('The manifest needs the installer: its name, its size and its SHA-256.');
  const { name, bytes, sha256 } = installer;
  if (typeof name !== 'string' || !ASSET_NAME.test(name) || !/\.exe$/i.test(name)) throw new TypeError(`The installer name ${JSON.stringify(name)} is not a plain file name of a program (.exe).`);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new TypeError('The installer size (bytes) must be a count of bytes of at least 1.');
  if (typeof sha256 !== 'string' || !DIGEST.test(sha256)) throw new TypeError('The installer SHA-256 must be 64 hexadecimal characters.');
  const document = {
    version, companionVersion, commit: commit.toLowerCase(), workflowRun,
    assets: [{ name, sha256: sha256.toLowerCase(), bytes }],
    signedInEdgeVerified: false, authenticodeSigned: false,
  };
  return Buffer.from(`${BOM}${JSON.stringify(document, null, 2).replace(/\n/g, '\r\n')}\r\n`, 'utf8');
}

// ------------------------------------------------------------------------------------------------------------------------------- one byte

/**
 * Opens `file` for reading and writing. A file that was written a moment ago (a download of 220 MB) can be held for a second or two by the virus scanner of the machine, which Windows reports as a sharing
 * violation (EBUSY, EPERM or EACCES); that is waited out, a few times, and anything else is raised at once.
 */
function openForWriting(file, { attempts = 8, waitMs = 500 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return fs.openSync(file, 'r+'); } catch (error) {
      if (attempt >= attempts || !['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

/** Turns every bit of the byte at `offset` of `file`, in place. Calling it twice with the same offset gives the file back; the size never changes. */
export function flipByte(file, offset) {
  const size = fs.statSync(file).size;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) throw new RangeError(`The offset ${offset} is not inside the file (${size} bytes).`);
  const descriptor = openForWriting(file);
  try {
    const byte = Buffer.alloc(1);
    if (fs.readSync(descriptor, byte, 0, 1, offset) !== 1) throw new Error('The byte could not be read.');
    byte[0] ^= 0xff;
    if (fs.writeSync(descriptor, byte, 0, 1, offset) !== 1) throw new Error('The byte could not be written.');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

// ------------------------------------------------------------------------------------------------------------------------------- keys

/** The text of a key list (CHATMCP-HUB/lib/release-keys.json) holding `entries`. */
export function keyListText(entries) {
  return `${JSON.stringify({ version: 1, algorithm: 'ES256', keys: entries }, null, 2)}\n`;
}

/** The entry for the key list that scripts/new-release-key.mjs prints after "Entry for CHATMCP-HUB/lib/release-keys.json". Throws when the output holds none, or one that is not a release key. */
export function entryFromToolOutput(output) {
  const text = String(output ?? '');
  const marker = text.indexOf('Entry for CHATMCP-HUB/lib/release-keys.json');
  const open = marker < 0 ? -1 : text.indexOf('{', marker);
  const close = open < 0 ? -1 : text.indexOf('}', open);
  if (close < 0) throw new Error('The output of the key tool holds no entry for the key list.');
  let entry;
  try { entry = JSON.parse(text.slice(open, close + 1)); } catch { throw new Error('The entry in the output of the key tool is not JSON.'); }
  if (!entry || typeof entry.kid !== 'string' || typeof entry.spki !== 'string' || entry.use !== 'release') throw new Error('The entry in the output of the key tool is not an entry for a release key.');
  return { kid: entry.kid, use: entry.use, spki: entry.spki };
}

/** Runs `node <script> <args>` without a passphrase or a key path from the environment, and resolves {status, stdout, stderr}. */
function runTool(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true, env: { ...process.env, DATGOLD_RELEASE_KEY: '', DATGOLD_RELEASE_KEY_PASSPHRASE: '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/**
 * Two throwaway keys in `directory` (outside every Git work tree: the tool refuses anything else): `run`, the key the builds trust and the manifest is signed with, and `other`, a key that no build
 * trusts, for the signature the shell must refuse. Each is made by scripts/new-release-key.mjs, and each has its own key list file (`listFile`) in the form Build-Installer.ps1 -ReleaseKeysFile takes.
 * Resolves {run: {kid, keyFile, listFile}, other: {...}}. The private key is never printed or logged here.
 */
export async function makeTestKeys(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const made = {};
  for (const name of ['run', 'other']) {
    const keyFile = path.join(directory, `${name}-release.key`);
    const done = await runTool(NEW_KEY_TOOL, [keyFile]);
    if (done.status !== 0) throw new Error(`scripts/new-release-key.mjs refused (exit ${done.status}): ${done.stderr.trim().slice(0, 400)}`);
    const entry = entryFromToolOutput(done.stdout);
    const listFile = path.join(directory, `${name}-release-keys.json`);
    fs.writeFileSync(listFile, keyListText([entry]), 'utf8');
    made[name] = { kid: entry.kid, keyFile, listFile };
  }
  return made;
}

// ------------------------------------------------------------------------------------------------------------------------------- signing

/**
 * Signs the manifest in `manifestFile` (the file as it is to be published) for `tag` with the key in `keyFile`, through scripts/sign-release.mjs: the tool checks that it is the manifest of that tag, that the
 * installer in `installerFile` is the one the manifest lists, and that `keysFile` lists the key, and it verifies the signature before it writes it. Resolves {signatureFile, bytes}; rejects with the tool's
 * own words when it refuses, and then no signature is left.
 */
export async function signWithTool({ tag, keyFile, keysFile, manifestFile, installerFile, outDirectory } = {}) {
  fs.mkdirSync(outDirectory, { recursive: true });
  const done = await runTool(SIGN_TOOL, ['--tag', tag, '--key', keyFile, '--manifest', manifestFile, '--installer', installerFile, '--keys-file', keysFile, '--out', outDirectory]);
  if (done.status !== 0) throw new Error(`scripts/sign-release.mjs refused (exit ${done.status}): ${done.stderr.trim().slice(0, 600)}`);
  const signatureFile = path.join(outDirectory, 'RELEASE-MANIFEST.json.sig');
  return { signatureFile, bytes: fs.readFileSync(signatureFile) };
}
