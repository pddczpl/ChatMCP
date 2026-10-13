import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateSandboxCliPackage, readSandboxCliDigest, verifyPinnedSandboxCli } from '../lib/windows-sandbox-cli-identity.mjs';
import { WindowsSandboxCliDriver } from '../lib/windows-sandbox-driver.mjs';

const windowsAppsRoot='C:\\Program Files\\WindowsApps';
const packageFullName='MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__cw5n1h2txyewy';
const sample={name:'MicrosoftWindows.WindowsSandbox',packageFullName,
  packageFamilyName:'MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy',version:'0.8.107.0',
  publisher:'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  publisherId:'cw5n1h2txyewy',signatureKind:'Store',status:'Ok',architecture:'X64',
  isDevelopmentMode:false,installLocation:windowsAppsRoot+'\\'+packageFullName};
const good=validateSandboxCliPackage(sample,{windowsAppsRoot});
assert.equal(good.cliPath,sample.installLocation+'\\wsb.exe');
assert.equal(Object.isFrozen(good),true);
for(const change of [
  {name:'OtherPackage'},{publisher:'CN=Untrusted'},{publisherId:'other'},
  {packageFamilyName:'Other_family'},{packageFullName:packageFullName+'\\..\\other'},
  {version:'0.8.106.0'},{version:'99999.0.0.0'},{version:'1.2.3'},
  {signatureKind:'Developer'},{signatureKind:'None'},{status:'Modified'},
  {architecture:'Arm64'},{isDevelopmentMode:true},{isDevelopmentMode:'false'},
  {installLocation:'C:\\Users\\Example\\AppData\\Local\\Microsoft\\WindowsApps'},
  {installLocation:'C:\\writable\\'+packageFullName},
  {cliPath:'C:\\Users\\Example\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe'},
]) assert.throws(()=>validateSandboxCliPackage({...sample,...change},{windowsAppsRoot}),
  {code:'untrusted_sandbox_cli'});
assert.throws(()=>verifyPinnedSandboxCli({...good,sha256:'a'.repeat(64)},'C:\\writable\\wsb.exe'),
  {code:'untrusted_sandbox_cli'});
assert.throws(()=>verifyPinnedSandboxCli({...good,sha256:'not-sha256'},good.cliPath),
  {code:'untrusted_sandbox_cli'});
console.log('PASS: CLI provenance rejects aliases, different publishers, unsigned/development packages and inconsistent versions');

const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-cli-identity-'));
try {
  const file=path.join(temporary,'wsb.exe');
  const original=Buffer.from('synthetic CLI fixture; never executed');
  await fs.writeFile(file,original);
  const sha=crypto.createHash('sha256').update(original).digest('hex');
  assert.equal(readSandboxCliDigest(file),sha);
  await fs.writeFile(file,Buffer.from('changed synthetic CLI bytes'));
  assert.notEqual(readSandboxCliDigest(file),sha,'Replacing the selected bytes changes the measured identity');
  assert.throws(()=>new WindowsSandboxCliDriver({cliPath:file,
    runtimeDirectory:temporary,nodeToolchainDirectory:temporary,stateDirectory:temporary}),
  {code:'untrusted_sandbox_cli'},'Real process execution must require OS package provenance');
  const link=path.join(temporary,'linked-cli.exe');
  let symlinkAvailable=true;
  try {await fs.symlink(file,link,'file');} catch(error) {
    if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;
    symlinkAvailable=false;
  }
  if(symlinkAvailable) {
    assert.throws(()=>readSandboxCliDigest(link),{code:'untrusted_sandbox_cli'});
    console.log('PASS: linked CLI executable is refused');
  } else console.log('SKIP: host does not permit creating a disposable symlink fixture');
  // Windows permits directory junctions without the file-symlink privilege.
  // Check that a linked parent cannot redirect an otherwise regular exe.
  const actualDirectory=path.join(temporary,'actual-directory');
  const linkedDirectory=path.join(temporary,'linked-directory');
  await fs.mkdir(actualDirectory);
  await fs.writeFile(path.join(actualDirectory,'wsb.exe'),original);
  await fs.symlink(actualDirectory,linkedDirectory,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>readSandboxCliDigest(path.join(linkedDirectory,'wsb.exe')),{code:'untrusted_sandbox_cli'});
  console.log('PASS: linked CLI directory ancestry is refused');
  console.log('PASS: CLI bytes are measured and real dispatch requires package identity');
} finally {await fs.rm(temporary,{recursive:true,force:true});}
