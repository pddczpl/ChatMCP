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

export function IntelligenceTab() {
  const { showToast } = useAppStore();
  const { t } = useTranslation();
  const { data: hub, refetch } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3500 });

  const ai = hub?.ai || {};

  const providers = [
    { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5-5', defaultUrl: 'https://api.anthropic.com' },
    { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-5-mini', defaultUrl: 'https://api.openai.com/v1' },
    { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-2.5-flash', defaultUrl: 'https://generativelanguage.googleapis.com' },
    { id: 'openrouter', name: 'OpenRouter', defaultModel: 'anthropic/claude-sonnet-4.5', defaultUrl: 'https://openrouter.ai/api/v1' },
    { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat', defaultUrl: 'https://api.deepseek.com' },
    { id: 'groq', name: 'Groq', defaultModel: 'llama-3.3-70b-versatile', defaultUrl: 'https://api.groq.com/openai/v1' },
    { id: 'ollama', name: 'Ollama (Local)', defaultModel: 'qwen2.5-coder:7b', defaultUrl: 'http://localhost:11434/v1' },
    { id: 'lmstudio', name: 'LM Studio (Local)', defaultModel: 'local-model', defaultUrl: 'http://localhost:1234/v1' },
    { id: 'custom-openai', name: 'Custom (OpenAI)', defaultModel: 'custom-model', defaultUrl: 'https://api.openai.com/v1' },
  ];

  const [provider, setProvider] = useState((ai as any).preset || ai.provider || 'anthropic');
  const [model, setModel] = useState(ai.model || 'claude-sonnet-5-5');
  const [apiBaseUrl, setApiBaseUrl] = useState(ai.apiBaseUrl || 'https://api.anthropic.com');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);

  useEffect(() => {
    if (ai.apiBaseUrl && !apiBaseUrl) setApiBaseUrl(ai.apiBaseUrl);
    if (ai.model && !model) setModel(ai.model);
    if ((ai as any).preset || ai.provider) setProvider((ai as any).preset || ai.provider);
  }, [ai]);

  const handleProviderChange = (pId: string) => {
    setProvider(pId);
    const p = providers.find((x) => x.id === pId);
    if (p) {
      setModel(p.defaultModel);
      setApiBaseUrl(p.defaultUrl);
    }
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const start = Date.now();
    try {
      // First save or send active settings
      await api.updateAiConfig({
        preset: provider,
        apiBaseUrl: apiBaseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
        remember: true,
      });

      const res = await api.testConnection();
      const latency = Date.now() - start;
      if (res?.ok !== false) {
        setTestResult({ ok: true, latencyMs: latency });
        showToast(t('ai_test_success'), 'success');
      } else {
        setTestResult({ ok: false, error: res?.error || t('ai_test_fail') });
        showToast(t('ai_test_fail'), 'error');
      }
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message || t('ai_test_fail') });
      showToast(err.message || t('ai_test_fail'), 'error');
    } finally {
      setTesting(false);
      refetch();
    }
  };

  const handleSave = async () => {
    try {
      await api.updateAiConfig({
        preset: provider,
        apiBaseUrl: apiBaseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
        remember: true,
      });
      showToast(t('ai_save_success'), 'success');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi lưu cấu hình', 'error');
    }
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-3.5 select-none text-xs">
      {/* Current Active Status */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-teal-500/10 text-teal-400 border border-teal-500/20 flex items-center justify-center">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <div className="font-semibold text-[var(--text)]">
              {ai.model || t('ai_status_unconfigured')}
            </div>
            <div className="text-[10px] text-[var(--faint)]">
              {ai.apiBaseUrl ? `${ai.provider || provider} · ${ai.apiBaseUrl}` : `Provider: ${ai.provider || provider}`}
            </div>
          </div>
        </div>

        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
          {ai.configured ? t('ai_status_ready') : t('ai_status_unconfigured')}
        </span>
      </div>

      {/* Provider Selector */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          {t('ai_provider_title')}
        </label>
        <div className="grid grid-cols-3 gap-1.5">
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => handleProviderChange(p.id)}
              className={`p-2 rounded-lg border text-left transition-all ${
                provider === p.id
                  ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold shadow-sm'
                  : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
              }`}
            >
              <div className="text-[11px] font-medium truncate">{p.name}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Base URL (API Endpoint) */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-[var(--muted)] flex items-center justify-between">
          <span>{t('ai_base_url')}</span>
          <span className="text-[10px] text-[var(--faint)] font-normal">Tùy biến URL / Render / Proxy</span>
        </label>
        <div className="relative">
          <Globe className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder={t('ai_base_url_hint')}
            className="w-full bg-[var(--surface)] text-[var(--text)] font-mono text-xs rounded-md pl-8 pr-3 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>

      {/* Model Name */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          {t('ai_model_id')}
        </label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="vd: claude-sonnet-5-5, gpt-4o, deepseek-chat..."
          className="w-full bg-[var(--surface)] text-[var(--text)] font-mono text-xs rounded-md px-3 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
        />
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-[var(--muted)] flex items-center justify-between">
          <span>{t('ai_api_key')}</span>
          <span className="text-[10px] text-[var(--faint)] font-normal">{t('ai_api_key_hint')}</span>
        </label>
        <div className="relative">
          <Key className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full bg-[var(--surface)] text-[var(--text)] font-mono text-xs rounded-md pl-8 pr-3 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>

      {/* Test Connection Result */}
      {testResult && (
        <div
          className={`p-2.5 rounded-lg border flex items-center gap-2 text-xs ${
            testResult.ok
              ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
              : 'bg-rose-950/30 border-rose-500/40 text-rose-300'
          }`}
        >
          {testResult.ok ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <span>{t('ai_test_success')} {testResult.latencyMs}ms</span>
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
              <span>{testResult.error || t('ai_test_fail')}</span>
            </>
          )}
        </div>
      )}

      {/* Buttons */}
      <div className="flex items-center gap-2 pt-2 border-t border-[var(--line-subtle)]">
        <Button
          variant="secondary"
          onClick={handleTestConnection}
          disabled={testing}
          className="flex-1 gap-1.5 h-8 text-xs"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 text-amber-400" />}
          <span>{testing ? t('ai_testing') : t('ai_test_conn')}</span>
        </Button>

        <Button
          variant="primary"
          onClick={handleSave}
          className="flex-1 gap-1.5 h-8 text-xs"
        >
          <Save className="w-3.5 h-3.5" />
          <span>{t('ai_save_config')}</span>
        </Button>
      </div>
    </div>
  );
}
