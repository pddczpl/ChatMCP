import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import type { AiProfile } from '@/types';

type Protocol = 'openai-chat'|'openai-responses'|'anthropic'|'gemini';
type Draft = {
  id:string; name:string; protocol:Protocol; model:string; apiBaseUrl:string;
  authMode:'auto'|'bearer'|'google-key'; apiKey:string; envKeyName:string; contextWindow:string;
  isDefault:boolean; clearCredentials:boolean; rateInput:string;rateOutput:string;
  rateCacheRead:string;rateCacheWrite:string;
};
const empty = ():Draft => ({
  id:'',name:'',protocol:'openai-chat',model:'',apiBaseUrl:'',
  authMode:'auto',apiKey:'',envKeyName:'',contextWindow:'',
  isDefault:false,clearCredentials:false,
  rateInput:'',rateOutput:'',rateCacheRead:'',rateCacheWrite:'',
});
const choices:Protocol[]=['openai-chat','openai-responses','anthropic','gemini'];

export function ModelProfilesPanel(){
  const queryClient=useQueryClient();
  const {showToast}=useAppStore();
  const {data,isLoading}=useQuery({
    queryKey:['aiProfiles'],queryFn:api.getProfiles,refetchInterval:7000,
  });
  const profiles=data?.profiles || [];
  const [draft,setDraft]=useState<Draft>(empty);
  const [editing,setEditing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const change=(key:keyof Draft,value:string|boolean)=>setDraft(current=>({...current,[key]:value}));
  const refresh=async()=>{
    await Promise.all([
      queryClient.invalidateQueries({queryKey:['aiProfiles']}),
      queryClient.invalidateQueries({queryKey:['hubState']}),
    ]);
  };
  const edit=(p:AiProfile)=>{
    setEditing(true);setMessage('');
    setDraft({
      id:p.id,name:p.name||p.id,
      protocol:choices.includes(p.protocol as Protocol)?p.protocol as Protocol:'openai-chat',
      model:p.model||'',apiBaseUrl:p.apiBaseUrl||'',
      authMode:p.authMode==='bearer'||p.authMode==='google-key'?p.authMode:'auto',
      apiKey:'',envKeyName:p.envKeyName||'',contextWindow:p.contextWindow?String(p.contextWindow):'',
      isDefault:!!p.isDefault,clearCredentials:false,
      rateInput:p.ratesUsdPerMillion?.input?.toString()||'',
      rateOutput:p.ratesUsdPerMillion?.output?.toString()||'',
      rateCacheRead:p.ratesUsdPerMillion?.cacheRead?.toString()||'',
      rateCacheWrite:p.ratesUsdPerMillion?.cacheWrite?.toString()||'',
    });
  };
  const save=async()=>{
    if(busy)return;
    setBusy(true);setMessage('');
    try{
      if(!draft.model.trim()||!draft.apiBaseUrl.trim())
        throw new Error('Enter a model and API base URL for this profile.');
      if(draft.apiKey.trim() && draft.envKeyName.trim())
        throw new Error('Choose either an API key or environment key for one profile.');
      const contextWindow=draft.contextWindow.trim()?Number(draft.contextWindow):null;
      const priceKeys=[
        ['rateInput','input'],['rateOutput','output'],
        ['rateCacheRead','cacheRead'],['rateCacheWrite','cacheWrite'],
      ] as const;
      const rates:Record<string,number>={};
      for(const [field,key] of priceKeys){
        const raw=draft[field].trim();
        if(!raw)continue;
        if(!/^(?:0|[0-9]+)(?:\.[0-9]+)?$/.test(raw) || !Number.isFinite(Number(raw)) ||
           Number(raw)>10000)throw new Error('Model token prices must be numbers 0..10000 USD per 1M tokens.');
        rates[key]=Number(raw);
      }
      if(Object.keys(rates).length && (!Object.hasOwn(rates,'input')||!Object.hasOwn(rates,'output')))
        throw new Error('Both input and output rates must be provided.');
      if(contextWindow!==null&&(!Number.isSafeInteger(contextWindow)||contextWindow<2000||contextWindow>10000000))
        throw new Error('Context window must be between 2,000 and 10,000,000 tokens.');
      await api.upsertProfile({
        ...(draft.id.trim()?{id:draft.id.trim()}:{}),
        name:draft.name.trim()||draft.id.trim()||draft.model.trim(),
        provider:draft.protocol,protocol:draft.protocol,model:draft.model.trim(),
        apiBaseUrl:draft.apiBaseUrl.trim(),authMode:draft.authMode,
        ...(contextWindow!==null?{contextWindow}:{}),
        ratesUsdPerMillion:Object.keys(rates).length?rates:null,
        ...(draft.apiKey.trim()?{apiKey:draft.apiKey.trim(),envKeyName:null}:
          {envKeyName:draft.envKeyName.trim()||null}),
        isDefault:draft.isDefault,clearCredentials:draft.clearCredentials,
      });
      setDraft(empty());setEditing(false);
      await refresh();
      showToast('Model profile saved. Existing tasks keep their original revision.','success');
    }catch(e:any){setMessage(e.message||'Cannot save model profile.');}
    finally{setBusy(false);}
  };
  const setDefault=async(id:string)=>{
    if(busy)return;setBusy(true);
    try{await api.setDefaultProfile(id);await refresh();showToast('Default model profile updated.','success');}
    catch(e:any){setMessage(e.message||'Cannot change default profile.');}
    finally{setBusy(false);}
  };
  const remove=async(id:string)=>{
    if(busy||!window.confirm('Delete model profile '+id+'? Existing task revisions may no longer resume.'))return;
    setBusy(true);
    try{
      await api.deleteProfile(id);
      if(draft.id===id){setDraft(empty());setEditing(false);}
      await refresh();showToast('Model profile deleted.','info');
    }catch(e:any){setMessage(e.message||'Cannot delete model profile.');}
    finally{setBusy(false);}
  };
  return (
    <section aria-label="Model profiles" className="space-y-2 border-t border-[var(--line)] pt-4 text-xs"
      data-testid="model-profiles-panel">
      <div>
        <h3 className="font-semibold text-[var(--text)]">Model profiles</h3>
        <p className="mt-1 text-[var(--faint)]">
          Saved profiles are available to task/agent roles in the conversation composer.
          Keys are protected locally and never displayed after saving.
        </p>
      </div>
      {isLoading && <p className="text-[var(--muted)]">Loading profiles...</p>}
      {profiles.map((p:AiProfile)=>(
        <div key={p.id} className="p-2 rounded-md border border-[var(--line)] bg-[var(--surface)]">
          <div className="font-medium break-all">{p.name||p.id} {p.isDefault?'· Default':''}</div>
          <div className="text-[var(--faint)] break-all">{p.protocol||p.provider} · {p.model} · {p.apiBaseUrl}</div>
          <div className="text-[var(--faint)]">{p.hasKey?'Protected key / environment reference configured':'No credential saved'}</div>
          <div className="flex flex-wrap gap-2 mt-1.5">
            <button type="button" className="underline text-[var(--primary)]" disabled={busy} onClick={()=>edit(p)}>Edit</button>
            {!p.isDefault&&<button type="button" className="underline text-[var(--primary)]" disabled={busy} onClick={()=>void setDefault(p.id)}>Make default</button>}
            <button type="button" className="underline text-rose-400" disabled={busy} onClick={()=>void remove(p.id)}>Delete</button>
          </div>
        </div>
      ))}
      <div className="grid grid-cols-1 gap-2 border border-[var(--line)] rounded-lg bg-[var(--surface)] p-2">
        <div className="flex justify-between items-center gap-2">
          <span className="font-semibold">{editing?'Edit profile':'Add profile'}</span>
          <button type="button" className="underline text-[var(--primary)]"
            onClick={()=>{setEditing(false);setDraft(empty());setMessage('');}}>New profile</button>
        </div>
        <label className="space-y-1">Profile ID (leave empty to generate)
          <input aria-label="Model profile ID" type="text" value={draft.id} disabled={editing}
            onChange={e=>change('id',e.target.value)}
            className="w-full p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]"/>
        </label>
        <label className="space-y-1">Display name
          <input aria-label="Model profile display name" type="text" value={draft.name}
            onChange={e=>change('name',e.target.value)}
            className="w-full p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]"/>
        </label>
        <label className="space-y-1">API protocol
          <select aria-label="Model profile protocol" value={draft.protocol}
            onChange={e=>change('protocol',e.target.value)}
            className="w-full p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]">
            {choices.map(value=><option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="space-y-1">API base URL
          <input aria-label="Model profile API base URL" type="url" value={draft.apiBaseUrl}
            placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"
            onChange={e=>change('apiBaseUrl',e.target.value)}
            className="w-full p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]"/>
        </label>
        <label className="space-y-1">Model ID
          <input aria-label="Model profile model" type="text" value={draft.model}
            onChange={e=>change('model',e.target.value)}
            className="w-full p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]"/>
        </label>
        <label className="space-y-1">Authentication
          <select aria-label="Model profile authentication" value={draft.authMode}
            onChange={e=>change('authMode',e.target.value)}
            className="w-full p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]">
            {['auto','bearer','google-key'].map(value=><option key={value}>{value}</option>)}
          </select>
        </label>
        <label className="space-y-1">API key (new/replacement only)
          <input aria-label="Model profile API key" type="password" autoComplete="off" value={draft.apiKey}
            onChange={e=>change('apiKey',e.target.value)}
            className="w-full p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]"/>
        </label>
        <label className="space-y-1">Environment variable (alternative to API key)
          <input aria-label="Model profile environment key" type="text" value={draft.envKeyName}
            onChange={e=>change('envKeyName',e.target.value)}
            placeholder="OPENAI_API_KEY"
            className="w-full p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]"/>
        </label>
        <label className="space-y-1">Context window tokens (optional)
          <input aria-label="Model profile context window" type="number" value={draft.contextWindow}
            onChange={e=>change('contextWindow',e.target.value)}
            className="w-full p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]"/>
        </label>
        <fieldset className="space-y-1 border border-[var(--line)] rounded-md p-2">
          <legend className="text-[var(--muted)]">Optional owner-supplied rates (USD / 1M tokens)</legend>
          <p className="text-[var(--faint)]">Prices are never assumed. Cache tokens are included in input; reasoning is included in output. Usage may be incomplete.</p>
          {([
            ['rateInput','Input'],['rateOutput','Output'],
            ['rateCacheRead','Cache read'],['rateCacheWrite','Cache write'],
          ] as const).map(([field,label])=><label key={field} className="flex gap-2 items-center">
            <span className="w-24">{label}</span>
            <input type="number" step="any" min="0" max="10000"
              aria-label={'Model rate '+label} value={draft[field]}
              onChange={e=>change(field,e.target.value)}
              className="flex-1 min-w-0 p-1.5 rounded border border-[var(--line)] bg-[var(--panel)]"/>
          </label>)}
        </fieldset>
        <label className="flex gap-2 items-center">
          <input type="checkbox" checked={draft.isDefault} onChange={e=>change('isDefault',e.target.checked)}/>
          Use as default profile for future tasks
        </label>
        {editing&&<label className="flex gap-2 items-center">
          <input type="checkbox" checked={draft.clearCredentials}
            onChange={e=>change('clearCredentials',e.target.checked)}/>
          Clear saved credentials for this profile
        </label>}
        {message&&<p role="alert" className="text-rose-400">{message}</p>}
        <button type="button" onClick={()=>void save()} disabled={busy}
          className="rounded-md bg-[var(--primary)] text-[var(--primary-foreground)] px-3 py-1.5 font-semibold disabled:opacity-50">
          {busy?'Saving...':'Save model profile'}
        </button>
      </div>
    </section>
  );
}
