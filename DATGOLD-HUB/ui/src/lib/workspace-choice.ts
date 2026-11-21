import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import type { HubState } from '@/types';

/**
 * Opens a folder that is already in the Hub's list of workspaces (a folder row of the sidebar, a row of the background panel), with one of its
 * conversations or none (''). The screen records the choice first and asks the Hub to activate the folder afterwards, so that whatever is sent
 * from the click on (a new conversation's first message, a follow-up) goes where the owner clicked. The Hub's activation only moves the default
 * folder of its list and writes the list to disk; a task names its own folder (POST /api/tasks/start, `workspacePath`), and any folder of the
 * list is accepted there, active or not.
 *
 * The screen used to record the choice only after the Hub's answer. In CI run 44813034061 (ubuntu) the Hub took 117 ms to answer, the e2e sent
 * its message 104 ms after the click, and the task started in the folder the screen still held: the old one.
 *
 * When the Hub refuses (the folder has left its list, or is gone from the disk), the screen goes back to the folder, conversation and base ref it
 * had, unless the owner has moved on since the click (another folder, or a conversation they started there), and the refusal is thrown for the
 * caller to show.
 */
export async function chooseWorkspace(folder: string, conversationId = ''): Promise<void> {
  const before = useAppStore.getState();
  const back = { folder: before.selectedWorkspacePath, conversationId: before.selectedTaskId, baseRef: before.selectedBaseRef };
  before.setSelectedWorkspacePath(folder);
  before.setSelectedTaskId(conversationId);
  try {
    await api.activateWorkspace(folder);
  } catch (error) {
    const now = useAppStore.getState();
    if (now.selectedWorkspacePath === folder && now.selectedTaskId === conversationId) {
      now.setSelectedWorkspacePath(back.folder);
      now.setSelectedTaskId(back.conversationId);
      now.setSelectedBaseRef(back.baseRef);
    }
    throw error;
  }
}

/**
 * Adds a folder to the Hub's list, activates it and makes it the screen's choice; it gives back the Hub's entry for it (its canonical path).
 * The Hub's answer to the activation, its list as it is now, goes into the cached Hub state before the choice is recorded, and a poll of the
 * Hub state that started earlier is called off so that its older answer cannot land on top. The sidebar puts a choice that is not in the
 * cached list back to the cached active folder (the effect in SessionSidebar that keeps a removed folder from coming back), and the cache was
 * older than the folder: the folder just added was put back to the old one at once and stayed so, while the Hub had the new one active, and
 * the next task started in the old folder.
 */
export async function addAndChooseWorkspace(queryClient: QueryClient, folder: string): Promise<{ path: string; name: string }> {
  const added = await api.addWorkspace(folder);
  const list = await api.activateWorkspace(added.workspace.path);
  if (Array.isArray(list?.items)) {
    await queryClient.cancelQueries({ queryKey: ['hubState'] });
    queryClient.setQueryData<HubState>(['hubState'], (state) => (state ? { ...state, workspaces: list } : state));
  }
  useAppStore.getState().setSelectedWorkspacePath(added.workspace.path);
  return added.workspace;
}
