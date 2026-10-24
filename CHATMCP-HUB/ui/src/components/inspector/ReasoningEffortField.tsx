import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { hasTranslation, useTranslation } from '@/lib/i18n';
import { modelInfoKey, reasoningChoices, reasoningHint, reasoningLabelKey } from '@/lib/reasoning-effort';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

interface Props {
  id: string;
  /** The connection preset (anthropic, openai, custom-openai ...) when there is one; a model profile has none. */
  preset?: string;
  protocol?: string;
  apiBaseUrl: string;
  model: string;
  /** 'auto' or a level. */
  value: string;
  onChange: (value: string) => void;
  /** The Hub says the provider refused the saved level. */
  refused?: boolean;
  disabled?: boolean;
}

/**
 * "Thinking effort" of a model connection: Auto, or one of the levels the Hub says this model takes on this protocol (the Hub answers from its model catalog, GET /api/ai/model-info).
 * Used by the AI connection and by the model profiles.
 */
export function ReasoningEffortField({ id, preset, protocol, apiBaseUrl, model, value, onChange, refused = false, disabled = false }: Props) {
  const { t } = useTranslation();
  const asked = useDebouncedValue(model.trim(), 400);
  const { data: info } = useQuery({
    queryKey: modelInfoKey(preset, protocol, apiBaseUrl, asked),
    queryFn: () => api.getModelInfo({ preset, protocol, apiBaseUrl, model: asked }),
    enabled: asked !== '' && Boolean(preset || protocol),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const choices = reasoningChoices(info, value);
  const hint = reasoningHint(info, value, refused);
  const name = (key: string) => (hasTranslation(key) ? t(key) : key);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-[12px] font-semibold text-muted block">{t('ai_reasoning_label')}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full bg-surface text-fg text-xs rounded-md px-3 py-1.5 border border-line focus:outline-none focus:border-primary"
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.offered ? name(reasoningLabelKey(choice.value)) : t('ai_reasoning_not_offered', { level: name(reasoningLabelKey(choice.value)) })}
          </option>
        ))}
      </select>
      {hint && (
        <p data-testid="reasoning-hint" className={`text-[12px] ${hint.tone === 'warning' ? 'text-warning' : 'text-faint'}`}>
          {hasTranslation(hint.key) ? t(hint.key, hint.params) : hint.key}
        </p>
      )}
    </div>
  );
}
