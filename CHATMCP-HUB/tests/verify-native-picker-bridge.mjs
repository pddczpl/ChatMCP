// Native Windows folder-picker regression: interactive child visibility,
// UTF-8 JSON wire response, safe diagnostic fallback, and a no-UI STA probe.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {HubManager} from '../lib/manager.mjs';
import {powerShell7ModuleStandIn,powerShellChildEnvironment} from './support/powershell-environment.mjs';

const bundleRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-picker-test-'));
try{
  const manager=new HubManager({bundleRoot,dataDirectory:temp,log:()=>{}});
  manager.powerShell=async()=> 'powershell.exe';
  let called=false;
  manager.checkedRun=async(_command,args,options)=>{
    called=true;
    assert.equal(options.quiet,true);
    assert.equal(options.windowsHide,false,'interactive FolderBrowserDialog MUST NOT be launched as a hidden child');
    assert.ok(args.includes('-STA'),'WinForms requires single-threaded apartment');
    assert.equal(args.at(-1).endsWith('Select-Workspace.ps1'),true);
    return '{"path":null,"probe":false}\n';
  };
  assert.deepEqual(await manager.browse(),{path:null});
  assert.equal(called,true);
  manager.checkedRun=async()=>{const error=new Error('Subprocess exited');
    error.result={code:1,output:'[CHATMCP-HUB] Folder picker failed: InvalidOperationException\n{"path":null}'};
    throw error;
  };
  await assert.rejects(manager.browse(),error=>{
    assert.equal(error.code,'native_folder_picker_failed');
    assert.equal(error.statusCode,503);
    assert.ok(error.message.includes('InvalidOperationException'));
    assert.ok(error.message.includes('dán đường dẫn'));
    return true;
  });
  manager.checkedRun=async()=> 'not-json';
  await assert.rejects(manager.browse(),{code:'native_folder_picker_invalid'});

  if(process.platform==='win32'){
    const file=path.join(bundleRoot,'windows','Select-Workspace.ps1');
    const out=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-STA','-File',file,'-Probe'],
      {encoding:'utf8',timeout:20000,windowsHide:false,env:powerShellChildEnvironment()});
    assert.equal(out.status,0,'native WinForms construction failed: '+String(out.stderr||'').slice(0,500));
    const last=String(out.stdout||'').trim().split(/\r?\n/).at(-1);
    const result=JSON.parse(last);
    assert.equal(result.probe,true);
    assert.equal(result.path,null);

    // A Hub started from a pwsh session carries the module folders of PowerShell 7 (lib/powershell-environment.mjs): the picker's PowerShell must not get them.
    // A bundle whose Select-Workspace.ps1 only reports whether it still has Get-FileHash tells whether it did; the raw child is the control.
    const modules=await powerShell7ModuleStandIn(path.join(temp,'ps7'));
    const lookup="try { 'FOUND ' + (Get-FileHash -LiteralPath $env:ComSpec -Algorithm SHA256).Hash.Length } catch { 'MISSING' }";
    const observer=path.join(temp,'observer-bundle');
    await fs.mkdir(path.join(observer,'windows'),{recursive:true});
    const script=path.join(observer,'windows','Select-Workspace.ps1');
    await fs.writeFile(script,`param([string]$InitialPath, [switch]$Probe)\r\n$answer = ${lookup}\r\n[Console]::Out.WriteLine(([pscustomobject]@{ path = $answer } | ConvertTo-Json -Compress))\r\n`);
    const savedModulePath=process.env.PSModulePath;
    process.env.PSModulePath=`${modules};${savedModulePath??''}`;
    try{
      const raw=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-File',script],{encoding:'utf8',timeout:20000,windowsHide:true,env:process.env});
      assert.equal(JSON.parse(String(raw.stdout).trim().split(/\r?\n/).at(-1)).path,'MISSING','control: behind the module folder of PowerShell 7 a raw child loses Get-FileHash');
      const observed=new HubManager({bundleRoot:observer,dataDirectory:temp,log:()=>{}});
      assert.deepEqual(await observed.browse(),{path:'FOUND 64'},'the folder picker is started without the module folders of PowerShell 7');
    }finally{if(savedModulePath===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=savedModulePath;}
  }
  console.log('PASS native workspace picker interactive launcher, safe fallback and Windows -STA -Probe');
} finally{await fs.rm(temp,{recursive:true,force:true,maxRetries:5}).catch(()=>{});}
