// Trusted host-side Windows Sandbox lifecycle driver. Never used by default.
// A tested publisher with independently established provenance is an explicit
// prerequisite before WindowsSandboxBackend may register this driver for work.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fault } from './execution-contract.mjs';
import { verifyExecutionSnapshot, validateSnapshotPath } from './execution-snapshots.mjs';
import { createSandboxConfiguration } from './windows-sandbox-config.mjs';
import { prepareExecutionRequest } from './windows-sandbox-transport.mjs';
import { SEALED_PROTOCOL, readSealedReceiptBytes, registerSealedCollection } from './windows-sandbox-sealed-receipt.mjs';
import { BLACKBOX_KIND, BLACKBOX_COMMAND, ZERO_SHA256, validateBlackboxManifest, validateBlackboxRequest } from './native-blackbox-contract.mjs';
import { validateSandboxCliPackage, verifyPinnedSandboxCli } from './windows-sandbox-cli-identity.mjs';

const executeFile = promisify(execFile);
const HASH = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const GUEST_WORK = 'C:\\ChatMCP\\Work';
const GUEST_INPUT = 'C:\\ChatMCP\\Input';

// Absence is evidence only when the complete inventory is well formed. In
// particular, [{}] must never be interpreted as confirmation of termination.
export function parseSandboxInventory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.WindowsSandboxEnvironments))
    throw fault('invalid_cli_inventory','Windows Sandbox inventory is not a verified instance list.');
  const ids=[];
  for (const row of value.WindowsSandboxEnvironments) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        typeof row.Id !== 'string' || !UUID.test(row.Id))
      throw fault('invalid_cli_inventory','Windows Sandbox inventory contains an invalid instance UUID.');
    const id=row.Id.toLowerCase();
    if (ids.includes(id)) throw fault('invalid_cli_inventory','Windows Sandbox inventory repeats an instance UUID.');
    ids.push(id);
  }
  return Object.freeze(ids);
}

export class WindowsSandboxCliDriver {
  constructor({ cliPath, cliPackage = null, runtimeDirectory, nodeToolchainDirectory, stateDirectory, runCli = null, publicationProtocol = 'diagnostic-hmac' } = {}) {
    if (!cliPath || !path.isAbsolute(cliPath) ||
        !runtimeDirectory || !path.isAbsolute(runtimeDirectory) ||
        !nodeToolchainDirectory || !path.isAbsolute(nodeToolchainDirectory) ||
        !stateDirectory || !path.isAbsolute(stateDirectory)) {
      throw fault('invalid_windows_driver', 'CLI, runtime and state paths must be absolute and broker-controlled.');
    }
    this.cliPath = cliPath;
    // Injected transports are explicit test seams. Every real launch requires
    // the exact package identity and hash selected by trusted host preflight.
    if(!runCli&&!cliPackage)throw fault('untrusted_sandbox_cli','A verified Store CLI package is required for real Windows Sandbox execution.');
    this.cliPackage=cliPackage?Object.freeze({...validateSandboxCliPackage(cliPackage),sha256:cliPackage.sha256}):null;
    if(this.cliPackage)verifyPinnedSandboxCli(this.cliPackage,this.cliPath);
    this.runtimeDirectory = runtimeDirectory;
    this.nodeToolchainDirectory = nodeToolchainDirectory;
    this.stateDirectory = stateDirectory;
    if (!['diagnostic-hmac', SEALED_PROTOCOL].includes(publicationProtocol)) throw fault('invalid_windows_driver', 'Unknown publication protocol.');
    this.publicationProtocol = publicationProtocol;
    this.runCli = runCli || (async(args,{signal,timeout=30000}={})=>{
      const out=await executeFile(this.cliPath,args,{
        encoding:'utf8',windowsHide:true,timeout,maxBuffer:1024*1024,signal,
      });
      return out.stdout;
    });
    this.owned = new Map();
  }
  async #cli(args, options) {
    if(this.cliPackage)verifyPinnedSandboxCli(this.cliPackage,this.cliPath);
    // ExecFile exceptions can contain full sensitive -c command-line arguments.
    let text;
    try { text=await this.runCli(args,options); }
    catch { throw fault('sandbox_cli_failed', 'Windows Sandbox CLI operation failed (sensitive arguments redacted).'); }
    if (typeof text !== 'string' || text.length > 1024*1024) {
      throw fault('invalid_cli_output', 'Windows Sandbox CLI did not return bounded textual output.');
    }
    if (!text.trim()) return {};
    try { return JSON.parse(text); }
    catch { throw fault('invalid_cli_json', 'Windows Sandbox CLI response is not valid JSON.'); }
  }
  async #stage({request,snapshot,generation,signal}) {
    signal?.throwIfAborted();
    if (!UUID.test(generation)) throw fault('invalid_generation', 'Run generation must be a UUID.');
    await verifyExecutionSnapshot(snapshot);
    const root=path.join(this.stateDirectory,'run-'+generation);
    const input=path.join(root,'input');
    const output=path.join(root,'output');
    // A private run UUID must not be reused. Never select an existing user's
    // directories or accept path names supplied by a model.
    await fs.mkdir(root,{recursive:false,mode:0o700});
    await fs.mkdir(input,{mode:0o700});
    await fs.mkdir(output,{mode:0o700});
    const runtime=path.join(this.runtimeDirectory,'GuestSupervisor.exe');
    const hashFile=path.join(this.runtimeDirectory,'GuestSupervisor.exe.sha256');
    const executable=await fs.readFile(runtime);
    const manifest=(await fs.readFile(hashFile,'utf8')).trim();
    if (!/^[a-fA-F0-9]{64}  GuestSupervisor\.exe$/.test(manifest) ||
        !crypto.timingSafeEqual(Buffer.from(HASH(executable),'hex'),Buffer.from(manifest.slice(0,64),'hex'))) {
      throw fault('untrusted_supervisor','Installed trusted supervisor does not match its pinned SHA-256 manifest.');
    }
    await fs.writeFile(path.join(input,'GuestSupervisor.exe'),executable,{flag:'wx',mode:0o400});
    const nodeSource=path.join(this.nodeToolchainDirectory,'node.exe');
    const nodeHash=(await fs.readFile(path.join(this.nodeToolchainDirectory,'node.exe.sha256'),'utf8')).trim();
    if (!/^[a-fA-F0-9]{64}  node\.exe$/.test(nodeHash)) throw fault('untrusted_toolchain','Node runtime manifest format is invalid.');
    const nodeBytes=await fs.readFile(nodeSource);
    if (!crypto.timingSafeEqual(Buffer.from(HASH(nodeBytes),'hex'),Buffer.from(nodeHash.slice(0,64),'hex'))) {
      throw fault('untrusted_toolchain','Installed offline Node runtime hash does not match installer manifest.');
    }
    const toolchainDir=path.join(input,'toolchain');
    await fs.mkdir(toolchainDir,{mode:0o700});
    await fs.writeFile(path.join(toolchainDir,'node.exe'),nodeBytes,{flag:'wx',mode:0o400});
    const blackbox=request.checkKind===BLACKBOX_KIND;
    if (blackbox && (request.command!==BLACKBOX_COMMAND || this.publicationProtocol!==SEALED_PROTOCOL))
      throw fault('unsupported_toolchain','Native black-box checks require the sealed publication protocol.');
    const reporterBytes=blackbox?null:await fs.readFile(new URL('./windows-sandbox-node-reporter.mjs',import.meta.url));
    if(reporterBytes)await fs.writeFile(path.join(input,'node-test-reporter.mjs'),reporterBytes,{flag:'wx',mode:0o400});
    const project=path.join(input,'project');
    await fs.mkdir(project,{mode:0o700});
    for (const file of snapshot.manifest.files) {
      signal?.throwIfAborted();
      const name=validateSnapshotPath(file.path);
      const source=path.join(snapshot.directory,...name.split('/'));
      const target=path.join(project,...name.split('/'));
      await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
      const content=await fs.readFile(source);
      if (content.length !== file.size || HASH(content) !== file.sha256) {
        throw fault('snapshot_changed','Staged file changed after snapshot verification.');
      }
      await fs.writeFile(target,content,{flag:'wx',mode:0o400});
    }
    // Never interpolate arbitrary model/project shell strings into SYSTEM launch.
    if (!blackbox && request.command !== 'node --test') {
      throw fault('unsupported_toolchain','Only fixed offline Node checks are supported.');
    }
    let grader=null,graderSha256=ZERO_SHA256;
    let args=['--test','--test-reporter=file:///C:/ChatMCP/Input/node-test-reporter.mjs'];
    if(blackbox) {
      const binding=validateBlackboxRequest(request.grader);
      const pinned=snapshot.manifest.files.find(file=>file.path===binding.manifestPath);
      if(!pinned || pinned.sha256!==binding.manifestSha256)
        throw fault('stale_check','Black-box case specification differs from the approved snapshot.');
      const bytes=await fs.readFile(path.join(project,...binding.manifestPath.split('/')));
      if(HASH(bytes)!==binding.manifestSha256)throw fault('stale_check','Black-box specification changed while staging.');
      const spec=validateBlackboxManifest(bytes);
      if(JSON.stringify(spec.cases.map(item=>item.id))!==JSON.stringify(binding.caseIds) ||
          !snapshot.manifest.files.some(file=>file.path===spec.adapter))
        throw fault('stale_check','Approved cases or adapter are absent from the immutable snapshot.');
      await fs.writeFile(path.join(input,'blackbox-check.json'),bytes,{flag:'wx',mode:0o400});
      graderSha256=binding.manifestSha256;
      grader={version:1,kind:BLACKBOX_KIND,manifestPath:GUEST_INPUT+'\\blackbox-check.json',manifestSha256:graderSha256};
      args=[GUEST_INPUT+'\\project\\'+spec.adapter.replaceAll('/','\\')];
    }
    const requestMeta=await prepareExecutionRequest({
      inputDirectory:input,runId:request.runId,
      command:GUEST_INPUT+'\\toolchain\\node.exe',
      args,grader,
      cwd:this.publicationProtocol===SEALED_PROTOCOL?GUEST_INPUT+'\\project':GUEST_WORK,
      timeoutSeconds:request.limits?.timeoutSeconds ?? 120,
      maxOutputBytes:blackbox?Math.min(request.limits?.maxOutputBytes ?? 64*1024,64*1024):request.limits?.maxOutputBytes ?? 100*1024,
    });
    const snapshotBytes = Buffer.from(JSON.stringify({baseSha:snapshot.manifest.baseSha,files:snapshot.manifest.files}));
    await fs.writeFile(path.join(input,'snapshot.json'),snapshotBytes,{flag:'wx',mode:0o400});
    const xml=createSandboxConfiguration({
      inputDirectory:input,exportDirectory:output,
      workspaceRoot:snapshot.directory,memoryMb:4096,protectedClient:true,
    });
    return {root,input,output,xml,nonce:requestMeta.nonce,authKey:requestMeta.authKey,
      supervisorSha256:HASH(executable),toolchainSha256:HASH(nodeBytes),snapshotSha256:snapshot.contentHash,
      requestSha256:HASH(await fs.readFile(requestMeta.requestPath)),reporterSha256:reporterBytes?HASH(reporterBytes):ZERO_SHA256,graderSha256};
  }
  async start({request,snapshot,generation,signal}) {
    if (this.owned.size) throw fault('sandbox_busy','This driver already owns an active Sandbox.');
    if (this.publicationProtocol === SEALED_PROTOCOL &&
        (!/^[0-9a-f]{64}$/.test(request.checkHash || '') || request.snapshotHash !== snapshot.contentHash)) {
      throw fault('invalid_seal_context','Sealed publication requires exact snapshot and check hashes.');
    }
    await fs.mkdir(this.stateDirectory,{recursive:true,mode:0o700});
    const before=parseSandboxInventory(await this.#cli(['list','--raw'],{signal,timeout:15000}));
    if (before.length) {
      throw fault('sandbox_busy','An existing or unverified Windows Sandbox is running.');
    }
    const stage=await this.#stage({request,snapshot,generation,signal});
    // Once the CLI launch begins, malformed output is an ownership emergency.
    // Do not stop an unknown instance or delete forensic staging.
    const created=await this.#cli(['start','-c',stage.xml,'--raw'],{signal,timeout:30000});
    if (typeof created?.Id !== 'string' || !UUID.test(created.Id))
      throw fault('unconfirmed_launch','CLI launched without a confirmed owned instance UUID.');
    const id=created.Id.toLowerCase();
    const running=parseSandboxInventory(await this.#cli(['list','--raw'],{signal,timeout:15000}));
    if (running.length!==1 || running[0]!==id) {
      throw fault('unconfirmed_launch','New Sandbox ID did not appear in the owned instance list.');
    }
    this.owned.set(id,{...stage,generation,runId:request.runId});
    if (this.publicationProtocol === SEALED_PROTOCOL) {
      const envelope = {version:1,instanceId:id,generation,runId:request.runId,nonce:stage.nonce,
        supervisorSha256:stage.supervisorSha256,toolchainSha256:stage.toolchainSha256,
        checkSha256:request.checkHash,snapshotSha256:stage.snapshotSha256,
        testBaselineSha256:stage.snapshotSha256,requestSha256:stage.requestSha256,reporterSha256:stage.reporterSha256,
        graderSha256:stage.graderSha256};
      const envelopeBytes=Buffer.from(JSON.stringify(envelope));
      // The guest mapping is read-only; finalize only from the trusted host,
      // after positive ownership and before any project process is created.
      await fs.writeFile(path.join(stage.input,'envelope.json'),envelopeBytes,{flag:'wx',mode:0o400});
      this.owned.get(id).envelopeBytes=envelopeBytes;
    }
    return {instanceId:id};
  }
  async execute({request,instanceId,generation,signal}) {
    const owned=this.owned.get(instanceId);
    if (!owned || owned.generation!==generation || owned.runId!==request.runId) {
      throw fault('sandbox_not_owned','Refusing to execute in an unowned or stale Windows Sandbox.');
    }
    if (this.publicationProtocol === SEALED_PROTOCOL && owned.executionStarted) {
      throw fault('replayed_generation','A sealed generation can execute only once.');
    }
    const running=parseSandboxInventory(await this.#cli(['list','--raw'],{signal,timeout:15000}));
    if (running.length!==1 || running[0]!==instanceId)
      throw fault('sandbox_not_owned','Owned Sandbox is not the only verified active instance.');
    // Staging is a fixed copy-only bootstrap and never runs project hooks.
    if (this.publicationProtocol !== SEALED_PROTOCOL) {
    const copyResult=await this.#cli([
      'exec','--id',instanceId,'-r','System',
      '-c','C:\\Windows\\System32\\robocopy.exe C:\\ChatMCP\\Input\\project C:\\ChatMCP\\Work /E /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS','--raw'
    ],{signal,timeout:30000});
    if (!Number.isInteger(copyResult.ExitCode) || copyResult.ExitCode<0 || copyResult.ExitCode>=8) {
      throw fault('guest_stage_failed','Guest-local input copy failed.');
    }
    }
    if (this.publicationProtocol === SEALED_PROTOCOL) {
      if (owned.executionStarted) throw fault('replayed_generation','A sealed generation can execute only once.');
      owned.executionStarted=true;
      const response=await this.#cli([
        'exec','--id',instanceId,'-r','System','-c',
        'C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --seal-envelope C:\\ChatMCP\\Input\\envelope.json --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output','--raw',
      ],{signal,timeout:Math.ceil((request.limits?.timeoutSeconds??120)*1000)+30000});
      if (!Number.isInteger(response.ExitCode)) throw fault('unknown_guest_exit','Missing native supervisor exit code.');
      const responses=[];
      for(let index=0;index<9;index++) {
        signal?.throwIfAborted();
        responses.push(await this.#cli([
          'exec','--id',instanceId,'-r','System','-c',
          'C:\\ChatMCP\\Input\\GuestSupervisor.exe --digest-word C:\\ChatMCP\\Input\\envelope.json '+index,'--raw',
        ],{signal,timeout:15000}));
      }
      const listed=parseSandboxInventory(await this.#cli(['list','--raw'],{signal,timeout:15000}));
      if (listed.length!==1 || listed[0]!==instanceId) {
        throw fault('sandbox_not_owned','Owned instance vanished during native publication.');
      }
      return registerSealedCollection({
        context:{runId:request.runId,instanceId,generation,expectedNonce:owned.nonce,cliExitCode:response.ExitCode},
        envelopeBytes:owned.envelopeBytes,receiptBytes:readSealedReceiptBytes(owned.output),responses,
      });
    }
    // The HMAC authentication key is staged in an isolated run export folder.
    // This is a temporary diagnostic transport, NOT an attested ACL guarantee.
    // The HMAC authentication key is transferred via a private file in the
    // output directory, NEVER on the supervisor process argv, child environment, or mapped input.
    // GuestSupervisor shreds and deletes this file immediately upon startup before child execution.
    const keyFile = path.join(owned.output, '.auth_key');
    // Exclusive create: refuse pre-existing/symlinked/junctioned files rather
    // than overwriting an attacker-planted export entry. POSIX mode:0o600
    // does NOT establish owner-only Windows ACLs, so G4 stays blocked.
    await fs.writeFile(keyFile, owned.authKey, { flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') {
      try {
        const { execFileSync } = await import('node:child_process');
        const username = process.env.USERNAME || 'CURRENT_USER';
        execFileSync('icacls.exe', [
          keyFile,
          '/inheritance:r',
          '/grant:r', '*S-1-5-18:(R,W)',
          '/grant:r', '*S-1-5-32-544:(R,W)',
          '/grant:r', `${username}:(F)`,
        ], { stdio: 'pipe', timeout: 5000 });
      } catch (aclErr) {
        try { await fs.rm(keyFile, { force: true }); } catch {}
        throw fault('guest_stage_failed', `Failed to apply restrictive Windows ACL to key file: ${aclErr.message}`);
      }
    }
    let response;
    try {
      response = await this.#cli([
        'exec','--id',instanceId,'-r','System',
        '-c','C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output',
        '--raw'
      ],{signal,timeout:Math.ceil((request.limits?.timeoutSeconds??120)*1000)+15000});
    } finally {
      try { await fs.rm(keyFile, { force: true }); } catch {}
    }
    if (!Number.isInteger(response.ExitCode)) {
      throw fault('unknown_guest_exit','Windows Sandbox CLI returned no definitive guest execution exit code.');
    }
    // Raw export data are UNTRUSTED. The publisher (not this driver) must prove
    // supervisor origin, verify bounds and bind run/snapshot/check/generation.
    return Object.freeze({
      exportDirectory:owned.output,expectedNonce:owned.nonce,expectedAuthKey:owned.authKey,
      runId:request.runId,instanceId,generation,
      cliExitCode:response.ExitCode,
      publisherAuthenticated:false,
    });
  }
  async stop({instanceId,generation}) {
    const owned=this.owned.get(instanceId);
    if (!owned || owned.generation!==generation) {
      throw fault('sandbox_not_owned','Never stop a Sandbox which this driver cannot prove it owns.');
    }
    await this.#cli(['stop','--id',instanceId,'--raw'],{timeout:30000});
    const after=parseSandboxInventory(await this.#cli(['list','--raw'],{timeout:15000}));
    if (after.includes(instanceId)) {
      throw fault('sandbox_stop_unconfirmed','Owned Sandbox termination could not be confirmed.');
    }
    this.owned.delete(instanceId);
    // Export content is untrusted. Cleanup after stop is a separate operation,
    // never a reason to claim successful publication.
    try { await fs.rm(owned.root,{recursive:true,force:true}); } catch {}
    return {stopped:true,instanceId};
  }
}


/**
 * Resolve the real Windows Sandbox CLI only after a trusted host preflight.
 * Reuse the SAME underlying driver for start/exec/stop: a later preflight
 * naturally reports the owned guest as running and must not lose ownership.
 * No automatic host fallback and no arbitrary user/model CLI path overrides.
 */
export class LazyWindowsSandboxDriver {
  constructor({preflight,runtimeDirectory,nodeToolchainDirectory,stateDirectory,runCli=null,publicationProtocol='diagnostic-hmac'}={}){
    if(typeof preflight!=='function'||!runtimeDirectory||!nodeToolchainDirectory||
        !stateDirectory||!path.isAbsolute(stateDirectory)) {
      throw fault('invalid_windows_driver','Host preflight and private driver directories are required.');
    }
    this.preflight=preflight;
    this.runtimeDirectory=runtimeDirectory;
    this.nodeToolchainDirectory=nodeToolchainDirectory;
    this.stateDirectory=stateDirectory;
    this.runCli=runCli;
    this.publicationProtocol=publicationProtocol;
    this.delegate=null;
    this.launching=false;
    this.quarantined=false;
  }
  async start(args){
    if(this.delegate||this.launching||this.quarantined)
      throw fault('sandbox_busy','A previous owned guest is running or requires manual reconciliation.');
    this.launching=true;
    try{
      let pre=await this.preflight();
      for(let retry=0; retry<15 && !pre?.available && (pre?.blockers||[]).some(b=>b.includes('currently running')); retry++){
        await new Promise(r=>setTimeout(r, 500));
        pre=await this.preflight();
      }
      if(!pre?.available || typeof pre?.details?.cliPath!=='string' ||
          !path.isAbsolute(pre.details.cliPath)){
        throw fault('sandbox_preflight_blocked','Windows Sandbox CLI path or OS requirements are not verified.');
      }
      // Pin this instance to the preflight-selected CLI until it is stopped.
      const delegate=new WindowsSandboxCliDriver({
        cliPath:pre.details.cliPath,
        cliPackage:pre.details.cliPackage,
        runtimeDirectory:this.runtimeDirectory,
        nodeToolchainDirectory:this.nodeToolchainDirectory,
        stateDirectory:this.stateDirectory,
        runCli:this.runCli,
        publicationProtocol:this.publicationProtocol,
      });
      this.delegate=delegate; // persist intent before invoking wsb start
      return await delegate.start(args);
    }catch(error){
      // If guest launch began and status is uncertain, block new attempts.
      // An explicit host investigation is safer than an automatic replay.
      if(this.delegate)this.quarantined=true;
      throw error;
    }finally{this.launching=false;}
  }
  async execute(args){
    if(!this.delegate||this.quarantined)
      throw fault('sandbox_not_owned','No trusted active owned Windows guest.');
    return this.delegate.execute(args);
  }
  async stop(args){
    if(!this.delegate)throw fault('sandbox_not_owned','Cannot stop a guest without trusted ownership.');
    try{
      const result=await this.delegate.stop(args);
      if(!result?.stopped||result.instanceId!==args.instanceId)
        throw fault('sandbox_stop_unconfirmed','Guest termination has not been independently confirmed.');
      this.delegate=null;
      this.quarantined=false;
      return result;
    }catch(error){this.quarantined=true;throw error;}
  }
}
