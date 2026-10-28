// Focused built-in tools for build/release diagnosis and repository maintenance.
// No new shell command templates from model input, no hooks and no external MCP.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isProtectedPath } from './protected-paths.mjs';
const O=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const S=(description,extra={})=>({type:'string',description,...extra});
const I=(description,extra={})=>({type:'integer',description,...extra});
const err=(code,message)=>Object.assign(new Error(message),{code});
const ok=value=>({isError:false,content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const rpath=x=>String(x||'').replace(/\\/g,'/');
const extension=(name)=>path.extname(name).toLowerCase();
function classify(buffer,name) {
  const hex=buffer.subarray(0,12).toString('hex');
  if(hex.startsWith('89504e470d0a1a0a'))return 'image/png';
  if(hex.startsWith('ffd8ff'))return 'image/jpeg';
  if(hex.startsWith('255044462d'))return 'application/pdf';
  if(hex.startsWith('504b0304'))return 'application/zip';
  if(hex.startsWith('7f454c46'))return 'application/x-elf';
  if(hex.startsWith('4d5a'))return 'application/vnd.microsoft.portable-executable';
  if(buffer.subarray(0,100).includes(0))return 'application/octet-stream';
  return ({'.txt':'text/plain','.md':'text/markdown','.json':'application/json','.csv':'text/csv'})[extension(name)]||'unknown';
}
export class WorkflowExtensions {
  constructor({workspace,git,shell}){this.workspace=workspace;this.git=git;this.shell=shell;}
  async target(p) {
    const info=await this.workspace.resolve(p);
    if(!info.relative || isProtectedPath(info.relative)) throw err('protected_path','Path is protected or points at the workspace root.');
    return info;
  }
  async gitConflicts({signal}={}){
    const [diff,stages]=await Promise.all([
      this.git.text(['diff','--name-only','--diff-filter=U','-z'],{signal}),
      this.git.text(['ls-files','-u','-z'],{signal}),
    ]);
    const paths=diff.stdout.split('\0').filter(Boolean);
    const stageRecords=stages.stdout.split('\0').filter(Boolean).slice(0,1000).map(x=>x.split('\t')).filter(x=>x.length===2)
      .map(x=>({mode:x[0].split(' ')[0],blob:x[0].split(' ')[1],stage:Number(x[0].split(' ')[2]),path:x[1]}));
    return ok({conflicts:paths,unmergedStages:stageRecords,hasConflicts:paths.length>0});
  }
  async buildDiscovery() {
    const root=(await this.workspace.resolve('')).root;
    const exists=async p=>Boolean(await fs.stat(path.join(root,p)).catch(()=>null));
    let pkg=null;
    if(await exists('package.json')){try{pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));}catch{}}
    const candidates=[];
    if(pkg?.scripts?.build)candidates.push({runner:'npm',command:'npm run build',detectedFrom:'package.json scripts.build'});
    if(await exists('Cargo.toml'))candidates.push({runner:'cargo',command:'cargo build',detectedFrom:'Cargo.toml'});
    if(await exists('go.mod'))candidates.push({runner:'go',command:'go build ./...',detectedFrom:'go.mod'});
    if((await fs.readdir(root)).some(f=>/\.(slnx?|csproj)$/i.test(f)))candidates.push({runner:'dotnet',command:'dotnet build',detectedFrom:'solution/project'});
    return candidates;
  }
  async build({runner,cwd='',timeout_seconds:timeoutSeconds=300},{signal}={}) {
    const supported=await this.buildDiscovery();
    const choice=supported.find(x=>x.runner===runner);
    if(!choice)throw err('unsupported_runner','Build runner not detected in workspace; build_detect lists available commands.');
    const result=await this.shell.run({command:choice.command,cwd,timeoutMs:Math.min(600000,timeoutSeconds*1000),signal});
    return {isError:result.exitCode!==0||result.timedOut||result.cancelled,
      content:[{type:'text',text:JSON.stringify({runner,command:choice.command,exitCode:result.exitCode,timedOut:result.timedOut})+'\n'+result.stdout.slice(-65000)+'\n'+result.stderr.slice(-18000)}],
      structuredContent:{runner,command:choice.command,exitCode:result.exitCode,timedOut:result.timedOut,cancelled:result.cancelled,durationMs:result.durationMs}};
  }
  async impact({changed_paths:changedPaths=[]},{signal}={}){
    const paths=changedPaths.length?changedPaths:(await this.git.text(['diff','--name-only','HEAD','--'],{signal})).stdout.split(/\r?\n/).filter(Boolean);
    const affected=new Set();
    for(const candidate of paths) {
      const p=rpath(candidate).replace(/^\.\//,'');
      if(!p||p.includes('..')||path.isAbsolute(p))continue;
      const base=path.posix.basename(p).replace(/\.[^.]+$/,'');
      const dir=path.posix.dirname(p);
      if(/\.(py|js|jsx|ts|tsx|mjs|cjs)$/.test(p)){
        affected.add((dir==='.'?'':dir+'/')+base+'.test.js');
        affected.add((dir==='.'?'':dir+'/')+base+'.test.ts');
        affected.add((dir==='.'?'':dir+'/')+'test_'+base+'.py');
        affected.add((dir==='.'?'':dir+'/')+'__tests__/'+base+'.test.js');
      }
    }
    const existing=[];
    for(const name of affected) {
      try{const item=await this.target(name);if((await fs.stat(item.absolute)).isFile())existing.push(name);}
      catch {/* nonexistent candidates are not tests */ }
    }
    return ok({changedPaths:paths.slice(0,100),directCandidateTests:existing,method:'filename-adjacency heuristic; not a complete dependency graph',hint:'Use dependency_graph for code-dependency analysis.'});
  }
  async inspectBinary({path:p}) {
    const file=await this.target(p),st=await fs.stat(file.absolute);
    if(!st.isFile())throw err('bad_file','Must be a regular file.');
    if(st.size>128*1024*1024)throw err('too_large','Binary inspection limited to 128 MB.');
    const handle=await fs.open(file.absolute,'r');
    let first;
    try{const data=Buffer.alloc(512);const r=await handle.read(data,0,data.length,0);first=data.subarray(0,r.bytesRead);}
    finally{await handle.close();}
    let current=await fs.lstat(file.absolute);
    if(!current.isFile())throw err('changed_file','File changed while inspecting.');
    const hash=createHash('sha256');
    for await(const chunk of createReadStream(file.absolute)){hash.update(chunk);}
    current=await fs.lstat(file.absolute);
    if(current.size!==st.size||current.mtimeMs!==st.mtimeMs)throw err('changed_file','File changed during hashing.');
    return ok({path:file.relative,size:st.size,sha256:hash.digest('hex'),detectedMime:classify(first,file.relative),headHex:first.subarray(0,24).toString('hex')});
  }
  async skillCandidates() {
    const root=(await this.workspace.resolve('')).root;
    const skip=new Set(['.git','node_modules','.venv','venv','dist','build','coverage','.chatmcp']);
    const queue=[{dir:root,depth:0}],found=[];
    let scanned=0;
    while(queue.length&&scanned<1600&&found.length<40) {
      const {dir,depth}=queue.shift();
      for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
        if(++scanned>1600)break;
        const rel=rpath(path.relative(root,path.join(dir,entry.name)));
        if(isProtectedPath(rel))continue;
        if(entry.isFile() && /^(SKILL|AGENTS|RULES)\.md$/i.test(entry.name))found.push(rel);
        else if(entry.isDirectory()&&depth<5&&!skip.has(entry.name))queue.push({dir:path.join(dir,entry.name),depth:depth+1});
      }
    }
    return ok({instructionFiles:found,scannedEntries:scanned,limited:scanned>=1600,source:'workspace metadata only; not automatic skill execution'});
  }
  register(define) {
    const read=(name,description,schema,run)=>define(name,{description,schema,category:'read',reason:'Read-only workspace analysis',summary:()=>name,run});
    const exec=(name,description,schema,run)=>define(name,{description,schema,category:'execute',reason:'Build code from selected workspace; real shell execution requires approval',
      annotations:{readOnlyHint:false,openWorldHint:false},summary:()=>name,run});
    read('git_conflict_inspect','Inspect unresolved merge paths and stage entries using GitRunner with command execution safeguards.',
      O({}),(_,ctx)=>this.gitConflicts(ctx));
    read('build_detect','Detect safe build commands from package.json, Cargo, Go or .NET project metadata.',
      O({}),()=>this.buildDiscovery().then(candidates=>ok({candidates})));
    exec('build_run','Build the selected project with an allowlisted command discovered from its actual manifests, report exit code.',
      O({runner:S('Selected build system.',{enum:['npm','cargo','go','dotnet']}),cwd:S('Workspace-relative build folder.'),
        timeout_seconds:I('Build timeout 1-600 seconds.',{minimum:1,maximum:600})},['runner']),(a,ctx)=>this.build(a,ctx));
    read('test_impact_analysis','Suggest existing tests next to changed source files; heuristic only, not complete semantic impact analysis.',
      O({changed_paths:{type:'array',description:'Relative modified source paths, or omitted to inspect Git diff.',maxItems:100,items:S('Path relative to workspace.')}}),
      (a,ctx)=>this.impact(a,ctx));
    read('binary_inspect','Inspect binary file type, size and SHA-256 inside workspace; refuse private keys and protected paths.',
      O({path:S('Relative file path to inspect.')},['path']),(a)=>this.inspectBinary(a));
    read('skills_discover','Find in-workspace AGENTS.md, RULES.md and SKILL.md instructions without enabling arbitrary scripts.',
      O({}),()=>this.skillCandidates());
  }
}
export function registerWorkflowExtensions(define,context){const group=new WorkflowExtensions(context);group.register(define);return group;}
