#!/usr/bin/env node
// Reads the REAL update feed once, with the Hub's own code, and says what the Hub would make of it. For the owner, by hand:
//
//     node CHATMCP-HUB/tests/live/check-update-feed.mjs
//
// It asks GitHub (one GET of https://github.com/pddczpl/ChatMCP/releases/latest/download/RELEASE-MANIFEST.json, with its two redirects), so CI never runs it. Everything else about the
// update notice is tested against a stand-in for GitHub (tests/verify-update-check.mjs, tests/verify-e2e-update-check.mjs); this is the one place where the real answer is looked at, and the
// place to look again when something changes upstream: the name of the installer, a new host in the redirects, a new key in the manifest.
//
// It prints what it found and exits 0 when the Hub would read the answer, 1 when it would not (with the code the Hub gives the failure), 2 for a bad use. It never writes a file,
// downloads nothing but the manifest and sends what the Hub sends: `User-Agent: DatGold/<version>` and `Accept`. The same two test hooks as the Hub's apply (a loopback stand-in), which
// is how tests/verify-update-check.mjs runs this very script offline.
import { VERSION } from '../../lib/manager.mjs';
import { FEED_URL, UpdateError, compareVersions, fetchManifest, notesUrlFor, parseManifest, updateOptionsFromEnvironment } from '../../lib/update-check.mjs';

if (process.argv.length > 2) {
  console.error('usage: node tests/live/check-update-feed.mjs   (no arguments: the feed is fixed; CHATMCP_UPDATE_FEED_URL may name a loopback stand-in)');
  process.exit(2);
}

const options = updateOptionsFromEnvironment(process.env, (line) => console.log(`note: ${line}`));
const feed = options.feedUrl ?? FEED_URL;
console.log(`feed:        ${feed}${feed === FEED_URL ? '' : '   (a loopback stand-in)'}`);
console.log(`this Hub:    ${VERSION}   (it would send User-Agent: DatGold/${VERSION})`);

try {
  const answer = await fetchManifest({ url: feed, userAgent: `DatGold/${VERSION}` });
  const manifest = parseManifest(answer.text);
  console.log(`redirects:   ${answer.redirects}`);
  console.log(`release:     ${manifest.version}   commit ${manifest.commit}`);
  console.log(`installer:   ${manifest.installerName ?? '(none: the manifest names no single .exe)'}`);
  for (const asset of manifest.assets) console.log(`asset:       ${asset.name}   ${asset.bytes} bytes   sha256 ${asset.sha256.slice(0, 16)}...`);
  const newer = compareVersions(manifest.version, VERSION) > 0;
  console.log(`verdict:     ${newer ? `the Hub would offer ${manifest.version} (newer than ${VERSION})` : `nothing to offer: ${manifest.version} is not newer than ${VERSION}`}`);
  console.log(`notes link:  ${notesUrlFor(manifest.version)}`);
  console.log('OK: the Hub reads this answer.');
} catch (error) {
  const known = error instanceof UpdateError;
  console.log(`FAIL: ${known ? error.code : 'unexpected'}: ${String(error?.message ?? error).slice(0, 300)}`);
  process.exitCode = 1;
}
