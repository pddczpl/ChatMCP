// Test support for the signed release manifest (lib/release-signature.mjs): throwaway keys and signatures made with plain node:crypto, NOT with the module under test, so that a
// test compares the module with an independent maker of the same thing. Nothing here is a key anybody trusts: every pair is made when a test runs and is gone with it.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

/** A new P-256 pair. `entry` is the line the key file (lib/release-keys.json) would hold for it. */
export function throwawayKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const kid = createHash('sha256').update(spki).digest('hex').slice(0, 8);
  return { privateKey, publicKey, spki, kid, spkiBase64: spki.toString('base64'), entry: { kid, use: 'release', spki: spki.toString('base64') } };
}

/** The raw 64 bytes r||s (IEEE P1363) of an ECDSA P-256 / SHA-256 signature over exactly `bytes`. */
export function rawSignature(bytes, key) {
  return sign('sha256', bytes, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
}

/** The text of RELEASE-MANIFEST.json.sig for `bytes`: {"alg","kid","sig"}. `kid`, `sig` and `alg` may be overridden to make a wrong one, `extra` adds keys and `omit` leaves some out. */
export function signatureFor(bytes, key, { kid = key.kid, sig = rawSignature(bytes, key).toString('base64'), alg = 'ES256', extra = {}, omit = [] } = {}) {
  const document = { alg, kid, sig, ...extra };
  for (const name of omit) delete document[name];
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
}

/** A pair whose key id has a letter in it (one made only of digits has no upper-case spelling). */
export function letteredKey() {
  for (;;) {
    const key = throwawayKey();
    if (/[a-f]/.test(key.kid)) return key;
  }
}

/** A key file (lib/release-keys.json) holding these entries. */
export function keyFileText(entries) {
  return `${JSON.stringify({ version: 1, algorithm: 'ES256', keys: entries }, null, 2)}\n`;
}
