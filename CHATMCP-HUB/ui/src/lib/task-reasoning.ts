// Which connection the thinking-effort chip of the composer asks the Hub about, and the level that connection holds. The chip is for one task: a new conversation is served by
// the global connection or by the model profile chosen beside the chip, an existing one by the profile it began with.
import type { AiProfile, HubState, Task } from '../types/index.ts';

export interface TaskConnection {
  /** The preset of the global connection; a model profile has none. */
  preset?: string;
  protocol?: string;
  apiBaseUrl: string;
  model: string;
  /** What is in force when the person chooses nothing: the level of the conversation, else the one saved with the connection ('auto' or a level). */
  saved: string;
}

const AUTO = 'auto';

/**
 * @param profileId a new conversation's choice: '' for the default profile (or the global connection when there is none), '__global__' for the global connection outright, or a profile id
 * @param task the conversation, when there is one: it is served by the profile it began with, and its own level (when it has one) is what is in force
 * @returns null when there is nothing to ask about (no connection, or a profile that no longer exists)
 */
export function taskConnection(hub: Pick<HubState, 'ai'> | undefined, profileId: string | undefined, task: Pick<Task, 'effectiveProfile' | 'reasoningEffort'> | null): TaskConnection | null {
  const ai = hub?.ai;
  if (!ai) return null;
  const own = task?.reasoningEffort || null;
  const fromGlobal = (): TaskConnection | null => (ai.model && ai.apiBaseUrl && (ai.preset || ai.protocol)
    ? { preset: ai.preset, protocol: ai.protocol, apiBaseUrl: ai.apiBaseUrl, model: ai.model, saved: own ?? (ai.reasoningEffort || AUTO) } : null);
  const fromProfile = (profile: AiProfile): TaskConnection | null => (profile.model && profile.apiBaseUrl && profile.protocol
    ? { protocol: profile.protocol, apiBaseUrl: profile.apiBaseUrl, model: profile.model, saved: own ?? (profile.reasoningEffort || AUTO) } : null);
  const profiles = ai.profiles ?? [];
  if (task) {
    const kept = task.effectiveProfile;
    if (!kept) return fromGlobal();
    const profile = profiles.find((entry) => entry.id === kept.id);
    if (profile) return fromProfile(profile);
    // The profile was deleted since: what the Hub kept of it is enough to ask about its model.
    return kept.model && kept.endpointOrigin && kept.protocol ? { protocol: kept.protocol, apiBaseUrl: kept.endpointOrigin, model: kept.model, saved: own ?? AUTO } : null;
  }
  const id = profileId ?? '';
  if (id === '__global__') return fromGlobal();
  const chosen = id || ai.defaultProfileId || '';
  if (!chosen) return fromGlobal();
  const profile = profiles.find((entry) => entry.id === chosen);
  if (profile) return fromProfile(profile);
  return id ? null : fromGlobal();
}
