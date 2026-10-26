// The signature on RELEASE-MANIFEST.json (lib/release-signature.mjs), step 2 of the in-app updater: ECDSA P-256 with SHA-256, the signature in IEEE P1363 form (r||s, 64 bytes), the keys
// as base64 SPKI in ONE data file (lib/release-keys.json) that the Hub reads and that the desktop shell will embed.
//
// What this suite holds the module to, with throwaway keys made when it runs (tests/support/release-keys.mjs signs with plain node:crypto, never with the module under test):
//   1. the key file that ships: only a placeholder or release keys, never a test key; nothing in it is malformed;
//   2. the key list: a key is trusted only when it is an EC P-256 key in its canonical SPKI form whose `kid` is the first 8 hex characters of the SHA-256 of that SPKI, and only entries
//      that say `use: "release"` count (a placeholder or a test key verifies nothing);
//   3. the signature file: 14 kinds of wrong shape, each refused with its own reason (a DER signature is not 64 bytes; a signature that is not canonical base64 is not a signature);
//   4. the check: a valid signature, one byte of the manifest changed, a wrong key, an unknown kid, a signature of another release, the bytes exactly as published (a BOM, CRLF, a
//      re-serialized document), the next key of a rotation;
//   5. what the module is not: it asks no network, starts no program and writes no file.
// A cross-check with .NET (ECDsa.VerifyData over the same bytes) was done by hand, not here (docs/THREAT-MODEL.md, Surface 8).
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALGORITHM, KEY_FILE, MAX_KEYS, SIGNATURE_ASSET, SIGNATURE_LIMITS, SignatureError,
  keyIdOf, loadReleaseKeys, parseReleaseKeys, parseSignature, publicKeyFromSpki, signManifest, signatureFileText, verifyManifest,
} from '../lib/release-signature.mjs';
import { keyFileText, letteredKey, rawSignature, signatureFor, throwawayKey } from './support/release-keys.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs `action`; fails unless it throws a SignatureError with this reason. */
function refuses(action, reason, label) {
  let error = null;
  try { action(); } catch (caught) { error = caught; }
  assert.ok(error, `${label}: it must be refused`);
  assert.ok(error instanceof SignatureError, `${label}: a SignatureError, not ${error?.constructor?.name}: ${error?.message}`);
  assert.equal(error.code, 'update_signature_invalid', label);
  assert.equal(error.reason, reason, `${label}: ${error.reason}`);
  return error;
}

const manifestText = (version = '3.11.0') => `${JSON.stringify({ version, commit: '0123456789abcdef0123456789abcdef01234567', assets: [{ name: 'DatGoldSetup.exe', sha256: 'b'.repeat(64), bytes: 232753314 }] }, null, 2)}\r\n`;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ------------------------------------------------------------------------------------------------------------------------------- 1. the key file that ships
{
  assert.equal(ALGORITHM, 'ES256');
  assert.equal(SIGNATURE_ASSET, 'RELEASE-MANIFEST.json.sig');
  assert.equal(SIGNATURE_LIMITS.maxBytes, 4096);
  assert.equal(MAX_KEYS, 4, 'room for the current key, the next one and two more');
  assert.ok(path.isAbsolute(KEY_FILE) && KEY_FILE.endsWith(path.join('lib', 'release-keys.json')), 'one data file, in lib/, which the installer ships (lib/ is in the payload)');
  const text = fs.readFileSync(KEY_FILE, 'utf8').replace(/^﻿/, '');
  const document = JSON.parse(text);
  assert.equal(document.version, 1);
  assert.equal(document.algorithm, ALGORITHM);
  assert.ok(Array.isArray(document.keys) && document.keys.length >= 1 && document.keys.length <= MAX_KEYS, 'at least one entry and no more than the room there is');
  for (const entry of document.keys) {
    assert.ok(['placeholder', 'release'].includes(entry.use), `a shipped entry is a placeholder or a release key, never a test key: ${JSON.stringify(entry.use)}`);
    if (entry.use === 'placeholder') assert.equal(entry.spki, null, 'a placeholder holds no key');
  }
  const loaded = loadReleaseKeys();
  assert.deepEqual(loaded.ignored, [], 'nothing in the shipped file is malformed');
  assert.equal(loaded.keys.length, document.keys.filter((entry) => entry.use === 'release').length, 'every release entry is a usable key and a placeholder is not');
  assert.equal(loaded.placeholders, document.keys.filter((entry) => entry.use === 'placeholder').length);
  for (const key of loaded.keys) assert.equal(key.kid, keyIdOf(key.spki), 'the kid of every shipped key is the one its SPKI gives');
  const unreadable = loadReleaseKeys(path.join(os.tmpdir(), 'chatmcp-no-such-key-file.json'));
  assert.deepEqual([unreadable.keys, unreadable.placeholders, unreadable.ignored.map((entry) => entry.reason)], [[], 0, ['unreadable']], 'a file that is not there is no key, not a crash');
  ok(`the key file that ships (${document.keys.length} entr${document.keys.length === 1 ? 'y' : 'ies'}: ${document.keys.map((entry) => entry.use).join(', ')}) is well formed and holds no test key; a placeholder is counted and trusted for nothing; a missing file gives no keys`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 2. the key id
{
  const key = throwawayKey();
  assert.match(keyIdOf(key.spki), /^[0-9a-f]{8}$/);
  assert.equal(keyIdOf(key.spki), createHash('sha256').update(key.spki).digest('hex').slice(0, 8), 'the first 8 hex characters of the SHA-256 of the SPKI bytes');
  assert.notEqual(keyIdOf(key.spki), createHash('sha256').update(key.spkiBase64).digest('hex').slice(0, 8), 'of the bytes, not of their base64 text');
  assert.notEqual(keyIdOf(key.spki), keyIdOf(throwawayKey().spki), 'two keys have two ids');
  assert.throws(() => keyIdOf('text'), TypeError);
  ok('keyIdOf is the first 8 hex characters of the SHA-256 of the SPKI bytes (not of their base64 text)');
}

// ------------------------------------------------------------------------------------------------------------------------------- 3. the key list
{
  const key = throwawayKey();
  const parsed = publicKeyFromSpki(key.spkiBase64);
  assert.equal(parsed.kid, key.kid);
  assert.ok(parsed.spki.equals(key.spki));
  assert.equal(parsed.publicKey.asymmetricKeyType, 'ec');
  assert.equal(parsed.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');

  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const koblitz = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const edwards = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  // the same point in compressed form: an SPKI that is not the canonical one the .NET side and the key id are made from
  const compressed = Buffer.concat([Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'), Buffer.from([key.spki[key.spki.length - 1] % 2 ? 3 : 2]), key.spki.subarray(27, 59)]).toString('base64');
  const bad = {
    'a curve of another size (P-384)': [wrongCurve, 'key_type'], 'secp256k1': [koblitz, 'key_type'], 'an RSA key': [rsa, 'key_type'], 'an Ed25519 key': [edwards, 'key_type'],
    'a key with a byte after the SPKI': [Buffer.concat([key.spki, Buffer.from([0])]).toString('base64'), 'key_der'], 'a truncated SPKI': [key.spki.subarray(0, 60).toString('base64'), 'key_der'],
    'the point in compressed form': [compressed, 'key_der'], 'random bytes': [Buffer.alloc(91, 7).toString('base64'), 'key_der'],
    'text that is not base64': ['not base64!', 'key_encoding'], 'base64 with a line break': [`${key.spkiBase64.slice(0, 40)}\n${key.spkiBase64.slice(40)}`, 'key_encoding'],
    'base64 without its padding': [key.spkiBase64.replace(/=+$/, ''), 'key_encoding'], 'an empty string': ['', 'key_encoding'], 'null': [null, 'key_encoding'], 'a number': [5, 'key_encoding'],
  };
  for (const [label, [value, reason]] of Object.entries(bad)) refuses(() => publicKeyFromSpki(value), reason, `a key that is ${label}`);

  const second = throwawayKey();
  const file = keyFileText([key.entry, second.entry, { kid: '00000000', use: 'placeholder', spki: null }]);
  const both = parseReleaseKeys(file);
  assert.deepEqual(both.keys.map((entry) => entry.kid), [key.kid, second.kid], 'the current key and the next one, in the order of the file');
  assert.equal(both.placeholders, 1);
  assert.deepEqual(both.ignored, []);
  assert.equal(parseReleaseKeys(`﻿${file}`).keys.length, 2, 'a BOM in front of the file is dropped');

  const reasonsOf = (text) => parseReleaseKeys(text).ignored.map((entry) => entry.reason);
  assert.deepEqual(reasonsOf(keyFileText([{ ...key.entry, kid: key.kid === '12345678' ? '87654321' : '12345678' }])), ['kid_mismatch'], 'a kid that is not the one of the SPKI is not trusted: a signature could not be matched to the key it names');
  const lettered = letteredKey();
  assert.deepEqual(reasonsOf(keyFileText([{ ...lettered.entry, kid: lettered.kid.toUpperCase() }])), ['kid_mismatch'], 'and the kid is lower case');
  assert.deepEqual(reasonsOf(keyFileText([{ ...key.entry, use: 'test' }])), ['use'], 'a test key is not a release key');
  assert.deepEqual(reasonsOf(keyFileText([{ ...key.entry, use: 'Release' }])), ['use']);
  assert.deepEqual(reasonsOf(keyFileText([{ ...key.entry, use: undefined }])), ['use'], 'no use is no key');
  assert.deepEqual(reasonsOf(keyFileText([{ kid: key.kid, use: 'release', spki: wrongCurve }])), ['key_type']);
  assert.deepEqual(reasonsOf(keyFileText([{ kid: key.kid, use: 'release', spki: null }])), ['key_encoding'], 'a release entry without a key');
  assert.deepEqual(reasonsOf(keyFileText([key.entry, key.entry])), ['duplicate'], 'one kid is one key');
  assert.deepEqual(reasonsOf(keyFileText([5, null, 'x', []])), ['entry', 'entry', 'entry', 'entry'], 'an entry that is not an object');
  const crowd = Array.from({ length: MAX_KEYS + 1 }, () => throwawayKey().entry);
  const crowded = parseReleaseKeys(keyFileText(crowd));
  assert.equal(crowded.keys.length, MAX_KEYS, 'no more keys than there is room for');
  assert.deepEqual(crowded.ignored.map((entry) => entry.reason), ['too_many']);
  for (const [label, text, reason] of [
    ['not JSON', '{ nope', 'not_json'], ['an empty file', '', 'not_json'], ['an array', '[]', 'shape'], ['null', 'null', 'shape'], ['a version of the future', JSON.stringify({ version: 2, keys: [key.entry] }), 'version'],
    ['no list of keys', JSON.stringify({ version: 1 }), 'shape'], ['keys that are not a list', JSON.stringify({ version: 1, keys: key.entry }), 'shape'], ['another algorithm', JSON.stringify({ version: 1, algorithm: 'RS256', keys: [key.entry] }), 'algorithm'],
  ]) {
    const result = parseReleaseKeys(text);
    assert.deepEqual([result.keys.length, result.ignored.map((entry) => entry.reason)], [0, [reason]], `${label}: no key, and the reason`);
  }
  assert.deepEqual(parseReleaseKeys(null).keys, [], 'text is what is read');
  ok(`the key list: a key is trusted only as an EC P-256 key in its canonical SPKI form (${Object.keys(bad).length} kinds of wrong key refused with a reason) whose kid is the one its SPKI gives, only with use "release", once, at most ${MAX_KEYS}; a placeholder is counted and a test key is not trusted; a damaged file gives no key and a reason`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 4. the signature file
{
  const key = throwawayKey();
  const manifest = Buffer.from(manifestText());
  const good = signatureFor(manifest, key);
  const parsed = parseSignature(good);
  assert.deepEqual([parsed.alg, parsed.kid, parsed.sig.length], ['ES256', key.kid, 64]);
  assert.ok(parsed.sig.equals(Buffer.from(JSON.parse(good.toString()).sig, 'base64')));
  assert.equal(parseSignature(Buffer.concat([BOM, good])).kid, key.kid, 'a BOM in front of the file is dropped (Windows PowerShell writes one)');
  assert.equal(parseSignature(signatureFor(manifest, key, { extra: { note: 'a later release may add a key', signedAt: 5 } })).kid, key.kid, 'keys it does not know are ignored');
  assert.equal(parseSignature(Buffer.from(`  \r\n${good.toString().replace(/\n/g, '\r\n')}\r\n\r\n`)).kid, key.kid, 'white space around the document');

  const raw = rawSignature(manifest, key);
  const text = raw.toString('base64');
  const der = sign('sha256', manifest, { key: key.privateKey, dsaEncoding: 'der' });
  assert.ok(der.length >= 68 && der.length <= 72 && der[0] === 0x30, 'a DER signature is 70-72 bytes starting with 0x30');
  // a character of the base64 alphabet that decodes to the same bytes but is not the canonical text of them
  const sameBytes = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c) => `${text.slice(0, 85)}${c}==`).find((candidate) => candidate !== text && Buffer.from(candidate, 'base64').equals(raw));
  assert.ok(sameBytes, 'the fixture needs a non-canonical spelling of the same 64 bytes');
  const wrong = {
    'an empty file': [Buffer.alloc(0), 'empty'], 'a file over the limit': [Buffer.from(` ${' '.repeat(SIGNATURE_LIMITS.maxBytes)}${good}`), 'size'], 'exactly the limit of spaces and nothing else': [Buffer.alloc(SIGNATURE_LIMITS.maxBytes, 0x20), 'json'],
    'bytes that are not UTF-8': [Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), 'encoding'], 'text that is not JSON': [Buffer.from('not json'), 'json'], 'JSON that is a list': [Buffer.from('[]'), 'shape'], 'JSON that is null': [Buffer.from('null'), 'shape'],
    'no alg': [signatureFor(manifest, key, { omit: ['alg'] }), 'alg'], 'ES384': [signatureFor(manifest, key, { alg: 'ES384' }), 'alg'], 'es256 in lower case': [signatureFor(manifest, key, { alg: 'es256' }), 'alg'], 'none': [signatureFor(manifest, key, { alg: 'none' }), 'alg'],
    'a kid in upper case': [signatureFor(manifest, key, { kid: key.kid.toUpperCase().replace(/[0-9]/g, 'A') }), 'kid'], 'a kid of 7 characters': [signatureFor(manifest, key, { kid: key.kid.slice(1) }), 'kid'], 'a kid of 9 characters': [signatureFor(manifest, key, { kid: `${key.kid}0` }), 'kid'],
    'a kid that is not hex': [signatureFor(manifest, key, { kid: 'zzzzzzzz' }), 'kid'], 'no kid': [signatureFor(manifest, key, { omit: ['kid'] }), 'kid'], 'no signature': [signatureFor(manifest, key, { omit: ['sig'] }), 'sig_encoding'],
    'a signature that is not text': [signatureFor(manifest, key, { sig: 5 }), 'sig_encoding'], 'a signature in base64url': [signatureFor(manifest, key, { sig: `${text.slice(0, 40)}-_${text.slice(42)}` }), 'sig_encoding'],
    'a signature with a space inside': [signatureFor(manifest, key, { sig: `${text.slice(0, 40)} ${text.slice(40)}` }), 'sig_encoding'], 'a signature without its padding': [signatureFor(manifest, key, { sig: text.replace(/=+$/, '') }), 'sig_encoding'],
    'a signature spelled in a non-canonical way': [signatureFor(manifest, key, { sig: sameBytes }), 'sig_encoding'], 'a signature that is empty': [signatureFor(manifest, key, { sig: '' }), 'sig_encoding'],
    'a DER signature instead of r||s': [signatureFor(manifest, key, { sig: der.toString('base64') }), 'sig_length'], 'r||s with a byte missing': [signatureFor(manifest, key, { sig: raw.subarray(0, 63).toString('base64') }), 'sig_length'],
    'r||s with a byte too many': [signatureFor(manifest, key, { sig: Buffer.concat([raw, Buffer.from([0])]).toString('base64') }), 'sig_length'],
  };
  for (const [label, [bytes, reason]] of Object.entries(wrong)) refuses(() => parseSignature(bytes), reason, `a signature file that is ${label}`);
  refuses(() => parseSignature(good.toString()), 'type', 'text instead of bytes');
  refuses(() => parseSignature(null), 'type', 'nothing');
  ok(`the signature file: ${Object.keys(wrong).length} kinds of wrong shape are each refused with their own reason (empty, over ${SIGNATURE_LIMITS.maxBytes} bytes, not UTF-8, not JSON, another algorithm, a bad kid, a signature that is not canonical base64, a DER signature or any length but 64 bytes); a BOM, white space and keys it does not know are fine`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 5. the check
{
  const key = throwawayKey();
  const other = throwawayKey();
  const keys = [publicKeyFromSpki(key.spkiBase64)];
  const manifest = Buffer.from(manifestText('3.11.0'));
  const signature = signatureFor(manifest, key);
  assert.deepEqual(verifyManifest(manifest, signature, keys), { kid: key.kid, alg: 'ES256' }, 'a valid signature names the key that made it');

  const changed = Buffer.from(manifest);
  changed[changed.length - 5] ^= 0x01;
  refuses(() => verifyManifest(changed, signature, keys), 'mismatch', 'one bit of the manifest changed');
  refuses(() => verifyManifest(manifest.subarray(0, manifest.length - 1), signature, keys), 'mismatch', 'one byte of the manifest missing');
  refuses(() => verifyManifest(Buffer.concat([manifest, Buffer.from(' ')]), signature, keys), 'mismatch', 'one byte more');
  refuses(() => verifyManifest(Buffer.from(manifestText('3.11.1')), signature, keys), 'mismatch', 'a signature of another release');
  const flipped = Buffer.from(rawSignature(manifest, key));
  flipped[10] ^= 0x01;
  refuses(() => verifyManifest(manifest, signatureFor(manifest, key, { sig: flipped.toString('base64') }), keys), 'mismatch', 'one bit of the signature changed');
  refuses(() => verifyManifest(manifest, signatureFor(manifest, other), keys), 'unknown_kid', 'a key that is not in the list');
  refuses(() => verifyManifest(manifest, signatureFor(manifest, other, { kid: key.kid }), keys), 'mismatch', 'a key that is not the one the kid names (the kid is only a label)');
  refuses(() => verifyManifest(manifest, signatureFor(manifest, key, { kid: '00000000' }), keys), 'unknown_kid', 'a kid that no key has');
  refuses(() => verifyManifest(manifest, signatureFor(manifest, key), []), 'unknown_kid', 'no key at all: the placeholder trusts nothing');
  refuses(() => verifyManifest(manifest, signatureFor(manifest, key, { sig: sign('sha256', manifest, { key: key.privateKey, dsaEncoding: 'der' }).toString('base64') }), keys), 'sig_length', 'the same signature in DER form');
  refuses(() => verifyManifest(manifest, Buffer.alloc(0), keys), 'empty', 'an empty signature file');
  refuses(() => verifyManifest(manifest.toString(), signature, keys), 'manifest', 'text instead of the bytes');
  refuses(() => verifyManifest(null, signature, keys), 'manifest', 'no manifest');

  // the exact bytes as published: a BOM, line endings and a different spelling of the same document are different documents
  const withBom = Buffer.concat([BOM, manifest]);
  const bomSignature = signatureFor(withBom, key);
  assert.deepEqual(verifyManifest(withBom, bomSignature, keys), { kid: key.kid, alg: 'ES256' }, 'a manifest published with a BOM is signed with its BOM');
  refuses(() => verifyManifest(withBom, signature, keys), 'mismatch', 'a manifest with a BOM against the signature of the one without');
  refuses(() => verifyManifest(manifest, bomSignature, keys), 'mismatch', 'and the other way round');
  refuses(() => verifyManifest(Buffer.from(manifest.toString().replace(/\r\n/g, '\n')), signature, keys), 'mismatch', 'the same text with LF instead of CRLF');
  refuses(() => verifyManifest(Buffer.from(JSON.stringify(JSON.parse(manifest.toString()))), signature, keys), 'mismatch', 'the same document re-serialized: nothing is ever re-serialized');
  refuses(() => verifyManifest(Buffer.alloc(0), signature, keys), 'mismatch', 'an empty manifest');

  // a rotation: the next key is in the list from the start, so a release signed with it verifies without a new installer
  const next = throwawayKey();
  const rotated = [publicKeyFromSpki(key.spkiBase64), publicKeyFromSpki(next.spkiBase64)];
  assert.equal(verifyManifest(manifest, signatureFor(manifest, next), rotated).kid, next.kid, 'a release signed with the next key verifies');
  assert.equal(verifyManifest(manifest, signature, rotated).kid, key.kid, 'and one signed with the current key still does');
  refuses(() => verifyManifest(manifest, signatureFor(manifest, next), keys), 'unknown_kid', 'while the list has only the current key, the next key is unknown');
  // a placeholder, a test key and a malformed entry are never in the list the Hub verifies with
  const fromFile = parseReleaseKeys(keyFileText([{ kid: '00000000', use: 'placeholder', spki: null }, { ...other.entry, use: 'test' }])).keys;
  refuses(() => verifyManifest(manifest, signatureFor(manifest, other), fromFile), 'unknown_kid', 'a key marked as a test key is not trusted');
  ok('verifyManifest accepts a valid signature and names its key; it refuses one changed byte of the manifest or of the signature, a missing or extra byte, another release, a wrong or unknown key, a DER signature, an empty file, and the manifest that is not exactly the signed bytes (a BOM, LF for CRLF, a re-serialized document); the next key of a rotation verifies');
}

// ------------------------------------------------------------------------------------------------------------------------------- 6. making a signature (what the owner's script uses)
{
  const key = throwawayKey();
  const manifest = Buffer.from(manifestText('3.11.0'));
  const document = signManifest(manifest, key.privateKey);
  assert.deepEqual(Object.keys(document), ['alg', 'kid', 'sig'], 'the file holds the algorithm, the key id and the signature, in that order');
  assert.deepEqual([document.alg, document.kid], ['ES256', key.kid]);
  assert.equal(Buffer.from(document.sig, 'base64').length, 64);
  const text = signatureFileText(document);
  assert.ok(text.endsWith('}\n') && JSON.parse(text).sig === document.sig);
  assert.deepEqual(verifyManifest(manifest, Buffer.from(text), [publicKeyFromSpki(key.spkiBase64)]), { kid: key.kid, alg: 'ES256' }, 'what it makes verifies with the module');
  assert.equal(sign('sha256', manifest, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).length, 64);
  // and with plain node:crypto, which does what .NET's ECDsa.VerifyData does with the same bytes
  assert.equal(verify('sha256', manifest, { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(document.sig, 'base64')), true, 'and plain node:crypto agrees');
  assert.throws(() => signManifest(manifest, generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey), SignatureError, 'only a P-256 key signs');
  assert.throws(() => signManifest(manifest, generateKeyPairSync('ed25519').privateKey), SignatureError, 'an Ed25519 key does not');
  assert.throws(() => signManifest(manifest.toString(), key.privateKey), SignatureError, 'the bytes are signed, not text');
  assert.throws(() => signManifest(manifest, 'a pem as text'), SignatureError, 'a key object is needed');
  ok('signManifest makes {alg, kid, sig} over exactly the bytes it is given (P-256 keys only), and what it makes verifies with the module and with plain node:crypto');
}

// ------------------------------------------------------------------------------------------------------------------------------- 7. what the module is not
{
  const source = fs.readFileSync(path.join(HUB_ROOT, 'lib', 'release-signature.mjs'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/node:https?|node:net|child_process|\bfetch\(|writeFile|createWriteStream|appendFile|process\.env/.test(code), 'it asks no network, starts no program, writes no file and reads no environment variable');
  const imports = [...code.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ['node:crypto', 'node:fs', 'node:url'], 'and imports nothing but crypto, fs (to read the key file) and url');
  ok('the module asks no network, starts no program, writes no file and reads no environment variable; it imports only node:crypto, node:fs and node:url');
}

console.log(`PASS: ${checks} release-signature groups`);
