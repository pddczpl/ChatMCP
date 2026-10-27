#!/usr/bin/env node
// Makes the two throwaway keys of the end-to-end proof of the in-app updater (scripts/new-release-key.mjs does the work) in a folder outside every Git work tree, and writes keys.json beside them:
//
//     node scripts/tests/updater-e2e/make-keys.mjs <folder>
//
// `run` is the key the test builds trust (its key list is what Build-Installer.ps1 -ReleaseKeysFile is given) and the manifest is signed with; `other` is a key that nothing trusts. The private keys stay in
// the folder, restricted to this account by the tool; only their paths and the public key lists are in keys.json. Nothing here is a release key and nothing is published.
import fs from 'node:fs';
import path from 'node:path';
import { makeTestKeys } from './release-files.mjs';

const folder = process.argv[2];
if (process.argv.length !== 3 || !folder || folder.startsWith('-')) { console.error('usage: node scripts/tests/updater-e2e/make-keys.mjs <folder outside every Git work tree>'); process.exit(2); }
try {
  const keys = await makeTestKeys(path.resolve(folder));
  fs.writeFileSync(path.join(path.resolve(folder), 'keys.json'), `${JSON.stringify(keys, null, 2)}\n`);
  console.log(`run key ${keys.run.kid}: key list ${keys.run.listFile}`);
  console.log(`other key ${keys.other.kid}: key list ${keys.other.listFile}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
