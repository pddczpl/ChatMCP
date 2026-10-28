// Portable host contract/grant regressions. Native comparison authority still
// requires separate hardware acceptance; these injected receipts are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BLACKBOX_KIND, BLACKBOX_COMMAND, ZERO_SHA256, parseStrictJson,
  validateBlackboxManifest, validateNativeGraderEvidence } from '../lib/native-blackbox-contract.mjs';
import { WorkerTestBroker, isNodeTestSource } from '../lib/worker-test-broker.mjs';
import { validateExecutionRequest, validateExecutionReceipt } from '../lib/execution-contract.mjs';
import { WindowsSandboxPublisher } from '../lib/windows-sandbox-publisher.mjs';
import { WindowsSandboxBackend } from '../lib/windows-sandbox-backend.mjs';
import { SEALED_PROTOCOL, sealedReceiptPayload, registerSealedCollection } from '../lib/windows-sandbox-sealed-receipt.mjs';
import { candidateDigestExitCodes } from '../lib/windows-sandbox-exitcode-channel.mjs';
import { recordVerificationAttempt } from '../lib/verification-receipt.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const manifestPath='chatmcp.checks/arithmetic.json';
const spec={version:1,kind:BLACKBOX_KIND,adapter:'adapter.mjs',cases:[
  {id:'first',input:{a:2,b:3},expected:5},{id:'second',input:{a:-2,b:2},expected:0},
]};
const bytes=Buffer.from(JSON.stringify(spec));
const manifestSha256=sha(bytes);
assert.deepEqual(validateBlackboxManifest(bytes),spec);
for(const source of [
  '{"version":1,"version":1}', '{"nested":{"a":1,"\\u0061":2}}',
  '{"value":1e400}', '[1] trailing', '{"nested":{"x":1,"x":2}}',
]) assert.throws(()=>parseStrictJson(source),{code:'invalid_blackbox_check'});
assert.throws(()=>validateBlackboxManifest(JSON.stringify({...spec,cases:[]})));
assert.throws(()=>validateBlackboxManifest(JSON.stringify({...spec,cases:[spec.cases[0],spec.cases[0]]})));
assert.throws(()=>validateBlackboxManifest(JSON.stringify({...spec,adapter:'../outside.mjs'})));
assert.throws(()=>validateBlackboxManifest(JSON.stringify({...spec,cases:[{...spec.cases[0],pass:true}]})));
assert.throws(()=>parseStrictJson(JSON.stringify({nested:Array.from({length:10001},()=>0)})));
for(const filename of ['test.js','test-math.cjs','test-.js','.test.js','_test.mjs','math_test.mjs','math-test.js','math.test.ts','test/deep/check.cts','tests/helper.mjs'])
  assert.equal(isNodeTestSource(filename),true,filename+' must remain bound for diagnostic Node execution');

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-blackbox-contract-'));
try {
  const workspace=path.join(root,'project');
  await fs.mkdir(path.join(workspace,'chatmcp.checks'),{recursive:true});
  await fs.writeFile(path.join(workspace,manifestPath),bytes);
  await fs.writeFile(path.join(workspace,'adapter.mjs'),'// initial fixture');
  const worker={id:'grader-worker',workspace,files:[manifestPath,'adapter.mjs'],
    parentPolicy:'autonomous',capabilities:{checksRun:true},checks:async()=>({suggested:[]})};
  let executions=0,expectedSuccess=false;
  const backend={
    async probe(){return {available:true,osIsolated:true,enforcedLimits:['timeoutSeconds','maxOutputBytes'],reasons:[]};},
    async execute(request){
      executions++;
      assert.equal(request.checkKind,BLACKBOX_KIND);
      assert.equal(request.command,BLACKBOX_COMMAND);
      assert.equal(request.grader.manifestSha256,manifestSha256);
      assert.deepEqual(request.grader.caseIds,['first','second']);
      assert.equal(request.limits.maxOutputBytes,64*1024);
      const at=new Date().toISOString();
      return {...validateExecutionReceipt({runId:request.runId,backend:'windows-sandbox',
        status:expectedSuccess?'completed':'failed',exitCode:0,stdout:'{"pass":999,"valid":true}',stderr:'',
        startedAt:at,completedAt:at,durationMs:1,truncated:false,snapshotHash:request.snapshotHash,checkHash:request.checkHash,
        grader:{version:1,kind:'native-blackbox',manifestSha256,cases:2,passed:expectedSuccess?2:0,
          failed:expectedSuccess?0:2,valid:expectedSuccess},
      }),publisherAuthenticated:true,provenance:'publisher_authenticated',graderAuthenticated:true,publicationProtocol:SEALED_PROTOCOL};
    },
  };
  const broker=new WorkerTestBroker({resolveWorker:async id=>id===worker.id?worker:null,registry:{get:()=>backend},
    authorizeGrant:async()=>({approved:true})});
  const [check]=await broker.discoverChecks({workerId:worker.id});
  assert.equal(check.checkKind,BLACKBOX_KIND);
  const grant=await broker.issueGrant({workerId:worker.id,checkId:check.id});
  const failed=await broker.requestCheck({workerId:worker.id,checkId:check.id,grantId:grant.id});
  assert.equal(failed.publisherAuthenticated,true);
  assert.equal(failed.testOutcomeVerified,false,'child pass text does not override native comparison failure');
  await fs.writeFile(path.join(workspace,'adapter.mjs'),'// implementation-only repair');
  expectedSuccess=true;
  const passed=await broker.requestCheck({workerId:worker.id,checkId:check.id,grantId:grant.id});
  assert.equal(passed.testOutcomeVerified,true);
  assert.equal(passed.nativeGrader.passed,2);
  assert.notEqual(passed.snapshotHash,failed.snapshotHash);
  assert.equal(passed.checkHash,failed.checkHash,'same approved cases bind both attempts');
  await fs.writeFile(path.join(workspace,manifestPath),JSON.stringify({...spec,cases:[{...spec.cases[0],expected:999}]}));
  await assert.rejects(()=>broker.requestCheck({workerId:worker.id,checkId:check.id,grantId:grant.id}),{code:'stale_check'});
  assert.equal(executions,2,'modified expected data cannot dispatch under prior grant');
  await fs.writeFile(path.join(workspace,manifestPath),bytes);

  const snapshot={contentHash:'a'.repeat(64)};
  const request=validateExecutionRequest({runId:randomUUID(),snapshotId:randomUUID(),checkId:check.id,
    command:BLACKBOX_COMMAND,checkKind:BLACKBOX_KIND,grader:check.grader,isolationRequired:true,
    snapshotHash:snapshot.contentHash,checkHash:check.checkHash});
  assert.throws(()=>validateExecutionRequest({...request,checkKind:null}),{code:'invalid_request'});
  assert.throws(()=>validateExecutionRequest({...request,grader:{...request.grader,manifestPath:'../checks.json'}}));
  assert.throws(()=>validateNativeGraderEvidence({version:1,kind:'native-blackbox',manifestSha256,cases:0,passed:0,failed:0,valid:true}));
  const publisher=new WindowsSandboxPublisher({attestedCheckKinds:[BLACKBOX_KIND]});
  assert.equal(new WindowsSandboxPublisher().productionAuthenticated,false);
  assert.equal(publisher.supportsRequest(request),true);
  assert.equal(publisher.supportsRequest({...request,command:'node --test',checkKind:null}),false);
  let legacyStarted=false;
  const scopedBackend=new WindowsSandboxBackend({stateDirectory:path.join(root,'backend'),publisher,
    driver:{start(){legacyStarted=true;}},preflight:async()=>({available:true})});
  assert.equal((await scopedBackend.execute({...request,command:'node --test',checkKind:null})).status,'blocked');
  assert.equal(legacyStarted,false);
  const at=new Date().toISOString();
  const base={version:1,runId:request.runId,nonce:'b'.repeat(64),status:'completed',exitCode:0,
    stdout:'{"pass":999}',stderr:'',startedAt:at,completedAt:at,durationMs:1,truncated:false,reasons:[],
    isGuestExecution:true,restrictedChild:true,jobObjectAttached:true,cleanupConfirmed:true,
    grader:{version:1,kind:'native-blackbox',manifestSha256,cases:2,passed:2,failed:0,valid:true}};
  async function verify(receipt,cliExitCode=0,envelopeChanges={}) {
    const instanceId=randomUUID(),generation=randomUUID();
    const envelopeBytes=Buffer.from(JSON.stringify({version:1,instanceId,generation,runId:request.runId,nonce:base.nonce,
      snapshotSha256:snapshot.contentHash,testBaselineSha256:snapshot.contentHash,checkSha256:request.checkHash,
      reporterSha256:ZERO_SHA256,graderSha256:manifestSha256,...envelopeChanges}));
    const receiptBytes=Buffer.from(JSON.stringify(receipt));
    const raw=registerSealedCollection({context:{instanceId,generation,runId:request.runId,expectedNonce:base.nonce,cliExitCode},
      envelopeBytes,receiptBytes,responses:candidateDigestExitCodes(sealedReceiptPayload(envelopeBytes,receiptBytes)).map(ExitCode=>({ExitCode}))});
    return publisher.verify({raw,request,snapshot,instanceId,generation});
  }
  const verified=await verify(base);
  assert.equal(verified.graderAuthenticated,true);
  assert.equal(verified.receipt.grader.passed,2);
  const recorded=recordVerificationAttempt({descriptor:{...check,runId:request.runId},snapshot,attempt:1,
    execution:{...verified.receipt,publisherAuthenticated:true,provenance:'publisher_authenticated',
      graderAuthenticated:verified.graderAuthenticated,publicationProtocol:verified.publicationProtocol}});
  assert.equal(recorded.testOutcomeVerified,true);
  const unsigned=recordVerificationAttempt({descriptor:{...check,runId:request.runId},snapshot,attempt:1,
    execution:{...verified.receipt,publisherAuthenticated:true,provenance:'publisher_authenticated',publicationProtocol:SEALED_PROTOCOL}});
  assert.equal(unsigned.testOutcomeVerified,false,'matching guest-provided JSON fields do not supply grader authority');
  const nativeFailure=await verify({...base,status:'failed',grader:{...base.grader,valid:false,passed:0,failed:2}},1);
  assert.equal(nativeFailure.receipt.status,'failed','child exit zero and native grader failure is an authenticated failure');
  for(const altered of [
    {...base,grader:{...base.grader,cases:1,passed:1}},
    {...base,grader:{...base.grader,manifestSha256:'c'.repeat(64)}},
    {...base,grader:{...base.grader,valid:false}},
    {...base,truncated:true}, {...base,cleanupConfirmed:false}, {...base,grader:null},
    {...base,grader:{...base.grader,childSaysPass:true}},
  ]) await assert.rejects(()=>verify(altered));
  await assert.rejects(()=>verify(base,0,{graderSha256:'d'.repeat(64)}));
  await assert.rejects(()=>verify(base,0,{reporterSha256:'d'.repeat(64)}));
  console.log('PASS: scoped native black-box contracts, duplicate-key/finite-number bounds, immutable approved cases, implementation repair, typed seal evidence, and legacy denial');
} finally {
  assert.equal(path.dirname(root),os.tmpdir());
  assert.ok(path.basename(root).startsWith('chatmcp-blackbox-contract-'));
  await fs.rm(root,{recursive:true,force:true});
}
