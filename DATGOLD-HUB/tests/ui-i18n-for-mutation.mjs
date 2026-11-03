// Runs the UI unit tests of the i18n code (the lint, the plural forms, the language of the page, the date helpers) so that tests/mutation/run-mutations.mjs
// can break that code on purpose and see whether they notice: tests/mutation/i18n-lint.json names this file as its suite. It is not a verify-*.mjs suite:
// run-all does not run it.
//
// The runner works in a copy of the Hub that has no node_modules, and the lint reads the source with the TypeScript parser, so the copy borrows that one package
// from the folder it was made from (the runner says which, in CHATMCP_MUTATION_SOURCE). Outside the runner this file runs the tests of the folder it is in.
// The tests that bundle components with esbuild (the store, translate) are not run here: they need the whole of node_modules.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.CHATMCP_MUTATION_SOURCE ? path.resolve(process.env.CHATMCP_MUTATION_SOURCE) : hub;
const ui = path.join(hub, 'ui');
const package_ = path.join(ui, 'node_modules', 'typescript');

if (!existsSync(package_)) {
  const borrowed = path.join(source, 'ui', 'node_modules', 'typescript');
  if (!existsSync(borrowed)) {
    console.log(`CHATMCP_TEST_SKIP: ${borrowed} is missing (run npm ci in DATGOLD-HUB/ui)`);
    process.exit(0);
  }
  cpSync(borrowed, package_, { recursive: true });
}

const files = ['tests/i18n-lint.test.mjs', 'tests/plural.test.mjs', 'tests/document-language.test.mjs', 'tests/format.test.mjs', 'tests/format-date.test.mjs'];
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...files], { cwd: ui, stdio: 'inherit' });
process.exit(run.status ?? 1);
