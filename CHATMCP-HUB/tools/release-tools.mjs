// What the owner needs to sign a release, behind the two command lines scripts/new-release-key.mjs and scripts/sign-release.mjs. It lives in the Hub folder so that the mutation runner and the Hub's
// suites can reach it (tests/verify-release-tools.mjs); it is not shipped, because the installer's payload takes lib/ and not tools/.
//
// The private key is the one secret of the whole updater: whoever has it can make every installed copy download a program of their choosing. So:
//   * a private key is never made, read or written inside a Git work tree (a path that only looks outside it, with .. or through a junction or a link, counts as inside), and an existing file is never
//     overwritten: that would be a key lost;
//   * its file is created empty, restricted to the current user (icacls by SID on Windows, mode 600 elsewhere), and only then written; where the restriction cannot be made or read back, the file is removed;
//   * a private key is never printed, only the public key, its id and the entry for lib/release-keys.json;
//   * a signature is made over the exact bytes of a manifest that is a release manifest of the tag, with a key that lib/release-keys.json lists (the installed apps reject any other), is verified before
//     it is written and is written under the name the release needs;
//   * nothing is uploaded and no program runs but icacls and whoami (by their full path): the command that uploads the signature is made for the owner to read and to run.
import { createPrivateKey, createPublicKey, createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, parseManifest } from '../lib/update-check.mjs';
import { KEY_FILE, SIGNATURE_ASSET, keyIdOf, loadReleaseKeys, signManifest, signatureFileText, verifyManifest } from '../lib/release-signature.mjs';

export const UPLOAD_REPOSITORY = 'pddczpl/ChatMCP';
export const KEY_PATH_VARIABLE = 'DATGOLD_RELEASE_KEY';
export const KEY_PASSPHRASE_VARIABLE = 'DATGOLD_RELEASE_KEY_PASSPHRASE';
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A refusal that is meant to be read: `exitCode` 1 is "no", 2 is "you used it wrongly". */
export class ToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'ToolError';
    this.exitCode = exitCode;
  }
}

// ------------------------------------------------------------------------------------------------------------------------------- where a key may be

const isInside = (root, target) => {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  const normalized = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return !normalized.startsWith('..') && !path.isAbsolute(relative);
};
const realOf = (existing) => { try { return fs.realpathSync.native(existing); } catch { return path.resolve(existing); } };

/**
 * The folder of the Git work tree that holds `target` (the nearest folder above it that has a .git, a folder or the file of a linked work tree), or the one of `extraRoots` that holds it, or null.
 * The deepest part of the path that exists is resolved first (a junction, a link or a short Windows name), so a path that merely looks outside a work tree is found inside it; the part that does
 * not exist yet (a key file about to be made) is added back.
 */
export function enclosingWorkTree(target, { extraRoots = [] } = {}) {
  const absolute = path.resolve(target);
  let existing = absolute;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const real = path.join(realOf(existing), ...tail);
  for (let directory = path.dirname(real); ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
    if (path.dirname(directory) === directory) break;
  }
  for (const root of extraRoots) if (isInside(realOf(root), real)) return root;
  return null;
}

// ------------------------------------------------------------------------------------------------------------------------------- the file of a private key

/** The only place a program is started: `program` is the full path of icacls or whoami, given by the code below, never by a person. */
function runProgram(program, args) {
  const done = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { status: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}

/**
 * Leaves `file` readable by the current user and nobody else. Windows: inheritance removed, the account (by SID, so that a name with odd characters is no problem) granted, and the list read back
 * to hold exactly one entry. Elsewhere: mode 600. Throws a ToolError, and the caller removes the file. `platform` and `run` are for tests.
 */
export function restrictToCurrentUser(file, { platform = process.platform, run = runProgram } = {}) {
  if (platform === 'win32') {
    const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const who = run(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const sid = /"(S-1-[0-9-]+)"/.exec(String(who?.stdout ?? ''))?.[1];
    if (who?.status !== 0 || !sid) throw new ToolError('Could not find out which account runs this, so the key file cannot be restricted to it. Nothing was written.');
    const icacls = path.join(system32, 'icacls.exe');
    for (const args of [[file, '/inheritance:r'], [file, '/grant:r', `*${sid}:F`]]) {
      const done = run(icacls, args);
      if (done?.status !== 0) throw new ToolError(`icacls could not restrict the key file to your account (${String(done?.stderr ?? '').trim().slice(0, 120) || `exit ${done?.status}`}). Nothing was written.`);
    }
    const listing = run(icacls, [file]);
    const entries = (String(listing?.stdout ?? '').match(/:\(/g) ?? []).length;
    if (listing?.status !== 0 || entries === 0) throw new ToolError('Could not read back who may open the key file, so it cannot be restricted with certainty. Nothing was written.');
    if (entries > 1) throw new ToolError(`More than your account may open the key file (${entries} access entries), so it was not used. Nothing was written.`);
    return;
  }
  fs.chmodSync(file, 0o600);
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) throw new ToolError('The key file could not be restricted to your account (mode 600). Nothing was written.');
}

/**
 * Makes a new release key: a P-256 private key in a PKCS#8 PEM file at `file` (encrypted when there is a passphrase) and returns what may be shown: its id, the public key (base64 SPKI) and the
 * entry for lib/release-keys.json. `extraRoots` are folders that count as a work tree even without .git (the one the scripts live in).
 */
export async function createReleaseKey({ file, passphrase = null, platform = process.platform, run = runProgram, extraRoots = [] } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new ToolError('Give the path of the private key file to create.', 2);
  const target = path.resolve(file);
  const parent = path.dirname(target);
  let folder = null;
  try { folder = fs.statSync(parent); } catch { /* reported below */ }
  if (!folder?.isDirectory()) throw new ToolError(`The folder ${parent} does not exist. Create it first, outside the repository; a mistake in the path should not leave a stray folder.`);
  const tree = enclosingWorkTree(target, { extraRoots });
  if (tree) throw new ToolError(`${target} is inside the Git work tree ${tree}. A private key must be kept where it can never be committed; choose a path outside every repository.`);
  let present = true;
  try { fs.lstatSync(target); } catch { present = false; }
  if (present) throw new ToolError(`${target} already exists and is never overwritten (an overwrite would be a key lost). Choose another path.`);

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  let descriptor = null;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
    restrictToCurrentUser(target, { platform, run });
    fs.writeSync(descriptor, pem);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    const readBack = createPrivateKey({ key: fs.readFileSync(target, 'utf8'), format: 'pem', ...(passphrase ? { passphrase } : {}) });
    if (!createPublicKey(readBack).export({ type: 'spki', format: 'der' }).equals(spki)) throw new ToolError('The key file did not read back as the key that was made. It was removed.');
  } catch (error) {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { /* it is being removed anyway */ } }
    fs.rmSync(target, { force: true });
    throw error instanceof ToolError ? error : new ToolError(`The key file could not be written (${error?.code ?? 'error'}). Nothing was left.`);
  }
  const kid = keyIdOf(spki);
  const base64 = spki.toString('base64');
  return { kid, spki: base64, entry: { kid, use: 'release', spki: base64 }, file: target, encrypted: Boolean(passphrase) };
}

/** The private key at `file`, for signing: outside every work tree, a P-256 key, opened with the passphrase when it has one. */
export function loadSigningKey({ file, passphrase = null, extraRoots = [] } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new ToolError(`Give the private key file (--key <path>, or ${KEY_PATH_VARIABLE} in the environment).`, 2);
  const resolved = path.resolve(file);
  const tree = enclosingWorkTree(resolved, { extraRoots });
  if (tree) throw new ToolError(`The private key file ${resolved} is inside the Git work tree ${tree}. A private key is never kept where it can be committed; move it outside every repository first.`);
  let text;
  try { text = fs.readFileSync(resolved, 'utf8'); } catch { throw new ToolError(`The key file ${resolved} could not be read.`); }
  let privateKey;
  try { privateKey = createPrivateKey({ key: text, format: 'pem', ...(passphrase ? { passphrase } : {}) }); } catch {
    if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) {
      throw new ToolError(passphrase ? 'The passphrase does not open the key file.' : `The key file is protected by a passphrase: set ${KEY_PASSPHRASE_VARIABLE} in the environment (never on the command line).`);
    }
    throw new ToolError('The key file is not a private key in PEM form.');
  }
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new ToolError('The key is not an EC P-256 key, the only kind the updater accepts.');
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, kid: keyIdOf(publicKey.export({ type: 'spki', format: 'der' })) };
}

// ------------------------------------------------------------------------------------------------------------------------------- signing

/** The command that uploads the signature, for the owner to read and to run. It is not run here: uploading to a release is an act that is approved each time. */
export function uploadCommand({ tag, signatureFile }) {
  return `gh release upload ${tag} "${signatureFile}" --repo ${UPLOAD_REPOSITORY}`;
}

function standInOrigin(base) {
  let url;
  try { url = new URL(base); } catch { throw new ToolError('The release base must be the address of a stand-in on this machine (a loopback address).', 2); }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) throw new ToolError('The release base must be the address of a stand-in on this machine (a loopback address).', 2);
  return url.origin;
}

/** The manifest of a tag, as GitHub serves it: the bytes, exactly. `releaseBase` is a loopback stand-in for the tests; the default is GitHub. */
async function fetchTagManifest({ tag, releaseBase, fetchImpl }) {
  const origin = releaseBase === null ? 'https://github.com' : standInOrigin(releaseBase);
  let response;
  try { response = await fetchImpl(`${origin}/${UPLOAD_REPOSITORY}/releases/download/${tag}/RELEASE-MANIFEST.json`, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'DatGold-release-tools' } }); } catch {
    throw new ToolError(`The manifest of ${tag} could not be fetched (no answer).`);
  }
  if (response.status !== 200) throw new ToolError(`GitHub answered HTTP ${response.status} for the manifest of ${tag}. Has the Publish workflow finished?`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes;
}

async function digestOfFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { size, sha256: hash.digest('hex') };
}

/**
 * Signs the manifest of `tag`: the file the owner gives (`manifestFile`), or the one published for the tag. Returns where the signature was written, the key, the manifest it read and the command to upload.
 * `installerFile` (optional) is compared with what the manifest lists. `keysFile` is the list of keys the installed apps trust (a test gives its own).
 */
export async function signRelease({
  tag, manifestFile = null, keyFile, passphrase = null, keysFile = KEY_FILE, allowUnlistedKey = false, installerFile = null, out = null, releaseBase = null, fetchImpl = globalThis.fetch, extraRoots = [],
} = {}) {
  if (typeof tag !== 'string' || !TAG.test(tag)) throw new ToolError('The tag must look like v3.11.0 (a release: no suffix).', 2);
  const key = loadSigningKey({ file: keyFile, passphrase, extraRoots });

  let bytes;
  const fetched = !manifestFile;
  if (manifestFile) {
    try { bytes = fs.readFileSync(manifestFile); } catch { throw new ToolError(`The manifest file ${manifestFile} could not be read.`); }
  } else bytes = await fetchTagManifest({ tag, releaseBase, fetchImpl });
  if (bytes.length === 0 || bytes.length > LIMITS.maxBytes) throw new ToolError(`That is not a release manifest: it has ${bytes.length} bytes.`);
  let manifest;
  try { manifest = parseManifest(bytes.toString('utf8')); } catch (error) { throw new ToolError(`That is not a release manifest: ${String(error?.message ?? error).slice(0, 160)}`); }
  if (manifest.version !== tag.slice(1)) throw new ToolError(`The manifest is of version ${manifest.version} but the tag is ${tag}. Sign the manifest of the release you are publishing.`);

  let installerChecked = false;
  if (installerFile) {
    if (!manifest.installerName) throw new ToolError('The manifest does not list exactly one program (.exe), so the installer you gave cannot be compared with it.');
    const listed = manifest.assets.find((asset) => asset.name === manifest.installerName);
    let found;
    try { found = await digestOfFile(installerFile); } catch { throw new ToolError(`The installer file ${installerFile} could not be read.`); }
    if (found.size !== listed.bytes || found.sha256 !== listed.sha256) throw new ToolError(`The installer you gave is not the one the manifest lists (${found.size} bytes, sha256 ${found.sha256}; the manifest says ${listed.bytes} bytes, sha256 ${listed.sha256}). Nothing was signed.`);
    installerChecked = true;
  }

  const trusted = loadReleaseKeys(keysFile).keys;
  if (!trusted.some((entry) => entry.kid === key.kid) && !allowUnlistedKey) {
    throw new ToolError(`The key ${key.kid} is not listed in ${keysFile}, so the installed apps would reject its signature. Put its entry there first (a small pull request), or pass --allow-unlisted-key if that is intended.`);
  }

  let outFile;
  if (out === null) outFile = path.join(os.tmpdir(), `datgold-release-${tag}`, SIGNATURE_ASSET);
  else {
    const resolved = path.resolve(out);
    outFile = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? path.join(resolved, SIGNATURE_ASSET) : resolved;
  }
  if (path.basename(outFile) !== SIGNATURE_ASSET) throw new ToolError(`The signature file must be named ${SIGNATURE_ASSET}: the release file takes the name of the file that is uploaded.`);

  const text = signatureFileText(signManifest(bytes, key.privateKey));
  try { verifyManifest(bytes, Buffer.from(text), [{ kid: key.kid, publicKey: key.publicKey }]); } catch { throw new ToolError('The signature that was made does not verify against the key that made it. Nothing was written.'); }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text);
  if (fetched) fs.writeFileSync(path.join(path.dirname(outFile), 'RELEASE-MANIFEST.json'), bytes);
  return { outFile, kid: key.kid, manifest, installerChecked, listed: trusted.some((entry) => entry.kid === key.kid), fetched, command: uploadCommand({ tag, signatureFile: outFile }) };
}
