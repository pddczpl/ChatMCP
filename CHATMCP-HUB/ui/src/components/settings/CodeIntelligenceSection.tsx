import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ScanSearch } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { SettingsCard } from './SettingsCard';

const ENGINES: Array<[string, string]> = [
  ['typescript-lsp', 'TypeScript LSP'],
  ['python-lsp', 'Python LSP (Pyright)'],
  ['tree-sitter', 'Tree-sitter WASM'],
  ['python-ast', 'Python Native AST'],
  ['heuristic', 'Heuristic Fallback'],
];

/** Real code-intelligence checks: an engine is never shown as Ready because a file exists. */
export function CodeIntelligenceSection() {
  const { showToast } = useAppStore();
  const { t } = useTranslation();
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const { data: intelligence, refetch: refreshIntelligence } = useQuery({
    queryKey: ['intelligenceEngineHealth'],
    queryFn: api.getIntelligenceStatus,
    enabled: Boolean(hub?.workspace?.path),
    refetchInterval: 12000,
  });
  const [probing, setProbing] = useState(false);
  const probe = async () => {
    setProbing(true);
    try {
      await api.probeIntelligenceEngines();
      await refreshIntelligence();
      showToast(t('ci_probed'), 'success');
    } catch (error: any) {
      showToast(error.message || t('ci_probe_failed'), 'error');
    } finally { setProbing(false); }
  };

  return (
    <SettingsCard
      data-testid="code-intelligence-engines"
      icon={ScanSearch}
      title="Code Intelligence Engines"
      description={t('ci_desc')}
      action={
        <Button variant="secondary" size="sm" onClick={probe} disabled={probing}>
          <RefreshCw className={cn('h-3.5 w-3.5', probing && 'animate-spin')} />
          {t('ci_recheck')}
        </Button>
      }
    >
      <ul className="space-y-2">
        {ENGINES.map(([id, name]) => {
          const engine = intelligence?.engineHealth?.engines?.find((item: { id: string; status: string; source?: string; version?: string | null; detail?: string }) => item.id === id);
          const status = engine?.status || 'not_checked';
          return (
            <li key={id} className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface px-3.5 py-2.5">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-fg">{name}</div>
                <div className="text-[12px] leading-4 text-muted">
                  {engine?.version ? 'v' + engine.version + ' · ' : ''}
                  {engine?.source || t('ci_not_checked')}
                  {engine?.detail ? ' · ' + engine.detail : ''}
                </div>
              </div>
              <span className={cn('shrink-0 text-[12px] font-semibold', status === 'ready' ? 'text-success' : status === 'not_checked' ? 'text-muted' : 'text-warning')}>
                {status === 'ready' ? 'Ready' : status === 'not_checked' ? t('ci_not_checked') : 'Unavailable'}
              </span>
            </li>
          );
        })}
      </ul>
    </SettingsCard>
  );
}
