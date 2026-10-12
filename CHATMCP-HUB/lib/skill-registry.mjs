// GitHub-backed, allowlisted SKILL.md registry.
// Discovery only reads manifests: imported third-party scripts never execute.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from './runtime.mjs';
import { normalizeSkillId, parseSkillManifest, safeFetchSkillManifest, safeFetchSkillBytes } from './plugins.mjs';

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
  constructor({pluginManager,stateDir,transport=safeFetchSkillManifest,binaryTransport=safeFetchSkillBytes}){
    this.pluginManager=pluginManager;this.file=path.join(stateDir,'registry-index.json');this.transport=transport;
    this.entries=[];this.updatedAt=null;this.busy=false;this.binaryTransport=binaryTransport;this.sourceRecords=SOURCES.map(s=>({...s,official:true}));
  }
  sources(){return this.sourceRecords.map(s=>({...s}));}
  async load(){const data=await readJson(this.file).catch(()=>null);if([1,2].includes(data?.version)&&Array.isArray(data.entries)){this.entries=data.entries;this.updatedAt=data.updatedAt;if(Array.isArray(data.sources)&&data.sources.length){const safe=data.sources.filter(x=>x&&/^[a-z0-9_-]{1,32}$/.test(x.id)&&/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(x.repo)&&/^[a-zA-Z0-9_.\/-]+$/.test(x.prefix)&&!x.prefix.includes('..'));if(safe.length)this.sourceRecords=safe.slice(0,20);}}}
  list({query=''}={}){const q=String(query).toLowerCase().slice(0,100);return this.entries.filter(x=>!q||(x.name+' '+(x.description||'')+' '+x.folder+' '+x.repo).toLowerCase().includes(q)).slice(0,500);}
  async addSource({id,repo,prefix='skills',confirmation}={}){
    if(confirmation!=='TRUST GITHUB SOURCE')throw fault('confirmation_required','Confirm trusted GitHub source.',403);
    if(!/^[a-zA-Z0-9_-]{1,32}$/.test(String(id||''))||!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(String(repo||''))||
      !/^[a-zA-Z0-9_.\/-]+$/.test(prefix)||prefix.includes('..')||prefix.startsWith('/'))throw fault('invalid_source','Invalid GitHub source.',400);
    const source={id:id.toLowerCase(),repo,prefix,official:false};
    if(this.sourceRecords.some(x=>x.id===source.id||x.repo===repo&&x.prefix===prefix))throw fault('duplicate_source','Source already indexed.',409);
    if(this.sourceRecords.length>=20)throw fault('too_many_sources','Maximum 20 sources.',413);
    this.sourceRecords.push(source);await this.#persist();return source;
  }
  async removeSource({sourceId,confirmation}={}){
    if(confirmation!=='REMOVE GITHUB SOURCE')throw fault('confirmation_required','Confirm removal of source.',403);
    if(SOURCES.some(x=>x.id===sourceId))throw fault('protected_source','Default sources cannot be removed.',403);
    if(!this.sourceRecords.some(x=>x.id===sourceId))throw fault('unknown_source','Unknown source.',404);
    this.sourceRecords=this.sourceRecords.filter(x=>x.id!==sourceId);
    this.entries=this.entries.filter(x=>x.sourceId!==sourceId);
    await this.#persist();return {removed:sourceId};
  }
  async #persist(){await writeJson(this.file,{version:2,updatedAt:this.updatedAt,entries:this.entries,sources:this.sourceRecords});}
  async #json(url){const {text}=await this.transport(url,{maxBytes:8*1024*1024});return JSON.parse(text);}
  async refresh({sourceId}={}){
    if(this.busy)throw fault('registry_busy','Registry is already refreshing.',409);
    const sources=sourceId?this.sourceRecords.filter(x=>x.id===sourceId):this.sourceRecords;
    if(!sources.length)throw fault('unknown_source','Unknown registry source.',404);
    this.busy=true;const found=[];const failures=[];
    try{
      for(const source of sources){
        try{
          const branch=await this.#json(github(source.repo)+'/commits/HEAD');
          const sha=branch.sha;
          if(!hashValid(sha))throw Error('Commit SHA was not verified');
          // Pinned tree recursion discovers nested SKILL.md entries in one
          // request, including deeper paths ignored by the legacy listing.
          const treeSha=branch?.commit?.tree?.sha;
          if (treeSha && hashValid(treeSha)) {
            const tree=await this.#json(github(source.repo)+'/git/trees/'+treeSha+'?recursive=1');
            if(tree?.truncated||!Array.isArray(tree?.tree)) throw Error('GitHub tree is truncated or unavailable');
            const matches=tree.tree.filter(x=>x.type==='blob'&&x.path.startsWith(source.prefix+'/')&&x.path.endsWith('/SKILL.md'));
            if(matches.length>1500)throw Error('More than 1500 skills in one source');
            for(const item of matches){
              const folder=item.path.slice(0,-'/SKILL.md'.length);
              if(folder.split('/').some(x=>!x||x==='.'||x==='..'))continue;
              const slug=(source.id+'-'+folder.slice(source.prefix.length+1)).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'');
              const id=normalizeSkillId(slug.length<=64?slug:slug.slice(0,55)+'-'+sha.slice(0,8));
              found.push({key:source.id+':'+folder,sourceId:source.id,id,name:folder.split('/').at(-1),description:'',repo:source.repo,
                revision:sha,treeSha,blobSha:item.sha,folder,manifestPath:item.path,license:'unknown',verifiedLicense:null,redistributable:false});
            }
            succeeded.add(source.id);
            continue;
          }
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
      this.entries=[...updated.values()].slice(0,5000);
      this.updatedAt=new Date().toISOString();
      await this.#persist();
      return {found:found.length,total:this.entries.length,failures,updatedAt:this.updatedAt};
    }finally{this.busy=false;}
  }
  async install({key,update=false}={}){
    if(typeof key!=='string')throw fault('invalid_key','Missing skill key');
    const entry=this.entries.find(x=>x.key===key);
    if(!entry)throw fault('not_indexed','Skill is not indexed.',404);
    if(entry.treeSha)return this.#installPinnedTree(entry,{update});
    if(!this.sourceRecords.some(x=>x.id===entry.sourceId&&x.repo===entry.repo)||!hashValid(entry.revision))throw fault('invalid_source','Source is not trusted.',403);
    const {text}=await this.transport(raw(entry.repo,entry.revision,entry.manifestPath),{maxBytes:128*1024});
    const parsed=parseSkillManifest(text,entry.manifestPath);
    const id=normalizeSkillId(entry.id);
    await this.pluginManager.load();
    // Fetch only bounded UTF-8 supporting files. Imported scripts are never executed.
    const resourceFiles=[],skipped=[];
    let rootEntries=[];
    try {rootEntries=await this.#json(github(entry.repo)+'/contents/'+entry.folder+'?ref='+entry.revision);}
    catch(e){skipped.push({path:entry.folder,reason:String(e.message||e).slice(0,120)});}
    const allowExt=/\.(md|mdx|txt|json|yaml|yml|py|js|ts|sh|css|html|toml|xml)$/i;
    const queue=[];
    for(const item of Array.isArray(rootEntries)?rootEntries:[]){
      if(item.type==='dir'&&['references','scripts','assets'].includes(item.name)){
        try{
          const children=await this.#json(github(entry.repo)+'/contents/'+item.path+'?ref='+entry.revision);
          if(Array.isArray(children))queue.push(...children.filter(x=>x.type==='file'));
        }catch(e){skipped.push({path:item.path,reason:String(e.message||e).slice(0,120)});}
      }
    }
    let totalBytes=0;
    for(const item of queue.slice(0,32)){
      const relative=item.path.slice(entry.folder.length+1);
      if(!item.path.startsWith(entry.folder+'/')||!allowExt.test(relative)||!/^(references|scripts|assets)\//.test(relative)){
        skipped.push({path:item.path,reason:'unsupported file type or path'});continue;
      }
      if(item.size>64*1024||totalBytes+item.size>512*1024){skipped.push({path:item.path,reason:'size limit'});continue;}
      try{
        const {text:resource}=await this.transport(raw(entry.repo,entry.revision,item.path),{maxBytes:64*1024});
        totalBytes+=Buffer.byteLength(resource,'utf8');
        resourceFiles.push({path:relative,text:resource});
      }catch(e){skipped.push({path:item.path,reason:String(e.message||e).slice(0,120)});}
    }
    if(queue.length>32)skipped.push({path:entry.folder,reason:'resource file count limit'});
    const installed=await this.pluginManager.importRegistrySkill({
      id,name:parsed.name,description:parsed.description,version:parsed.version,
      systemPrompt:parsed.systemPrompt,license:parsed.license,author:parsed.author,tools:parsed.tools,
      sourceUrl:raw(entry.repo,entry.revision,entry.manifestPath),commitSha:entry.revision,
      originalSkillText:text,resourceFiles,
    });
    return {...installed,revision:entry.revision,readOnlyImport:true,skippedResources:skipped};
  }

  /** Complete recursive, binary-safe installation from a pinned Git tree. */
  async #installPinnedTree(entry,{update=false}={}){
    if(this.busy)throw fault('registry_busy','Registry operation already running.',409);
    if(!this.sourceRecords.some(x=>x.id===entry.sourceId&&x.repo===entry.repo)||!hashValid(entry.revision)||!hashValid(entry.treeSha))
      throw fault('invalid_source','Skill source or revision is invalid.',403);
    this.busy=true;
    try{
      const tree=await this.#json(github(entry.repo)+'/git/trees/'+entry.treeSha+'?recursive=1');
      if(tree?.truncated||!Array.isArray(tree?.tree))throw fault('truncated_tree','Source tree is incomplete.',413);
      const files=tree.tree.filter(x=>x.path?.startsWith(entry.folder+'/'));
      const manifest=files.find(x=>x.path===entry.manifestPath&&x.type==='blob');
      if(!manifest||manifest.sha!==entry.blobSha)throw fault('integrity_mismatch','Pinned SKILL.md checksum differs from index.',409);
      // Recursive Git trees contain directory entries (mode 040000) as well
      // as blobs; directories are not assets and must not invalidate a skill.
      const other=files.filter(x=>x!==manifest&&x.type!=='tree');
      if(other.some(x=>x.type!=='blob'||!['100644','100755'].includes(x.mode)))
        throw fault('unsupported_asset','Symlinks/submodules cannot be imported as skill dependencies.',409);
      if(other.length>200||other.some(x=>x.size>2*1024*1024)||other.reduce((n,x)=>n+(x.size||0),0)>24*1024*1024)
        throw fault('skill_too_large','Skill has more than 200 files or exceeds asset size limits.',413);
      const download=async(file,maxBytes)=>{
        const {bytes}=await this.binaryTransport(raw(entry.repo,entry.revision,file.path),{maxBytes});
        const b=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes||[]);
        if(b.length>maxBytes)throw fault('asset_too_large','Downloaded asset exceeds limit.',413);
        const gitSha=crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
        if(!hashValid(file.sha)||gitSha!==file.sha.toLowerCase())throw fault('asset_hash_mismatch','Git blob checksum mismatch: '+file.path,409);
        return b;
      };
      const skillBytes=await download(manifest,128*1024);
      const originalSkillText=skillBytes.toString('utf8');
      if(originalSkillText.includes('\uFFFD'))throw fault('bad_encoding','SKILL.md is not UTF-8.');
      const parsed=parseSkillManifest(originalSkillText,entry.manifestPath);
      const resourceFiles=[],names=new Set();let byteCount=0;
      for(const file of other){
        const rel=file.path.slice(entry.folder.length+1);
        if(!/^[a-zA-Z0-9_.@+() -]+(?:\/[a-zA-Z0-9_.@+() -]+)*$/.test(rel)||
          rel.split('/').some(x=>x==='.'||x==='..'||x==='.git')||rel==='manifest.json')
          throw fault('invalid_resource_path','Unsafe skill asset path: '+rel,403);
        const b=await download(file,2*1024*1024);
        byteCount+=b.length;if(byteCount>24*1024*1024)throw fault('skill_too_large','Total asset limit reached.',413);
        resourceFiles.push({path:rel,encoding:'base64',data:b.toString('base64')});
        names.add(rel);
      }
      // Report links to missing dependencies (never fetch outside the pinned folder).
      const refs=[...originalSkillText.matchAll(/\]\((?:\.\/)?([^()\s#?]+)(?:#[^)]*)?\)/g)].map(m=>m[1]);
      const missing=[...new Set(refs)].filter(x=>!names.has(x)&&x!=='SKILL.md'&&
        !/^(https?:|mailto:|#)/.test(x)&&!x.startsWith('../')).slice(0,100);
      const candidate=resourceFiles.find(x=>/^(LICENSE|LICENCE)(?:\.(?:md|txt))?$/i.test(x.path));
      let licenseEvidence={status:'unknown',spdx:null,path:null,scope:null,redistributionReviewed:false};
      if(candidate){
        const text=Buffer.from(candidate.data,'base64').toString('utf8').toLowerCase();
        const match=text.includes('permission is hereby granted, free of charge')?'MIT':
          text.includes('apache license')&&text.includes('version 2.0')?'Apache-2.0':
          text.includes('redistribution and use in source and binary forms')?'BSD':null;
        licenseEvidence={status:match&&(!parsed.license||parsed.license==='unknown'||parsed.license.toLowerCase()===match.toLowerCase())?'matched_file':'unverified',
          spdx:match,path:entry.folder+'/'+candidate.path,scope:'skill',redistributionReviewed:false};
      }else{
        // Repository-wide license evidence is advisory. Do not claim the
        // individual skill was legally reviewed or can be redistributed.
        const rootLicense=tree.tree.find(x=>x.type==='blob'&&/^(LICENSE|LICENCE)(?:\.(?:md|txt))?$/i.test(x.path)&&x.size<=128*1024);
        if(rootLicense){
          const text=(await download(rootLicense,128*1024)).toString('utf8').toLowerCase();
          const match=text.includes('permission is hereby granted, free of charge')?'MIT':
            text.includes('apache license')&&text.includes('version 2.0')?'Apache-2.0':
            text.includes('redistribution and use in source and binary forms')?'BSD':null;
          licenseEvidence={status:'repository_license',spdx:match,path:rootLicense.path,scope:'repository',redistributionReviewed:false};
        }
      }
      await this.pluginManager.load();
      const installed=await this.pluginManager.importRegistrySkill({
        id:entry.id,name:parsed.name,description:parsed.description,version:parsed.version,license:parsed.license,
        author:parsed.author,systemPrompt:parsed.systemPrompt,tools:parsed.tools,
        sourceUrl:raw(entry.repo,entry.revision,entry.manifestPath),commitSha:entry.revision,
        originalSkillText,resourceFiles,licenseEvidence,
        dependencies:{referenced:refs,unresolved:missing,fileCount:resourceFiles.length,bytes:byteCount},update
      });
      return {...installed,resourceCount:resourceFiles.length,missingDependencies:missing,readOnlyImport:true,licenseEvidence};
    }finally{this.busy=false;}
  }
  updates(){
    const installed=new Map(this.pluginManager.installed().map(x=>[x.id,x]));
    return this.entries.filter(x=>installed.get(x.id)?.provenance==='github-registry'&&installed.get(x.id).commitSha!==x.revision)
      .map(x=>({...x,installedRevision:installed.get(x.id).commitSha,updateAvailable:true}));
  }
}
