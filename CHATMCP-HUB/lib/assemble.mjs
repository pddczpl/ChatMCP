// Builds the workspace-facing services of the Hub and attaches them to the manager.
//
// Everything here is local and cheap to create; nothing starts a process or touches the network. The Hub
// (hub.mjs) and the tests share this function so that what is tested is what runs.
import path from 'node:path';
import { StudioWorkspace } from './studio-workspace.mjs';
import { StudioTerminal } from './studio-terminal.mjs';
import { PermissionGate } from './permissions.mjs';
import { StudioTools } from './studio-tools.mjs';
import { StudioWorkflow } from './studio-workflow.mjs';
import { StudioVerification } from './studio-verification.mjs';
import { CodeIntelligence } from './studio-intelligence.mjs';
import { previewStatus } from './studio-preview.mjs';
import { LocalTools } from './local-tools.mjs';

export function assembleStudio(manager, { bundleRoot }) {
  const studioDirectory = path.join(manager.hubDirectory, 'studio');
  manager.studio = new StudioWorkspace({ manager, directory: studioDirectory });
  manager.workflow = new StudioWorkflow({ directory: path.join(studioDirectory, 'workflows') });
  manager.intelligence = new CodeIntelligence({ workspace: manager.studio, directory: path.join(studioDirectory, 'index'), bundleRoot });
  manager.preview = previewStatus;
  manager.terminal = new StudioTerminal({ workspace: manager.studio });
  manager.verification = new StudioVerification({ workspace: manager.studio, terminal: manager.terminal, directory: path.join(studioDirectory, 'verifications'), secrets: () => manager.secrets || [] });
  manager.permissions = new PermissionGate({ manager, workspace: manager.studio, directory: studioDirectory });
  manager.verification.permissions = manager.permissions;
  manager.studioTools = new StudioTools({ workspace: manager.studio, gate: manager.permissions, intelligence: manager.intelligence });
  manager.localTools = new LocalTools({ workspace: manager.studio, stateDirectory: path.join(manager.hubDirectory, 'local'), secrets: () => manager.secrets || [] });
  manager.permissions.attachLocalTools(manager.localTools);
  manager.permissions.onEvent = (event) => manager.log(`${event.type}: ${event.toolName ?? event.name ?? event.id ?? ''}`);
  return manager;
}
