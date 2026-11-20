// lib/proof/tree-snapshot.mjs, property test on a 663-file repository of untracked files (P4 pod-15).
//
// 200 random operations (create, edit, same-size edit, delete, rename, .gitignore on and off). After every one the engine's cached
// snapshot equals the reference (plain `git add -A && git write-tree` in a throw-away index, tests/support/proof-tree-fixtures.mjs);
// every 20 steps a full snapshot, its rawTree and a fresh reference index agree too, and every 5 steps a cached raw-v1 snapshot.
// The files are untracked, so every blob is new to the repository. The 8,002-file run is tests/verify-proof-tree-property-8k.mjs.
import { generateRepo, propertyTest } from './support/proof-tree-fixtures.mjs';

setTimeout(() => { console.error('FAIL: the proof tree property suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const started = performance.now();
const repo = generateRepo('small', 663, 663, { commit: false });
const counts = await propertyTest(repo, { steps: 200, fullEvery: 20, rawEvery: 5, label: '663 files' });
console.log(`  ok - property test, 663 untracked files, 200 steps ${JSON.stringify(counts)}: every cached, full, raw and raw-v1 snapshot equals the reference [${Math.round(performance.now() - started)} ms]`);
console.log('verify-proof-tree-property: 1 check passed');
