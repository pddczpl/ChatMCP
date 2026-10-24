import { hasTranslation, type Translate } from '@/lib/i18n';

/** The name of a read-only helper's role in the language on screen; a role the dictionary does not know is shown as the Hub wrote it. */
export const agentRoleLabel = (role: string, t: Translate): string => {
  const key = `agent_role_${role}`;
  return hasTranslation(key) ? t(key) : role;
};

/** What the Hub's status word means in the language on screen. No status reads as waiting; an unknown one is shown as written. */
export const agentStatusLabel = (status: string | undefined, t: Translate): string => {
  if (!status) return t('agent_status_queued');
  const key = `agent_status_${status}`;
  return hasTranslation(key) ? t(key) : status;
};

/**
 * What the state of a task (the Hub's task state machine, as lib/task-view.ts names it) says in the language on screen: the words of
 * taskStateLabel, from the dictionary, so that the Vietnamese is unchanged. No state reads as unknown; a state with no word is shown as written.
 */
export const taskStateText = (status: string | undefined, t: Translate): string => {
  if (!status) return t('agents_bg_no_state');
  const key = `agents_bg_state_${status}`;
  return hasTranslation(key) ? t(key) : status;
};
