// Makes tests/fixtures/release-verify-vectors.json: the cases that the Hub (lib/release-signature.mjs, lib/update-check.mjs, lib/update-download.mjs) and the desktop shell
// (native-shared/UpdatePackage.cs, run by scripts/tests/native-lifecycle) must read the same way. The Hub checks a release and the shell checks it AGAIN with its own code, so a manifest, a
// signature or a key list that one side takes and the other refuses is a defect: the Hub would call an update ready that the shell then refuses, or (worse) the other way round.
//
// Every case is built by construction and carries the outcome it is built for (`expect`): a bit that was flipped is a refusal, a signature the key made is valid. Nothing here asks the Hub's code
// what the outcome is, so the file cannot agree with the Hub by being made from it. tests/verify-release-vectors.mjs runs every case through the Hub's code, and the native tests run the
// same file through the shell's. The keys are made for the run and thrown away with the process: no private key is written anywhere.
//
// Regenerating is optional and gives a new file (new keys, new signatures); the cases themselves are written down here. Run: node tests/support/make-release-vectors.mjs
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Nothing of the Hub's code is used to make the cases: the id of a key and the signature are made with plain node:crypto, so the file cannot agree with the Hub by being made from it.
const keyIdOf = (spki) => createHash('sha256').update(spki).digest('hex').slice(0, 8);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'fixtures', 'release-verify-vectors.json');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ------------------------------------------------------------------------------------------------------------------------------- keys
function newKey(curve = 'prime256v1') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, spki, kid: keyIdOf(spki) };
}
const entry = (key, extra = {}) => ({ kid: key.kid, use: 'release', spki: b64(key.spki), ...extra });
const keyList = (entries, over = {}) => `${JSON.stringify({ version: 1, algorithm: 'ES256', about: 'keys made for the test vectors', keys: entries, ...over }, null, 2)}\n`;
const withLetter = () => { for (;;) { const key = newKey(); if (/[a-f]/.test(key.kid)) return key; } };
const A = withLetter();
const [B, C, D, E] = Array.from({ length: 4 }, () => newKey());
// the same point as A in other forms: compressed (59 bytes) and off the curve (91 bytes), each with the id that its own bytes give
const HEADER = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const x = A.spki.subarray(HEADER.length + 1, HEADER.length + 33);
const y = A.spki.subarray(HEADER.length + 33);
const COMPRESSED_HEADER = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d03010703220002', 'hex');
const compressedSpki = Buffer.concat([COMPRESSED_HEADER, x]);
compressedSpki[COMPRESSED_HEADER.length - 1] = (y[31] & 1) ? 0x03 : 0x02;
const offCurveSpki = Buffer.from(A.spki);
offCurveSpki[offCurveSpki.length - 1] ^= 1;
const odd = (spki) => ({ kid: keyIdOf(spki), use: 'release', spki: b64(spki) });
const p384 = (() => { const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }); return publicKey.export({ type: 'spki', format: 'der' }); })();
const rsa = (() => { const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }); return publicKey.export({ type: 'spki', format: 'der' }); })();

// ------------------------------------------------------------------------------------------------------------------------------- manifests
const manifestObject = (over = {}) => ({
  version: '3.11.0', commit: '0123456789abcdef0123456789abcdef01234567',
  assets: [{ name: 'DatGoldSetup.exe', bytes: 232753314, sha256: 'a'.repeat(64) }, { name: 'DatGold-Browser-Companion.zip', bytes: 1024, sha256: 'b'.repeat(64) }], ...over,
});
const lf = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const crlf = (value) => Buffer.from(`${JSON.stringify(value, null, 2).replace(/\n/g, '\r\n')}\r\n`);
const MANIFEST = lf(manifestObject());

// ------------------------------------------------------------------------------------------------------------------------------- signatures
const signedBy = (key, bytes) => ({ alg: 'ES256', kid: key.kid, sig: sign('sha256', bytes, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') });
const fileOf = (document) => Buffer.from(`${JSON.stringify({ alg: document.alg, kid: document.kid, sig: document.sig }, null, 2)}\n`);
const signatureFile = (key, bytes) => fileOf(signedBy(key, bytes));
const flip = (bytes, index, bit = 0) => { const copy = Buffer.from(bytes); copy[index] ^= 1 << bit; return copy; };
const LIST_A = keyList([entry(A)]);
const signatureCases = [];
const sig = (name, note, keys, manifest, signature, expect) => signatureCases.push({ name, note, keys, manifest: b64(manifest), signature: b64(signature), expect });
const valid = (key) => ({ valid: true, kid: key.kid });
const refused = { valid: false };

sig('valid', 'one key, LF manifest, the signature file the owner tool writes', LIST_A, MANIFEST, signatureFile(A, MANIFEST), valid(A));
const CRLF = crlf(manifestObject());
sig('valid-crlf', 'the manifest as Windows PowerShell writes it (CRLF), signed as it is', LIST_A, CRLF, signatureFile(A, CRLF), valid(A));
const WITH_BOM = Buffer.concat([BOM, MANIFEST]);
sig('valid-bom', 'a UTF-8 byte order mark is part of what was signed', LIST_A, WITH_BOM, signatureFile(A, WITH_BOM), valid(A));
sig('lf-signed-crlf-shown', 'signed with LF, presented with CRLF', LIST_A, CRLF, signatureFile(A, MANIFEST), refused);
sig('bom-removed', 'signed with the BOM, presented without it', LIST_A, MANIFEST, signatureFile(A, WITH_BOM), refused);
sig('reserialized', 'the same data, compact JSON, under the signature of the pretty one', LIST_A, Buffer.from(JSON.stringify(manifestObject())), signatureFile(A, MANIFEST), refused);
for (const [label, index] of [['first', 0], ['middle', Math.floor(MANIFEST.length / 2)], ['last', MANIFEST.length - 1]])
  sig(`manifest-bit-${label}`, `one bit of the ${label} byte of the manifest`, LIST_A, flip(MANIFEST, index), signatureFile(A, MANIFEST), refused);
const good = signedBy(A, MANIFEST);
const raw = Buffer.from(good.sig, 'base64');
for (const [label, index] of [['r', 0], ['s', 63]])
  sig(`signature-bit-${label}`, `one bit in the ${label} half of the signature`, LIST_A, MANIFEST, fileOf({ ...good, sig: b64(flip(raw, index)) }), refused);
sig('signature-der', 'the same signature in DER form (70 to 72 bytes)', LIST_A, MANIFEST,
  fileOf({ ...good, sig: b64(sign('sha256', MANIFEST, { key: A.privateKey, dsaEncoding: 'der' })) }), refused);
sig('signature-63-bytes', 'one byte short', LIST_A, MANIFEST, fileOf({ ...good, sig: b64(raw.subarray(0, 63)) }), refused);
sig('signature-65-bytes', 'one byte long', LIST_A, MANIFEST, fileOf({ ...good, sig: b64(Buffer.concat([raw, Buffer.from([0])])) }), refused);
sig('signature-base64-whitespace', 'a line break inside the base64', LIST_A, MANIFEST, fileOf({ ...good, sig: `${good.sig.slice(0, 40)}\n${good.sig.slice(40)}` }), refused);
sig('signature-base64-trailing-space', 'a space after the base64', LIST_A, MANIFEST, fileOf({ ...good, sig: `${good.sig} ` }), refused);
sig('signature-base64-no-padding', 'the padding removed', LIST_A, MANIFEST, fileOf({ ...good, sig: good.sig.replace(/=+$/, '') }), refused);
{
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = good.sig[good.sig.length - 3]; // the sixth data character of the last quantum: its low four bits are spare
  sig('signature-base64-spare-bits', 'the same 64 bytes, with spare bits set in the last base64 character', LIST_A, MANIFEST,
    fileOf({ ...good, sig: `${good.sig.slice(0, -3)}${alphabet[alphabet.indexOf(last) | 1]}==` }), refused);
  let withPlus = signedBy(A, MANIFEST);
  for (let tries = 0; tries < 200 && !/[+/]/.test(withPlus.sig); tries += 1) withPlus = signedBy(A, MANIFEST);
  sig('signature-base64-url-alphabet', 'the URL-safe alphabet (- and _ for + and /)', LIST_A, MANIFEST, fileOf({ ...withPlus, sig: withPlus.sig.replace(/\+/g, '-').replace(/\//g, '_') }), refused);
}
sig('signature-kid-unknown', 'made by a key that is not in the list', LIST_A, MANIFEST, signatureFile(B, MANIFEST), refused);
sig('signature-kid-names-another-key', 'made by A, the file names B, and B is in the list', keyList([entry(A), entry(B)]), MANIFEST, fileOf({ ...good, kid: B.kid }), refused);
sig('signature-kid-uppercase', 'the key id in capitals', LIST_A, MANIFEST, fileOf({ ...good, kid: good.kid.toUpperCase() }), refused);
sig('signature-kid-short', 'a key id of 7 characters', LIST_A, MANIFEST, fileOf({ ...good, kid: good.kid.slice(0, 7) }), refused);
sig('signature-alg-es384', 'another algorithm', LIST_A, MANIFEST, fileOf({ ...good, alg: 'ES384' }), refused);
sig('signature-alg-lowercase', 'es256', LIST_A, MANIFEST, fileOf({ ...good, alg: 'es256' }), refused);
sig('signature-file-bom', 'a byte order mark in front of the signature file', LIST_A, MANIFEST, Buffer.concat([BOM, signatureFile(A, MANIFEST)]), valid(A));
sig('signature-file-extra-fields', 'fields it does not know are ignored', LIST_A, MANIFEST, Buffer.from(JSON.stringify({ ...good, note: 'made by hand', created: '2026-10-26' })), valid(A));
sig('signature-file-empty', 'no bytes', LIST_A, MANIFEST, Buffer.alloc(0), refused);
sig('signature-file-not-json', 'text', LIST_A, MANIFEST, Buffer.from('not json'), refused);
sig('signature-file-array', 'a JSON array', LIST_A, MANIFEST, Buffer.from(JSON.stringify([good])), refused);
sig('signature-file-invalid-utf8', 'bytes that are not UTF-8', LIST_A, MANIFEST, Buffer.concat([Buffer.from('{"alg":"ES256","kid":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]), refused);
{
  // complete and valid in every field it reads; the one byte that is not UTF-8 is in a field it does not read, so only a strict decoder refuses it
  const whole = Buffer.from(JSON.stringify({ ...good, note: 'X' }));
  sig('signature-file-invalid-utf8-in-a-field-it-does-not-read', 'a valid signature file with one byte that is not UTF-8 after the fields it reads', LIST_A, MANIFEST, Buffer.concat([whole.subarray(0, whole.length - 3), Buffer.from([0xff]), Buffer.from('"}')]), refused);
}
{
  const text = signatureFile(A, MANIFEST).toString('utf8');
  const pad = (size) => Buffer.from(text.replace(/\n$/, '') + ' '.repeat(size - Buffer.byteLength(text.replace(/\n$/, ''))));
  sig('signature-file-4096-bytes', 'exactly the largest size that is read', LIST_A, MANIFEST, pad(4096), valid(A));
  sig('signature-file-4097-bytes', 'one byte over it', LIST_A, MANIFEST, pad(4097), refused);
}
sig('empty-manifest-signed', 'a signature of no bytes is a signature (the manifest is then refused as a manifest)', LIST_A, Buffer.alloc(0), signatureFile(A, Buffer.alloc(0)), valid(A));

// ---- the key list
const second = keyList([entry(A), entry(B)]);
sig('keys-second-key-signs', 'two keys, the second signs', second, MANIFEST, signatureFile(B, MANIFEST), valid(B));
sig('keys-placeholder-only', 'the placeholder that ships until the owner has made a key', keyList([{ kid: '00000000', use: 'placeholder', spki: null }]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-placeholder-then-key', 'a placeholder and then a key', keyList([{ kid: '00000000', use: 'placeholder', spki: null }, entry(A)]), MANIFEST, signatureFile(A, MANIFEST), valid(A));
sig('keys-compressed-point', 'a key whose point is compressed (59 bytes) is not a key, even when the signature names it and is valid for the same point', keyList([odd(compressedSpki)]), MANIFEST, fileOf({ ...good, kid: keyIdOf(compressedSpki) }), refused);
sig('keys-compressed-point-and-key', 'it costs that entry and nothing else', keyList([odd(compressedSpki), entry(A)]), MANIFEST, signatureFile(A, MANIFEST), valid(A));
{
  // each of these is the point of A in another form, with the id its own bytes give and a signature of A's that names that id: if the form were taken as a key, the signature would check, so the refusal is the key's
  const trailingByteSpki = Buffer.concat([A.spki, Buffer.from([0])]);
  sig('keys-trailing-byte', 'a key of 92 bytes: the 91 of a key and one more (the library reads the first structure and says nothing of the rest)', keyList([odd(trailingByteSpki)]), MANIFEST, fileOf({ ...good, kid: keyIdOf(trailingByteSpki) }), refused);
  const markerSpki = Buffer.from(A.spki);
  markerSpki[HEADER.length] = 0x02;
  sig('keys-point-marker-is-not-uncompressed', 'a key of 91 bytes whose point does not start with 0x04', keyList([odd(markerSpki)]), MANIFEST, fileOf({ ...good, kid: keyIdOf(markerSpki) }), refused);
  const unusedBitsSpki = Buffer.from(A.spki);
  unusedBitsSpki[HEADER.length - 1] = 0x01;
  sig('keys-bit-string-with-unused-bits', 'a key of 91 bytes whose BIT STRING says that one bit of it is unused', keyList([odd(unusedBitsSpki)]), MANIFEST, fileOf({ ...good, kid: keyIdOf(unusedBitsSpki) }), refused);
}
sig('keys-off-curve', 'a point that is not on the curve is not a key', keyList([odd(offCurveSpki)]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-off-curve-takes-no-slot', 'and takes no one of the four places', keyList([entry(B), odd(offCurveSpki), entry(C), entry(D), entry(E)]), MANIFEST, signatureFile(E, MANIFEST), valid(E));
{
  // a key that is refused as a key must not take a place: with four places and this key counted, E would be the fifth (the form with the wrong marker is the one whose signature check fails whether or not it was counted)
  const markerSpki = Buffer.from(A.spki);
  markerSpki[HEADER.length] = 0x02;
  sig('keys-point-marker-takes-no-slot', 'a key whose point does not start with 0x04 takes no one of the four places', keyList([entry(B), odd(markerSpki), entry(C), entry(D), entry(E)]), MANIFEST, signatureFile(E, MANIFEST), valid(E));
}
sig('keys-p384', 'a P-384 key', keyList([odd(p384)]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-rsa', 'an RSA key', keyList([odd(rsa)]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-p384-takes-no-slot', 'a P-384 key takes no one of the four places', keyList([entry(B), odd(p384), entry(C), entry(D), entry(E)]), MANIFEST, signatureFile(E, MANIFEST), valid(E));
sig('keys-rsa-takes-no-slot', 'nor does an RSA key', keyList([entry(B), odd(rsa), entry(C), entry(D), entry(E)]), MANIFEST, signatureFile(E, MANIFEST), valid(E));
sig('keys-kid-claimed-by-entry', 'the entry claims the id of B for the bytes of A, and the signature (made by A) names B', keyList([entry(A, { kid: B.kid })]), MANIFEST, fileOf({ ...good, kid: B.kid }), refused);
sig('keys-four-fourth-signs', 'room for four: the fourth signs', keyList([entry(A), entry(B), entry(C), entry(D)]), MANIFEST, signatureFile(D, MANIFEST), valid(D));
sig('keys-five-fifth-signs', 'a fifth entry is not read', keyList([entry(A), entry(B), entry(C), entry(D), entry(E)]), MANIFEST, signatureFile(E, MANIFEST), refused);
sig('keys-five-first-signs', 'and the first four still are', keyList([entry(A), entry(B), entry(C), entry(D), entry(E)]), MANIFEST, signatureFile(A, MANIFEST), valid(A));
sig('keys-duplicate-entry', 'one key listed twice', keyList([entry(A), entry(A)]), MANIFEST, signatureFile(A, MANIFEST), valid(A));
sig('keys-duplicate-takes-no-slot', 'the second listing takes no place', keyList([entry(A), entry(A), entry(B), entry(C), entry(D)]), MANIFEST, signatureFile(D, MANIFEST), valid(D));
sig('keys-kid-does-not-match', 'an entry whose id is not the id of its own bytes', keyList([entry(A, { kid: B.kid })]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-kid-missing', 'an entry with no id', keyList([{ use: 'release', spki: b64(A.spki) }]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-spki-whitespace', 'a line break inside the base64 of a key', keyList([entry(A, { spki: `${b64(A.spki).slice(0, 30)}\n${b64(A.spki).slice(30)}` })]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-spki-null', 'a release entry with no key', keyList([entry(A, { spki: null })]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-use-test', 'a test key trusts nothing', keyList([entry(A, { use: 'test' })]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-use-missing', 'an entry that does not say what it is', keyList([{ kid: A.kid, spki: b64(A.spki) }]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-entries-that-are-not-objects', 'strings, null and a list among the entries are skipped', keyList(['x', null, [], 7, entry(A)]), MANIFEST, signatureFile(A, MANIFEST), valid(A));
sig('keys-list-bom', 'a byte order mark in front of the key file', `${String.fromCharCode(0xfeff)}${LIST_A}`, MANIFEST, signatureFile(A, MANIFEST), valid(A));
sig('keys-list-algorithm-missing', 'the algorithm line is optional', keyList([entry(A)], { algorithm: undefined }), MANIFEST, signatureFile(A, MANIFEST), valid(A));
sig('keys-list-algorithm-other', 'another algorithm', keyList([entry(A)], { algorithm: 'ES384' }), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-list-version-2', 'a version this code does not know', keyList([entry(A)], { version: 2 }), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-list-not-json', 'text', 'not json', MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-list-array', 'a JSON array', JSON.stringify([entry(A)]), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-list-keys-not-an-array', 'keys that is an object', JSON.stringify({ version: 1, keys: entry(A) }), MANIFEST, signatureFile(A, MANIFEST), refused);
sig('keys-list-empty', 'no text', '', MANIFEST, signatureFile(A, MANIFEST), refused);

// ------------------------------------------------------------------------------------------------------------------------------- the manifest as a document
const manifestCases = [];
const man = (name, note, bytes, expect) => manifestCases.push({ name, note, text: b64(bytes), expect });
const asText = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const okManifest = (over = {}, installer = { name: 'DatGoldSetup.exe', bytes: 232753314, sha256: 'a'.repeat(64) }) => ({ ok: true, version: over.version ?? '3.11.0', installer });
man('real shape', 'what the publish workflow writes, with one installer', MANIFEST, okManifest());
man('crlf', 'CRLF line ends', CRLF, okManifest());
man('bom', 'a byte order mark', WITH_BOM, okManifest());
man('unknown keys are ignored', 'a later release adds fields', asText({ ...manifestObject(), signedInEdgeVerified: true, notes: 'x' }), okManifest());
man('two installers', 'the manifest names no single installer', asText(manifestObject({ assets: [{ name: 'A.exe', bytes: 1, sha256: 'a'.repeat(64) }, { name: 'B.exe', bytes: 1, sha256: 'b'.repeat(64) }] })), { ok: true, version: '3.11.0', installer: null });
man('no installer', 'no .exe among the assets', asText(manifestObject({ assets: [{ name: 'notes.zip', bytes: 1, sha256: 'a'.repeat(64) }] })), { ok: true, version: '3.11.0', installer: null });
man('no assets', 'an empty list', asText(manifestObject({ assets: [] })), { ok: true, version: '3.11.0', installer: null });
man('upper-case extension', '.EXE counts as a program', asText(manifestObject({ assets: [{ name: 'Setup.EXE', bytes: 5, sha256: 'c'.repeat(64) }] })), { ok: true, version: '3.11.0', installer: { name: 'Setup.EXE', bytes: 5, sha256: 'c'.repeat(64) } });
man('upper-case digest', 'the digest is lower-cased', asText(manifestObject({ assets: [{ name: 'DatGoldSetup.exe', bytes: 9, sha256: 'ABCDEF0123456789'.repeat(4) }] })), { ok: true, version: '3.11.0', installer: { name: 'DatGoldSetup.exe', bytes: 9, sha256: 'abcdef0123456789'.repeat(4) } });
man('zero bytes', 'a size of 0 is a size', asText(manifestObject({ assets: [{ name: 'DatGoldSetup.exe', bytes: 0, sha256: 'a'.repeat(64) }] })), { ok: true, version: '3.11.0', installer: { name: 'DatGoldSetup.exe', bytes: 0, sha256: 'a'.repeat(64) } });
man('name with two dots', 'a plain file name for a manifest (the installer rule refuses it later)', asText(manifestObject({ assets: [{ name: 'a..b.exe', bytes: 5, sha256: 'a'.repeat(64) }] })), { ok: true, version: '3.11.0', installer: { name: 'a..b.exe', bytes: 5, sha256: 'a'.repeat(64) } });
man('128-character name', 'the longest name', asText(manifestObject({ assets: [{ name: `${'a'.repeat(124)}.exe`, bytes: 5, sha256: 'a'.repeat(64) }] })), { ok: true, version: '3.11.0', installer: { name: `${'a'.repeat(124)}.exe`, bytes: 5, sha256: 'a'.repeat(64) } });
man('129-character name', 'one more', asText(manifestObject({ assets: [{ name: `${'a'.repeat(125)}.exe`, bytes: 5, sha256: 'a'.repeat(64) }] })), { ok: false });
man('32 assets', 'the most', asText(manifestObject({ assets: Array.from({ length: 32 }, (_, index) => ({ name: `f${index}.bin`, bytes: 1, sha256: 'a'.repeat(64) })) })), { ok: true, version: '3.11.0', installer: null });
man('33 assets', 'one more', asText(manifestObject({ assets: Array.from({ length: 33 }, (_, index) => ({ name: `f${index}.bin`, bytes: 1, sha256: 'a'.repeat(64) })) })), { ok: false });
for (const [label, over] of [
  ['pre-release version', { version: '3.11.0-rc.1' }], ['build metadata', { version: '3.11.0+abc' }], ['leading zero', { version: '03.11.0' }], ['two parts', { version: '3.11' }], ['four parts', { version: '3.11.0.1' }],
  ['version is a number', { version: 3.11 }], ['version is missing', { version: undefined }], ['short commit', { commit: '0123456789abcdef' }], ['commit that is not hex', { commit: 'z'.repeat(40) }], ['no commit', { commit: undefined }],
  ['commit with a line break at the end', { commit: '0123456789abcdef0123456789abcdef01234567\n' }], ['asset name with a line break at the end', { assets: [{ name: 'a.exe\n', bytes: 1, sha256: 'a'.repeat(64) }] }],
  ['digest with a line break at the end', { assets: [{ name: 'a.exe', bytes: 1, sha256: `${'a'.repeat(64)}\n` }] }], ['version with a line break at the end', { version: '3.11.0\n' }],
  ['assets is an object', { assets: { name: 'a.exe' } }], ['assets is missing', { assets: undefined }], ['an asset that is a string', { assets: ['a.exe'] }],
  ['name with a slash', { assets: [{ name: 'a/b.exe', bytes: 1, sha256: 'a'.repeat(64) }] }], ['name with a space', { assets: [{ name: 'a b.exe', bytes: 1, sha256: 'a'.repeat(64) }] }],
  ['name that starts with a dot', { assets: [{ name: '.a.exe', bytes: 1, sha256: 'a'.repeat(64) }] }], ['name with a backslash', { assets: [{ name: 'a\\b.exe', bytes: 1, sha256: 'a'.repeat(64) }] }],
  ['negative size', { assets: [{ name: 'a.exe', bytes: -1, sha256: 'a'.repeat(64) }] }], ['size with a fraction', { assets: [{ name: 'a.exe', bytes: 1.5, sha256: 'a'.repeat(64) }] }],
  ['size that is a string', { assets: [{ name: 'a.exe', bytes: '5', sha256: 'a'.repeat(64) }] }], ['size that is null', { assets: [{ name: 'a.exe', bytes: null, sha256: 'a'.repeat(64) }] }],
  ['size past the safe integers', { assets: [{ name: 'a.exe', bytes: 9007199254740993, sha256: 'a'.repeat(64) }] }],
  ['short digest', { assets: [{ name: 'a.exe', bytes: 1, sha256: 'a'.repeat(63) }] }], ['digest that is not hex', { assets: [{ name: 'a.exe', bytes: 1, sha256: 'g'.repeat(64) }] }], ['long digest', { assets: [{ name: 'a.exe', bytes: 1, sha256: 'a'.repeat(65) }] }],
  ['two assets with one name in two letter cases', { assets: [{ name: 'A.exe', bytes: 1, sha256: 'a'.repeat(64) }, { name: 'a.EXE', bytes: 1, sha256: 'a'.repeat(64) }] }],
]) man(label, 'refused', asText(manifestObject(over)), { ok: false });
man('root is an array', 'refused', asText([manifestObject()]), { ok: false });
man('root is null', 'refused', asText('null'), { ok: false });
man('not JSON', 'refused', asText('version 3.11.0'), { ok: false });
man('empty', 'refused', Buffer.alloc(0), { ok: false });
man('text after the document', 'refused', asText(`${JSON.stringify(manifestObject())} x`), { ok: false });
man('trailing comma', 'refused', asText(JSON.stringify(manifestObject()).replace(/\}$/, ',}')), { ok: false });
man('a comment', 'refused', asText(`/* signed */\n${JSON.stringify(manifestObject())}`), { ok: false });
man('single quotes', 'refused', asText(JSON.stringify(manifestObject()).replace(/"/g, "'")), { ok: false });

// ------------------------------------------------------------------------------------------------------------------------------- versions and installer names
const releaseVersions = [
  ['3.10.2', true], ['0.0.0', true], ['10.20.30', true], ['3.10.2-rc.1', false], ['3.10.2+build.5', false], ['3.10', false], ['3', false], ['3.10.2.1', false], ['03.10.2', false], ['3.010.2', false], ['3.10.02', false],
  ['', false], [' 3.10.2', false], ['3.10.2 ', false], ['3.10.2\n', false], ['v3.10.2', false], ['3.10.x', false], ['-1.0.0', false], ['1.-2.3', false], ['1_0.2.3', false], [`${String.fromCharCode(0x661)}.${String.fromCharCode(0x662)}.${String.fromCharCode(0x663)}`, false],
  ['99999999999999999999.0.0', false], ['9007199254740991.0.0', true], ['9007199254740992.0.0', false], ['1.2.3'.padEnd(70, '1'), false],
];
const compareVersions = [['3.10.2', '3.10.2', 0], ['3.11.0', '3.10.2', 1], ['3.10.2', '3.11.0', -1], ['3.9.0', '3.10.2', -1], ['3.10.2', '3.9.0', 1], ['10.0.0', '9.9.9', 1], ['4.0.0', '3.99.99', 1], ['3.10.10', '3.10.9', 1], ['0.0.1', '0.0.0', 1]];
const installerNames = [
  ['DatGoldSetup.exe', null], ['ChatMCPSetup.exe', null], ['a.exe', null], ['A1_b-c.d.exe', null], ['x'.repeat(100) + '.exe', null], ['x'.repeat(101) + '.exe', 'shape'], ['.exe', 'shape'], ['', 'shape'],
  ['a b.exe', 'shape'], ['a/b.exe', 'shape'], ['a\\b.exe', 'shape'], ['a:b.exe', 'shape'], ['a:b.exe:stream.exe', 'shape'], ['setup.EXE', 'shape'], ['setup.exe ', 'shape'], ['setup.exe\n', 'shape'], ['DatGoldSetup.exe\n', 'shape'], ['setup.exe.', 'shape'], ['setup.bat', 'shape'], ['setup', 'shape'],
  ['.hidden.exe', 'start'], ['-dash.exe', 'start'], ['_under.exe', 'start'], ['a..b.exe', 'dots'], ['a...exe', 'dots'],
  ['CON.exe', 'device'], ['con.exe', 'device'], ['PRN.exe', 'device'], ['AUX.exe', 'device'], ['NUL.exe', 'device'], ['COM1.exe', 'device'], ['com9.exe', 'device'], ['LPT1.exe', 'device'], ['lpt9.exe', 'device'],
  ['CON.txt.exe', 'device'], ['nul.setup.exe', 'device'], ['COM0.exe', null], ['COM10.exe', null], ['CONSOLE.exe', null], ['LPT.exe', null], ['CONIN$.exe', 'shape'],
];

const document = {
  version: 1,
  about: 'Cases that the Hub (CHATMCP-HUB/tests/verify-release-vectors.mjs) and the desktop shell (scripts/tests/native-lifecycle/ReleaseVectorTests.cs) must read the same way. Made by tests/support/make-release-vectors.mjs; every `expect` was written down when the case was made, not taken from the code. The keys were made for the run and no private key is kept.',
  signatures: signatureCases,
  manifests: manifestCases,
  releaseVersions: releaseVersions.map(([text, expect]) => ({ text, expect })),
  compareVersions: compareVersions.map(([a, b, expect]) => ({ a, b, expect })),
  installerNames: installerNames.map(([name, problem]) => ({ name, problem })),
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(document, null, 1)}\n`);
console.log(`wrote ${path.relative(process.cwd(), out)}: ${signatureCases.length} signature cases, ${manifestCases.length} manifest cases, ${releaseVersions.length} versions, ${compareVersions.length} comparisons, ${installerNames.length} installer names`);
