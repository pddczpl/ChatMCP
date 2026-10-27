#!/usr/bin/env node
// Puts a version into a COPY of the tree before it is built. The end-to-end proof of the in-app updater builds two setups of one commit, an old one and a newer one, and no version bump is committed
// for it: the CI job makes two Git work trees of the commit under test and gives each its version with this tool, then builds them with scripts/Build-Installer.ps1.
//
//     node scripts/tests/updater-e2e/set-build-version.mjs <root of a Git work tree> <version x.y.z>
//     node scripts/tests/updater-e2e/set-build-version.mjs --read <root>
//
// Only a release version x.y.z is accepted: the Hub's feed carries releases only (lib/update-check.mjs, parseManifest), the shell compares x.y.z (native-shared/ReleaseVersion.cs), and a suffix such as
// "-test" would be refused as a release by both. The places are the ones that a build reads its version from, the ones tests/verify-docs.mjs holds to one version. A tree that does not fit (a place
// missing, a place twice, two places that disagree, a file missing) is refused as a whole, before any file is written; a place that was added later and is not on this list is found by the job itself
// (the setup that comes out must say the version it was given, and the installed Hub must answer with it).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NUMBER = String.raw`(\d+\.\d+\.\d+)`;

/**
 * Where the version is written: the file (with / in its path), a pattern with three groups (what comes before the version, the version, what comes after), how many times it must be found, and a
 * name for a message. The patterns do not use ^ or $, so a file with CRLF is no different from one with LF.
 */
const PLACES = Object.freeze([
  { file: 'CHATMCP-HUB/package.json', find: new RegExp(String.raw`("version": ")${NUMBER}(")`, 'g'), count: 1, name: 'the version of the Hub package' },
  { file: 'CHATMCP-HUB/ui/package.json', find: new RegExp(String.raw`("version": ")${NUMBER}(")`, 'g'), count: 1, name: 'the version of the UI package' },
  { file: 'CHATMCP-HUB/ui/package-lock.json', find: new RegExp(String.raw`("name": "chatmcp-studio-frontend",\s*"version": ")${NUMBER}(")`, 'g'), count: 2, name: 'the version of the UI package in its lock file (the file and its root package)' },
  { file: 'CHATMCP-HUB/lib/manager.mjs', find: new RegExp(String.raw`(export const VERSION = ')${NUMBER}(')`, 'g'), count: 1, name: 'VERSION of the Hub' },
  { file: 'CHATMCP-HUB/hub.mjs', find: new RegExp(String.raw`(export const UI_BUILD = ')${NUMBER}(-react-agent')`, 'g'), count: 1, name: 'UI_BUILD of the Hub' },
  { file: 'CHATMCP-HUB/ui/src/lib/api.ts', find: new RegExp(String.raw`(const UI_BUILD = ')${NUMBER}(-react-agent')`, 'g'), count: 1, name: 'UI_BUILD the page sends' },
  { file: 'CHATMCP-HUB/web/react-app.js', find: new RegExp(String.raw`(const BUILD = ')${NUMBER}(-react-agent')`, 'g'), count: 1, name: 'BUILD of the first page' },
  { file: 'CHATMCP-HUB/web/react-app.js', find: new RegExp(String.raw`(const uiVersion = ')${NUMBER}(')`, 'g'), count: 1, name: 'uiVersion of the first page' },
  { file: 'desktop-shell/ChatMCP.csproj', find: new RegExp(String.raw`(<Version>)${NUMBER}(</Version>)`, 'g'), count: 1, name: 'the version of the desktop shell' },
  { file: 'installer/ChatMCP.Installer.csproj', find: new RegExp(String.raw`(<Version>)${NUMBER}(</Version>)`, 'g'), count: 1, name: 'the version of the setup' },
]);

/** The files that hold the version, once each, with / in their paths. */
export const VERSION_FILES = Object.freeze([...new Set(PLACES.map((place) => place.file))]);

const absolute = (root, relative) => path.join(root, ...relative.split('/'));

function readText(root, relative) {
  try { return fs.readFileSync(absolute(root, relative), 'utf8'); } catch (error) {
    throw new Error(`${relative}: the file cannot be read (${error?.code ?? 'error'}), so this is not a tree this tool knows.`);
  }
}

/** Every place with the version it holds. Throws for a place that is not found as often as it should be. */
function scan(root) {
  const texts = new Map();
  const found = [];
  for (const place of PLACES) {
    if (!texts.has(place.file)) texts.set(place.file, readText(root, place.file));
    const matches = [...texts.get(place.file).matchAll(place.find)];
    if (matches.length !== place.count) {
      throw new Error(`${place.file}: ${matches.length} place(s) found for ${place.name}, ${place.count} expected, so this is not a tree this tool knows. Nothing was written.`);
    }
    for (const match of matches) found.push({ place, version: match[2] });
  }
  return { texts, found };
}

/** The one version that every place holds. Throws when the places disagree. */
function coherentVersion(found) {
  const versions = new Map();
  for (const { place, version } of found) versions.set(version, [...(versions.get(version) ?? []), place.file]);
  if (versions.size !== 1) {
    const said = [...versions].map(([version, files]) => `${version} in ${[...new Set(files)].join(', ')}`).join('; ');
    throw new Error(`The places of the version disagree (${said}). Nothing was written.`);
  }
  return [...versions.keys()][0];
}

/** The version that a tree says, the same in every place. */
export function readBuildVersion(root) {
  return coherentVersion(scan(root).found);
}

/**
 * Gives the tree at `root` the release version `version`. Resolves {from, to, files}. Everything is read and checked first and written afterwards, so a tree that does not fit is left as it was.
 * What is written is the version and nothing else: the bytes of each file are the same with the old version put back.
 */
export function setBuildVersion(root, version) {
  if (typeof version !== 'string' || !RELEASE.test(version)) throw new TypeError(`${JSON.stringify(version)} is not a release version x.y.z (a suffix such as -test is not one: the Hub's feed carries releases only).`);
  const { texts, found } = scan(root);
  const from = coherentVersion(found);
  const next = new Map();
  for (const place of PLACES) {
    const text = next.get(place.file) ?? texts.get(place.file);
    next.set(place.file, text.replace(place.find, (_all, before, _old, after) => `${before}${version}${after}`));
  }
  for (const [relative, text] of next) fs.writeFileSync(absolute(root, relative), text, 'utf8');
  return { from, to: version, files: [...next.keys()] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const usage = 'usage: node scripts/tests/updater-e2e/set-build-version.mjs <root of a Git work tree> <version x.y.z>\n       node scripts/tests/updater-e2e/set-build-version.mjs --read <root>';
  const args = process.argv.slice(2);
  try {
    if (args.length === 2 && args[0] === '--read') console.log(readBuildVersion(path.resolve(args[1])));
    else if (args.length === 2 && !args[0].startsWith('-')) {
      const done = setBuildVersion(path.resolve(args[0]), args[1]);
      console.log(`${path.resolve(args[0])}: version ${done.from} -> ${done.to} in ${done.files.length} files`);
    } else { console.error(usage); process.exit(2); }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
