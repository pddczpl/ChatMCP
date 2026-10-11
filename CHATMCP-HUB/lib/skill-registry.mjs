// GitHub-backed, allowlisted SKILL.md registry.
// Discovery only reads manifests: imported third-party scripts never execute.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './runtime.mjs';
import { normalizeSkillId, parseSkillManifest, safeFetchSkillManifest } from './plugins.mjs';

const fault=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const SOURCES=Object.freeze([
  {id:'anthropic',repo:'anthropics/skills',prefix:'skills'},
  {id:'openai',repo:'openai/skills',prefix:'skills/.curated'},
  {id:'vercel',repo:'vercel-labs/agent-skills',prefix:'skills'},
  {id:'github',repo:'github/awesome-copilot',prefix:'skills'},
  {id:'cloudflare',repo:'cloudflare/skills',prefix:'skills'},
]);
const github=(p)=>'https://api.github.com/repos/'+p;
const raw=(repo,sha,file)=>'https://raw.githubusercontent.com/'+repo+'/'+sha+'/'+file;
const hashValid=(sha)=>/^[a-f0-9]{40}$/i.test(sha);
export class GitHubSkillRegistry {
  constructor({pluginManager,stateDir,transport=safeFetchSkillManifest}){
    this.pluginManager=pluginManager;this.file=path.join(stateDir,'registry-index.json');this.transport=transport;
    this.entries=[];this.updatedAt=null;this.busy=false;
  }
  sources(){return SOURCES.map(s=>({...s}));}
  async load(){const data=await readJson(this.file).catch(()=>null);if(data?.version===1&&Array.isArray(data.entries)){this.entries=data.entries;this.updatedAt=data.updatedAt;}}
  list({query=''}={}){const q=String(query).toLowerCase().slice(0,100);return this.entries.filter(x=>!q||(x.name+' '+x.description+' '+x.repo).toLowerCase().includes(q)).slice(0,250);}
  async #json(url){const {text}=await this.transport(url,{maxBytes:512*1024});return JSON.parse(text);}
  async refresh({sourceId}={}){
    if(this.busy)throw fault('registry_busy','Registry is already refreshing.',409);
    const sources=sourceId?SOURCES.filter(x=>x.id===sourceId):SOURCES;
    if(!sources.length)throw fault('unknown_source','Unknown registry source.',404);
    this.busy=true;const found=[];const failures=[];
    try{
      for(const source of sources){
        try{
          const branch=await this.#json(github(source.repo)+'/commits/HEAD');
          const sha=branch.sha;
          if(!hashValid(sha))throw Error('Commit SHA was not verified');
          const items=await this.#json(github(source.repo)+'/contents/'+source.prefix+'?ref='+sha);
          if(!Array.isArray(items))throw Error('Expected a GitHub directory listing');
          for(const entry of items.filter(x=>x.type==='dir').slice(0,45)){
            const folder=entry.path;
            try {
              const {text}=await this.transport(raw(source.repo,sha,folder+'/SKILL.md'),{maxBytes:128*1024});
              const parsed=parseSkillManifest(text,folder+'/SKILL.md');
              const id=normalizeSkillId((source.id+'-'+parsed.id).slice(0,64));
              found.push({key:source.id+':'+folder,sourceId:source.id,id,name:parsed.name,description:parsed.description||'',repo:source.repo,revision:sha,folder,manifestPath:folder+'/SKILL.md',license:parsed.license||'unknown',verifiedLicense:null,redistributable:false});
            }catch{ /* No valid skill manifest in this subdirectory. */ }
          }
        }catch(e){failures.push({source:source.id,error:String(e.message||e).slice(0,180)});}
      }
      const updated=new Map((sourceId?this.entries.filter(x=>x.sourceId!==sourceId):[]).map(x=>[x.key,x]));
      for(const item of found)updated.set(item.key,item);
      this.entries=[...updated.values()].slice(0,300);
      this.updatedAt=new Date().toISOString();
      await writeJson(this.file,{version:1,updatedAt:this.updatedAt,entries:this.entries});
      return {found:found.length,total:this.entries.length,failures,updatedAt:this.updatedAt};
    }finally{this.busy=false;}
  }
  async install({key}={}){
    if(typeof key!=='string')throw fault('invalid_key','Missing skill key');
    const entry=this.entries.find(x=>x.key===key);
    if(!entry)throw fault('not_indexed','Skill is not indexed.',404);
    if(!SOURCES.some(x=>x.id===entry.sourceId&&x.repo===entry.repo)||!hashValid(entry.revision))throw fault('invalid_source','Source is not trusted.',403);
    const {text}=await this.transport(raw(entry.repo,entry.revision,entry.manifestPath),{maxBytes:128*1024});
    const parsed=parseSkillManifest(text,entry.manifestPath);
    const id=normalizeSkillId(entry.id);
    await this.pluginManager.load();
    const installed=await this.pluginManager.install(id,{name:parsed.name,description:parsed.description,version:parsed.version,systemPrompt:parsed.systemPrompt,license:parsed.license,author:parsed.author,category:'skills',tools:parsed.tools});
    // Imported instructions are lower-trust; no script execution or verified-license status is implied.
    return {...installed,sourceUrl:raw(entry.repo,entry.revision,entry.manifestPath),revision:entry.revision,readOnlyImport:true};
  }
}
