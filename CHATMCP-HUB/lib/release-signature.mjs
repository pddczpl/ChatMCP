// The signature on RELEASE-MANIFEST.json: step 2 of the in-app updater. Without it anyone who can write release files on GitHub could make every installed copy download their program through the
// Update button, so the Hub downloads only a release whose manifest carries a signature that one of the keys it ships with has made.
//
// The format is the one the desktop shell (.NET) will check again with its own code, so both sides verify the same file without a conversion:
//   * the algorithm is ECDSA over P-256 with SHA-256 ("ES256"); the signature is the 64 bytes r||s of IEEE P1363 (what `ECDsa.VerifyData` takes by default), not the DER form;
//   * the signature file, a release file named RELEASE-MANIFEST.json.sig, is small JSON: {"alg": "ES256", "kid": "<8 hex>", "sig": "<base64 of the 64 bytes>"};
//   * it is made over the EXACT BYTES of RELEASE-MANIFEST.json as they are published: the signature is checked on the bytes as they arrived and nothing is ever re-serialized, so a BOM, a line ending or
//     a space is part of what was signed (a caller reads the version in the manifest first, to know which signature to ask for, but takes nothing else from it until the signature has checked);
//   * a key is a base64 SPKI; its id (`kid`) is the first 8 hex characters of the SHA-256 of the SPKI bytes. The keys are listed in ONE data file, lib/release-keys.json, which the Hub reads from
//     its own files (lib/ is in the installer's payload) and which the shell can embed. The list has room for the next key, so that a rotation does not need a new installer first. Only an entry
//     that says `use: "release"` is a key: a placeholder (the file ships with one until the owner has made a key) and a test key verify nothing, and scripts/verify-release-source.py refuses to
//     release while either is in the file.
//
// The module is pure: it asks no network, starts no program, writes no file and reads no environment variable. Anything a person controls is data and is checked as data.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ALGORITHM = 'ES256';
/** The name of the release file that holds the signature. */
export const SIGNATURE_ASSET = 'RELEASE-MANIFEST.json.sig';
export const SIGNATURE_LIMITS = Object.freeze({ maxBytes: 4096 });
/** Room in the key file for the current key, the next one and two more. */
export const MAX_KEYS = 4;
export const KEY_FILE = fileURLToPath(new URL('./release-keys.json', import.meta.url));

const SIGNATURE_BYTES = 64;
/** SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING } up to the 0x00 of the BIT STRING, then 0x04 and the 64 bytes of the point: 91 bytes in all. */
const SPKI_HEADER = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const SPKI_BYTES = 91;
const KID = /^[0-9a-f]{8}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class SignatureError extends Error {
  /** `reason` says what was wrong, for a log and for a test; the code is the one the update notice shows for any signature that does not check. */
  constructor(reason, message) {
    super(message);
    this.name = 'SignatureError';
    this.code = 'update_signature_invalid';
    this.reason = reason;
  }
}
const invalid = (reason, message) => new SignatureError(reason, message);

/** The bytes of canonical base64 and nothing else (no white space, no URL alphabet, padding as it is written, no spare bits set); null for anything that is not. */
function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || value.length % 4 !== 0 || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

/** The id of a key: the first 8 hex characters of the SHA-256 of its SPKI bytes (the bytes, not their base64 text). */
export function keyIdOf(spki) {
  if (!Buffer.isBuffer(spki)) throw new TypeError('The key id is made from the SPKI bytes.');
  return createHash('sha256').update(spki).digest('hex').slice(0, 8);
}

/**
 * A public key from its base64 SPKI. Only an EC P-256 key in its canonical (uncompressed, nothing after it) form is accepted, because the key id and the other side's import are made from exactly
 * those bytes. Throws a SignatureError.
 */
export function publicKeyFromSpki(value) {
  const spki = decodeBase64(value);
  if (!spki) throw invalid('key_encoding', 'The key is not canonical base64.');
  let publicKey;
  try { publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' }); } catch { throw invalid('key_der', 'The key is not a public key in SPKI form.'); }
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw invalid('key_type', 'The key is not an EC P-256 key.');
  // OpenSSL remembers the form a point was read in (a compressed point is exported compressed again), so the form is checked on the bytes: 91 bytes, the fixed header and an uncompressed point
  if (spki.length !== SPKI_BYTES || !spki.subarray(0, SPKI_HEADER.length).equals(SPKI_HEADER) || spki[SPKI_HEADER.length] !== 0x04) throw invalid('key_der', 'The key is not in the canonical SPKI form (91 bytes, an uncompressed point).');
  return { kid: keyIdOf(spki), spki, publicKey };
}

/**
 * The keys of the key file's text. Never throws: what is wrong with the file or with an entry is in `ignored` ({index, kid, reason}; index -1 is the file) and costs that entry and nothing else.
 * `keys` holds the entries that say `use: "release"` and are valid, once each, at most MAX_KEYS, in the order of the file; `placeholders` counts the entries that say they are a placeholder.
 */
export function parseReleaseKeys(text) {
  const result = { keys: [], ignored: [], placeholders: 0 };
  const skip = (index, reason, entry = null) => result.ignored.push({ index, kid: typeof entry?.kid === 'string' ? entry.kid : null, reason });
  let document;
  try { document = JSON.parse((typeof text === 'string' ? text : '').replace(/^﻿/, '')); } catch { skip(-1, 'not_json'); return result; }
  if (!document || typeof document !== 'object' || Array.isArray(document)) { skip(-1, 'shape'); return result; }
  if (document.version !== 1) { skip(-1, 'version'); return result; }
  if (document.algorithm !== undefined && document.algorithm !== ALGORITHM) { skip(-1, 'algorithm'); return result; }
  if (!Array.isArray(document.keys)) { skip(-1, 'shape'); return result; }
  const seen = new Set();
  document.keys.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { skip(index, 'entry'); return; }
    if (entry.use === 'placeholder') { result.placeholders += 1; return; }
    if (entry.use !== 'release') { skip(index, 'use', entry); return; }
    if (result.keys.length >= MAX_KEYS) { skip(index, 'too_many', entry); return; }
    let key;
    try { key = publicKeyFromSpki(entry.spki); } catch (error) { skip(index, error.reason ?? 'key_der', entry); return; }
    if (entry.kid !== key.kid) { skip(index, 'kid_mismatch', entry); return; }
    if (seen.has(key.kid)) { skip(index, 'duplicate', entry); return; }
    seen.add(key.kid);
    result.keys.push({ kid: key.kid, spki: key.spki, publicKey: key.publicKey, use: 'release' });
  });
  return result;
}

/** The keys of the key file (lib/release-keys.json, or another file for a test). A file that cannot be read gives no key and the reason `unreadable`. */
export function loadReleaseKeys(file = KEY_FILE) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { keys: [], ignored: [{ index: -1, kid: null, reason: 'unreadable' }], placeholders: 0 }; }
  return parseReleaseKeys(text);
}

/**
 * The signature file, read strictly: UTF-8 (a BOM is dropped), at most SIGNATURE_LIMITS.maxBytes, JSON with `alg` "ES256", a `kid` of 8 lower-case hex characters and a `sig` that is canonical base64
 * of exactly 64 bytes. Keys it does not know are ignored. Throws a SignatureError with a reason.
 */
export function parseSignature(bytes) {
  if (!Buffer.isBuffer(bytes)) throw invalid('type', 'The signature file is read as bytes.');
  if (bytes.length === 0) throw invalid('empty', 'The signature file is empty.');
  if (bytes.length > SIGNATURE_LIMITS.maxBytes) throw invalid('size', `The signature file is larger than ${SIGNATURE_LIMITS.maxBytes} bytes.`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('encoding', 'The signature file is not UTF-8.'); }
  let document;
  try { document = JSON.parse(text); } catch { throw invalid('json', 'The signature file is not JSON.'); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw invalid('shape', 'The signature file is not a JSON object.');
  if (document.alg !== ALGORITHM) throw invalid('alg', `The signature file does not say ${ALGORITHM}.`);
  if (typeof document.kid !== 'string' || !KID.test(document.kid)) throw invalid('kid', 'The key id of the signature file is not 8 lower-case hexadecimal characters.');
  const signature = decodeBase64(document.sig);
  if (!signature) throw invalid('sig_encoding', 'The signature is not canonical base64.');
  if (signature.length !== SIGNATURE_BYTES) throw invalid('sig_length', `The signature is ${signature.length} bytes, not ${SIGNATURE_BYTES} (r||s); a DER signature is not accepted.`);
  return { alg: ALGORITHM, kid: document.kid, sig: signature };
}

/**
 * Checks that `signatureBytes` (the text of RELEASE-MANIFEST.json.sig) is a signature of exactly `manifestBytes` by one of `keys` (the entries parseReleaseKeys returns).
 * Returns {kid, alg}; throws a SignatureError with the reason (`unknown_kid` when no key has the id the file names, `mismatch` when the signature is not this manifest's, a reason of
 * parseSignature when the file is wrong).
 */
export function verifyManifest(manifestBytes, signatureBytes, keys) {
  if (!(manifestBytes instanceof Uint8Array)) throw invalid('manifest', 'The manifest is verified as bytes.');
  const document = parseSignature(signatureBytes);
  const key = (Array.isArray(keys) ? keys : []).find((candidate) => candidate?.kid === document.kid);
  if (!key) throw invalid('unknown_kid', 'No key that this version trusts has the id the signature names.');
  let good = false;
  try { good = verify('sha256', manifestBytes, { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, document.sig); } catch { good = false; }
  if (!good) throw invalid('mismatch', 'The signature is not the one of this manifest.');
  return { kid: document.kid, alg: ALGORITHM };
}

/** What the owner's script writes: {alg, kid, sig} for exactly these bytes, made with an EC P-256 private key (a KeyObject). */
export function signManifest(manifestBytes, privateKey) {
  if (!(manifestBytes instanceof Uint8Array)) throw invalid('manifest', 'The manifest is signed as bytes.');
  if (!privateKey || typeof privateKey !== 'object' || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw invalid('key_type', 'Only an EC P-256 private key signs.');
  }
  const kid = keyIdOf(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
  const signature = sign('sha256', manifestBytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return { alg: ALGORITHM, kid, sig: signature.toString('base64') };
}

/** The text of the signature file for a document made by signManifest. */
export function signatureFileText(document) {
  return `${JSON.stringify({ alg: document.alg, kid: document.kid, sig: document.sig }, null, 2)}\n`;
}
