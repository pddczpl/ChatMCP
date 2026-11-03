// Runs the UI unit tests of the logic of the Review tab that is not the hunk model (ui/src/lib/review-accepted.ts, review-rules.ts, review-actions.ts, review-source-task.ts and
// review-offer.ts) so that tests/mutation/run-mutations.mjs can break that code on purpose and see whether they notice: tests/mutation/review-state.json names this file as its suite.
// It is not a verify-*.mjs suite: run-all does not run it, `npm run test:unit` in ui/ already runs these tests with all the others.
//
// The runner works in a copy of the Hub that has no node_modules, and the code under test imports the hunk model, which compares lines with the `diff` package, so the copy borrows that
// one package from the folder it was made from (the runner says which, in CHATMCP_MUTATION_SOURCE). Outside the runner this file runs the tests of the folder it is in.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.CHATMCP_MUTATION_SOURCE ? path.resolve(process.env.CHATMCP_MUTATION_SOURCE) : hub;
const ui = path.join(hub, 'ui');
const package_ = path.join(ui, 'node_modules', 'diff');

if (!existsSync(package_)) {
  const borrowed = path.join(source, 'ui', 'node_modules', 'diff');
  if (!existsSync(borrowed)) {
    console.log(`CHATMCP_TEST_SKIP: ${borrowed} is missing (run npm ci in DATGOLD-HUB/ui)`);
    process.exit(0);
  }
  cpSync(borrowed, package_, { recursive: true });
}

const files = ['tests/review-accepted.test.mjs', 'tests/review-rules.test.mjs', 'tests/review-actions.test.mjs', 'tests/review-source-task.test.mjs', 'tests/review-offer.test.mjs'];
// The TAP reporter prints "not ok" lines, which the mutation tool lists as the checks that noticed a mutation.
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...files], { cwd: ui, stdio: 'inherit', windowsHide: true });
if (run.error) console.error(`could not run the UI tests: ${run.error.message}`);
process.exit(run.status ?? 1);
