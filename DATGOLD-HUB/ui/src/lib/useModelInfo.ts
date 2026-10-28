import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { modelInfoKey } from '@/lib/reasoning-effort';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

interface Target {
  /** The connection preset (anthropic, openai, custom-openai ...) when there is one; a model profile has none. */
  preset?: string;
  protocol?: string;
  apiBaseUrl: string;
  model: string;
}

/** A model id the Hub takes (it answers 400 to any other): starts with a letter or a digit, then letters, digits and . _ : / -, at most 151 characters. */
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/;

/** No address, or an http(s) address the Hub can read: half an address ("htt", "https://") is not one yet. */
function addressFits(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * What the Hub knows about the model typed in a form (GET /api/ai/model-info). Every part of a form that wants it (the thinking-effort field, the note under the context window, the line under the
 * model) calls this with the same target, so React Query makes one request for them all. The question is settled before it is asked, 400 ms after the typing stops: a provider card, an address and a
 * model that change one after the other are one question, and half an address or a model id the Hub would refuse is none (no request, no 400). While the answer for the next model comes, what was
 * known of the previous one stays on the page, so that the notes do not flash "unknown" between two answers.
 */
export function useModelInfo({ preset, protocol, apiBaseUrl, model }: Target) {
  const settled = useDebouncedValue(JSON.stringify([preset ?? '', protocol ?? '', apiBaseUrl.trim(), model.trim()]), 400);
  const [askedPreset, askedProtocol, askedAddress, askedModel] = JSON.parse(settled) as [string, string, string, string];
  const answerable = MODEL_ID.test(askedModel) && Boolean(askedPreset || askedProtocol) && addressFits(askedAddress);
  return useQuery({
    queryKey: modelInfoKey(askedPreset || undefined, askedProtocol || undefined, askedAddress, askedModel),
    queryFn: () => api.getModelInfo({ preset: askedPreset || undefined, protocol: askedProtocol || undefined, apiBaseUrl: askedAddress, model: askedModel }),
    enabled: answerable,
    placeholderData: answerable ? keepPreviousData : undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
