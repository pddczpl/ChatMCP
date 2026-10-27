// Phase 1 G4 transport FEASIBILITY probe, never publisher attestation.
//
// The caller must already hold an exact Windows Sandbox instance owner
// record (UUID + generation). The fixed guest command echoes a fresh PUBLIC
// marker through "wsb exec --raw"; no secrets or project files are read.
// Returning CLI_PROCESS_STDOUT_OBSERVED means only that the CLI forwards an
// arbitrary guest command's stdout. A hostile process could forge such an
// echo. This module NEVER marks output as production-authenticated.
import { randomBytes } from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const response=(status,hasStdout=false,echoObserved=false,exitCodeObserved=false,keys=[]) =>
  Object.freeze({status,hasStdout,echoObserved,exitCodeObserved,
    reportedFields:Object.freeze(keys),productionAuthenticated:false});

export async function probeOwnedSandboxCliStdout({owned,runCli}={}) {
  if(!UUID.test(owned?.instanceId||'') || !UUID.test(owned?.generation||'') ||
      typeof runCli!=='function') {
    const err=new Error('Trusted, already-owned Windows Sandbox UUID/generation and CLI function required.');
    err.code='cli_probe_owner_required';
    throw err;
  }
  const marker='CHATMCP_OUTPUT_CHANNEL_'+randomBytes(10).toString('hex').toUpperCase();
  const args=['exec','--id',owned.instanceId,'-r','System',
    '-c','cmd.exe /d /c echo '+marker,'--raw'];
  let raw;
  try { raw=await runCli(args); }
  catch { return response('CLI_PROBE_FAILED'); }
  if(typeof raw!=='string'||raw.length>128*1024)
    return response('CLI_RESPONSE_UNUSABLE');
  let value;
  try { value=JSON.parse(raw); }
  catch { return response('CLI_RESPONSE_UNUSABLE'); }
  if(!value || typeof value!=='object'||Array.isArray(value))
    return response('CLI_RESPONSE_UNUSABLE');
  const keys=Object.keys(value).sort().filter(k=>k.length<=80).slice(0,24);
  // Never propagate guest output; return an observation of one public marker.
  const stdout=typeof value.Stdout==='string'&&value.Stdout.length<=64*1024?value.Stdout:null;
  const echo=stdout!==null && stdout.split(/\r?\n/).some(s=>s.trim()===marker);
  const exit0=value.ExitCode===0;
  return response(echo&&exit0?'CLI_PROCESS_STDOUT_OBSERVED':'CLI_PROCESS_STDOUT_NOT_PROVEN',
    stdout!==null,echo,exit0,keys);
}
