#!/usr/bin/env node
// Makes the key that signs releases of DatGold Studio (ECDSA P-256), for the owner, by hand:
//
//     node scripts/new-release-key.mjs <path of the private key file to create>
//
// The path must be OUTSIDE every Git work tree, the file must not exist (it is never overwritten) and only your Windows account can open it: the file is made empty, restricted with icacls, and only then
// written. Make it in a folder that only you can open (a folder under your own profile is one), on a disk with NTFS permissions (an exFAT or FAT32 drive has no access list, and the tool refuses to make the
// key there), and then move it to the place you keep it offline: a copy that is kept elsewhere has the access list of that place, which is yours to look after. A passphrase can protect it: set DATGOLD_RELEASE_KEY_PASSPHRASE in the environment (never on the command line).
//
// It prints the key id and the public key and the entry for DATGOLD-HUB/lib/release-keys.json, which replaces the placeholder there (a small pull request). It NEVER prints the private key.
// Exit code: 0 when the key was made, 1 when it was refused (nothing is left behind), 2 for a bad use.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_PASSPHRASE_VARIABLE, ToolError, createReleaseKey } from '../DATGOLD-HUB/tools/release-tools.mjs';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = [
  'usage: node scripts/new-release-key.mjs <path of the private key file to create>',
  '',
  '  The path must be outside every Git work tree, and the file must not exist.',
  `  A passphrase can protect the file: set ${KEY_PASSPHRASE_VARIABLE} in the environment.`,
].join('\n');

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); process.exit(0); }
if (args.length !== 1 || args[0].startsWith('-')) { console.error(USAGE); process.exit(2); }

try {
  const made = await createReleaseKey({ file: args[0], passphrase: process.env[KEY_PASSPHRASE_VARIABLE] || null, extraRoots: [REPOSITORY] });
  console.log([
    'A P-256 release key was made.',
    '',
    `key id (kid):  ${made.kid}`,
    'public key (base64 SPKI):',
    made.spki,
    '',
    'Entry for DATGOLD-HUB/lib/release-keys.json (replace the placeholder with it, in a small pull request):',
    JSON.stringify(made.entry, null, 2),
    '',
    `The private key is in ${made.file}${made.encrypted ? ' (protected by the passphrase you gave)' : ''}. It is the one secret of the update system: whoever has it can make every installed copy download their program.`,
    '  - Keep it OFFLINE (a drive you do not leave plugged in), with a copy in a second place. Never in the repository, never in CI, never in a chat.',
    '  - If it is lost, installed copies cannot be updated by the button until their owners install a new version by hand. So make a second key now (run this again with another path) and put',
    '    its entry in the key file as the next key: a release signed with it then verifies on copies that were installed before, and a rotation does not need a new installer first.',
    '  - Then sign a release with scripts/sign-release.mjs after the Publish workflow has run. That script prints the command that uploads the signature; it never runs it.',
  ].join('\n'));
} catch (error) {
  if (error instanceof ToolError) { console.error(error.message); process.exit(error.exitCode); }
  console.error(`Unexpected failure (${error?.code ?? error?.name ?? 'error'}); nothing was printed that could be a key.`);
  process.exit(1);
}
