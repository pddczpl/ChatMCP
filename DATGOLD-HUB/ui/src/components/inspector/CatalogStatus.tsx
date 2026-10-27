import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { hasTranslation, useTranslation, type TranslationKey } from '@/lib/i18n';
import '@/lib/i18n-models'; // the strings only the picker asks for load with it
import { useAppStore } from '@/store/useAppStore';

/**
 * Which list of models the Hub knows (the one that ships with it, or one the owner had it fetch), how old it is, and the one button that fetches a newer one. Nothing is fetched until the button
 * is pressed, and the line says what the button contacts and that it sends nothing of the person's.
 */
export function CatalogStatusLine() {
  const { t, lang } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useAppStore();
  const { data: status } = useQuery({ queryKey: ['catalogStatus'], queryFn: api.getCatalog, staleTime: 60_000, retry: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const update = async () => {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      const next = await api.refreshCatalog();
      queryClient.setQueryData(['catalogStatus'], next);
      // What was worked out from the old list is asked again: the models of a provider, what the Hub knows about the model in a form, and the Hub's own state (the window it plans with).
      await Promise.all(['catalogModels', 'modelInfo', 'hubState'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      showToast(t('ai_catalog_updated', { label: next.label, models: formatNumber(next.models, lang) }), 'success');
    } catch (error) {
      setProblem(t('ai_catalog_failed', { error: error instanceof Error ? error.message : '' }));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const age = status.ageDays <= 0 ? t('ai_catalog_age_today') : status.ageDays === 1 ? t('ai_catalog_age_one') : t('ai_catalog_age_other', { n: status.ageDays });
  const reasonKey = `ai_catalog_ignored_${status.ignored?.reason}`;
  const failedBefore = status.lastRefresh && !status.lastRefresh.ok ? t('ai_catalog_failed', { error: status.lastRefresh.error ?? '' }) : '';
  const alert = problem || failedBefore;
  return (
    <div data-testid="catalog-status" role="group" aria-label={t('ai_catalog_title')} className="space-y-1 rounded-md border border-line-subtle p-2 text-[12px] text-faint">
      <p data-testid="catalog-line" className="text-muted">
        {t('ai_catalog_line', {
          label: status.label,
          source: t(status.source === 'refreshed' ? 'ai_catalog_source_refreshed' : 'ai_catalog_source_bundled'),
          age,
          models: formatNumber(status.models, lang),
        })}
      </p>
      {status.ignored && (
        <p role="status" className="text-warning">
          {t('ai_catalog_ignored', { reason: hasTranslation(reasonKey) ? t(reasonKey as TranslationKey) : status.ignored.reason })}
        </p>
      )}
      {alert && <p role="alert" className="text-warning">{alert}</p>}
      <div className="flex items-start justify-between gap-2">
        <p>{t('ai_catalog_privacy')}</p>
        <button
          type="button"
          data-testid="catalog-update"
          disabled={busy || status.refreshing}
          onClick={() => void update()}
          className="shrink-0 rounded-md border border-line px-2 py-1 font-medium text-fg hover:bg-hover disabled:opacity-50"
        >
          {busy || status.refreshing ? t('ai_catalog_updating') : t('ai_catalog_update')}
        </button>
      </div>
    </div>
  );
}
