#!/usr/bin/env node
// Signs the manifest of a release, for the owner, by hand, OFFLINE and after the Publish workflow has run:
//
//     node scripts/sign-release.mjs --tag v3.11.0 --key <private key file> --installer <DatGoldSetup.exe of the Publish run>
//
// It takes the manifest as GitHub publishes it (RELEASE-MANIFEST.json of the tag; never a copy from the repository: the signature covers the exact bytes, and a BOM or a line ending is part of them), or
// the file you give with --manifest, checks that it is a release manifest of that tag, makes RELEASE-MANIFEST.json.sig with the key (ECDSA P-256, SHA-256, r||s) and checks the signature it made.
//
// What GitHub serves cannot vouch for itself: the signature exists for the day that someone who can write release files writes them. So the installer that the manifest lists is compared with the
// installer of the Publish run, which you download from the run and not from the release (gh run download <run id> --repo pddczpl/ChatMCP --name <artifact>), and nothing is signed without it.
//
//   --tag v3.11.0           the release (required)
//   --key <file>            the private key (or DATGOLD_RELEASE_KEY in the environment); outside every Git work tree. A passphrase comes from DATGOLD_RELEASE_KEY_PASSPHRASE.
//   --installer <file>      the installer of the Publish run: its size and SHA-256 must be what the manifest lists, or nothing is signed (required, unless the next option is given)
//   --allow-unchecked-installer   sign without comparing an installer (you have compared the sha256 below with the Publish run yourself)
//   --manifest <file>       sign this file instead of fetching the manifest of the tag (it must be the file as published)
//   --out <file|folder>     where to write RELEASE-MANIFEST.json.sig (default: a folder of its own in the temporary files)
//   --keys-file <file>      the list of keys the installed apps trust (default: CHATMCP-HUB/lib/release-keys.json); the key must be in it
//   --allow-unlisted-key    sign even though the key is not in that list (installed apps will reject the signature until it is)
//   --release-base <url>    a stand-in on this machine instead of github.com (loopback addresses only; for tests)
//
// It uploads NOTHING and starts no program: it prints the `gh release upload` command for you to read and to run yourself, because uploading to a release is an act that is approved each time.
// Exit code: 0 when the signature was made, 1 when it was refused, 2 for a bad use.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_PASSPHRASE_VARIABLE, KEY_PATH_VARIABLE, ToolError, signRelease } from '../CHATMCP-HUB/tools/release-tools.mjs';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node scripts/sign-release.mjs --tag v3.11.0 --key <private key file> --installer <file> [--manifest <file>] [--out <file|folder>] [--keys-file <file>] [--allow-unlisted-key] [--allow-unchecked-installer]\n'
  + `  The key can also come from ${KEY_PATH_VARIABLE}, and its passphrase from ${KEY_PASSPHRASE_VARIABLE}, in the environment. Read the comment at the top of this file.`;
const WITH_VALUE = new Map([['--tag', 'tag'], ['--key', 'keyFile'], ['--manifest', 'manifestFile'], ['--installer', 'installerFile'], ['--out', 'out'], ['--keys-file', 'keysFile'], ['--release-base', 'releaseBase']]);

function parse(argv) {
  const options = { allowUnlistedKey: false, allowUncheckedInstaller: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') return { help: true };
    if (name === '--allow-unlisted-key') { options.allowUnlistedKey = true; continue; }
    if (name === '--allow-unchecked-installer') { options.allowUncheckedInstaller = true; continue; }
    const field = WITH_VALUE.get(name);
    const value = argv[index + 1];
    if (!field || value === undefined || value.startsWith('--')) throw new ToolError(`${USAGE}\n\nUnknown option or missing value: ${name}`, 2);
    options[field] = value;
    index += 1;
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.help) { console.log(USAGE); process.exit(0); }
  const keyFile = options.keyFile ?? (process.env[KEY_PATH_VARIABLE] || undefined);
  if (!options.tag) throw new ToolError(`${USAGE}\n\nGive the release with --tag.`, 2);
  if (!keyFile) throw new ToolError(`${USAGE}\n\nGive the private key with --key (or ${KEY_PATH_VARIABLE}).`, 2);
  const signed = await signRelease({
    ...options, keyFile, passphrase: process.env[KEY_PASSPHRASE_VARIABLE] || null, releaseBase: options.releaseBase ?? null, extraRoots: [REPOSITORY],
  });
  const { manifest } = signed;
  console.log([
    `release:    ${manifest.version}   commit ${manifest.commit}   (${signed.fetched ? `fetched for ${options.tag}` : 'from the file you gave'})`,
    ...manifest.assets.map((asset) => `asset:      ${asset.name}   ${asset.bytes} bytes   sha256 ${asset.sha256}`),
    `installer:  ${signed.installerChecked ? 'the file you gave is the one the manifest lists' : 'NOT compared (you chose --allow-unchecked-installer): compare the sha256 above with the Publish run yourself'}`,
    `key:        ${signed.kid}   (${signed.listed ? 'listed in the key file' : 'NOT listed in the key file: installed apps will reject this signature'})`,
    `signature:  ${signed.outFile}   (checked against the key that made it)`,
    ...(signed.fetched ? [`manifest:   ${path.join(path.dirname(signed.outFile), 'RELEASE-MANIFEST.json')}   (the bytes that were signed)`] : []),
    '',
    'Nothing was uploaded. Compare the sha256 above with the Publish run first; then, to publish the signature, run:',
    '',
    `  ${signed.command}`,
    '',
    'Add --clobber to replace a signature that is already on the release. A release without a valid signature is never offered for download by the app.',
  ].join('\n'));
} catch (error) {
  if (error instanceof ToolError) { console.error(error.message); process.exit(error.exitCode); }
  console.error(`Unexpected failure (${error?.code ?? error?.name ?? 'error'}); nothing was uploaded.`);
  process.exit(1);
}
