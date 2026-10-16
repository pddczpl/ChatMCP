// Native Windows folder-picker regression: interactive child visibility,
// UTF-8 JSON wire response, safe diagnostic fallback, and a no-UI STA probe.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {HubManager} from '../lib/manager.mjs';

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
      {encoding:'utf8',timeout:20000,windowsHide:false});
    assert.equal(out.status,0,'native WinForms construction failed: '+String(out.stderr||'').slice(0,500));
    const last=String(out.stdout||'').trim().split(/\r?\n/).at(-1);
    const result=JSON.parse(last);
    assert.equal(result.probe,true);
    assert.equal(result.path,null);
  }
  console.log('PASS native workspace picker interactive launcher, safe fallback and Windows -STA -Probe');
} finally{await fs.rm(temp,{recursive:true,force:true,maxRetries:5}).catch(()=>{});}
