// lib/proof/tree-snapshot.mjs, property test on an 8,002-file committed repository (P4 pod-15).
//
// 200 random operations (create, edit, same-size edit, delete, rename, .gitignore on and off) on top of a commit. After every one the
// engine's cached snapshot equals the reference (plain `git add -A && git write-tree` in a throw-away index,
// tests/support/proof-tree-fixtures.mjs); every 50 steps a full snapshot, its rawTree and a fresh reference index agree too, and every
// 25 steps a cached raw-v1 snapshot.
import { generateRepo, propertyTest } from './support/proof-tree-fixtures.mjs';

setTimeout(() => { console.error('FAIL: the proof tree property suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const started = performance.now();
const repo = generateRepo('big', 8002, 8002, { commit: true });
const generated = Math.round(performance.now() - started);
const counts = await propertyTest(repo, { steps: 200, fullEvery: 50, rawEvery: 25, label: '8,002 files' });
console.log(`  ok - property test, 8,002 committed files (generated in ${generated} ms), 200 steps ${JSON.stringify(counts)}: every cached, full, raw and raw-v1 snapshot equals the reference [${Math.round(performance.now() - started)} ms]`);
console.log('verify-proof-tree-property-8k: 1 check passed');
