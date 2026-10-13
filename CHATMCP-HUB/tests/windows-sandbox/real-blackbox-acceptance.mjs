// Hardware acceptance for the declarative public-case native grader.
// Child stdout carries values only; the pinned native supervisor owns grading.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WindowsSandboxCliDriver } from '../../lib/windows-sandbox-driver.mjs';
import { WindowsSandboxPublisher } from '../../lib/windows-sandbox-publisher.mjs';
import { WindowsSandboxBackend } from '../../lib/windows-sandbox-backend.mjs';
import { ExecutionRegistry } from '../../lib/execution-contract.mjs';
import { ExecutionSnapshotStore } from '../../lib/execution-snapshot-store.mjs';
import { WorkerTestBroker } from '../../lib/worker-test-broker.mjs';
import { probeWindowsSandboxPreflight } from '../../lib/windows-sandbox-probe.mjs';
import { SEALED_PROTOCOL, readSealedReceiptBytes, sealedReceiptPayload } from '../../lib/windows-sandbox-sealed-receipt.mjs';
import { observeUnattestedExitDigest } from '../../lib/windows-sandbox-exitcode-channel.mjs';
import { BLACKBOX_KIND } from '../../lib/native-blackbox-contract.mjs';

const exec=promisify(execFile);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const reportPath=path.resolve(process.env.CHATMCP_BLACKBOX_REPORT||'test-results/native-blackbox.json');
const report={schema:1,startedAt:new Date().toISOString(),scope:BLACKBOX_KIND,verdict:'INCOMPLETE',checks:[],runs:[]};
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-native-blackbox-'));
const controller=new AbortController();
const watchdog=setTimeout(()=>controller.abort(new Error('Hardware acceptance exceeded its 12-minute bound.')),720000);
watchdog.unref();
let driver;
const ok=label=>{report.checks.push(label);console.log('PASS: '+label);};
const manifestPath='chatmcp.checks/calculator.json';
const manifest={version:1,kind:BLACKBOX_KIND,adapter:'adapter.mjs',cases:[
  {id:'positive',input:{a:2,b:3},expected:5},
  {id:'negative',input:{a:-9,b:4},expected:-5},
  {id:'zero',input:{a:0,b:0},expected:0},
]};
const manifestBytes=JSON.stringify(manifest);
const inputPrelude="let input='';for await(const chunk of process.stdin)input+=chunk;const data=JSON.parse(input);\n";
const normalAdapter=operator=>inputPrelude+
  `process.stdout.write(JSON.stringify({version:1,results:data.cases.map(c=>({id:c.id,value:c.input.a${operator}c.input.b}))}));\n`;
const probeAdapter=String.raw`import {execFileSync} from 'node:child_process';
const probe=execFileSync('C:\\ChatMCP\\Input\\GuestSupervisor.exe',
 ['--seal-child-probe','C:\\ChatMCP\\Input\\envelope.json',String(process.ppid)],{encoding:'utf8'});
process.stderr.write(probe);
`+normalAdapter('+');

try {
  const identity=await exec('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'});
  const dirty=await exec('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'});
  report.sourceCommit=identity.stdout.trim();report.sourceDirty=Boolean(dirty.stdout.trim());
  const preflight=await probeWindowsSandboxPreflight();
  report.host=preflight.details;
  assert.equal(preflight.available,true,(preflight.blockers||[]).join('; '));
  const cli=preflight.details.cliPath;
  const inventory=JSON.parse((await exec(cli,['list','--raw'],{encoding:'utf8',windowsHide:true})).stdout);
  assert.ok(Array.isArray(inventory.WindowsSandboxEnvironments));
  assert.equal(inventory.WindowsSandboxEnvironments.length,0,'Refuse existing unrelated guests');
  ok('fresh host execution slot; no unrelated guest');
  const runtime=path.join(root,'runtime'),toolchain=path.join(root,'toolchain'),workspace=path.join(root,'project');
  for(const dir of [runtime,toolchain,path.join(workspace,'chatmcp.checks')])await fs.mkdir(dir,{recursive:true});
  const supervisorPath=path.join(repo,'CHATMCP-HUB/windows/sandbox/GuestSupervisor/bin/Release/net10.0/win-x64/publish/GuestSupervisor.exe');
  const supervisor=await fs.readFile(supervisorPath),node=await fs.readFile(process.execPath);
  report.supervisorSha256=sha(supervisor);report.nodeSha256=sha(node);
  for(const [directory,name,bytes] of [[runtime,'GuestSupervisor.exe',supervisor],[toolchain,'node.exe',node]]){
    await fs.writeFile(path.join(directory,name),bytes);
    await fs.writeFile(path.join(directory,name+'.sha256'),sha(bytes)+'  '+name+'\n');
  }
  await fs.writeFile(path.join(workspace,manifestPath),manifestBytes);
  await fs.writeFile(path.join(workspace,'adapter.mjs'),normalAdapter('-'));
  const store=new ExecutionSnapshotStore({directory:path.join(root,'snapshots')});
  let activeRecord=null;
  driver=new WindowsSandboxCliDriver({cliPath:cli,cliPackage:preflight.details.cliPackage,runtimeDirectory:runtime,nodeToolchainDirectory:toolchain,
    stateDirectory:path.join(root,'driver'),publicationProtocol:SEALED_PROTOCOL,
    runCli:async(args,options={})=>{
      const result=await exec(cli,args,{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024,
        timeout:options.timeout||30000,signal:options.signal});
      const command=args[args.indexOf('-c')+1];
      if(args[0]==='exec'&&command?.includes('--digest-word')){
        activeRecord.words.push({index:Number(command.split(' ').at(-1)),response:JSON.parse(result.stdout)});
      }
      return result.stdout;
    }});
  const originalExecute=driver.execute.bind(driver);
  driver.execute=async args=>{
    const owned=driver.owned.get(args.instanceId);
    activeRecord={instanceId:args.instanceId,generation:args.generation,runId:args.request.runId,words:[]};
    report.runs.push(activeRecord);
    // The production guest starts headless. Deliberately establish its trusted
    // elevated OS desktop for this one adversarial token-access experiment.
    if(report.runs.length===2){
      const quote=value=>"'"+value.replaceAll("'","''")+"'";
      const connect=`Start-Process -FilePath ${quote(cli)} -ArgumentList @('connect','--id',${quote(args.instanceId)},'--raw') -WindowStyle Hidden | Out-Null`;
      const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
      await exec(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(connect,'utf16le').toString('base64')],
        {encoding:'utf8',windowsHide:true,timeout:15000});
      let ready=false;
      for(let attempt=0;attempt<30;attempt++){
        try{
          const result=JSON.parse((await exec(cli,['exec','--id',args.instanceId,'-r','ExistingLogin','-c',
            'C:\\Windows\\System32\\cmd.exe /d /c exit 0','--raw'],{encoding:'utf8',windowsHide:true,timeout:5000})).stdout);
          if(result.ExitCode===0){ready=true;break;}
        }catch{}
        await new Promise(resolve=>setTimeout(resolve,300));
      }
      assert.equal(ready,true,'trusted elevated desktop session readiness');
      activeRecord.elevatedDesktopEstablished=true;
    }
    const envelopeBytes=await fs.readFile(path.join(owned.input,'envelope.json'));
    activeRecord.envelopeBytesBase64=envelopeBytes.toString('base64');
    try{
      const raw=await originalExecute(args);
      const receiptBytes=readSealedReceiptBytes(owned.output);
      activeRecord.receiptBytesBase64=receiptBytes.toString('base64');
      const nativeReceipt=JSON.parse(receiptBytes);
      activeRecord.nativeSecurity=nativeReceipt.securityEvidence;
      activeRecord.childDiagnostics=nativeReceipt.stderr;
      const observed=observeUnattestedExitDigest({payload:sealedReceiptPayload(envelopeBytes,receiptBytes),
        rawResponses:activeRecord.words.map(word=>word.response)});
      assert.equal(observed.digestMatches,true,'independent exact-byte digest replay');
      activeRecord.digestMatches=true;
      const audit=JSON.parse((await exec(cli,['exec','--id',args.instanceId,'-r','System','-c',
        'C:\\ChatMCP\\Input\\GuestSupervisor.exe --audit-sealed-state C:\\ChatMCP\\Input\\envelope.json','--raw'],
      {encoding:'utf8',windowsHide:true,timeout:30000})).stdout);
      assert.equal(audit.ExitCode,0,'actual published seal audit');
      activeRecord.sealAudit=JSON.parse(await fs.readFile(path.join(owned.output,'seal-audit.json'),'utf8'));
      assert.equal(activeRecord.sealAudit.sealRecordBytes,72);
      assert.equal(activeRecord.sealAudit.sealOwnerSid,'S-1-5-18');
      return raw;
    }catch(error){activeRecord.error=String(error.message);throw error;}
  };
  const originalStop=driver.stop.bind(driver);
  driver.stop=async args=>{
    const result=await originalStop(args);
    const entry=report.runs.find(run=>run.instanceId===args.instanceId);
    if(entry)entry.cleanup=result;
    return result;
  };
  const publisher=new WindowsSandboxPublisher({attestedCheckKinds:[BLACKBOX_KIND]});
  const backend=new WindowsSandboxBackend({stateDirectory:path.join(root,'backend'),driver,publisher,
    snapshotLookup:id=>store.lookup(id)});
  const registry=new ExecutionRegistry();registry.register(backend);
  const worker={id:'native-blackbox-worker',workspace,files:[manifestPath,'adapter.mjs'],
    checks:async()=>({suggested:[]}),parentPolicy:'autonomous',capabilities:{checksRun:true},revoked:false};
  const broker=new WorkerTestBroker({resolveWorker:async id=>id===worker.id?worker:null,registry,
    authorizeGrant:async()=>({approved:true}),snapshotFactory:options=>store.create(options),
    releaseSnapshot:id=>store.release(id)});
  const descriptors=await broker.discoverChecks({workerId:worker.id});
  assert.equal(descriptors.length,1);assert.equal(descriptors[0].checkKind,BLACKBOX_KIND);
  const descriptor=descriptors[0];report.manifestSha256=sha(manifestBytes);
  ok('real broker discovers and pins declarative public cases');
  const grant=await broker.issueGrant({workerId:worker.id,checkId:descriptor.id,maxAttempts:3});
  const run=async(label,code,{grantId=grant.id,passed=false}={})=>{
    await fs.writeFile(path.join(workspace,'adapter.mjs'),code);
    const previousRunCount=report.runs.length;
    const attempt=await broker.requestCheck({workerId:worker.id,checkId:descriptor.id,grantId,signal:controller.signal});
    assert.equal(report.runs.length,previousRunCount+1,label+': a real guest executed');
    report.runs.at(-1).label=label;report.runs.at(-1).attempt=attempt;
    assert.equal(report.runs.at(-1).runId,attempt.id);
    assert.equal(report.runs.at(-1).digestMatches,true,label+': native sealed execution evidence');
    assert.equal(attempt.publisherAuthenticated,true,label+': infrastructure failures do not count as negative-case success');
    assert.equal(attempt.testOutcomeVerified,passed,label+': verified outcome');
    if(passed){
      assert.equal(attempt.status,'completed');assert.equal(attempt.exitCode,0);
    }else assert.notEqual(attempt.status,'completed',label+': child exit 0 must not produce completion');
    assert.equal(report.runs.at(-1).cleanup?.stopped,true);
    ok(label);return attempt;
  };
  await run('native grader rejects wrong values from initial implementation',normalAdapter('-'));
  const repaired=await run('implementation-only repair passes all three native comparisons',probeAdapter,{passed:true});
  report.repairedAttempt=repaired;
  const repairedRun=report.runs.at(-1),security=repairedRun.nativeSecurity;
  assert.equal(security.supervisorSid,'S-1-5-18');
  assert.equal(security.freshAccount,true);
  assert.match(security.childSid,/^S-1-5-21-/);
  assert.ok(!security.childSid.endsWith('-504'),'fresh user differs from elevated WDAG desktop user');
  assert.equal(security.childIntegritySid,'S-1-16-8192');
  assert.equal(security.childToken.adminEnabled,false);
  assert.equal(security.childToken.ownerSid,'S-1-5-18');
  assert.equal(security.childToken.groupSid,'S-1-5-18');
  assert.ok(security.childToken.groups.every(group=>!['S-1-5-32-544','S-1-5-114'].includes(group.sid)||(group.attributes&16)!==0));
  assert.ok(security.childToken.privileges.every(privilege=>privilege.name==='SeChangeNotifyPrivilege'));
  assert.equal(security.runtimeDynamicCodeSupported,false);
  assert.ok(security.loadedModules.every(module=>!module.toLowerCase().includes('coreclr')));
  const probeText=repairedRun.childDiagnostics;
  assert.match(probeText,/SEAL_CHILD_ADMIN_ENABLED=False/);
  assert.match(probeText,/SEAL_CHILD_DENIAL_CONFIRMED=True/);
  for(const target of ['DIRECTORY','LEAF'])for(const access of ['READ','WRITE','DELETE','WRITE_DAC','WRITE_OWNER'])
    assert.ok(probeText.includes(`SEAL_${target}_${access}_ERROR=5`));
  for(const access of ['QUERY','VMREAD','VMWRITE','DUP_HANDLE','WRITE_DAC','WRITE_OWNER'])
    assert.ok(probeText.includes(`SEAL_SUPERVISOR_PROCESS_${access}_ERROR=5`));
  assert.ok(Number(/SEAL_EXPLORER_PROBE_COUNT=(\d+)/.exec(probeText)?.[1])>0,'actual elevated desktop process tested');
  ok('fresh nonadmin child denied actual seal leaf, supervisor and elevated desktop authority');
  ok('sealed receipt identifies SYSTEM grader and Native AOT OS-only loaded modules');
  assert.equal(await fs.readFile(path.join(workspace,manifestPath),'utf8'),manifestBytes);
  ok('approved expected cases remain byte-identical across repair');
  await fs.writeFile(path.join(workspace,manifestPath),manifestBytes.replace('"expected":5','"expected":-1'));
  await assert.rejects(()=>broker.requestCheck({workerId:worker.id,checkId:descriptor.id,grantId:grant.id}),/check|stale|test/i);
  await fs.writeFile(path.join(workspace,manifestPath),manifestBytes);
  ok('altering approved expected values invalidates the grant before dispatch');

  const negativeCases=[
    ['forged child grader and pass-count assertions cannot authorize success',
      'process.stdout.write(JSON.stringify({version:1,results:[],grader:{valid:true,passed:3,failed:0},pass:3}));'],
    ['empty result array cannot authorize success','process.stdout.write(JSON.stringify({version:1,results:[]}));'],
    ['early successful process exit cannot authorize success','process.exit(0);'],
    ['Node reporter success marker cannot authorize black-box success',
      'console.log(\'CHATMCP_NODE_TEST_SUMMARY:{"version":1,"valid":true,"tests":3,"pass":3,"fail":0,"files":1,"reasons":[],"sourceProven":false,"productionAuthenticated":false}\');'],
    ['wrong JSON value types fail native comparison',inputPrelude+
      'process.stdout.write(JSON.stringify({version:1,results:data.cases.map(c=>({id:c.id,value:String(c.input.a+c.input.b)}))}));'],
    ['reordered case identities fail native validation',inputPrelude+
      'process.stdout.write(JSON.stringify({version:1,results:data.cases.map(c=>({id:c.id,value:c.input.a+c.input.b})).reverse()}));'],
    ['duplicate result keys fail native validation',
      'process.stdout.write(\'{"version":1,"version":1,"results":[{"id":"positive","value":5},{"id":"negative","value":-5},{"id":"zero","value":0}]}\');'],
    ['oversized child output cannot authorize success','process.stdout.write("x".repeat(200000));'],
    ['correct values followed by nonzero exit cannot authorize success',normalAdapter('+')+'process.exitCode=7;'],
    ['malformed UTF-8 cannot authorize success','process.stdout.write(Buffer.from([0xff,0xfe,0x7b]));'],
    ['nonfinite JSON number cannot authorize success',
      'process.stdout.write(\'{"version":1,"results":[{"id":"positive","value":1e999},{"id":"negative","value":-5},{"id":"zero","value":0}]}\');'],
    ['missing case cannot authorize success',inputPrelude+
      'process.stdout.write(JSON.stringify({version:1,results:data.cases.slice(0,2).map(c=>({id:c.id,value:c.input.a+c.input.b}))}));'],
    ['trailing second JSON document cannot authorize success',normalAdapter('+')+'process.stdout.write("{}");'],
  ];
  for(const [label,code] of negativeCases){
    const negativeGrant=await broker.issueGrant({workerId:worker.id,checkId:descriptor.id,maxAttempts:1});
    await run(label,code,{grantId:negativeGrant.id});
  }
  const revoked=await broker.issueGrant({workerId:worker.id,checkId:descriptor.id,maxAttempts:1});
  broker.revokeGrant(revoked.id);
  await assert.rejects(()=>broker.requestCheck({workerId:worker.id,checkId:descriptor.id,grantId:revoked.id}),{code:'stale_grant'});
  ok('revoked check grant cannot launch a guest');
  report.verdict='PASS';
}catch(error){report.verdict='FAIL';report.error=String(error.stack||error);process.exitCode=1;console.error(report.error);}
finally{
  clearTimeout(watchdog);
  const cleanupErrors=[];
  for(const [instanceId,owned] of driver?.owned||[]){
    try{await driver.stop({instanceId,generation:owned.generation});}
    catch(error){cleanupErrors.push({instanceId,error:String(error.message)});}
  }
  report.cleanupConfirmed=cleanupErrors.length===0&&(driver?.owned.size??0)===0;
  if(!report.cleanupConfirmed){report.verdict='FAIL';report.cleanupErrors=cleanupErrors;process.exitCode=1;}
  report.finishedAt=new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath),{recursive:true});
  await fs.writeFile(reportPath,JSON.stringify(report,null,2));
  if(report.cleanupConfirmed)await fs.rm(root,{recursive:true,force:true});
  console.log(`${report.verdict}: ${report.checks.length} black-box hardware checks; evidence ${reportPath}`);
}
