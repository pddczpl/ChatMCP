import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { 
  Cpu, 
  Key, 
  Globe, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Zap, 
  Save 
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { aiDraftHasChanges, aiProtocolForPreset, reconcileSavedAiConfig, selectAiProviderDraft, type AiConfigForm } from '@/lib/ai-config-form';
import { ModelProfilesPanel } from './ModelProfilesPanel';
import { ModelField } from './ModelField';
import { ReasoningEffortField } from './ReasoningEffortField';
import { contextWindowField, contextWindowHint, contextWindowRangeText, windowHintSentence } from '@/lib/context-window';
import { useModelInfo } from '@/lib/useModelInfo';

export function IntelligenceTab() {
  const { showToast } = useAppStore();
  const { t } = useTranslation();
  const { data: hub, refetch } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3500 });

  const ai = hub?.ai || {};

  const providers = [
    { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5-5', defaultUrl: 'https://api.anthropic.com' },
    { id: 'openai', name: 'OpenAI (Chat Completions)', defaultModel: 'gpt-5-mini', defaultUrl: 'https://api.openai.com/v1' },
    { id: 'openai-responses', name: 'OpenAI Responses API', defaultModel: 'gpt-5-mini', defaultUrl: 'https://api.openai.com/v1' },
    { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-2.5-flash', defaultUrl: 'https://generativelanguage.googleapis.com' },
    { id: 'openrouter', name: 'OpenRouter', defaultModel: 'anthropic/claude-sonnet-4.5', defaultUrl: 'https://openrouter.ai/api/v1' },
    { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat', defaultUrl: 'https://api.deepseek.com' },
    { id: 'groq', name: 'Groq', defaultModel: 'llama-3.3-70b-versatile', defaultUrl: 'https://api.groq.com/openai/v1' },
    { id: 'mistral', name: 'Mistral', defaultModel: 'mistral-large-latest', defaultUrl: 'https://api.mistral.ai/v1' },
    { id: 'ollama', name: 'Ollama (Local)', defaultModel: 'qwen2.5-coder:7b', defaultUrl: 'http://localhost:11434/v1' },
    { id: 'lmstudio', name: 'LM Studio (Local)', defaultModel: 'local-model', defaultUrl: 'http://localhost:1234/v1' },
    { id: 'custom-openai', name: 'Custom (Chat Completions)', defaultModel: '', defaultUrl: '' },
    { id: 'custom-responses', name: 'Custom (Responses API)', defaultModel: '', defaultUrl: '' },
    { id: 'custom-gemini', name: 'Custom (Gemini)', defaultModel: '', defaultUrl: '' },
    { id: 'custom-anthropic', name: 'Custom (Anthropic)', defaultModel: '', defaultUrl: '' },
  ];

  const [form, setForm] = useState<AiConfigForm>({
    provider: (ai as any).preset || ai.provider || 'anthropic',
    model: ai.model || 'claude-sonnet-5-5',
    apiBaseUrl: ai.apiBaseUrl || 'https://api.anthropic.com',
    apiKey: '',
  });
  const { provider, model, apiBaseUrl, apiKey } = form;
  // What to ask the Hub about the model in the form: a real preset (a Hub with no connection yet calls its provider "gateway", which is not one, and refuses it), and the protocol.
  const askPreset = providers.some((choice) => choice.id === form.provider) ? form.provider : undefined;
  const askProtocol = aiProtocolForPreset(form.provider) ?? ((ai as any).protocol || undefined);
  const { data: modelInfo } = useModelInfo({ preset: askPreset, protocol: askProtocol, apiBaseUrl, model });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [customHeadersDraft,setCustomHeadersDraft] = useState('');
  const [customHeadersDirty,setCustomHeadersDirty] = useState(false);
  // Only an edited window is sent; an untouched form leaves the saved one (or the preset default) alone.
  const [contextWindowDraft,setContextWindowDraft] = useState('');
  const [contextWindowDirty,setContextWindowDirty] = useState(false);
  // How many times the form was saved: a new key for the same address is another account, so what the provider answered about the account's models (the picker keeps it) is for one save only.
  const [accountRevision, setAccountRevision] = useState(0);
  const savedWindow = (ai as any).contextWindowTokens as number | null | undefined;
  const windowHint = contextWindowHint(contextWindowDirty ? contextWindowDraft : savedWindow, modelInfo);
  const windowSentence = windowHintSentence(t, windowHint);
  // 'auto' or a level. Only an edited level is sent; an untouched form leaves the saved one alone, and choosing another provider starts at auto (as the Hub does).
  const [reasoningDraft, setReasoningDraft] = useState<string | null>(null);
  const savedEffort: string = (ai as any).reasoningEffort || 'auto';
  const effortValue = reasoningDraft ?? savedEffort;
  const effortChanged = reasoningDraft !== null && reasoningDraft !== savedEffort;
  const draftChanged = aiDraftHasChanges(form, ai as any) || customHeadersDirty || contextWindowDirty;
  const expectedProtocol = aiProtocolForPreset(form.provider);
  const oldOrigin = (() => { try { return new URL(ai.apiBaseUrl || '').origin; } catch { return ''; } })();
  const newOrigin = (() => { try { return new URL(form.apiBaseUrl).origin; } catch { return ''; } })();
  const retainsExistingKey = oldOrigin !== '' && oldOrigin === newOrigin
    && String(ai.preset || '').startsWith('custom-') && form.provider.startsWith('custom-')
    && ai.keySource === 'saved';
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);
  const [formInitialized, setFormInitialized] = useState(false);

  useEffect(() => {
    if (!hub || formInitialized) return;
    setForm(current => ({ ...current,
      apiBaseUrl: ai.apiBaseUrl || current.apiBaseUrl,
      model: ai.model || current.model,
      provider: (ai as any).preset || current.provider,
    }));
    setFormInitialized(true);
  }, [hub, formInitialized, ai]);

  const handleProviderChange = (pId: string) => {
    const p = providers.find((x) => x.id === pId);
    if (!p) return;
    setForm(current => selectAiProviderDraft(current, p));
    setTestResult(null);
    setSaveError('');
    setCustomHeadersDraft('');
    setCustomHeadersDirty(false);
    setContextWindowDraft('');
    setContextWindowDirty(false);
    setReasoningDraft('auto');
  };

  const handleEndpointChange = (nextUrl: string) => {
    // Never carry an unsaved credential to a different destination.
    setForm(current => {
      let sameOrigin = false;
      try { sameOrigin = new URL(nextUrl).origin === new URL(current.apiBaseUrl).origin; } catch { /* Incomplete URL. */ }
      return { ...current, apiBaseUrl: nextUrl, apiKey: sameOrigin ? current.apiKey : '' };
    });
    setTestResult(null);
    setSaveError('');
    setCustomHeadersDraft('');
    setCustomHeadersDirty(false);
  };

  const saveForm = async () => {
    const submitted = form;
    const parsedHeaders=customHeadersDirty?JSON.parse(customHeadersDraft||'[]'):undefined;
    if(parsedHeaders!==undefined && !Array.isArray(parsedHeaders))
      throw new Error('Custom headers must be a JSON array.');
    const windowField = contextWindowField(contextWindowDraft, contextWindowDirty);
    const result = await api.updateAiConfig({
      preset: submitted.provider,
      ...(aiProtocolForPreset(submitted.provider) ? { protocol: aiProtocolForPreset(submitted.provider) } : {}),
      ...(['custom-openai','custom-responses'].includes(submitted.provider) ? { authMode: 'bearer' } : {}),
      apiBaseUrl: submitted.apiBaseUrl.trim(),
      model: submitted.model.trim(),
      apiKey: submitted.apiKey.trim() || undefined,
      remember: true,
      ...(customHeadersDirty?{customHeaders:parsedHeaders}:{}),
      ...windowField,
      ...(reasoningDraft !== null ? { reasoningEffort: reasoningDraft } : {}),
    });
    const saved = result.ai;
    if (!saved || (aiProtocolForPreset(submitted.provider) && saved.protocol !== aiProtocolForPreset(submitted.provider))) {
      throw new Error(t('ai_protocol_unsaved'));
    }
    setForm(current => reconcileSavedAiConfig(current, submitted, saved));
    setCustomHeadersDraft('');
    setCustomHeadersDirty(false);
    setContextWindowDraft('');
    setContextWindowDirty(false);
    setReasoningDraft(null);
    setAccountRevision((count) => count + 1);
    return reconcileSavedAiConfig(submitted, submitted, saved);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setSaveError('');
    const start = Date.now();
    let savedForm: AiConfigForm | undefined;
    try {
      savedForm = await saveForm();
      const res = await api.testConnection();
      const latency = Date.now() - start;
      if (res?.ok !== false) {
        if (expectedProtocol && res.protocol !== expectedProtocol) {
          throw new Error(t('ai_protocol_mismatch'));
        }
        setTestResult({ ok: true, latencyMs: latency });
        showToast(t('ai_test_success'), 'success');
      } else {
        setTestResult({ ok: false, error: res?.error || t('ai_test_fail') });
        showToast(t('ai_test_fail'), 'error');
      }
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message || t('ai_test_fail') });
      setSaveError(err.message || t('ai_test_fail'));
      showToast(err.message || t('ai_test_fail'), 'error');
    } finally {
      setTesting(false);
      const refreshed = await refetch();
      if (savedForm && refreshed.data?.ai) {
        const submitted = savedForm;
        setForm(current => reconcileSavedAiConfig(current, submitted, refreshed.data.ai!));
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await saveForm();
      showToast(t('ai_save_success'), 'success');
      await refetch();
    } catch (err: any) {
      setSaveError(err.message || t('ai_save_failed'));
      showToast(err.message || t('ai_save_failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-3.5 select-none text-xs">
      {/* Current Active Status */}
      <div className="p-3 rounded-lg bg-surface border border-line flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent border border-accent/20 flex items-center justify-center">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <div className="font-semibold text-fg">
              {ai.model || t('ai_status_unconfigured')}
            </div>
            <div className="text-[12px] text-faint">
              {ai.apiBaseUrl ? `${ai.preset || ai.provider} · ${ai.protocol || 'unknown'} · ${ai.apiBaseUrl}` : `Provider: ${ai.preset || ai.provider}`}
            </div>
          </div>
        </div>

        <span className="px-2 py-0.5 rounded-full text-[12px] font-semibold bg-success/20 text-success border border-success/30">
          {ai.configured ? t('ai_status_ready') : t('ai_status_unconfigured')}
        </span>
      </div>

      {(draftChanged || effortChanged) && (
        <div role="status" className="rounded-md border border-warning/40 bg-warning/10 text-warning p-2.5">
          {t('ai_pending_a')}<strong>{ai.preset || t('ai_unknown')} / {ai.protocol || t('ai_unknown')}</strong>{t('ai_pending_b')}{form.provider}{expectedProtocol ? ` / ${expectedProtocol}` : ''}.
          {retainsExistingKey && !form.apiKey.trim() ? t('ai_keeps_key') : ''}
        </div>
      )}
      {saveError && <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 text-danger p-2.5">{saveError}</div>}

      {/* Provider Selector */}
      <div className="space-y-1.5">
        <label className="text-[12px] font-semibold text-muted block">
          {t('ai_provider_title')}
        </label>
        <div className="grid grid-cols-3 gap-1.5">
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => handleProviderChange(p.id)}
              className={`p-2 rounded-lg border text-left transition-all ${
                provider === p.id
                  ? 'bg-primary/15 border-primary/50 text-primary font-semibold shadow-sm'
                  : 'bg-surface border-line-subtle text-muted hover:bg-hover'
              }`}
            >
              <div className="text-[12px] font-medium truncate">{p.name}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Base URL (API Endpoint) */}
      <div className="space-y-1.5">
        <label className="text-[12px] font-semibold text-muted flex items-center justify-between">
          <span>{t('ai_base_url')}</span>
          <span className="text-[12px] text-faint font-normal">{t('ai_base_url_note')}</span>
        </label>
        <div className="relative">
          <Globe className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            type="text"
            aria-label="API base URL"
            value={apiBaseUrl}
            onChange={(e) => handleEndpointChange(e.target.value)}
            placeholder={t('ai_base_url_hint')}
            className="w-full bg-surface text-fg font-mono text-xs rounded-md pl-8 pr-3 py-1.5 border border-line focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Model Name: the input, with a list of the provider's models and what the Hub knows of the one typed (a script of its own: the plain input until it is there) */}
      <div className="space-y-1.5">
        <label className="text-[12px] font-semibold text-muted block">
          {t('ai_model_id')}
        </label>
        <ModelField
          id="datgold-model"
          ariaLabel="Model"
          value={model}
          onChange={(next) => setForm(current => ({ ...current, model: next }))}
          placeholder={t('ai_model_placeholder')}
          inputClassName="w-full bg-surface text-fg font-mono text-xs rounded-md px-3 py-1.5 border border-line focus:outline-none focus:border-primary"
          preset={askPreset}
          protocol={askProtocol}
          apiBaseUrl={apiBaseUrl}
          // The account's own models can be asked of the provider only for the connection the Hub holds, with its saved key.
          canListAccount={Boolean(ai.configured) && provider === ((ai as any).preset || ai.provider) && apiBaseUrl.trim() === (ai.apiBaseUrl || '').trim()}
          showCatalog
          accountRevision={accountRevision}
        />
      </div>

      {/* Thinking effort: how much the model is asked to think, from what the Hub knows about this model */}
      <ReasoningEffortField
        id="datgold-reasoning-effort"
        preset={askPreset}
        protocol={askProtocol}
        apiBaseUrl={apiBaseUrl}
        model={model}
        value={effortValue}
        onChange={setReasoningDraft}
        refused={reasoningDraft === null && (ai as any).reasoning?.refused === true}
      />

      {/* Context window: what the agent plans its history and tool list against */}
      <div className="space-y-1.5">
        <label htmlFor="chatmcp-context-window" className="text-xs font-semibold text-muted block">
          Context window (tokens)
        </label>
        <input
          id="chatmcp-context-window"
          type="number"
          aria-label="Context window tokens"
          value={contextWindowDirty ? contextWindowDraft : (savedWindow ?? '')}
          onChange={(e) => { setContextWindowDraft(e.target.value); setContextWindowDirty(true); }}
          placeholder="unknown"
          className="w-full bg-surface text-fg font-mono text-xs rounded-md px-3 py-1.5 border border-line focus:outline-none focus:border-primary"
        />
        <p data-testid="context-window-hint" className={`text-xs ${windowHint.kind === 'unknown' ? 'text-warning' : 'text-faint'}`}>
          {windowHint.kind === 'unknown' ? 'Unknown: the agent plans with a conservative estimate and shows a warning on every task. ' : ''}
          {windowSentence ? `${windowSentence} ` : ''}
          {`Allowed: ${contextWindowRangeText()} tokens (larger values are reduced to the maximum, smaller ones are refused). Leave empty if you do not know it.`}
        </p>
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <label className="text-[12px] font-semibold text-muted flex items-center justify-between">
          <span>{t('ai_api_key')}</span>
          <span className="text-[12px] text-faint font-normal">{t('ai_api_key_hint')}</span>
        </label>
        <div className="relative">
          <Key className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            type="password"
            aria-label="API key"
            value={apiKey}
            onChange={(e) => setForm(current => ({ ...current, apiKey: e.target.value }))}
            placeholder="sk-..."
            className="w-full bg-surface text-fg font-mono text-xs rounded-md pl-8 pr-3 py-1.5 border border-line focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Protected custom HTTP headers: never populate editable fields with
          secret values returned from persisted application state. */}
      <div className="space-y-1.5">
        <label htmlFor="chatmcp-custom-headers" className="text-[12px] font-semibold text-muted block">
          Custom HTTP headers (JSON)
        </label>
        <p className="text-[12px] text-faint">
          Existing: {Array.isArray((ai as any).customHeaders)
            ? (ai as any).customHeaders.map((h:any)=>h.name).join(', ') || 'none'
            : 'none'}. Only edit to replace the saved set. Use envKeyName to reference an environment variable.
          Literal values are encrypted on save and never returned by the API.
        </p>
        <textarea id="chatmcp-custom-headers" aria-label="Custom headers JSON" rows={3}
          spellCheck={false} value={customHeadersDraft}
          onChange={event=>{setCustomHeadersDraft(event.target.value);setCustomHeadersDirty(true);}}
          placeholder='[{"name":"X-Tenant","envKeyName":"CHATMCP_TENANT"}]'
          className="w-full bg-surface text-fg font-mono text-xs rounded-md px-3 py-2 border border-line focus:outline-none focus:border-primary"/>
        {customHeadersDirty && <p className="text-[12px] text-warning">Saving replaces the existing headers; use [] to clear them.</p>}
      </div>

      {/* Test Connection Result */}
      {testResult && (
        <div
          className={`p-2.5 rounded-lg border flex items-center gap-2 text-xs ${
            testResult.ok
              ? 'bg-success/10 border-success/40 text-success'
              : 'bg-danger/10 border-danger/40 text-danger'
          }`}
        >
          {testResult.ok ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
              <span>{t('ai_test_success')} {testResult.latencyMs}ms</span>
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-danger flex-shrink-0" />
              <span>{testResult.error || t('ai_test_fail')}</span>
            </>
          )}
        </div>
      )}

      {/* Buttons */}
      <div className="flex items-center gap-2 pt-2 border-t border-line-subtle">
        <Button
          variant="secondary"
          aria-label={t('ai_test_aria')}
          onClick={handleTestConnection}
          disabled={testing || saving || !!hub?.agent?.activeTaskId}
          className="flex-1 gap-1.5 h-8 text-xs"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 text-warning" />}
          <span>{testing ? t('ai_testing') : t('ai_test_conn')}</span>
        </Button>

        <Button
          variant="primary"
          onClick={handleSave}
          disabled={testing || saving || !!hub?.agent?.activeTaskId}
          className="flex-1 gap-1.5 h-8 text-xs"
        >
          <Save className="w-3.5 h-3.5" />
          <span>{t('ai_save_config')}</span>
        </Button>
      </div>
      <ModelProfilesPanel />
    </div>
  );
}
