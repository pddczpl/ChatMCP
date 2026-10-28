#!/usr/bin/env node
// Reads the REAL release feed once, up to and including the SIGNATURE of the newest release, with the Hub's own code, and says what a click on Download would do. For the owner, by hand:
//
//     node DATGOLD-HUB/tests/live/check-update-download.mjs [--expect valid|missing|invalid]
//
// It asks GitHub for two files: the manifest of the newest release (as tests/live/check-update-feed.mjs does) and the signature of that release, at the address the Hub builds from the version the
// manifest names. CI never runs it. It NEVER asks for the installer: it prints the address a click would use and what the manifest promises (name, size, SHA-256) and stops there. A real download
// of the installer (about 230 MB) is a separate act that the owner approves each time, and nothing in this script can start it. Everything else about the signature and the download is tested against a
// stand-in for GitHub (tests/verify-release-signature.mjs, tests/verify-update-check.mjs, tests/verify-update-download.mjs, tests/verify-e2e-update-download.mjs); this is the one place where the real
// answer for a release's signature file is looked at, and the place to look again when something changes upstream (a new redirect host, a signature file that has a new name).
//
// It prints what it found and exits 0 when the Hub would reach a decision (the signature is valid, missing or invalid, and is the one --expect names when that is given), 1 when it would not (the
// manifest or the signature could not be read, or the answer is not the expected one), 2 for a bad use. A release that was made before the first key existed has no signature file, and the answer to
// expect is then `missing` (GitHub answers 404). It never writes a file and sends what the Hub sends: `User-Agent: DatGold/<version>` and `Accept`. The same test hooks as the Hub's apply (a loopback
// stand-in, with CHATMCP_UPDATE_TEST_KEY for the key the stand-in signs with), which is how the suites run this very script offline.
import { VERSION } from '../../lib/manager.mjs';
import { FEED_URL, UpdateError, compareVersions, fetchManifest, parseManifest, proveManifest, releaseAssetUrl, updateOptionsFromEnvironment } from '../../lib/update-check.mjs';
import { SIGNATURE_ASSET, loadReleaseKeys } from '../../lib/release-signature.mjs';
import { DOWNLOAD, installerNameProblem } from '../../lib/update-download.mjs';

const EXPECTED = ['valid', 'missing', 'invalid'];
const args = process.argv.slice(2);
let expected = null;
if (args.length === 2 && args[0] === '--expect' && EXPECTED.includes(args[1])) expected = args[1];
else if (args.length !== 0) {
  console.error('usage: node tests/live/check-update-download.mjs [--expect valid|missing|invalid]   (the feed is fixed; CHATMCP_UPDATE_FEED_URL may name a loopback stand-in)');
  process.exit(2);
}

const options = updateOptionsFromEnvironment(process.env, (line) => console.log(`note: ${line}`));
const feed = options.feedUrl ?? FEED_URL;
const shipped = loadReleaseKeys();
const keys = [...shipped.keys, ...(options.testKeys ?? [])];
console.log(`feed:        ${feed}${feed === FEED_URL ? '' : '   (a loopback stand-in)'}`);
console.log(`this Hub:    ${VERSION}   (it would send User-Agent: DatGold/${VERSION})`);
console.log(`keys:        ${shipped.keys.length} release key(s) ship with this version${shipped.placeholders ? `, ${shipped.placeholders} placeholder (trusts nothing)` : ''}${options.testKeys?.length ? `, plus ${options.testKeys.length} test key from the environment` : ''}`);

try {
  const userAgent = `DatGold/${VERSION}`;
  const answer = await fetchManifest({ url: feed, userAgent });
  const manifest = parseManifest(answer.text);
  console.log(`release:     ${manifest.version}   commit ${manifest.commit}   (manifest: ${answer.bytes.length} bytes, ${answer.redirects} redirects)`);
  console.log(`installer:   ${manifest.installer ? `${manifest.installer.name}   ${manifest.installer.bytes} bytes   sha256 ${manifest.installer.sha256}` : '(none: the manifest names no single .exe)'}`);
  console.log(`asks:        ${releaseAssetUrl(feed, manifest.version, SIGNATURE_ASSET)}   (the signature of that release)`);
  const proof = await proveManifest({ feed, version: manifest.version, manifestBytes: answer.bytes, keys, userAgent });
  const said = {
    valid: `valid   (key ${proof.kid})`,
    missing: 'missing   (GitHub answered 404: this release has no signature file)',
    invalid: `invalid   (${proof.code}, ${proof.reason})`,
  }[proof.state];
  console.log(`signature:   ${said}`);

  const newer = compareVersions(manifest.version, VERSION) > 0;
  console.log(`newer:       ${newer ? `${manifest.version} is newer than ${VERSION}` : `${manifest.version} is not newer than ${VERSION}: nothing to offer`}`);
  if (!newer) console.log('download:    no button (nothing newer)');
  else if (proof.state !== 'valid') console.log('download:    no button; the page says why (the release is not signed, or its signature does not check)');
  else if (!manifest.installer) console.log('download:    no button; the manifest names no single installer');
  else if (installerNameProblem(manifest.installer.name) !== null) console.log(`download:    refused; the name of the installer is not one DatGold accepts (${installerNameProblem(manifest.installer.name)})`);
  else if (manifest.installer.bytes > DOWNLOAD.maxBytes) console.log('download:    refused; the installer is larger than the limit');
  else {
    console.log(`download:    a click would fetch ${releaseAssetUrl(feed, manifest.version, manifest.installer.name)}`);
    console.log(`             (${manifest.installer.bytes} bytes; it needs ${manifest.installer.bytes * DOWNLOAD.freeSpaceFactor} bytes free; NOT fetched now)`);
  }
  if (expected !== null && proof.state !== expected) {
    console.log(`FAIL: the signature is ${proof.state}, not the ${expected} that was expected.`);
    process.exitCode = 1;
  } else console.log(`OK: the Hub reads this answer and ${newer ? `would ${proof.state === 'valid' ? 'offer the download' : 'announce the release without a download button'}` : 'has nothing newer to offer'}.`);
} catch (error) {
  const known = error instanceof UpdateError;
  console.log(`FAIL: ${known ? error.code : 'unexpected'}: ${String(error?.message ?? error).slice(0, 300)}`);
  process.exitCode = 1;
}
