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

const executeFile = promisify(execFile);
const HASH = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const GENERATED_LAUNCH_SCRIPT = [
  '@echo off',
  'setlocal',
  'mkdir C:\\ChatMCP\\Work 2>nul',
  'robocopy C:\\ChatMCP\\Input\\project C:\\ChatMCP\\Work /E /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS >nul',
  'if %ERRORLEVEL% GEQ 8 exit /b %ERRORLEVEL%',
  'C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');

export class WindowsSandboxCliDriver {
  constructor({ cliPath, runtimeDirectory, stateDirectory, runCli = null } = {}) {
    if (!cliPath || !path.isAbsolute(cliPath) ||
        !runtimeDirectory || !path.isAbsolute(runtimeDirectory) ||
        !stateDirectory || !path.isAbsolute(stateDirectory)) {
      throw fault('invalid_windows_driver', 'CLI, runtime and state paths must be absolute and broker-controlled.');
    }
    this.cliPath = cliPath;
    this.runtimeDirectory = runtimeDirectory;
    this.stateDirectory = stateDirectory;
    this.runCli = runCli || (async(args,{signal,timeout=30000}={})=>{
      const out=await executeFile(this.cliPath,args,{
        encoding:'utf8',windowsHide:true,timeout,maxBuffer:1024*1024,signal,
      });
      return out.stdout;
    });
    this.owned = new Map();
  }
  async #cli(args, options) {
    const text=await this.runCli(args,options);
    if (typeof text !== 'string' || text.length > 1024*1024) {
      throw fault('invalid_cli_output', 'Windows Sandbox CLI did not return bounded textual output.');
    }
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
    const requestMeta=await prepareExecutionRequest({
      inputDirectory:input,runId:request.runId,command:'cmd.exe',
      args:['/d','/s','/c',request.command],
      cwd:'C:\\ChatMCP\\Work',
      timeoutSeconds:request.limits?.timeoutSeconds ?? 120,
      maxOutputBytes:request.limits?.maxOutputBytes ?? 100*1024,
    });
    await fs.writeFile(path.join(input,'launch.cmd'),GENERATED_LAUNCH_SCRIPT,{flag:'wx',mode:0o400});
    const xml=createSandboxConfiguration({
      inputDirectory:input,exportDirectory:output,
      workspaceRoot:snapshot.directory,memoryMb:4096,protectedClient:true,
    });
    return {root,input,output,xml,nonce:requestMeta.nonce};
  }
  async start({request,snapshot,generation,signal}) {
    if (this.owned.size) throw fault('sandbox_busy','This driver already owns an active Sandbox.');
    await fs.mkdir(this.stateDirectory,{recursive:true,mode:0o700});
    const before=await this.#cli(['list','--raw'],{signal,timeout:15000});
    if (!Array.isArray(before.WindowsSandboxEnvironments) || before.WindowsSandboxEnvironments.length) {
      throw fault('sandbox_busy','An existing or unverified Windows Sandbox is running.');
    }
    const stage=await this.#stage({request,snapshot,generation,signal});
    // Once the CLI launch begins, malformed output is an ownership emergency.
    // Do not stop an unknown instance or delete forensic staging.
    const created=await this.#cli(['start','-c',stage.xml,'--raw'],{signal,timeout:30000});
    const id=created.Id;
    if (!UUID.test(id || '')) throw fault('unconfirmed_launch','CLI launched without a confirmed owned instance UUID.');
    const running=await this.#cli(['list','--raw'],{signal,timeout:15000});
    if (!Array.isArray(running.WindowsSandboxEnvironments) ||
        !running.WindowsSandboxEnvironments.some(x=>x.Id===id)) {
      throw fault('unconfirmed_launch','New Sandbox ID did not appear in the owned instance list.');
    }
    this.owned.set(id,{...stage,generation,runId:request.runId});
    return {instanceId:id};
  }
  async execute({request,instanceId,generation,signal}) {
    const owned=this.owned.get(instanceId);
    if (!owned || owned.generation!==generation || owned.runId!==request.runId) {
      throw fault('sandbox_not_owned','Refusing to execute in an unowned or stale Windows Sandbox.');
    }
    const response=await this.#cli([
      'exec','--id',instanceId,'-r','System',
      '-c','cmd.exe /d /s /c C:\\ChatMCP\\Input\\launch.cmd','--raw'
    ],{signal,timeout:Math.ceil((request.limits?.timeoutSeconds??120)*1000)+15000});
    if (!Number.isInteger(response.ExitCode)) {
      throw fault('unknown_guest_exit','Windows Sandbox CLI returned no definitive guest execution exit code.');
    }
    // Raw export data are UNTRUSTED. The publisher (not this driver) must prove
    // supervisor origin, verify bounds and bind run/snapshot/check/generation.
    return Object.freeze({
      exportDirectory:owned.output,expectedNonce:owned.nonce,
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
    const after=await this.#cli(['list','--raw'],{timeout:15000});
    if (!Array.isArray(after.WindowsSandboxEnvironments) ||
        after.WindowsSandboxEnvironments.some(x=>x.Id===instanceId)) {
      throw fault('sandbox_stop_unconfirmed','Owned Sandbox termination could not be confirmed.');
    }
    this.owned.delete(instanceId);
    // Export content is untrusted. Cleanup after stop is a separate operation,
    // never a reason to claim successful publication.
    try { await fs.rm(owned.root,{recursive:true,force:true}); } catch {}
    return {stopped:true,instanceId};
  }
}
