// Executes the actual evaluation process, not just checks source strings.
// CLAIM: evaluation-cli
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './evaluate.mjs';
const suiteDir=path.dirname(fileURLToPath(import.meta.url));
const harness=path.join(suiteDir,'evaluate.mjs');
assert.ok(CASES.length>=9);
assert.equal(new Set(CASES.map(c=>c.id)).size,CASES.length);
const list=spawnSync(process.execPath,[harness,'--list'],{encoding:'utf8',timeout:10000});
assert.equal(list.status,0,list.stderr);
assert.match(list.stdout,/multiagent-code-dependencies/);
assert.match(list.stdout,/browser-verification/);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-evaluation-check-'));
try{
  const file=path.join(dir,'report.json');
  const result=spawnSync(process.execPath,[harness,'--case','provider-telemetry','--output',file],
    {encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  const report=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(report.cases.length,1);
  assert.equal(report.cases[0].evaluationId,'provider-telemetry');
  assert.equal(report.cases[0].outcome,'pass');
  assert.equal(report.cases[0].verification.reportedStatus,'PASS');
  assert.ok(report.cases[0].verification.evidenceDigest);
  assert.ok(report.cases[0].durationMs>=0);
  assert.equal(report.cases[0].tokenUsage,null);
  assert.equal(report.cases[0].costUsd,null);
  assert.equal(report.liveModelEvaluation.outcome,'not-run');
  assert.match(report.source.commit||'',/^[0-9a-f]{40}$/);
  const invalid=spawnSync(process.execPath,[harness,'--live'],{encoding:'utf8',timeout:10000});
  assert.equal(invalid.status,2);
  console.log('PASS reproducible external-process evaluation report, unknown usage, and no false live claims');
}finally{await fs.rm(dir,{recursive:true,force:true});}
