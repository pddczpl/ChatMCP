#!/usr/bin/env node
// Runs UI unit tests (ui/tests/*.test.mjs) with Node's own test runner, so that tests/mutation/run-mutations.mjs - which runs a file of this folder in a copy of the Hub folder -
// can judge them. A mutation list for a pure function of the page (ui/src/lib/*.ts) names this file as its suite.
//
// It is not a verify-*.mjs suite on purpose: run-all.mjs does not run it, `npm run test:unit` in ui/ already runs these tests with all the others. The tests it can run must need
// nothing from node_modules (the mutation tool does not copy it): the ones that import only TypeScript files of ui/src do, the ones that bundle React components do not.
//
// Usage: node tests/ui-unit-for-mutation.mjs [ui/tests/file.test.mjs ...]   (default: the tests of the tool-call view logic)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const DEFAULT_TESTS = ['tests/task-view.test.mjs', 'tests/format.test.mjs'];

const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_TESTS;
// The TAP reporter prints "not ok" lines, which the mutation tool lists as the checks that noticed a mutation.
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...files], { cwd: UI, stdio: 'inherit', windowsHide: true });
if (run.error) console.error(`could not run the UI tests: ${run.error.message}`);
process.exit(run.status ?? 1);
