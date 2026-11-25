#!/usr/bin/env node
// `chatmcp verify`: the command line of Proof-of-Done (docs/PROOF-CLI.md). Exit codes: 0 pass, 1 unverified or failed, 2 usage,
// 3 integrity failure, 4 environment. The CLI makes no network calls; its state is in CHATMCP_STATE_DIR, else the Hub's data folder.
import { main } from '../lib/proof/cli/index.mjs';
import { searchProgramsOnPathOnly } from '../lib/runtime.mjs';

searchProgramsOnPathOnly(); // this process stands in the workspace

const code = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });
process.exitCode = code;
// The answer is written; a handle a module left open must not keep the process (and a script waiting for it) alive.
setTimeout(() => process.exit(code), 10_000).unref();
