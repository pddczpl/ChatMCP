import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { contextWindowHint, contextWindowRangeText } from '@/lib/context-window';
import { useTranslation } from '@/lib/i18n';
import { PROFILE_PROTOCOLS, buildProfilePayload, draftFromProfile, emptyProfileDraft, type ProfileDraft } from '@/lib/model-profile-form';
import { useModelInfo } from '@/lib/useModelInfo';
import type { AiProfile } from '@/types';
import { ModelField } from './ModelField';
import { ReasoningEffortField } from './ReasoningEffortField';

const choices = PROFILE_PROTOCOLS;
const headerSummary = (profile: AiProfile) => (profile.customHeaders || [])
  .map(header => header.source === 'environment' ? `${header.name} (env ${header.envKeyName})` : `${header.name} (protected)`).join(', ');

export function ModelProfilesPanel(){
  const queryClient=useQueryClient();
  const {showToast}=useAppStore();
  const {data,isLoading}=useQuery({
    queryKey:['aiProfiles'],queryFn:api.getProfiles,refetchInterval:7000,
  });
  const profiles=data?.profiles || [];
  const [draft,setDraft]=useState<ProfileDraft>(emptyProfileDraft);
  const [editing,setEditing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const {t}=useTranslation();
  // What the Hub knows about the model in the form (the catalog's window and prices): the empty fields below say what the Hub uses then. A profile has a protocol and an endpoint, no preset.
  const {data:modelInfo}=useModelInfo({protocol:draft.protocol,apiBaseUrl:draft.apiBaseUrl,model:draft.model});
  const windowHint=contextWindowHint(draft.contextWindow,modelInfo);
  const catalogRate=(rate:'input'|'output'|'cacheRead'|'cacheWrite')=>modelInfo?.trusted===true&&modelInfo.rates&&typeof modelInfo.rates[rate]==='number'?String(modelInfo.rates[rate]):undefined;
  const change=(key:keyof ProfileDraft,value:string|boolean)=>setDraft(current=>({...current,[key]:value}));
  const refresh=async()=>{
    await Promise.all([
      queryClient.invalidateQueries({queryKey:['aiProfiles']}),
      queryClient.invalidateQueries({queryKey:['hubState']}),
    ]);
  };
  const edit=(p:AiProfile)=>{
    setEditing(true);setMessage('');
    setDraft(draftFromProfile(p));
  };
  const savedHeaders:NonNullable<AiProfile["customHeaders"]>=editing?(profiles.find((p:AiProfile)=>p.id===draft.id)?.customHeaders||[]):[];
  const save=async()=>{
    if(busy)return;
    setBusy(true);setMessage('');
    try{
      await api.upsertProfile(buildProfilePayload(draft));
      setDraft(emptyProfileDraft());setEditing(false);
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
      if(draft.id===id){setDraft(emptyProfileDraft());setEditing(false);}
      await refresh();showToast('Model profile deleted.','info');
    }catch(e:any){setMessage(e.message||'Cannot delete model profile.');}
    finally{setBusy(false);}
  };
  return (
    <section aria-label="Model profiles" className="space-y-2 border-t border-line pt-4 text-xs"
      data-testid="model-profiles-panel">
      <div>
        <h3 className="font-semibold text-fg">Model profiles</h3>
        <p className="mt-1 text-faint">
          Saved profiles are available to task/agent roles in the conversation composer.
          Keys are protected locally and never displayed after saving.
        </p>
      </div>
      {isLoading && <p className="text-muted">Loading profiles...</p>}
      {profiles.map((p:AiProfile)=>(
        <div key={p.id} className="p-2 rounded-md border border-line bg-surface">
          <div className="font-medium break-all">{p.name||p.id} {p.isDefault?'· Default':''}</div>
          <div className="text-faint break-all">{p.protocol||p.provider} · {p.model} · {p.apiBaseUrl}{p.customPath?` · path ${p.customPath}`:''}</div>
          <div className="text-faint">{p.hasKey?'Protected key / environment reference configured':'No credential saved'}</div>
          {(p.customHeaders?.length||0)>0&&<div className="text-faint break-all">Custom headers: {headerSummary(p)}</div>}
          <div className="flex flex-wrap gap-2 mt-1.5">
            <button type="button" className="underline text-primary" disabled={busy} onClick={()=>edit(p)}>Edit</button>
            {!p.isDefault&&<button type="button" className="underline text-primary" disabled={busy} onClick={()=>void setDefault(p.id)}>Make default</button>}
            <button type="button" className="underline text-danger" disabled={busy} onClick={()=>void remove(p.id)}>Delete</button>
          </div>
        </div>
      ))}
      <div className="grid grid-cols-1 gap-2 border border-line rounded-lg bg-surface p-2">
        <div className="flex justify-between items-center gap-2">
          <span className="font-semibold">{editing?'Edit profile':'Add profile'}</span>
          <button type="button" className="underline text-primary"
            onClick={()=>{setEditing(false);setDraft(emptyProfileDraft());setMessage('');}}>New profile</button>
        </div>
        <label className="space-y-1">Profile ID (leave empty to generate)
          <input aria-label="Model profile ID" type="text" value={draft.id} disabled={editing}
            onChange={e=>change('id',e.target.value)}
            className="w-full p-1.5 rounded border border-line bg-panel"/>
        </label>
        <label className="space-y-1">Display name
          <input aria-label="Model profile display name" type="text" value={draft.name}
            onChange={e=>change('name',e.target.value)}
            className="w-full p-1.5 rounded border border-line bg-panel"/>
        </label>
        <label className="space-y-1">API protocol
          <select aria-label="Model profile protocol" value={draft.protocol}
            onChange={e=>change('protocol',e.target.value)}
            className="w-full p-1.5 rounded border border-line bg-panel">
            {choices.map(value=><option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="space-y-1">API base URL
          <input aria-label="Model profile API base URL" type="url" value={draft.apiBaseUrl}
            placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"
            onChange={e=>change('apiBaseUrl',e.target.value)}
            className="w-full p-1.5 rounded border border-line bg-panel"/>
        </label>
        <label className="space-y-1">Custom API path (optional)
          <input aria-label="Model profile custom path" type="text" value={draft.customPath}
            placeholder="/proxy/{model}/messages"
            onChange={e=>change('customPath',e.target.value)}
            className="w-full p-1.5 rounded border border-line bg-panel font-mono"/>
          <span className="block text-faint">Only for a gateway whose route differs from the standard one. {'{model}'} is replaced by the model ID. Empty uses the standard route.</span>
        </label>
        <label className="space-y-1">Model ID
          <ModelField id="datgold-profile-model" ariaLabel="Model profile model" value={draft.model} onChange={value=>change('model',value)}
            inputClassName="w-full p-1.5 rounded border border-line bg-panel" protocol={draft.protocol} apiBaseUrl={draft.apiBaseUrl}/>
        </label>
        <ReasoningEffortField id="datgold-profile-reasoning" protocol={draft.protocol} apiBaseUrl={draft.apiBaseUrl} model={draft.model}
          value={draft.reasoningEffort} onChange={value=>change('reasoningEffort',value)}/>
        <label className="space-y-1">Authentication
          <select aria-label="Model profile authentication" value={draft.authMode}
            onChange={e=>change('authMode',e.target.value)}
            className="w-full p-1.5 rounded border border-line bg-panel">
            {['auto','bearer','google-key'].map(value=><option key={value}>{value}</option>)}
          </select>
        </label>
        <label className="space-y-1">API key (new/replacement only)
          <input aria-label="Model profile API key" type="password" autoComplete="off" value={draft.apiKey}
            onChange={e=>change('apiKey',e.target.value)}
            className="w-full p-1.5 rounded border border-line bg-panel"/>
        </label>
        <label className="space-y-1">Environment variable (alternative to API key)
          <input aria-label="Model profile environment key" type="text" value={draft.envKeyName}
            onChange={e=>change('envKeyName',e.target.value)}
            placeholder="OPENAI_API_KEY"
            className="w-full p-1.5 rounded border border-line bg-panel"/>
        </label>
        <div className="space-y-1">
          <label htmlFor="chatmcp-profile-headers">Custom HTTP headers (JSON, optional)</label>
          <p className="text-faint">
            Existing: {savedHeaders.length?savedHeaders.map(header=>header.name).join(', '):'none'}.
            Only edit to replace the saved set; saving replaces all of them, and [] clears them. Use envKeyName to read a value from an
            environment variable. Literal values are encrypted for this endpoint only and never shown again.
          </p>
          <textarea id="chatmcp-profile-headers" aria-label="Model profile custom headers JSON" rows={3} spellCheck={false}
            value={draft.customHeadersText}
            onChange={e=>setDraft(current=>({...current,customHeadersText:e.target.value,customHeadersDirty:true}))}
            placeholder='[{"name":"X-Tenant","envKeyName":"CHATMCP_TENANT"}]'
            className="w-full p-1.5 rounded border border-line bg-panel font-mono"/>
          {draft.customHeadersDirty&&<p className="text-warning">Saving replaces the existing headers of this profile.</p>}
        </div>
        <label className="space-y-1">Context window tokens (optional)
          <input aria-label="Model profile context window" type="number" value={draft.contextWindow}
            placeholder="unknown"
            onChange={e=>change('contextWindow',e.target.value)}
            className="w-full p-1.5 rounded border border-line bg-panel"/>
          <span className="block text-faint">{contextWindowRangeText()} tokens. {windowHint.kind==='catalog'?`${t('ai_window_catalog',{tokens:windowHint.tokens,source:windowHint.source})} `:windowHint.kind==='catalog_limited'?`${t('ai_window_catalog_limited',{tokens:windowHint.tokens,window:windowHint.window,input:windowHint.input,source:windowHint.source})} `:'Empty = unknown: the agent then plans with a conservative estimate and shows a warning. '}Larger values are reduced to the maximum.</span>
        </label>
        <fieldset className="space-y-1 border border-line rounded-md p-2">
          <legend className="text-muted">Optional owner-supplied rates (USD / 1M tokens)</legend>
          <p className="text-faint">Leave a rate empty to use the model catalog's price as an estimate (shown as an estimate, never as a bill); when the catalog does not know the model, no cost is shown. Cache tokens are included in input; reasoning is included in output. Usage may be incomplete.</p>
          {([
            ['rateInput','Input','input'],['rateOutput','Output','output'],
            ['rateCacheRead','Cache read','cacheRead'],['rateCacheWrite','Cache write','cacheWrite'],
          ] as const).map(([field,label,rate])=><label key={field} className="flex gap-2 items-center">
            <span className="w-24">{label}</span>
            <input type="number" step="any" min="0" max="10000"
              aria-label={'Model rate '+label} value={draft[field]} placeholder={catalogRate(rate)}
              onChange={e=>change(field,e.target.value)}
              className="flex-1 min-w-0 p-1.5 rounded border border-line bg-panel"/>
          </label>)}
        </fieldset>
        <label className="flex gap-2 items-center">
          <input type="checkbox" checked={draft.isDefault} onChange={e=>change('isDefault',e.target.checked)}/>
          Use as default profile for future tasks
        </label>
        {editing&&<label className="flex gap-2 items-center">
          <input type="checkbox" checked={draft.clearCredentials}
            onChange={e=>change('clearCredentials',e.target.checked)}/>
          Clear saved credentials (key and custom headers) for this profile
        </label>}
        {message&&<p role="alert" className="text-danger">{message}</p>}
        <button type="button" onClick={()=>void save()} disabled={busy}
          className="rounded-md bg-primary text-primary-fg px-3 py-1.5 font-semibold disabled:opacity-50">
          {busy?'Saving...':'Save model profile'}
        </button>
      </div>
    </section>
  );
}
