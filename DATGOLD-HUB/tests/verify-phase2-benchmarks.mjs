import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const output=execFileSync(process.execPath,
  ['tests/benchmarks/phase2-reliability.mjs'],{
    cwd:process.cwd(),encoding:'utf8',timeout:30000,maxBuffer:100000,
  });
const report=JSON.parse(output);
assert.equal(report.phase,2);
assert.equal(report.schema,1);
assert.equal(report.total,9);
assert.equal(report.passed,9);
assert.equal(report.modelRequests,0);
assert.equal(report.hostCommandExecutions,0);
assert.equal(report.networkRequests,0);
assert.equal(report.windowsGuestAttested,false);
console.log('PASS: nine Phase2 crash, journal, secret-safe context benchmark cases without provider or host tools');
