// Runs the UI unit tests of the rollback plans (ui/src/lib/rollback.ts) so that tests/mutation/run-mutations.mjs can break that code on purpose and see whether they notice:
// tests/mutation/rollback-plan.json names this file as its suite. It is not a verify-*.mjs suite: run-all does not run it. The code under test imports no package, so the copy of the Hub
// that the runner makes needs no node_modules.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'ui');
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', 'tests/rollback.test.mjs'], { cwd: ui, stdio: 'inherit' });
process.exit(run.status ?? 1);
