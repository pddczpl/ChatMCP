// A single desktop may have several local projects selected simultaneously.
// Registration is an explicit CSRF-protected user action; model tool outputs
// cannot select arbitrary new host paths as coding workspaces.
import path from 'node:path';
import { readJson, writeJson } from './runtime.mjs';

const fail=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const now=()=>new Date().toISOString();

export class WorkspaceRegistry {
  constructor({manager,directory}={}){
    if(!manager||!directory)throw new TypeError('WorkspaceRegistry requires a Hub manager and private state directory.');
    this.manager=manager;this.file=path.join(directory,'workspaces.json');
    this.items=[];this.activePath=null;this.removedPaths=new Set();this.writes=Promise.resolve();
  }
  #lookup(folder){return this.items.find(x=>equal(x.path,folder));}
  #save(){
    const copy={version:2,activePath:this.activePath,items:this.items.slice(0,40),removedPaths:[...this.removedPaths].slice(0,80)};
    this.writes=this.writes.catch(()=>{}).then(()=>writeJson(this.file,copy));
    return this.writes;
  }
  async load(){
    const saved=await readJson(this.file).catch(()=>null);
    const input=Array.isArray(saved?.items)?saved.items.slice(0,40):[];
    this.removedPaths=new Set(Array.isArray(saved?.removedPaths)
      ? saved.removedPaths.filter(p=>typeof p==='string'&&path.isAbsolute(p)).slice(0,80):[]);
    for(const item of input){
      if(typeof item?.path!=='string')continue;
      try{
        const folder=await this.manager.validateWorkspace(item.path);
        if(!this.#lookup(folder))this.items.push({
          path:folder,name:path.basename(folder)||folder,addedAt:String(item.addedAt||now()),
          lastUsedAt:String(item.lastUsedAt||now()),
        });
      }catch{/* A moved/deleted folder is not restored as an executable workspace. */}
    }
    // Only import the legacy primary workspace on a *first* registry creation.
    // After an explicit removal, a reload must never resurrect it.
    if(!saved?.version && this.manager.workspace && !this.#lookup(this.manager.workspace)){
      this.items.unshift({path:this.manager.workspace,name:path.basename(this.manager.workspace)||this.manager.workspace,addedAt:now(),lastUsedAt:now()});
    }
    const selected=typeof saved?.activePath==='string'?this.#lookup(saved.activePath):null;
    this.activePath=selected?.path||this.items[0]?.path||null;
    await this.#save();
    return this.state();
  }
  state(){return {activePath:this.activePath,items:this.items.map(x=>({...x}))};}
  async add(folder){
    const validated=await this.manager.validateWorkspace(folder);
    let entry=this.#lookup(validated);
    if(!entry){
      if(this.items.length>=40)throw fail('workspace_limit','Maximum 40 registered local workspaces.',409);
      entry={path:validated,name:path.basename(validated)||validated,addedAt:now(),lastUsedAt:now()};
      this.items.push(entry);
    }
    for(const removed of this.removedPaths)
      if(equal(removed,entry.path))this.removedPaths.delete(removed);
    if(!this.activePath)this.activePath=entry.path;
    await this.#save();
    return {...entry};
  }
  async activate(folder){
    const entry=await this.resolve(folder);
    entry.lastUsedAt=now();
    this.activePath=entry.path;
    await this.#save();
    return this.state();
  }
  async resolve(folder){
    const candidate=folder==null||folder===''?this.activePath:folder;
    if(typeof candidate!=='string'||!path.isAbsolute(candidate))
      throw fail('workspace_missing','Select a registered workspace.',409);
    const real=await this.manager.validateWorkspace(candidate);
    const entry=this.#lookup(real);
    if(!entry)throw fail('unregistered_workspace','This folder has not been selected through the workspace picker.',403);
    return entry;
  }
  async remove(folder){
    const entry=await this.resolve(folder);
    this.items=this.items.filter(x=>!equal(x.path,entry.path));
    this.removedPaths.add(entry.path);
    if(this.activePath&&equal(this.activePath,entry.path))
      this.activePath=this.items[0]?.path||null;
    await this.#save();
    return this.state(); // Never delete the directory, Git branch, or tasks.
  }
}
