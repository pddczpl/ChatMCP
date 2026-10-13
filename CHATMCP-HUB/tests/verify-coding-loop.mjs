import assert from 'node:assert/strict';
import { runVerifiedCoding, VERIFIED_CODING_DEFAULTS } from '../lib/coding-verification-loop.mjs';
assert.equal(VERIFIED_CODING_DEFAULTS.maxTestAttempts,3);
let hash = 'old', calls=0;
const broker = { async requestCheck({workerId,checkId}) {
  calls++;
  return { id:'r'+calls, workerId, checkId, snapshotHash:hash, status:calls===1?'failed':'completed',
    exitCode:calls===1?1:0, testOutcomeVerified:true, reasons:calls===1?['assertion failure']:[] };
} };
const run=await runVerifiedCoding({
  workerId:'coder',checks:['unit'],grants:['approved'],
  broker, currentContentHash:async()=>hash,
  repair:async()=>{hash='new';return {changed:true};},
});
assert.equal(run.state,'ready_for_review');
assert.equal(run.repairs,1);
assert.deepEqual(run.attempts.map(x=>x.outcome),['failed_check','verified']);
assert.equal(run.integrated,false);
const unver=await runVerifiedCoding({workerId:'coder',checks:['unit'],grants:['approved'],
  broker:{requestCheck:async()=>({id:'u',workerId:'coder',checkId:'unit',snapshotHash:'a',
    status:'completed',exitCode:0,testOutcomeVerified:false})},
  currentContentHash:async()=> 'a',repair:async()=>{throw Error('must not repair');}});
assert.equal(unver.state,'needs_attention');
assert.equal(unver.repairs,0);
let retries=0;
const blocked=await runVerifiedCoding({workerId:'coder',checks:['unit'],grants:['approved'],
  broker:{requestCheck:async()=>({id:'f',workerId:'coder',checkId:'unit',snapshotHash:'a',
    status:'failed',exitCode:2,testOutcomeVerified:true,reasons:['failed']})},
  currentContentHash:async()=> 'a',
  repair:async()=>{retries++;return {changed:false};},
});
assert.equal(blocked.state,'needs_attention');
assert.equal(retries,1);
const ctl = new AbortController();ctl.abort('stop');
const cancel=await runVerifiedCoding({workerId:'coder',checks:['unit'],grants:['approved'],
  broker,currentContentHash:async()=> 'x',repair:async()=>({changed:true}),signal:ctl.signal});
assert.equal(cancel.state,'cancelled');
console.log('PASS: bounded repair, verified receipts, stale/unchanged failure, cancellation');
