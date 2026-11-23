// Runs the UI unit tests of the logic of the plan-mode page (P9 ac-11: ui/src/lib/plan-draft.ts and plan-view.ts, and the feedback of an answered request in
// task-view.ts) so that tests/mutation/run-mutations.mjs can break it on purpose and see whether they notice: tests/mutation/plan-view.json names this file as its
// suite. It is not a verify-*.mjs suite: run-all does not run it (`npm run test:unit` in ui/ runs these tests with all the others). The two test files import only
// TypeScript files of ui/src/lib, so the copy of the Hub that the runner makes needs no node_modules.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'ui');
const files = ['tests/plan-draft.test.mjs', 'tests/plan-view.test.mjs'];
// The TAP reporter prints "not ok" lines, which the mutation tool lists as the checks that noticed a mutation.
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...files], { cwd: ui, stdio: 'inherit', windowsHide: true });
if (run.error) console.error(`could not run the UI tests: ${run.error.message}`);
process.exit(run.status ?? 1);
