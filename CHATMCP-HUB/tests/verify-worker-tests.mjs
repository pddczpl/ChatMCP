import assert from 'node:assert/strict';
import { WorkerTestBroker } from '../lib/worker-test-broker.mjs';
import { hashCheck, verificationIsFresh, parseNodeTapSummary, recordVerificationAttempt } from '../lib/verification-receipt.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const work=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-worker-test-'));
await fs.writeFile(path.join(work,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
await fs.mkdir(path.join(work,'test'));
const testPath=path.join(work,'test','math.test.mjs');
const initialTest="import { test } from 'node:test'; test('math',()=>{});\n";
await fs.writeFile(testPath,initialTest);
const registry = { get: name => name === 'windows-sandbox' ? {
  async probe() { return { available:false,osIsolated:true,enforcedLimits:[],reasons:['No attested guest publisher'] }; },
  async execute() { throw new Error('MUST_NOT_EXECUTE'); },
} : null };
const worker = {
  id:'worker-a', workspace:work, files:['package.json','test/math.test.mjs'], baseSha:'a'.repeat(40),
  parentPolicy:'review', capabilities:{ checksRun:true },
  async checks() { return { suggested:[{from:'package.json',command:'npm test'}] }; },
};
const broker=new WorkerTestBroker({
  resolveWorker:async id=> id===worker.id ? worker : null, registry,
  authorizeGrant:async ()=>({ approved:true }),
  snapshotFactory:async()=>({ snapshotId:'s1', contentHash:'f'.repeat(64), manifest:{}, directory:'/unused' }),
});
const [descriptor] = await broker.discoverChecks({workerId:'worker-a'});
assert.equal(descriptor.checkHash,hashCheck(descriptor));
const grant=await broker.issueGrant({workerId:'worker-a',checkId:descriptor.id});
const result=await broker.requestCheck({workerId:'worker-a',checkId:descriptor.id,grantId:grant.id});
assert.equal(result.status,'isolation_unavailable');
assert.equal(result.commandSucceeded,false);
assert.equal(result.testOutcomeVerified,false);
assert.equal(broker.listAttempts({workerId:'worker-a'}).length,1);
assert.ok(verificationIsFresh(result,{snapshotHash:'f'.repeat(64),checkHash:descriptor.checkHash,sourceHash:descriptor.sourceHash}));
await assert.rejects(broker.requestCheck({workerId:'other',checkId:descriptor.id,grantId:grant.id}),/worker/i);
await fs.writeFile(testPath,"import { test } from 'node:test'; test('disabled',()=>{});\n");
await assert.rejects(broker.requestCheck({workerId:'worker-a',checkId:descriptor.id,grantId:grant.id}),/check|test|stale/i);
await fs.writeFile(testPath,initialTest);
// A changed test definition must revoke the immutable check approval even
// when the suggested shell command string ("npm test") is unchanged.
await fs.writeFile(path.join(work,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
await assert.rejects(broker.requestCheck({workerId:'worker-a',checkId:descriptor.id,grantId:grant.id}),/definition|check|grant/i);
broker.revokeGrant(grant.id);
await assert.rejects(broker.requestCheck({workerId:'worker-a',checkId:descriptor.id,grantId:grant.id}),/grant/i);
worker.parentPolicy='readonly';
await assert.rejects(broker.issueGrant({workerId:'worker-a',checkId:descriptor.id}),/authority/i);
worker.parentPolicy='review'; worker.revoked=true;
await assert.rejects(broker.issueGrant({workerId:'worker-a',checkId:descriptor.id}),/authority/i);
// A revoked immutable grant must never dispatch after an asynchronous OS probe.
await fs.writeFile(path.join(work,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
worker.revoked=false;worker.parentPolicy='autonomous';
let lateDispatches=0;
let liveGrant;
let liveBroker;
liveBroker=new WorkerTestBroker({
  resolveWorker:async id=>id===worker.id?worker:null,
  authorizeGrant:async()=>({approved:true}),
  snapshotFactory:async()=>({
    snapshotId:'late-fixture',contentHash:'f'.repeat(64),
    manifest:{files:[]},directory:'/unused',
  }),
  registry:{get:()=>({
    async probe(){
      // Simulates an owner revoking the grant while Windows is probing.
      liveBroker.revokeGrant(liveGrant.id);
      return {available:true,osIsolated:true,enforcedLimits:['timeoutSeconds','maxOutputBytes'],reasons:[]};
    },
    async execute(){lateDispatches++;throw new Error('must not execute after revoke');},
  })},
});
const [lateCheck]=await liveBroker.discoverChecks({workerId:worker.id});
liveGrant=await liveBroker.issueGrant({workerId:worker.id,checkId:lateCheck.id});
await assert.rejects(
  liveBroker.requestCheck({workerId:worker.id,checkId:lateCheck.id,grantId:liveGrant.id}),
  {code:'stale_grant'}
);
assert.equal(lateDispatches,0,'No isolated guest starts with an asynchronously revoked grant');
// A parent policy downgrade while probing must also block dispatch.
let downgradeDispatches=0;
const downgraded=new WorkerTestBroker({
  resolveWorker:async id=>id===worker.id?worker:null,
  authorizeGrant:async()=>({approved:true}),
  snapshotFactory:async()=>({snapshotId:'downgrade',contentHash:'f'.repeat(64),manifest:{files:[]},directory:'/unused'}),
  registry:{get:()=>({
    async probe(){
      worker.parentPolicy='readonly';
      return {available:true,osIsolated:true,enforcedLimits:['timeoutSeconds','maxOutputBytes']};
    },
    async execute(){downgradeDispatches++;throw new Error('must not execute after downgrade');}
  })},
});
const [downgradeCheck]=await downgraded.discoverChecks({workerId:worker.id});
const downgradeGrant=await downgraded.issueGrant({workerId:worker.id,checkId:downgradeCheck.id});
await assert.rejects(
  downgraded.requestCheck({workerId:worker.id,checkId:downgradeCheck.id,grantId:downgradeGrant.id}),
  {code:'worker_permission_denied'}
);
assert.equal(downgradeDispatches,0,'No isolated execution after parent policy downgrade');
await fs.rm(work,{recursive:true,force:true});
const tap='TAP version 13\n# Subtest: basic\nok 1 - basic\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 4\n';
assert.equal(parseNodeTapSummary(tap)?.tests,1);
assert.equal(parseNodeTapSummary(tap.replace('# fail 0','# fail 1')),null);
assert.equal(parseNodeTapSummary('TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0'),null);
const timestamp=new Date().toISOString();
const sourceReceipt={
  runId:'signed-check',backend:'windows-sandbox',status:'completed',exitCode:0,
  stdout:tap,stderr:'',startedAt:timestamp,completedAt:timestamp,durationMs:2,
  truncated:false,snapshotHash:'f'.repeat(64),checkHash:descriptor.checkHash,
};
const sourceDescriptor={...descriptor,runId:'signed-check'};
const fixtureEvidence=recordVerificationAttempt({
  descriptor:sourceDescriptor,snapshot:{contentHash:'f'.repeat(64)},grantId:grant.id,
  execution:{...sourceReceipt,publisherAuthenticated:true,provenance:'publisher_authenticated'},
  attempt:1,
});
assert.equal(fixtureEvidence.testOutcomeVerified,true);
assert.equal(fixtureEvidence.parsedAssertions.pass,1);
const unsignedEvidence=recordVerificationAttempt({
  descriptor:sourceDescriptor,snapshot:{contentHash:'f'.repeat(64)},grantId:grant.id,
  execution:{...sourceReceipt,publisherAuthenticated:false},attempt:1,
});
assert.equal(unsignedEvidence.testOutcomeVerified,false);
console.log('PASS: scoped check grants, changed script denial, authentic positive TAP parsing and zero-test rejection');
