import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {summarizeParityBenchmark} from '../lib/parity-benchmark.mjs';
const output=execFileSync(process.execPath,['tests/benchmarks/run-offline.mjs'],{
  cwd:process.cwd(),encoding:'utf8',timeout:30000,maxBuffer:128000,
});
const report=JSON.parse(output);
assert.equal(report.total,7);
assert.equal(report.passed,7);
assert.equal(report.modelRequests,0);
assert.equal(report.hostCommandExecutions,0);
console.log('PASS: seven deterministic no-network Phase 1 benchmark outcomes');

const fixture=(id,bGrade,cGrade,br,cr)=>({
  id,baseline:{grade:bGrade,httpRequests:br,inputTokens:1000,outputTokens:500,durationMs:60000},
  candidate:{grade:cGrade,httpRequests:cr,inputTokens:900,outputTokens:400,durationMs:90000},
});
const parity=summarizeParityBenchmark({schema:1,cases:[
  fixture('a','pass','pass',5,4),fixture('b','pass','fail',5,4),
]});
assert.equal(parity.total,2);
assert.equal(parity.baseline.passRate,1);
assert.equal(parity.candidate.passRate,0.5);
assert.equal(parity.relativeSuccessRate,0.5);
assert.equal(parity.independentValidation,false);
assert.equal(parity.comparisonAdequacy,'insufficient-sample-size');
assert.throws(()=>summarizeParityBenchmark({schema:1,cases:[fixture('a','pass','pass',1,1),fixture('a','pass','pass',2,2)]}),/duplicate/);
assert.throws(()=>summarizeParityBenchmark({schema:1,cases:[fixture('a','pass','pass',-1,1)]}),/Invalid baseline.httpRequests/);
console.log('PASS: parity comparison aggregates usage without asserting independent correctness or executing paid models');
