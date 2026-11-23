// The cross-system fixture of `chatmcp verify reproduce` (docs/PROOF-CLI.md, "reproduce"): a small project (BASE), the change an agent
// made to it (applyChange), and the packs that real sessions of the CLI made of that change, one per system that made one
// (`<platform>.pack.json` beside this file). tests/verify-proof-reproduce.mjs checks every committed pack and reproduces it on every CI
// system, so a pack made on Windows is reproduced on Linux, macOS and Windows.
//
// To make the pack of this system again (it replaces `<platform>.pack.json`):
//   node tests/fixtures/proof-reproduce/fixture.mjs --write
// The project has no dependency but Node.js; its checks are `node <file>` commands, which every shell the CLI runs reads the same way.
// The files are written from the strings here (LF line ends, no executable bit), so a checkout's line-end settings cannot change them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ACCEPTANCE = [
  'version: 1',
  'criteria:',
  '  - id: unit',
  '    text: The unit test passes after the setup',
  '    checks:',
  '      - run: node test.mjs',
  '  - id: exit-code',
  '    text: The checker exits with the code it documents',
  '    checks:',
  '      - run: node lint.mjs',
  '        expect:',
  '          exit: 3',
  'reproduce:',
  '  setup:',
  '    - node setup.mjs',
  '',
].join('\n');

/** The project before the change: path -> content (a string is UTF-8 text, a Buffer is written as it is). */
export const BASE = Object.freeze({
  '.gitignore': 'build/\n',
  '.chatmcp/acceptance.yml': ACCEPTANCE,
  'src/add.mjs': 'export const add = (a, b) => a - b;\n',
  'src/data.bin': Buffer.from(Array.from({ length: 256 }, (_, byte) => byte)),
  'old.txt': 'This file is removed by the change.\n',
  'setup.mjs': "import fs from 'node:fs';\nfs.mkdirSync('build', { recursive: true });\nfs.writeFileSync('build/ready.txt', 'ready\\n');\nconsole.log('setup done');\n",
  'test.mjs': [
    "import fs from 'node:fs';",
    "import { add } from './src/add.mjs';",
    "if (!fs.existsSync('build/ready.txt')) { console.error('run the setup first: node setup.mjs'); process.exit(2); }",
    "if (add(2, 3) !== 5) { console.error('add(2, 3) is not 5'); process.exit(1); }",
    "console.log('2 checks passed');",
    '',
  ].join('\n'),
  'lint.mjs': "console.log('3 findings, as documented');\nprocess.exit(3);\n",
});

/** What the agent changed: a fix, a binary file rewritten, a file added, a file removed. */
export const CHANGE = Object.freeze({
  write: Object.freeze({
    'src/add.mjs': 'export const add = (a, b) => a + b;\n',
    'src/data.bin': Buffer.from(Array.from({ length: 256 }, (_, byte) => 255 - byte)),
    'src/extra.mjs': 'export const extra = true;\n',
  }),
  remove: Object.freeze(['old.txt']),
});

/** Writes `files` (path -> content) under `root`. */
export function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** Applies the agent's change to a copy of BASE at `root`. */
export function applyChange(root) {
  writeFiles(root, CHANGE.write);
  for (const relative of CHANGE.remove) fs.rmSync(path.join(root, ...relative.split('/')));
}

/** The committed packs of this fixture: [{platform, file}]. */
export function committedPacks() {
  return fs.readdirSync(HERE).filter((name) => /^[a-z0-9]+\.pack\.json$/.test(name)).sort()
    .map((name) => ({ platform: name.slice(0, -'.pack.json'.length), file: path.join(HERE, name) }));
}

// ------------------------------------------------------------------------------------------------------------- making the pack
function makePack() {
  const bin = path.resolve(HERE, '..', '..', '..', 'bin', 'chatmcp.mjs');
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-fixture-')));
  const repo = path.join(scratch, 'project');
  const empty = path.join(scratch, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|CHATMCP_)/i.test(key)));
  Object.assign(env, { CHATMCP_STATE_DIR: path.join(scratch, 'state'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, GIT_TERMINAL_PROMPT: '0' });
  const run = (file, args, label) => {
    const result = spawnSync(file, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 && !label.allow?.includes(result.status)) throw new Error(`${label.name}: exit ${result.status}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const cli = (args, allow = [0]) => JSON.parse(run(process.execPath, [bin, 'verify', '--json', ...args], { name: `chatmcp verify ${args.join(' ')}`, allow }));
  try {
    fs.mkdirSync(repo);
    writeFiles(repo, BASE);
    const git = ['-c', 'user.name=Proof Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
    run('git', [...git, 'init', '-q'], { name: 'git init' });
    run('git', [...git, 'add', '-A'], { name: 'git add' });
    run('git', [...git, 'commit', '-q', '-m', 'the base of the fixture'], { name: 'git commit' });
    const preview = cli(['trust'], [1]);
    cli(['trust', '--sha256', preview.data.sha256]);
    cli(['snapshot']);
    run(process.execPath, ['setup.mjs'], { name: 'node setup.mjs' });
    cli(['run', '--', 'node test.mjs'], [1]); // before the fix, on the base tree: a receipt of another tree
    applyChange(repo);
    cli(['run', '--', 'node test.mjs']);
    cli(['run', '--', 'node lint.mjs'], [1]); // `run` passes exit 0 only; the pack holds it to the criterion's `expect: exit: 3`
    const pack = cli(['pack', '--agent', 'fixture-agent', '--agent-version', '1']);
    const target = path.join(HERE, `${process.platform}.pack.json`);
    fs.copyFileSync(pack.data.packFile, target);
    console.log(`wrote ${target} (${fs.statSync(target).size} bytes, statement ${pack.data.digest})`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--write')) {
    console.error('node tests/fixtures/proof-reproduce/fixture.mjs --write   makes the pack of this system again');
    process.exit(2);
  }
  makePack();
}
