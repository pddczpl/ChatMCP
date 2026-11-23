// Runs the UI unit tests of the page's API client (ui/src/lib/api.ts, ui/tests/api.test.mjs) so that tests/mutation/run-mutations.mjs can break the plan
// calls of P9 ac-10 (the feedback of a denial, decidePlan, savePlan's baseRevision) and the deny handler of ConversationView on purpose and see whether
// they notice: tests/mutation/plan-ui.json names this file as its suite. It is not a verify-*.mjs suite: run-all does not run it (`npm run test:unit` in
// ui/ runs these tests with all the others). api.ts imports no package, so the copy of the Hub that the runner makes needs no node_modules.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'ui');
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', 'tests/api.test.mjs'], { cwd: ui, stdio: 'inherit', windowsHide: true });
if (run.error) console.error(`could not run the UI tests: ${run.error.message}`);
process.exit(run.status ?? 1);
