import { useTranslation } from '@/lib/i18n';
import { DynamicSubagents } from './DynamicSubagents';
import { ManualGroup } from './ManualGroup';
import { DelegationNotice } from './agent-parts';
import { TabBody } from './parts';
import { useDelegation } from './useDelegation';

/** Groups of read-only helpers: the AI plans one from a goal, or the owner builds one by hand. Nothing here edits a file or runs a command. */
export function AgentGroups() {
  const { t } = useTranslation();
  const delegation = useDelegation();
  return (
    <TabBody label={t('agents_view_groups')} testId="agent-groups">
      <DelegationNotice blocked={delegation.blocked} primary={delegation.primary} viewing={delegation.viewing} />
      {/* When the folder in view is not the one the helpers would read, each form switches itself off (but keeps its Stop button). */}
      <DynamicSubagents />
      <ManualGroup />
    </TabBody>
  );
}
