import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const output=execFileSync(process.execPath,['tests/benchmarks/run-offline.mjs'],{
  cwd:process.cwd(),encoding:'utf8',timeout:30000,maxBuffer:128000,
});
const report=JSON.parse(output);
assert.equal(report.total,7);
assert.equal(report.passed,7);
assert.equal(report.modelRequests,0);
assert.equal(report.hostCommandExecutions,0);
console.log('PASS: seven deterministic no-network Phase 1 benchmark outcomes');
