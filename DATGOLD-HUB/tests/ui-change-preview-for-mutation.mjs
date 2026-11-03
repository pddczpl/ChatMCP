// Runs the UI unit tests of the part of the approval card that reads the request (ui/src/lib/change-preview.ts) so that tests/mutation/run-mutations.mjs can break that code on purpose and
// see whether they notice: tests/mutation/change-preview.json names this file as its suite. It is not a verify-*.mjs suite: run-all does not run it, `npm run test:unit` in ui/ already
// runs these tests with all the others.
//
// The code under test imports types only and the test imports the planners of the Hub, so the copy of the Hub that the runner makes needs no node_modules.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'ui');
// The TAP reporter prints "not ok" lines, which the mutation tool lists as the checks that noticed a mutation.
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', 'tests/change-preview.test.mjs'], { cwd: ui, stdio: 'inherit', windowsHide: true });
if (run.error) console.error(`could not run the UI tests: ${run.error.message}`);
process.exit(run.status ?? 1);
