import assert from 'node:assert/strict';
import { WorkerTestBroker } from '../lib/worker-test-broker.mjs';
import { hashCheck, verificationIsFresh } from '../lib/verification-receipt.mjs';
const registry = { get: name => name === 'windows-sandbox' ? {
  async probe() { return { available:false,osIsolated:true,enforcedLimits:[],reasons:['No attested guest publisher'] }; },
  async execute() { throw new Error('MUST_NOT_EXECUTE'); },
} : null };
const worker = {
  id:'worker-a', workspace:'/unused', files:['app.js'], baseSha:'a'.repeat(40),
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
broker.revokeGrant(grant.id);
await assert.rejects(broker.requestCheck({workerId:'worker-a',checkId:descriptor.id,grantId:grant.id}),/grant/i);
worker.parentPolicy='readonly';
await assert.rejects(broker.issueGrant({workerId:'worker-a',checkId:descriptor.id}),/authority/i);
worker.parentPolicy='review'; worker.revoked=true;
await assert.rejects(broker.issueGrant({workerId:'worker-a',checkId:descriptor.id}),/authority/i);
console.log('PASS: immutable check grants, revocation, parent permissions, missing isolated backend fail closed');
