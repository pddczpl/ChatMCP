// Runner wrapper for Windows Sandbox Smoke Suite to integrate with run-all.mjs.
// Runs all feasibility, preflight, Job Object boundary, and negative isolation tests.

import { runSmokeTests } from './windows-sandbox/smoke.mjs';

await runSmokeTests();
