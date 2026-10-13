import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const text=execFileSync(process.execPath,
  ['tests/benchmarks/phase3-multiagent.mjs'],{
    cwd:process.cwd(),encoding:'utf8',timeout:30000,maxBuffer:100000,
  });
const report=JSON.parse(text);
assert.equal(report.schema,1);
assert.equal(report.phase,3);
assert.equal(report.total,9);
assert.equal(report.passed,9);
assert.equal(report.modelRequests,0);
assert.equal(report.networkRequests,0);
assert.equal(report.hostCommandExecutions,0);
assert.equal(report.windowsGuestAttested,false);
console.log('PASS: Phase3 nine deterministic planning/concurrency/failure benchmark cases; no model or host tools');
