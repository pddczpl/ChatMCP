// Real native candidate acceptance. A passing transport probe is deliberately
// distinct from independent G4 approval and never enables production.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WindowsSandboxCliDriver } from '../../lib/windows-sandbox-driver.mjs';
import { WindowsSandboxPublisher } from '../../lib/windows-sandbox-publisher.mjs';
import { SEALED_PROTOCOL, readSealedReceiptBytes, sealedReceiptPayload } from '../../lib/windows-sandbox-sealed-receipt.mjs';
import { observeUnattestedExitDigest } from '../../lib/windows-sandbox-exitcode-channel.mjs';
import { createExecutionSnapshot } from '../../lib/execution-snapshots.mjs';
import { probeWindowsSandboxPreflight } from '../../lib/windows-sandbox-probe.mjs';
import { parseRegisteredNodeTests } from '../../lib/verification-receipt.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-native-seal-'));
const report={schema:1,startedAt:new Date().toISOString(),productionAuthenticated:false,G4:'BLOCKED',runs:[]};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const executeFile=promisify(execFile);
const destination=path.resolve(process.env.CHATMCP_NATIVE_SEAL_REPORT||'test-results/native-seal.json');
let active=null;
try {
  const preflight=await probeWindowsSandboxPreflight();
  report.host=preflight.details;
  assert.equal(preflight.available,true,(preflight.blockers||[]).join('; '));
  const runtime=path.join(root,'runtime'),node=path.join(root,'node'),workspace=path.join(root,'workspace');
  for(const directory of [runtime,node,workspace])await fs.mkdir(directory);
  const supervisor=await fs.readFile(fileURLToPath(new URL('../../windows/sandbox/GuestSupervisor/bin/Release/net10.0/win-x64/publish/GuestSupervisor.exe',import.meta.url)));
  const nodeBytes=await fs.readFile(process.execPath);
  report.supervisorSha256=sha(supervisor);report.nodeSha256=sha(nodeBytes);
  for(const [directory,name,bytes] of [[runtime,'GuestSupervisor.exe',supervisor],[node,'node.exe',nodeBytes]]) {
    await fs.writeFile(path.join(directory,name),bytes);
    await fs.writeFile(path.join(directory,name+'.sha256'),sha(bytes)+'  '+name);
  }
  await fs.writeFile(path.join(workspace,'native.test.mjs'),String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
test('restricted child cannot open or publish protected seal',()=>{
 const output=execFileSync('C:\\ChatMCP\\Input\\GuestSupervisor.exe',['--seal-child-probe','C:\\ChatMCP\\Input\\envelope.json'],{encoding:'utf8',windowsHide:true});
 console.log(output);
 assert.match(output,/SEAL_CHILD_DENIAL_CONFIRMED=True/);
});
`);
  const snapshot=await createExecutionSnapshot({workspace,files:['native.test.mjs'],outputRoot:path.join(root,'snapshots')});
  const generation=crypto.randomUUID(),runId=crypto.randomUUID();
  const request={runId,command:'node --test',snapshotHash:snapshot.contentHash,checkHash:sha('native-seal-denial-v1'),limits:{timeoutSeconds:90,maxOutputBytes:100*1024}};
  const driver=new WindowsSandboxCliDriver({cliPath:preflight.details.cliPath,runtimeDirectory:runtime,
    nodeToolchainDirectory:node,stateDirectory:path.join(root,'state'),publicationProtocol:SEALED_PROTOCOL,
    runCli:async(args,options={})=>{
      const result=await executeFile(preflight.details.cliPath,args,{encoding:'utf8',windowsHide:true,
        maxBuffer:1024*1024,timeout:options.timeout||30000,signal:options.signal});
      const command=args[args.indexOf('-c')+1];
      if(args[0]==='exec'&&command?.includes('--digest-word')) {
        report.digestWords??=[];
        report.digestWords.push({instanceId:args[args.indexOf('--id')+1],index:Number(command.split(' ').at(-1)),response:JSON.parse(result.stdout)});
      }
      return result.stdout;
    }});
  const started=await driver.start({request,snapshot,generation});
  active={driver,generation,instanceId:started.instanceId};
  const envelopeBytes=await fs.readFile(path.join(driver.owned.get(started.instanceId).input,'envelope.json'));
  report.envelope=JSON.parse(envelopeBytes);
  report.envelopeBytesBase64=envelopeBytes.toString('base64');
  const entry={instanceId:started.instanceId,generation,runId,snapshotHash:snapshot.contentHash};
  report.runs.push(entry);
  try {
    const startedAt=Date.now();
    const raw=await driver.execute({request,instanceId:started.instanceId,generation});
    entry.transportMs=Date.now()-startedAt;
    const receiptBytes=readSealedReceiptBytes(driver.owned.get(started.instanceId).output);
    report.receiptBytesBase64=receiptBytes.toString('base64');
    assert.equal(observeUnattestedExitDigest({payload:sealedReceiptPayload(envelopeBytes,receiptBytes),
      rawResponses:report.digestWords.map(word=>word.response)}).digestMatches,true);
    const verified=await new WindowsSandboxPublisher().verify({raw,request,snapshot,instanceId:started.instanceId,generation});
    entry.receipt=verified.receipt;
    assert.equal(verified.receipt.status,'completed');
    assert.match(verified.receipt.stdout,/SEAL_CHILD_DENIAL_CONFIRMED=True/);
    assert.deepEqual(parseRegisteredNodeTests(verified.receipt.stdout),{tests:1,pass:1,fail:0});
    entry.transportVerdict='PASS';
    console.log(verified.receipt.stdout);
    console.log('PASS: real SYSTEM-sealed digest, restricted child denial and nine native ExitCode words; independent G4 remains BLOCKED.');
  } catch(error) {
    entry.error=String(error.message);
    try { entry.unverifiedDiagnostic=JSON.parse(await fs.readFile(path.join(driver.owned.get(started.instanceId).output,'receipt.json'),'utf8')); }
    catch {}
    console.error(JSON.stringify(entry,null,2));
    throw error;
  } finally {
    entry.cleanup=await driver.stop({instanceId:started.instanceId,generation});active=null;
  }
} catch(error) {
  report.error=String(error.stack||error);process.exitCode=1;
} finally {
  if(active) await active.driver.stop(active).catch(error=>{report.cleanupError=String(error.message);});
  report.finishedAt=new Date().toISOString();
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.writeFile(destination,JSON.stringify(report,null,2));
  if(!report.cleanupError)await fs.rm(root,{recursive:true,force:true});
  console.log('Native evidence: '+destination);
}
