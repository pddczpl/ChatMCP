// The cases that the Hub and the desktop shell must read the same way (tests/fixtures/release-verify-vectors.json, made by tests/support/make-release-vectors.mjs): a release is checked by the Hub
// when it is downloaded and AGAIN by the shell (native-shared/UpdatePackage.cs) before it runs the installer, with two implementations of the same rules, in two languages. A manifest, a signature
// or a key list that one of them takes and the other refuses is a defect: the Hub would call an update ready that the shell then refuses, or the shell would run what the Hub never offered.
//
// This suite runs every case through the Hub's code (lib/release-signature.mjs, lib/update-check.mjs, lib/update-download.mjs) and holds it to the outcome the case was BUILT for (the file says what
// each case is for; it is not made from the Hub's answers). scripts/tests/native-lifecycle/ReleaseVectorTests.cs runs the same file through the shell's code. If this suite and that one agree
// with the file, they agree with each other.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignatureError, parseReleaseKeys, verifyManifest } from '../lib/release-signature.mjs';
import { compareVersions, isReleaseVersion, parseManifest } from '../lib/update-check.mjs';
import { installerNameProblem } from '../lib/update-download.mjs';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'release-verify-vectors.json');
const text = fs.readFileSync(FILE, 'utf8');
const vectors = JSON.parse(text);
let checks = 0;
const ok = (label) => { checks += 1; };

assert.equal(vectors.version, 1, 'the vector file is version 1');
assert.ok(!/PRIVATE KEY/.test(text) && !/"d"\s*:/.test(text), 'the file holds no private key');
ok('no private key in the file');

// ---- signatures
const outcomes = { valid: 0, refused: 0 };
for (const item of vectors.signatures) {
  const keys = parseReleaseKeys(item.keys).keys;
  let got;
  try { got = { valid: true, kid: verifyManifest(Buffer.from(item.manifest, 'base64'), Buffer.from(item.signature, 'base64'), keys).kid }; } catch (error) {
    if (!(error instanceof SignatureError)) throw error;
    got = { valid: false };
  }
  assert.deepEqual(got, item.expect.valid ? { valid: true, kid: item.expect.kid } : { valid: false }, `signature case "${item.name}" (${item.note})`);
  outcomes[item.expect.valid ? 'valid' : 'refused'] += 1;
  ok(`signature: ${item.name}`);
}
assert.ok(outcomes.valid >= 12 && outcomes.refused >= 40, `the cases are not all of one kind (${JSON.stringify(outcomes)})`);
ok('the signature cases are of both kinds');

// ---- manifests
const kinds = { ok: 0, refused: 0 };
for (const item of vectors.manifests) {
  let got;
  try {
    const manifest = parseManifest(Buffer.from(item.text, 'base64').toString('utf8'));
    got = { ok: true, version: manifest.version, installer: manifest.installer ? { name: manifest.installer.name, bytes: manifest.installer.bytes, sha256: manifest.installer.sha256 } : null };
  } catch (error) {
    if (error?.name !== 'UpdateError') throw error;
    got = { ok: false };
  }
  assert.deepEqual(got, item.expect, `manifest case "${item.name}" (${item.note})`);
  kinds[item.expect.ok ? 'ok' : 'refused'] += 1;
  ok(`manifest: ${item.name}`);
}
assert.ok(kinds.ok >= 10 && kinds.refused >= 25, `the manifest cases are not all of one kind (${JSON.stringify(kinds)})`);
ok('the manifest cases are of both kinds');

// ---- versions
for (const item of vectors.releaseVersions) {
  assert.equal(isReleaseVersion(item.text), item.expect, `isReleaseVersion(${JSON.stringify(item.text)})`);
  ok(`release version: ${JSON.stringify(item.text.length > 30 ? `${item.text.slice(0, 30)}...` : item.text)} is ${item.expect}`);
}
for (const item of vectors.compareVersions) {
  assert.equal(compareVersions(item.a, item.b), item.expect, `compareVersions(${item.a}, ${item.b})`);
  ok(`compare: ${item.a} with ${item.b} is ${item.expect}`);
}

// ---- the name of the installer
for (const item of vectors.installerNames) {
  assert.equal(installerNameProblem(item.name), item.problem, `installerNameProblem(${JSON.stringify(item.name)})`);
  ok(`installer name: ${JSON.stringify(item.name)} is ${item.problem ?? 'accepted'}`);
}

console.log(`PASS: ${checks} checks - ${vectors.signatures.length} signature cases, ${vectors.manifests.length} manifest cases, ${vectors.releaseVersions.length} version spellings, ${vectors.compareVersions.length} comparisons and ${vectors.installerNames.length} installer names agree with the Hub's code`);
