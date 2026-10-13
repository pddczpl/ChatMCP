// Independent review of retained bytes; does not import publication/grader code.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const filename=process.argv[2];
const expectedNative=process.argv[3];
const partial=process.argv[4]==='--partial';
assert.ok(filename&&/^[a-f0-9]{64}$/.test(expectedNative),'Provide report and independently measured native SHA256');
const report=JSON.parse(fs.readFileSync(filename,'utf8'));
if(!partial)assert.equal(report.verdict,'PASS');
assert.equal(report.sourceDirty,false,'identified clean source tree');
assert.equal(report.cleanupConfirmed,true);
assert.equal(report.supervisorSha256,expectedNative);
const hashes=new Set(),runIds=new Set(),instances=new Set(),nonces=new Set();
const result=[];
for(const run of report.runs){
 const envelope=Buffer.from(run.envelopeBytesBase64,'base64');
 const receiptBytes=Buffer.from(run.receiptBytesBase64,'base64');
 const e=JSON.parse(envelope.toString('utf8'));
 const r=JSON.parse(receiptBytes.toString('utf8'));
 assert.equal(envelope.toString('utf8'),JSON.stringify(e),'canonical retained envelope bytes');
 assert.equal(e.instanceId,run.instanceId);
 assert.equal(e.generation,run.generation);
 assert.equal(e.runId,run.runId);
 assert.equal(e.supervisorSha256,expectedNative);
 assert.equal(e.toolchainSha256,report.nodeSha256);
 assert.equal(r.runId,run.runId);
 assert.equal(r.nonce,e.nonce);
 assert.match(e.nonce,/^[a-f0-9]{64}$/);
 assert.ok(!nonces.has(e.nonce),'fresh nonce');nonces.add(e.nonce);
 assert.ok(!runIds.has(run.runId),'fresh run');runIds.add(run.runId);
 assert.ok(!instances.has(run.instanceId),'fresh instance');instances.add(run.instanceId);
 assert.equal(run.words.length,9);
 let value=0n;
 run.words.forEach((word,index)=>{
  assert.equal(word.index,index);
  const code=word.response.ExitCode;
  assert.ok(Number.isInteger(code)&&code>=0x40000000&&code<=0x7fffffff,'positive framed native exit word');
  value=(value<<30n)|BigInt(code-0x40000000);
 });
 assert.equal(value&((1n<<14n)-1n),0n,'canonical final padding');
 const observed=(value>>14n).toString(16).padStart(64,'0');
 const size=Buffer.alloc(4);size.writeUInt32BE(envelope.length);
 const expected=crypto.createHash('sha256').update('ChatMCP.G4.SealedReceipt.v1\n','ascii').update(size).update(envelope).update(receiptBytes).digest('hex');
 assert.equal(observed,expected,'independently reconstructed exact-byte seal');
 assert.ok(!hashes.has(expected),'new seal');hashes.add(expected);
 assert.equal(r.restrictedChild,true);assert.equal(r.jobObjectAttached,true);assert.equal(r.cleanupConfirmed,true);
 assert.equal(r.isGuestExecution,true);
 assert.equal(run.cleanup.stopped,true);assert.equal(run.cleanup.instanceId,run.instanceId);
 assert.equal(r.grader.kind,'native-blackbox');assert.equal(r.grader.manifestSha256,e.graderSha256);
 assert.ok(r.grader.cases>0&&r.grader.cases<=64);
 assert.equal(r.grader.passed+r.grader.failed,r.grader.cases);
 const s=r.securityEvidence;
 assert.equal(s.supervisorSid,'S-1-5-18');assert.equal(s.supervisorIntegritySid,'S-1-16-16384');
 assert.ok(s.childSid.startsWith('S-1-5-21-')&&!s.childSid.endsWith('-504'));
 assert.equal(s.childIntegritySid,'S-1-16-8192');assert.equal(s.freshAccount,true);
 assert.equal(s.childToken.adminEnabled,false);
 assert.equal(s.childToken.ownerSid,'S-1-5-18');assert.equal(s.childToken.groupSid,'S-1-5-18');
 assert.ok(s.childToken.groups.every(group=>group.sid!=='S-1-5-32-544'||!(group.attributes&4)));
 assert.deepEqual(s.childToken.privileges.map(p=>p.name),['SeChangeNotifyPrivilege']);
 assert.equal(s.sealOwnerSid,'S-1-5-18');assert.equal(s.sealSddl,'O:SYG:SYD:P(A;;FA;;;SY)');
 assert.equal(s.runtimeDynamicCodeSupported,false);
 assert.ok(s.loadedModules.length>1);
 assert.ok(s.loadedModules.every(name=>/^C:\\Windows\\(?:System32|WinSxS)\\/i.test(name)||name==='C:\\ChatMCP\\Input\\GuestSupervisor.exe'));
 assert.ok(s.loadedModules.every(name=>!/(?:coreclr|hostfxr|hostpolicy)\.dll$/i.test(name)));
 assert.equal(run.sealAudit.sealRecordBytes,72);assert.equal(run.sealAudit.sealPath,s.sealPath);
 assert.equal(run.sealAudit.sealOwnerSid,'S-1-5-18');assert.equal(run.sealAudit.diagnosticOnly,true);
 assert.equal(run.sealAudit.sealSddl,s.sealSddl);
 assert.equal(run.stagedRequest.grader.manifestSha256,e.graderSha256);
 assert.equal(run.stagedRequest.command,'C:\\ChatMCP\\Input\\toolchain\\node.exe');
 assert.equal(run.stagedRequest.cwd,'C:\\ChatMCP\\Input\\project');
 assert.equal(run.stagedRequest.runId,e.runId);assert.equal(run.stagedRequest.nonce,e.nonce);
 if(run.elevatedDesktopEstablished){
  const lines=new Map(r.stderr.trim().split(/\r?\n/).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  assert.equal(lines.get('SEAL_CHILD_SID'),s.childSid);
  assert.equal(lines.get('SEAL_SUPERVISOR_PID'),String(r.supervisorPid));
  assert.equal(lines.get('SEAL_CHILD_DENIAL_CONFIRMED'),'True');
  assert.equal(lines.get('SEAL_CHILD_DIGEST_EXIT'),'3');
  for(const target of ['DIRECTORY','LEAF'])for(const access of ['READ','WRITE','DELETE','WRITE_DAC','WRITE_OWNER'])
   assert.equal(lines.get(`SEAL_${target}_${access}_ERROR`),'5');
  const explorers=[...lines.keys()].filter(key=>/^SEAL_EXPLORER_\d+_PID$/.test(key));
  assert.ok(explorers.length>0);assert.equal(explorers.length,Number(lines.get('SEAL_EXPLORER_PROBE_COUNT')));
  for(const target of ['SUPERVISOR',...explorers.map(key=>key.slice(5,-4))]){
   for(const right of ['QUERY','VMREAD','VMWRITE','DUP_HANDLE','WRITE_DAC','WRITE_OWNER'])
    assert.equal(lines.get(`SEAL_${target}_PROCESS_${right}_ERROR`),'5');
   if(lines.get(`SEAL_${target}_PROCESS_LIMITED_QUERY_ERROR`)==='5')assert.equal(lines.get(`SEAL_${target}_TOKEN_OPEN_ATTEMPTED`),'False');
   else for(const right of ['DUPLICATE','IMPERSONATE','ASSIGN_PRIMARY'])assert.equal(lines.get(`SEAL_${target}_TOKEN_${right}_ERROR`),'5');
  }
 }
 if(run.diagnosticScenario){
  assert.equal(run.stagedRequest.timeoutSeconds,6);
  assert.equal(r.exitCode,null);assert.ok(r.reasons.includes('Command execution exceeded timeout'));
  assert.ok(r.childPid>0&&r.durationMs>=5500&&r.durationMs<=25000);
  assert.equal(r.grader.valid,false);assert.equal(r.grader.passed,0);
  if(run.diagnosticScenario.kind==='non-reading-stdin')assert.ok(run.diagnosticScenario.inputBytes>60*1024);
  if(run.diagnosticScenario.kind==='descendant-timeout'){
   assert.equal(run.descendant.parentPid,r.childPid);
   assert.equal(run.descendant.token,run.diagnosticScenario.descendantToken);
   assert.equal(run.descendant.liveQueryExit,23);assert.equal(run.descendant.afterCleanupQueryExit,24);
  }
 }
 if(run.attempt){
  assert.equal(run.attempt.snapshotHash,e.snapshotSha256);assert.equal(run.attempt.checkHash,e.checkSha256);
  assert.equal(run.attempt.publisherAuthenticated,true);
  assert.equal(run.attempt.testOutcomeVerified,r.grader.valid&&r.grader.failed===0&&r.status==='completed'&&r.exitCode===0&&!r.truncated);
 }
 result.push({label:run.label,status:r.status,valid:r.grader.valid,cases:r.grader.cases,passed:r.grader.passed,childSid:s.childSid});
}
if(!partial)assert.ok(result.length>=17,'expected comprehensive native run set');
if(!partial){
 assert.equal(report.runs.filter(run=>run.attempt?.testOutcomeVerified).length,1);
 assert.equal(report.runs.filter(run=>run.elevatedDesktopEstablished).length,1);
 assert.deepEqual(report.runs.filter(run=>run.diagnosticScenario).map(run=>run.diagnosticScenario.kind).sort(),['descendant-timeout','non-reading-stdin']);
 assert.equal(report.runs[0].attempt.grantId,report.runs[1].attempt.grantId);
 assert.equal(report.runs[0].attempt.checkHash,report.runs[1].attempt.checkHash);
 // sourceHash identifies the pinned CHECK definition; implementation changes
 // appear in the snapshot hash while case authority remains unchanged.
 assert.equal(report.runs[0].attempt.sourceHash,report.runs[1].attempt.sourceHash);
 assert.notEqual(report.runs[0].attempt.snapshotHash,report.runs[1].attempt.snapshotHash);
}
console.log(JSON.stringify({review:partial?'PARTIAL_ONLY_NO_ACCEPTANCE':'PASS',sourceCommit:report.sourceCommit,sourceDirty:report.sourceDirty,supervisorSha256:expectedNative,verifiedRuns:result.length,results:result},null,2));
