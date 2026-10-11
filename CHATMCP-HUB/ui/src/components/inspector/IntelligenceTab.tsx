import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { 
  Cpu, 
  Key, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Zap, 
  Sliders, 
  Save 
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function IntelligenceTab() {
  const { showToast } = useAppStore();
  const { data: hub, refetch } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3500 });

  const ai = hub?.ai || {};
  const [provider, setProvider] = useState(ai.provider || 'anthropic');
  const [model, setModel] = useState(ai.model || 'claude-3-5-sonnet-latest');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);

  const providers = [
    { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-3-5-sonnet-latest' },
    { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o' },
    { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-1.5-pro-latest' },
    { id: 'openrouter', name: 'OpenRouter', defaultModel: 'anthropic/claude-3.5-sonnet' },
    { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
    { id: 'ollama', name: 'Ollama (Local)', defaultModel: 'llama3:8b' },
  ];

  const handleProviderChange = (pId: string) => {
    setProvider(pId);
    const p = providers.find((x) => x.id === pId);
    if (p) setModel(p.defaultModel);
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const start = Date.now();
    try {
      const res = await api.testConnection({ provider, model, apiKey: apiKey || undefined });
      const latency = Date.now() - start;
      if (res?.ok !== false) {
        setTestResult({ ok: true, latencyMs: latency });
        showToast('Kết nối AI thành công!', 'success');
      } else {
        setTestResult({ ok: false, error: res?.error || 'Kết nối thất bại' });
        showToast('Kết nối AI thất bại', 'error');
      }
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message || 'Lỗi mạng hoặc API key' });
      showToast('Lỗi kết nối AI', 'error');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      await api.updateAiConfig({ provider, model, apiKey: apiKey || undefined });
      showToast('Đã lưu cấu hình AI', 'success');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi lưu cấu hình', 'error');
    }
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-4 select-none text-xs">
      {/* Current Active Status */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between tilt-3d">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-teal-500/10 text-teal-400 border border-teal-500/20 flex items-center justify-center">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <div className="font-semibold text-[var(--text)]">
              {ai.model || 'Chưa thiết lập'}
            </div>
            <div className="text-[10px] text-[var(--faint)]">
              Nhà cung cấp: {ai.provider || 'anthropic'}
            </div>
          </div>
        </div>

        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
          Sẵn sàng
        </span>
      </div>

      {/* Provider Selector */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          Chọn nhà cung cấp mô hình (Provider)
        </label>
        <div className="grid grid-cols-2 gap-2">
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
              <div className="text-xs">{p.name}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Model Name */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          Tên mô hình (Model ID)
        </label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="vd: claude-3-5-sonnet-latest"
          className="w-full bg-[var(--surface)] text-[var(--text)] font-mono text-xs rounded-md px-3 py-2 border border-[var(--line)] focus:outline-none focus:border-sky-500"
        />
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-[var(--muted)] flex items-center justify-between">
          <span>API Key / Access Token</span>
          <span className="text-[10px] text-[var(--faint)] font-normal">Để trống nếu dùng biến môi trường</span>
        </label>
        <div className="relative">
          <Key className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full bg-[var(--surface)] text-[var(--text)] font-mono text-xs rounded-md pl-8 pr-3 py-2 border border-[var(--line)] focus:outline-none focus:border-sky-500"
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
              <span>Kết nối thành công! Độ trễ phản hồi: {testResult.latencyMs}ms</span>
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
              <span>{testResult.error || 'Kiểm tra kết nối thất bại'}</span>
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
          <span>{testing ? 'Đang kiểm tra...' : 'Kiểm tra kết nối'}</span>
        </Button>

        <Button
          variant="primary"
          onClick={handleSave}
          className="flex-1 gap-1.5 h-8 text-xs"
        >
          <Save className="w-3.5 h-3.5" />
          <span>Lưu cấu hình</span>
        </Button>
      </div>
    </div>
  );
}
