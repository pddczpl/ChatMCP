// The CHATMCP_REQUIRE_REAL_LSP gate of tests/verify-lsp-tier.mjs.
//
// verify-lsp-tier.mjs always runs against a protocol-faithful stub and, when it finds them, also against the real typescript-language-server
// and pyright. Without the gate a missing real server is one "skip" line in a run that still prints PASS, so a CI job that was meant to
// run them could silently lose them. CI sets CHATMCP_REQUIRE_REAL_LSP=1 together with CHATMCP_LSP_NODE_MODULES (the staged runtime), and a
// real server that cannot be found must then fail the suite. This suite runs the real script as a child process in each situation and
// reads its exit code and output. What it cannot do is start the real servers: for the positive case the stub fills the real slots, so
// it proves the gate and the accounting, not the servers (the run in CI and tests/verify-lsp-tier.mjs with CHATMCP_LSP_NODE_MODULES do).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TIER = path.join(here, 'verify-lsp-tier.mjs');
const STUB = path.join(here, 'fixtures', 'stub-lsp-server.mjs');
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-lsp-gate-'));
const nothingGlobal = path.join(root, 'no-global-npm');
await fs.mkdir(nothingGlobal);

/** Runs verify-lsp-tier.mjs with exactly these variables; no global npm install can be found by it. */
function runTier(variables) {
  const env = { ...process.env, APPDATA: nothingGlobal, npm_config_prefix: nothingGlobal, ...variables };
  for (const name of ['CHATMCP_REQUIRE_REAL_LSP', 'CHATMCP_LSP_NODE_MODULES']) if (!(name in variables)) delete env[name];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TIER], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function modulesWith(name, packages) {
  const modules = path.join(root, name, 'node_modules');
  await fs.mkdir(modules, { recursive: true });
  for (const [entry, content] of Object.entries(packages)) {
    await fs.mkdir(path.dirname(path.join(modules, entry)), { recursive: true });
    if (content === 'stub') await fs.copyFile(STUB, path.join(modules, entry));
    else await fs.writeFile(path.join(modules, entry), content);
  }
  return modules;
}

const TS_SERVER = 'typescript-language-server/lib/cli.mjs';
const TSSERVER = 'typescript/lib/tsserver.js';
const PYRIGHT = 'pyright/langserver.index.js';

try {
  // 1. required, nothing there: fails at once, names every missing package and the variable
  {
    const empty = await modulesWith('empty', {});
    const { code, output } = await runTier({ CHATMCP_REQUIRE_REAL_LSP: '1', CHATMCP_LSP_NODE_MODULES: empty });
    assert.notEqual(code, 0, `a required real server that is missing must fail the suite:\n${output}`);
    assert.match(output, /CHATMCP_REQUIRE_REAL_LSP/);
    for (const missing of ['typescript-language-server', 'typescript (', 'pyright']) assert.ok(output.includes(missing), `the failure must name ${missing}:\n${output}`);
    assert.ok(output.includes(empty), 'the failure must say where it looked');
    assert.doesNotMatch(output, /^PASS:/m);
    ok('CHATMCP_REQUIRE_REAL_LSP=1 with an empty runtime folder fails and names the three missing packages and the folder');
  }

  // 2./3. required, one of the two servers missing: fails and names only that one
  {
    const onlyPyright = await modulesWith('only-pyright', { [PYRIGHT]: '// not started: the gate fails first\n' });
    const first = await runTier({ CHATMCP_REQUIRE_REAL_LSP: '1', CHATMCP_LSP_NODE_MODULES: onlyPyright });
    assert.notEqual(first.code, 0, first.output);
    assert.ok(first.output.includes('typescript-language-server') && first.output.includes('typescript ('), first.output);
    assert.ok(!first.output.includes('pyright ('), `pyright is there and must not be reported missing:\n${first.output}`);
    ok('required with pyright present and TypeScript missing: fails, reports TypeScript only');

    const onlyTypeScript = await modulesWith('only-typescript', { [TS_SERVER]: '// not started\n', [TSSERVER]: '// not started\n' });
    const second = await runTier({ CHATMCP_REQUIRE_REAL_LSP: '1', CHATMCP_LSP_NODE_MODULES: onlyTypeScript });
    assert.notEqual(second.code, 0, second.output);
    assert.ok(second.output.includes('pyright ('), second.output);
    assert.ok(!second.output.includes('typescript-language-server ('), second.output);
    ok('required with TypeScript present and pyright missing: fails, reports pyright only');
  }

  // 4. not required: a missing real server stays a skip (a developer without the runtime still gets the stub run)
  {
    const empty = await modulesWith('empty-optional', {});
    const { code, output } = await runTier({ CHATMCP_LSP_NODE_MODULES: empty });
    assert.equal(code, 0, `without the variable a missing real server is only skipped:\n${output}`);
    assert.match(output, /^\s*skip - /m);
    assert.match(output, /^PASS: \d+ LSP tier checks \(real typescript-language-server: skipped, real pyright: skipped\)/m);
    ok('without CHATMCP_REQUIRE_REAL_LSP a missing real server is a skip line, the summary says skipped, the exit code is 0');
  }

  // 5. required and present: the real part runs, nothing is skipped, the summary says ran (stub files stand in for the packages)
  {
    const present = await modulesWith('present', { [TS_SERVER]: 'stub', [TSSERVER]: '// tsserver slot, not used by the stand-in\n', [PYRIGHT]: 'stub' });
    const { code, output } = await runTier({ CHATMCP_REQUIRE_REAL_LSP: '1', CHATMCP_LSP_NODE_MODULES: present });
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /^\s*skip - /m);
    assert.match(output, /real typescript-language-server answers find_definition and find_references/);
    assert.match(output, /real pyright-langserver answers find_definition/);
    assert.match(output, /^PASS: \d+ LSP tier checks \(real typescript-language-server: ran, real pyright: ran\)/m);
    ok('required and both servers present: both real sections run, no skip line, the summary says ran');
  }
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

console.log(`PASS: ${checks} LSP real-server gate checks`);
process.exit(0);
