import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createHubServer } from '../hub.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { PermissionGate } from '../lib/permissions.mjs';
import { StudioTerminal } from '../lib/studio-terminal.mjs';
import { StudioWorkflow } from '../lib/studio-workflow.mjs';
import { StudioDelegates } from '../lib/studio-delegates.mjs';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-v2-http-'));
const dir=path.join(temp,'repo');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'main.py'),'def hello():\n    return 123\n');
const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
const origin=`http://127.0.0.1:${port}`;const taskId='123e4567-e89b-42d3-a456-426614174000';
const manager={workspace:dir,secrets:[],catalog:{ready:true,tools:[]},log:()=>{},state:()=>({version:'2.0.0',workspace:{path:dir},services:{docker:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'},desktop:{state:'ready'}}})};
manager.studio=new StudioWorkspace({manager,directory:path.join(temp,'state')});
manager.permissions=new PermissionGate({manager,workspace:manager.studio,directory:path.join(temp,'policy')});
manager.terminal=new StudioTerminal({workspace:manager.studio});
manager.workflow=new StudioWorkflow({directory:path.join(temp,'workflow')});
manager.delegates=new StudioDelegates({workspace:manager.studio,provider:{ready:()=>false},directory:path.join(temp,'delegates')});
const browser={browserState:()=>({paired:false})};
const engine={state:()=>({activeTaskId:null,active:null,tasks:[]}),get:()=>null,setAutoResume:async({id,enabled})=>({id,autoResume:enabled})};
const secret='studio-http-test-secret-0123456789abcdef';const auth={Authorization:`Bearer ${secret}`};
const server=createHubServer(manager,{port,secret,agent:engine,browser,bundleRoot:path.resolve(import.meta.dirname,'..')});await new Promise(r=>server.listen(port,'127.0.0.1',r));
let n=0;const ok=x=>{assert.ok(x);n++;};
const eq=(actual,expected,label)=>{assert.deepStrictEqual(actual,expected,label);n++;};
async function get(url){const r=await fetch(origin+url,{headers:auth});return [r,await r.json().catch(()=>null)];}
let csrf;
async function post(url,payload,override=null){const r=await fetch(origin+url,{method:'POST',headers:{...auth,Origin:origin,'Content-Type':'application/json','X-ChatMCP-Request':'local-dashboard','X-ChatMCP-CSRF':override??csrf},body:JSON.stringify(payload)});return [r,await r.json().catch(()=>null)];}
try{
  const [s,st]=await get('/api/state');ok(s.ok&&st.studio.permissions.mode==='review');csrf=st.csrfToken;
  let [r,v]=await get('/api/studio/tree');ok(r.ok&&v.entries.length===1);
  [r,v]=await get('/api/studio/file?file=main.py');ok(r.ok&&v.content.includes('hello'));
  [r,v]=await get('/api/studio/file?file=../bad');ok(r.status===403);
  [r,v]=await get('/api/studio/search?query=hello&mode=symbol');ok(r.ok&&v.matches.length===1);
  [r,v]=await post('/api/studio/permissions/config',{mode:'autonomous'},'wrong');ok(r.status===403);
  [r,v]=await post('/api/studio/permissions/config',{mode:'autonomous'});ok(r.ok&&v.mode==='autonomous');
  [r,v]=await post('/api/studio/checkpoint',{label:'baseline'});const id=v.id;ok(r.ok&&v.fileCount===1);
  [r,v]=await get('/api/studio/checkpoints');ok(r.ok&&v.some(x=>x.id===id));
  await fs.writeFile(path.join(dir,'main.py'),'def hello():\n    return 456\n');
  [r,v]=await get(`/api/studio/review?checkpointId=${encodeURIComponent(id)}`);const change=v.changes[0];ok(r.ok&&change.currentSha&&change.diff.includes('456'));
  [r,v]=await post('/api/studio/accept',{checkpointId:id,file:'main.py',expectedSha:change.currentSha});ok(r.ok);
  [r,v]=await post('/api/studio/restore',{checkpointId:id,file:'main.py',expectedSha:change.currentSha});ok(r.ok&&(await fs.readFile(path.join(dir,'main.py'),'utf8')).includes('123'));
  [r,v]=await post('/api/studio/terminal/start',{command:'echo HTTP-ok',timeoutMinutes:1});ok(r.ok&&v.id);
  let sawTermLog=false;
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));[r,v]=await get('/api/studio/terminal');if(r.ok&&v[0]?.logs?.some(x=>x.message.includes('HTTP-ok'))){sawTermLog=true;break;}}
  ok(sawTermLog);
  [r,v]=await post('/api/studio/plan/set',{taskId,title:'Roadmap',items:[{text:'Verify',status:'done',evidence:''}]});ok(r.ok&&v.items.length===1);
  [r,v]=await get('/api/studio/plan?taskId='+taskId);ok(r.ok&&v.title==='Roadmap');
  [r,v]=await post('/api/tasks/auto-resume',{id:taskId,enabled:true});ok(r.ok&&v.task.id===taskId&&v.task.autoResume);
  [r,v]=await post('/api/tasks/auto-resume',{id:taskId,enabled:false},'wrong');ok(r.status===403);
  [r,v]=await get('/api/studio/checks');ok(r.ok);
  [r,v]=await get('/api/studio/delegates');ok(r.ok);
  [r,v]=await get('/api/studio/workflow?taskId='+taskId);ok(r.ok&&v.steps.length===0);
  // ---- ux-5: the editor saves text without changing a byte it was not asked to change -------------------------------------
  // Every expectation is derived from the bytes written here, never from what the Hub reports about them.
  const sha256=buffer=>createHash('sha256').update(buffer).digest('hex');
  const BOM=Buffer.from([0xef,0xbb,0xbf]);
  const put=async(name,buffer)=>{await fs.writeFile(path.join(dir,name),buffer);return buffer;};
  const onDisk=name=>fs.readFile(path.join(dir,name));
  const same=(a,b)=>Buffer.isBuffer(a)&&Buffer.isBuffer(b)&&Buffer.compare(a,b)===0;
  const readUrl=(name,extra='')=>`/api/studio/file?file=${encodeURIComponent(name)}${extra}`;
  const save=(name,content,expectedSha)=>post('/api/studio/file/save',{file:name,content,expectedSha});
  const checkpointsAbout=async name=>(await get('/api/studio/checkpoints'))[1].filter(x=>x.label.includes(name)).length;
  const roundTrips=[
    ['plain.txt',Buffer.from(`héllo wörld ${String.fromCodePoint(0x1f600)}\nsecond line\n`,'utf8'),'next line\n','utf8','lf'],
    ['bom.txt',Buffer.concat([BOM,Buffer.from('bom file\n','utf8')]),'next line\n','utf8-bom','lf'],
    ['crlf.txt',Buffer.from('one\r\ntwo\r\nthree\r\n','utf8'),'four\r\n','utf8','crlf'],
  ];
  for(const [name,original,addition,encoding,eol] of roundTrips){
    await put(name,original);
    [r,v]=await get(readUrl(name));
    ok(r.ok&&v.sha256===sha256(original)&&same(Buffer.from(v.content,'utf8'),original)); // what the editor is handed is the file, byte for byte
    eq([v.encoding,v.eol],[encoding,eol],`${name}: the read says how the file is encoded`);
    const read=v;
    [r,v]=await save(name,read.content+addition,read.sha256);
    const expected=Buffer.concat([original,Buffer.from(addition,'utf8')]);
    ok(r.ok&&same(await onDisk(name),expected)); // only the text that was added changed
    eq([v.sha256,v.previousSha],[sha256(expected),sha256(original)],`${name}: the answer carries the sha of the bytes now on disk`);
    ok(same(await fs.readFile(path.join(temp,'state','checkpoints',v.checkpointId,'files',name)),original)); // checkpoint-before-write holds the file as it was
    [r,v]=await save(name,expected.toString('utf8'),sha256(expected));
    ok(r.ok&&v.unchanged===true&&same(await onDisk(name),expected)); // saving what is there writes nothing
  }
  // A file that is not UTF-8 is refused, and a refused save changes nothing and takes no checkpoint.
  const refused=[
    ['utf16-ascii.txt',Buffer.from([0xff,0xfe,0x68,0x00,0x69,0x00,0x0a,0x00]),'binary_file'], // UTF-16 text is full of NUL bytes
    ['utf16-cjk.txt',Buffer.from([0xff,0xfe,0xe5,0x65,0x2c,0x67,0x9e,0x8a]),'not_utf8'], // no NUL byte, but 0xFF is never UTF-8
    ['cp1252.txt',Buffer.from([0x63,0x61,0x66,0xe9,0x0a]),'not_utf8'], // "café" with the single byte of Windows-1252
  ];
  for(const [name,original,code] of refused){
    await put(name,original);
    [r,v]=await get(readUrl(name));
    eq([r.status,v.code],[415,code],`${name}: read is refused`);
    const before=await checkpointsAbout(name);
    [r,v]=await save(name,'overwritten\n',sha256(original));
    eq([r.status,v.code],[415,code],`${name}: save is refused even with the right sha`);
    ok(same(await onDisk(name),original)&&await checkpointsAbout(name)===before);
  }
  // A BOM is the file's, not the editor's: an editor that drops the character does not take the BOM out of the file, and one that keeps it does not double it.
  await put('bom-restore.txt',Buffer.concat([BOM,Buffer.from('bom restore\n','utf8')]));
  [r,v]=await get(readUrl('bom-restore.txt'));
  eq(v.content.charCodeAt(0),0xfeff,'the read keeps the BOM as the first character');
  const bomRead=v;
  [r,v]=await save('bom-restore.txt',bomRead.content.slice(1)+'edited\n',bomRead.sha256);
  const afterDrop=await onDisk('bom-restore.txt');
  ok(r.ok&&v.bomRestored===true&&same(afterDrop,Buffer.concat([BOM,Buffer.from('bom restore\nedited\n','utf8')]))&&!same(afterDrop.subarray(3,6),BOM));
  [r,v]=await get(readUrl('bom-restore.txt'));
  [r,v]=await save('bom-restore.txt',v.content+'more\n',v.sha256);
  ok(r.ok&&!v.bomRestored&&same(await onDisk('bom-restore.txt'),Buffer.concat([BOM,Buffer.from('bom restore\nedited\nmore\n','utf8')])));
  // A lone surrogate cannot be written as UTF-8: Buffer.from would turn it into U+FFFD without a word.
  await put('surrogate.txt',Buffer.from('keep\n'));
  [r,v]=await save('surrogate.txt','a'+String.fromCharCode(0xd800)+'b',sha256(Buffer.from('keep\n')));
  eq([r.status,v.code],[400,'invalid_unicode'],'a lone surrogate is refused');
  ok(same(await onDisk('surrogate.txt'),Buffer.from('keep\n')));
  // The limit is 300,000 bytes of text (not characters), the same through the HTTP route as inside save(), and the error says so.
  await put('limit.txt',Buffer.from('small\n'));
  [r,v]=await save('limit.txt','a'.repeat(300000),sha256(Buffer.from('small\n')));
  ok(r.ok&&(await onDisk('limit.txt')).length===300000); // exactly at the limit is accepted (and the body is far larger than the 64 KB of an ordinary POST)
  const atLimit=sha256(await onDisk('limit.txt'));
  [r,v]=await save('limit.txt','a'.repeat(300001),atLimit);
  eq([r.status,v.code],[413,'too_large'],'one byte over the limit is refused');
  ok(/300/.test(v.error)&&(await onDisk('limit.txt')).length===300000); // the message names the limit, and nothing was written
  const euro=String.fromCharCode(0x20ac); // 3 bytes each
  [r,v]=await save('limit.txt',euro.repeat(100000),atLimit);
  ok(r.ok&&(await onDisk('limit.txt')).length===300000);
  [r,v]=await save('limit.txt',euro.repeat(100001),sha256(await onDisk('limit.txt')));
  eq([r.status,v.code],[413,'too_large'],'the limit counts bytes: 100,001 three-byte characters are over it');
  await put('big280.txt',Buffer.from('b'.repeat(280000)));
  [r,v]=await get(readUrl('big280.txt','&maxBytes=300000'));
  ok(r.ok&&v.size===280000); // the route can hand out everything save() can take back
  await put('huge.txt',Buffer.from('h'.repeat(300001)));
  [r,v]=await get(readUrl('huge.txt','&maxBytes=300000'));
  eq([r.status,v.code],[413,'file_too_large'],'a file over the limit cannot be opened');
  [r,v]=await save('huge.txt','small\n',sha256(Buffer.from('h'.repeat(300001))));
  eq([r.status,v.code],[413,'file_too_large'],'nor saved over');
  // Somebody else changed the file after it was read.
  await put('race.txt',Buffer.from('v1\n'));
  [r,v]=await get(readUrl('race.txt'));
  const raceRead=v;
  await put('race.txt',Buffer.from('v2 by someone else\n'));
  [r,v]=await save('race.txt','v1 edited\n',raceRead.sha256);
  eq([r.status,v.code],[409,'stale_revision'],'a change after the read is refused');
  ok(same(await onDisk('race.txt'),Buffer.from('v2 by someone else\n')));
  // ... or while the checkpoint was being taken.
  await put('race2.txt',Buffer.from('w1\n'));
  [r,v]=await get(readUrl('race2.txt'));
  const race2Read=v;
  const realCheckpoint=manager.studio.checkpoint;
  manager.studio.checkpoint=async function(...args){await put('race2.txt',Buffer.from('w2 during the snapshot\n'));return realCheckpoint.apply(this,args);};
  try{[r,v]=await save('race2.txt','w1 edited\n',race2Read.sha256);}finally{manager.studio.checkpoint=realCheckpoint;}
  eq([r.status,v.code],[409,'stale_revision'],'a change while the checkpoint is taken is refused');
  ok(same(await onDisk('race2.txt'),Buffer.from('w2 during the snapshot\n')));
  const html=await fetch(origin+'/').then(r=>r.text());ok(html.includes('id="root"')&&html.includes('react-app.js'));
  const script=await fetch(origin+'/react-app.js').then(r=>r.text());ok(script.includes('/api/studio/permissions/decide')&&script.includes('/api/studio/restore'));
  const css=await fetch(origin+'/react.css').then(r=>r.text());ok(css.includes('.studio-columns'));
  console.log(`PASS: ${n} Studio 2.0 HTTP checks (CSRF, path security, review, Git rollback, terminal, plan, UI assets)`);
}finally{await manager.terminal.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true,maxRetries:20,retryDelay:200}).catch(()=>{});}
