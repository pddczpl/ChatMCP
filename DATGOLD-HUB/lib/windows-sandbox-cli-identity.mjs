// Store package identity comes from the OS package manager, not an executable
// alias or PATH. Store signs the package; its individual PE need not carry an
// Authenticode signature. This pins the selected installed version and bytes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fault } from './execution-contract.mjs';

const NAME='MicrosoftWindows.WindowsSandbox';
const PUBLISHER_ID='cw5n1h2txyewy';
const PUBLISHER='CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&
  path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase();
const invalid=()=>fault('untrusted_sandbox_cli','The installed Windows Sandbox Store package identity could not be verified.');

export function sandboxWindowsAppsRoot() {
  return path.win32.join(process.env.ProgramW6432||process.env.ProgramFiles||'C:\\Program Files','WindowsApps');
}

export function validateSandboxCliPackage(value,{windowsAppsRoot=sandboxWindowsAppsRoot()}={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
      value.name!==NAME||value.publisherId!==PUBLISHER_ID||value.publisher!==PUBLISHER||
      value.packageFamilyName!==NAME+'_'+PUBLISHER_ID||value.signatureKind!=='Store'||
      value.status!=='Ok'||value.architecture!=='X64'||value.isDevelopmentMode!==false||
      typeof value.version!=='string'||!/^\d{1,5}(\.\d{1,5}){3}$/.test(value.version)||
      value.version.split('.').some(part=>Number(part)>65535)||
      value.packageFullName!==`${NAME}_${value.version}_x64__${PUBLISHER_ID}`||
      !path.win32.isAbsolute(windowsAppsRoot)) throw invalid();
  const installLocation=path.win32.join(windowsAppsRoot,value.packageFullName);
  const cliPath=path.win32.join(installLocation,'wsb.exe');
  if(!samePath(value.installLocation,installLocation)||
      (value.cliPath!==undefined&&!samePath(value.cliPath,cliPath))) throw invalid();
  return Object.freeze({name:NAME,packageFullName:value.packageFullName,
    packageFamilyName:value.packageFamilyName,version:value.version,publisher:PUBLISHER,
    publisherId:PUBLISHER_ID,signatureKind:'Store',status:'Ok',architecture:'X64',
    isDevelopmentMode:false,installLocation,cliPath});
}

export function readSandboxCliDigest(cliPath) {
  // Every parent must remain a real directory. Neither an app execution alias
  // nor a junction into an untrusted writable directory can satisfy this check.
  let current=path.parse(cliPath).root;
  const parts=cliPath.slice(current.length).split(path.sep);
  for(let i=0;i<parts.length;i++) {
    current=path.join(current,parts[i]);
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink()||(i<parts.length-1?!stat.isDirectory():!stat.isFile())) throw invalid();
  }
  if(!samePath(fs.realpathSync(cliPath),cliPath)) throw invalid();
  const fd=fs.openSync(cliPath,'r');
  try {
    const before=fs.fstatSync(fd);
    if(!before.isFile()||before.size<1||before.size>32*1024*1024)throw invalid();
    const bytes=fs.readFileSync(fd);
    const after=fs.fstatSync(fd);
    const currentStat=fs.statSync(cliPath);
    if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||
        before.dev!==currentStat.dev||before.ino!==currentStat.ino||before.mtimeMs!==currentStat.mtimeMs)
      throw invalid();
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } finally { fs.closeSync(fd); }
}

export function pinSandboxCliPackage(value,options) {
  const identity=validateSandboxCliPackage(value,options);
  return Object.freeze({...identity,sha256:readSandboxCliDigest(identity.cliPath)});
}

export function verifyPinnedSandboxCli(value,cliPath) {
  const identity=validateSandboxCliPackage(value);
  if(!samePath(identity.cliPath,cliPath)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||
      readSandboxCliDigest(identity.cliPath)!==value.sha256) throw invalid();
  return true;
}
