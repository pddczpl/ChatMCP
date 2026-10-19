// Source lint for the "escaped newline swallowed by a comment" defect class.
//
// A physical source line that contains the two characters backslash + n followed by indentation and a // comment is almost always a
// block of code that was pasted with literal escape sequences: everything after the first // is a comment, so the statements that
// follow silently do not exist. v3.9.0 lost every installed skill this way (lib/agent.mjs, context.skillContext).
//
// The gate scans lib/**/*.mjs and hub.mjs. A negative control writes a file that contains the pattern into a temporary folder and
// requires the scanner to flag it, so the scanner cannot rot into a check that matches nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// literal backslash, the letter n, at least one space or tab, then a // comment opener
const SWALLOWED_NEWLINE = new RegExp(String.raw`\\n[ \t]+//`);

async function* walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* walk(full); }
    else if (entry.name.endsWith('.mjs')) yield full;
  }
}

export async function scan(files) {
  const matches = [];
  for (const file of files) {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (SWALLOWED_NEWLINE.test(line)) matches.push({ file, line: index + 1, text: line.trim().slice(0, 120) });
    });
  }
  return matches;
}

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const files = [path.join(hubRoot, 'hub.mjs')];
for await (const file of walk(path.join(hubRoot, 'lib'))) files.push(file);
const found = await scan(files);
for (const match of found) console.log(`  not ok - ${path.relative(hubRoot, match.file)}:${match.line} ${match.text}`);
assert.equal(found.length, 0, `${found.length} source line(s) contain a literal backslash-n followed by spaces and "//"`);
ok(`no swallowed-newline lines in ${files.length} source files`);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-lint-control-'));
try {
  const seeded = path.join(temp, 'seeded.mjs');
  await fs.writeFile(seeded, 'const a = 1;\n        // note' + String.fromCharCode(92) + 'n        // swallowed\n        const b = 2;\n');
  const control = await scan([seeded]);
  assert.equal(control.length, 1, 'the scanner must flag the seeded violation');
  assert.equal(control[0].line, 2);
  const clean = path.join(temp, 'clean.mjs');
  await fs.writeFile(clean, "const text = 'a' + String.fromCharCode(10);\n// a normal comment\nconst url = 'http://example.test/a\\n';\n");
  assert.equal((await scan([clean])).length, 0, 'ordinary escapes and comments must not be flagged');
  ok('negative control: a seeded backslash-n-then-comment line is flagged, ordinary code is not');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

console.log(`PASS: ${checks} source lint checks`);
