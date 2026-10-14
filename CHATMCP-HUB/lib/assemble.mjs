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
import { GitRunner } from './git-runner.mjs';
import { ShellRunner } from './shell-runner.mjs';
import { PluginManager } from './plugins.mjs';
import { createDefaultExecutionRegistry } from './execution-contract.mjs';
import { SandboxEngine } from './sandbox-engine.mjs';
import { WindowsSandboxBackend } from './windows-sandbox-backend.mjs';
import { WindowsSandboxPublisher } from './windows-sandbox-publisher.mjs';
import { LazyWindowsSandboxDriver } from './windows-sandbox-driver.mjs';
import { probeWindowsSandboxPreflight } from './windows-sandbox-probe.mjs';
import { ExecutionSnapshotStore } from './execution-snapshot-store.mjs';
import { BLACKBOX_KIND } from './native-blackbox-contract.mjs';
import { SEALED_PROTOCOL } from './windows-sandbox-sealed-receipt.mjs';

/**
 * @param {object} options
 * @param {string} options.bundleRoot
 * @param {object} [options.exec]  how programs are run for the agent (lib/exec-mode.mjs). Absent: the local Hub's own behavior, unchanged.
 */
export function assembleStudio(manager, { bundleRoot, exec = null }) {
  const studioDirectory = path.join(manager.hubDirectory, 'studio');
  const localDirectory = path.join(manager.hubDirectory, 'local');
  if (!manager.pluginManager) {
    const hubStateDir = manager.stateDirectory ?? manager.stateDir ?? manager.hubDirectory;
    manager.pluginManager = new PluginManager({ stateDir: hubStateDir });
    manager.pluginManager.load().catch(() => {});
  }
  const secrets = () => manager.secrets || [];
  // Options for every GitRunner of the Hub. With a spawner, Git runs under the agent's account, in a repository that account owns.
  const gitOptions = exec ? {
    ...(exec.spawn ? { spawner: exec.spawn, env: exec.env } : {}),
    ...(exec.hooksDirectory ? { hooksDirectory: exec.hooksDirectory } : {}),
    safeDirectory: Boolean(exec.safeDirectory),
  } : {};
  manager.studio = new StudioWorkspace({ manager, directory: studioDirectory, gitOptions });
  manager.workflow = new StudioWorkflow({ directory: path.join(studioDirectory, 'workflows') });
  manager.intelligence = new CodeIntelligence({ workspace: manager.studio, directory: path.join(studioDirectory, 'index'), bundleRoot });
  manager.preview = previewStatus;
  manager.terminal = new StudioTerminal({
    workspace: manager.studio,
    ...(exec ? { spawner: exec.spawn, childEnv: exec.terminalEnv, restrict: exec.terminal } : {}),
  });
  manager.verification = new StudioVerification({ workspace: manager.studio, terminal: manager.terminal, directory: path.join(studioDirectory, 'verifications'), secrets });
  manager.permissions = new PermissionGate({ manager, workspace: manager.studio, directory: studioDirectory });
  manager.verification.permissions = manager.permissions;
  manager.studioTools = new StudioTools({ workspace: manager.studio, gate: manager.permissions, intelligence: manager.intelligence });
  const localOptions = { workspace: manager.studio, stateDirectory: localDirectory, secrets, studioIntelligence: manager.intelligence };
  if (exec) {
    localOptions.shell = new ShellRunner({
      workspace: manager.studio, stateDirectory: localDirectory, secrets,
      ...(exec.spawn ? { spawner: exec.spawn, env: exec.env, bashTransport: 'argv' } : {}),
      maxCommandChars: exec.maxCommandChars, maxTimeoutMs: exec.maxTimeoutMs,
    });
    localOptions.git = new GitRunner({ workspace: manager.studio, hooksDirectory: gitOptions.hooksDirectory ?? path.join(localDirectory, 'no-hooks'), secrets, ...gitOptions });
    localOptions.disabledTools = exec.disabledTools;
    localOptions.sharedWorkspace = exec.sharedWorkspace;
  }
  manager.localTools = new LocalTools(localOptions);
  manager.permissions.attachLocalTools(manager.localTools);
  manager.permissions.onEvent = (event) => manager.log(`${event.type}: ${event.toolName ?? event.name ?? event.id ?? ''}`);
  const effectiveShell = localOptions.shell || manager.localTools?.shell || new ShellRunner({ workspace: manager.studio, stateDirectory: localDirectory, secrets });
  manager.executionRegistry = createDefaultExecutionRegistry({
    workspaceRoot: manager.studio?.root || manager.hubDirectory,
    workspace: manager.studio,
    shellRunner: effectiveShell,
    permissionGate: manager.permissions,
  });
  manager.executionSnapshots ??= new ExecutionSnapshotStore({
    directory:path.join(manager.hubDirectory,'execution-snapshots'),
  });
  // Independent native acceptance approves only the declarative public-case
  // grader over SYSTEM-sealed publication. Legacy Node tests stay unverified;
  // host readiness, immutable grants and confirmed guest cleanup remain required.
  const sandboxState=path.join(manager.hubDirectory,'sandbox-execution');
  const driver=process.platform==='win32'
    ? new LazyWindowsSandboxDriver({
        preflight:probeWindowsSandboxPreflight,
        runtimeDirectory:path.join(bundleRoot,'runtimes','windows-sandbox'),
        // Installer layout: runtime is a sibling of CHATMCP-HUB, not inside it.
        nodeToolchainDirectory:path.resolve(bundleRoot,'..','runtimes','node'),
        stateDirectory:path.join(sandboxState,'driver'),
        publicationProtocol:SEALED_PROTOCOL,
      })
    : null;
  manager.executionRegistry.register(new WindowsSandboxBackend({
    stateDirectory:sandboxState,driver,
    publisher:new WindowsSandboxPublisher({hostAttested:false,attestedCheckKinds:[BLACKBOX_KIND]}),
    snapshotLookup:(id)=>manager.executionSnapshots.lookup(id),
  }));
  manager.permissions.attachExecutionRegistry(manager.executionRegistry);
  manager.sandboxEngine = new SandboxEngine({
    workspaceRoot: manager.studio?.root || manager.hubDirectory,
    workspace: manager.studio,
    shellRunner: effectiveShell,
    registry: manager.executionRegistry,
    permissionGate: manager.permissions,
  });
  return manager;
}
