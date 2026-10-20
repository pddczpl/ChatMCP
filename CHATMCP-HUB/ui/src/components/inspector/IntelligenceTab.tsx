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
import { contextWindowField, contextWindowRangeText } from '@/lib/context-window';

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
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [customHeadersDraft,setCustomHeadersDraft] = useState('');
  const [customHeadersDirty,setCustomHeadersDirty] = useState(false);
  // Only an edited window is sent; an untouched form leaves the saved one (or the preset default) alone.
  const [contextWindowDraft,setContextWindowDraft] = useState('');
  const [contextWindowDirty,setContextWindowDirty] = useState(false);
  const savedWindow = (ai as any).contextWindowTokens as number | null | undefined;
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
    });
    const saved = result.ai;
    if (!saved || (aiProtocolForPreset(submitted.provider) && saved.protocol !== aiProtocolForPreset(submitted.provider))) {
      throw new Error('Hub chưa lưu đúng giao thức đã chọn. Cấu hình AI hiện tại chưa được xác nhận.');
    }
    setForm(current => reconcileSavedAiConfig(current, submitted, saved));
    setCustomHeadersDraft('');
    setCustomHeadersDirty(false);
    setContextWindowDraft('');
    setContextWindowDirty(false);
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
          throw new Error('Giao thức kiểm tra không khớp lựa chọn của bạn. Kiểm tra lại cấu hình đã lưu.');
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
      setSaveError(err.message || 'Lỗi lưu cấu hình');
      showToast(err.message || 'Lỗi lưu cấu hình', 'error');
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

      {draftChanged && (
        <div role="status" className="rounded-md border border-warning/40 bg-warning/10 text-warning p-2.5">
          Chưa áp dụng cấu hình mới. Hub vẫn đang sử dụng <strong>{ai.preset || 'chưa xác định'} / {ai.protocol || 'chưa xác định'}</strong>.
          Bấm Lưu cấu hình để áp dụng {form.provider}{expectedProtocol ? ` / ${expectedProtocol}` : ''}.
          {retainsExistingKey && !form.apiKey.trim() ? ' API key đã lưu sẽ được giữ lại vì không đổi host.' : ''}
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
          <span className="text-[12px] text-faint font-normal">API hoặc model cục bộ</span>
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

      {/* Model Name */}
      <div className="space-y-1.5">
        <label className="text-[12px] font-semibold text-muted block">
          {t('ai_model_id')}
        </label>
        <input
          type="text"
          aria-label="Model"
          value={model}
          onChange={(e) => setForm(current => ({ ...current, model: e.target.value }))}
          placeholder="vd: claude-sonnet-5-5, gpt-4o, deepseek-chat..."
          className="w-full bg-surface text-fg font-mono text-xs rounded-md px-3 py-1.5 border border-line focus:outline-none focus:border-primary"
        />
      </div>

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
        <p data-testid="context-window-hint" className={`text-xs ${savedWindow ? 'text-faint' : 'text-warning'}`}>
          {savedWindow ? '' : 'Unknown: the agent plans with a conservative estimate and shows a warning on every task. '}
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
          aria-label="Lưu & kiểm tra"
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
