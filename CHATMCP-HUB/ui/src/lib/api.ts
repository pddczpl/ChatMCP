import { browseNativeWorkspace } from './native-folder-picker.ts';
import type { OutboundReview, HubState, HubHealth, Task, TaskDetail, ChatAttachment, WorkspaceCollection, BackgroundRun, BackgroundWorkflow, TreeEntry, FileData, GitStatus, Checkpoint, GitReview, TerminalState, Plan, MarketplacePlugin, ProviderPreset, ModelInfo, AccountModel, CatalogModels, CatalogStatus } from '@/types';
import { normalizeTask } from './task-view.ts';
import { getHubSecret, hubSessionReady, reportHubSessionLost } from './session.ts';

export interface BackendCapabilityReport {
  backend: string;
  available: boolean;
  osIsolated: boolean;
  platform: string;
  networkPolicy: string;
  writeScope: string;
  concurrency: number;
  enforcedLimits: string[];
  unsupportedLimits: string[];
  reasons: string[];
  observedAt: string;
}

export interface SandboxStatus {
  mode: string;
  backend: string;
  available: boolean;
  osIsolated: boolean;
  platform: string;
  workspaceRoot: string;
  networkPolicy?: string;
  writeScope?: string;
  concurrency?: number;
  limits: {
    timeoutSeconds: number;
    maxMemoryMb?: number | null;
    maxCpuCores?: number | null;
    maxOutputBytes: number;
  };
  enforcedLimits: string[];
  unsupportedLimits: string[];
  reasons: string[];
  observedAt: string;
  capabilities?: BackendCapabilityReport;
  backends?: BackendCapabilityReport[];
}

const UI_BUILD = '3.9.0-react-agent';
let currentCsrfToken = '';

export function setCsrfToken(token: string) {
  currentCsrfToken = token;
}

export async function request<T>(route: string, options: RequestInit = {}): Promise<T> {
  const method = options.method || 'GET';
  await hubSessionReady;
  const headers: Record<string, string> = {
    'X-ChatMCP-Request': 'local-dashboard',
    'X-ChatMCP-UI-Build': UI_BUILD,
    ...(options.headers as Record<string, string>),
  };
  // The Hub's per-launch secret (see session.ts); every API route, reads included, requires it.
  const secret = getHubSecret();
  if (secret) headers.Authorization = `Bearer ${secret}`;

  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    if (currentCsrfToken) {
      headers['X-ChatMCP-CSRF'] = currentCsrfToken;
    }
  }

  const res = await fetch(route, {
    ...options,
    headers,
    cache: 'no-store',
    credentials: 'same-origin',
  });

  let data;
  try { data = await res.json(); }
  catch {
    if (res.ok) throw new Error(`Phản hồi JSON không hợp lệ tại ${route}`);
    data = null;
  }

  if (res.status === 401 && data?.code === 'hub_auth_required') {
    // The Hub restarted (new secret) or this tab never had one. A reload cannot fix that: show the "reopen ChatMCP" screen.
    reportHubSessionLost();
    const err = new Error(data?.error || 'Cần mở lại DatGold từ launcher.') as Error & { status: number; code?: string };
    err.status = 401;
    err.code = 'hub_auth_required';
    throw err;
  }

  if (res.status === 401 && data?.code === 'login_required') {
    window.location.reload();
    throw new Error('Phiên đăng nhập đã hết. Đang mở lại trang đăng nhập…');
  }

  if (!res.ok) {
    const errorMsg = data?.error || `Lỗi HTTP ${res.status} tại ${route}`;
    const err = new Error(errorMsg) as Error & { status: number; code?: string };
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }

  if (data?.csrfToken) {
    setCsrfToken(data.csrfToken);
  }

  return data as T;
}

export const api = {
  request,
  getHealth: () => request<HubHealth>('/api/health'),
  getState: () => request<HubState>('/api/state').then((st) => {
    if (st.csrfToken) setCsrfToken(st.csrfToken);
    return { ...st, tasks: (st.agent?.tasks ?? []).map(normalizeTask) };
  }),
  getCapabilities: () => request<any>('/api/capabilities'),
  getSandboxStatus: () => request<SandboxStatus>('/api/sandbox/status'),

  probeIntelligenceEngines: () => request<any>('/api/studio/intelligence/engines/probe', {method:'POST',body:'{}'}),
  
  // Tasks
  getTask: (id: string): Promise<Task> => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`).then(normalizeTask),
  startTask: (prompt: string, attachments: ChatAttachment[] = [], baseRef: string | null = null,
    dependsOn: string[] = [], workspacePath: string | null = null,
    profileId: string | null = null, roleProfiles: Record<string,string> = {}) =>
    request<{ task: TaskDetail }>('/api/tasks/start', { method: 'POST',
      body: JSON.stringify({ prompt, attachments, baseRef, dependsOn, workspacePath, profileId, roleProfiles }) })
      .then((r) => ({ task: normalizeTask(r.task) })),
  continueTask: (id: string, prompt: string, attachments: ChatAttachment[] = []) =>
    request<{ task: TaskDetail }>('/api/tasks/continue', { method: 'POST', body: JSON.stringify({ id, prompt, attachments }) }).then((r) => ({ task: normalizeTask(r.task) })),
  acceptCriterion: (payload:{id:string;objectiveId:string;criterionIndex:number;receiptId:string;confirmed:true}) =>
    request<{task:TaskDetail}>('/api/tasks/accept-criterion',{
      method:'POST',body:JSON.stringify(payload)
    }).then(r=>({task:normalizeTask(r.task)})),
  cancelTask: (id: string) => request<{ task: TaskDetail }>('/api/tasks/cancel', { method: 'POST', body: JSON.stringify({ id }) }).then((r) => ({ task: normalizeTask(r.task) })),
  deleteTask: (id: string) => request<{ ok: boolean; deletedId: string; deletedIds?: string[]; preservedWorktrees?: string[] }>('/api/tasks/delete', { method: 'POST', body: JSON.stringify({ id }) }),
  setAutoResume: (id: string, enabled: boolean) => request<{ task: TaskDetail }>('/api/tasks/auto-resume', { method: 'POST', body: JSON.stringify({ id, enabled }) }),
  
  // Workspace
  selectWorkspace: (path: string) => request<HubState>('/api/workspace/select', { method: 'POST', body: JSON.stringify({ path }) }),
  browseWorkspace: async (initialPath?: string | null) => {
    // Desktop-native dialog runs in the WinForms UI process. The Hub's
    // PowerShell dialog remains a fallback ONLY for ordinary web browsers.
    const native=await browseNativeWorkspace(initialPath);
    if(native!==null)return native;
    return request<{path?:string}>('/api/workspace/browse',{
      method:'POST',body:JSON.stringify({initialPath:initialPath||null}),
    });
  },
  getWorkspaces: () => request<WorkspaceCollection>('/api/workspaces'),
  addWorkspace: (folder: string) => request<{workspace:{path:string;name:string};workspaces:WorkspaceCollection}>('/api/workspaces/add',{
    method:'POST',body:JSON.stringify({path:folder})}),
  activateWorkspace: (folder: string) => request<WorkspaceCollection>('/api/workspaces/activate',{
    method:'POST',body:JSON.stringify({path:folder})}),
  removeWorkspace: (folder: string) => request<WorkspaceCollection>('/api/workspaces/remove',{
    method:'POST',body:JSON.stringify({path:folder})}),
  getBackgroundRuns: () => request<{tasks:BackgroundRun[];workflows:BackgroundWorkflow[]}>('/api/background-tasks'),
  cancelWorkflow: (id:string) => request<{workflow:BackgroundWorkflow}>('/api/workflows/cancel',{
    method:'POST',body:JSON.stringify({id}),
  }),
  
  // Permissions & Approvals
  // `leaveFullAccess: true` with a mode: the Hub lowers Full Access to host-review in the same call if it is on (a page that decided from its own
  // copy of the state could be a few seconds behind the Hub); it never touches sandbox-only or host-review.
  configurePermissions: (payload: { mode?: string; executionPolicy?: string; confirmation?: string; leaveFullAccess?: boolean }) =>
    request<any>('/api/studio/permissions/config', { method: 'POST', body: JSON.stringify(payload) }),
  decidePermission: (id: string, approved: boolean) =>
    request<any>('/api/studio/permissions/decide', { method: 'POST', body: JSON.stringify({ id, approved }) }),
    
  // Files
  getTree: (directory = '', limit = 350) =>
    request<{ directory: string; entries: TreeEntry[] }>(`/api/studio/tree?directory=${encodeURIComponent(directory)}&limit=${limit}`),
  getFile: (file: string, maxBytes = 230000) =>
    request<FileData>(`/api/studio/file?file=${encodeURIComponent(file)}&maxBytes=${maxBytes}`),
  saveFile: (file: string, content: string, expectedSha?: string) =>
    request<any>('/api/studio/file/save', { method: 'POST', body: JSON.stringify({ file, content, expectedSha }) }),
  searchCode: (query: string, mode = 'text', limit = 90) =>
    request<{ matches: any[] }>(`/api/studio/search?query=${encodeURIComponent(query)}&mode=${mode}&limit=${limit}`),
    
  // Git & Review
  getGitStatus: () => request<GitStatus>('/api/studio/git/status'),
  getGitRefs: (workspacePath: string = '') => request<{branches:{ref:string;name:string}[];worktrees:{path:string;branch:string|null;head:string|null}[];currentBranch:string|null}>(
    '/api/studio/git/refs' + (workspacePath ? '?workspacePath='+encodeURIComponent(workspacePath) : '')),
  getGitDiff: (staged = false) => request<{ diff: string; staged?: boolean; truncated?: boolean }>(`/api/studio/git/diff?staged=${staged}`),
  createCheckpoint: (label: string) => request<Checkpoint>('/api/studio/checkpoint', { method: 'POST', body: JSON.stringify({ label }) }),
  getCheckpoints: () => request<Checkpoint[]>('/api/studio/checkpoints'),
  getReview: (checkpointId: string) => request<GitReview>(`/api/studio/review?checkpointId=${encodeURIComponent(checkpointId)}`),
  restoreFile: (checkpointId: string, file: string, expectedSha: string) =>
    request<any>('/api/studio/restore', { method: 'POST', body: JSON.stringify({ checkpointId, file, expectedSha }) }),
  acceptFile: (checkpointId: string, file: string, expectedSha: string) =>
    request<any>('/api/studio/accept', { method: 'POST', body: JSON.stringify({ checkpointId, file, expectedSha }) }),

  // Terminal
  getTerminals: () => request<TerminalState[]>('/api/studio/terminal'),
  startTerminal: (command: string, sandbox = false, interactive = false) =>
    request<TerminalState>('/api/studio/terminal/start', { method: 'POST', body: JSON.stringify({ command, sandbox, interactive, timeoutMinutes: 15 }) }),
  stopTerminal: (id: string) => request<any>('/api/studio/terminal/stop', { method: 'POST', body: JSON.stringify({ id }) }),
  sendTerminalInput: (id: string, text: string) => request<any>('/api/studio/terminal/input', { method: 'POST', body: JSON.stringify({ id, text }) }),
  getChecks: () => request<{ suggested: { from: string; command: string }[] }>('/api/studio/checks'),
  getVerifications: (taskId = '') => request<{ runs: any[]; total: number }>(`/api/studio/verifications?taskId=${encodeURIComponent(taskId)}`),
  runVerify: (command: string, taskId = '') => request<any>('/api/studio/verify/run', { method: 'POST', body: JSON.stringify({ command, taskId }) }),

  // Plan
  getPlan: (taskId: string) => request<Plan>(`/api/studio/plan?taskId=${encodeURIComponent(taskId)}`),
  savePlan: (taskId: string, title: string, items: any[]) =>
    request<Plan>('/api/studio/plan/set', { method: 'POST', body: JSON.stringify({ taskId, title, items }) }),

  // Bounded multi-agent orchestration (read-only workers)
  orchestrateAgents: (nodes: {id:string;role:string;question:string;dependsOn?:string[]}[],maxConcurrency=3) =>
    request<any>('/api/studio/delegates/orchestrate',{method:'POST',body:JSON.stringify({nodes,maxConcurrency})}),
  getOrchestrator: () => request<any>('/api/studio/delegates'),
  getDynamicDelegates: () => request<{activeRunId:string|null;last:any}>('/api/studio/dynamic-delegates'),
  runDynamicDelegates: (goal:string) => request<any>('/api/studio/dynamic-delegates/run',{
    method:'POST',body:JSON.stringify({goal,confirmation:'AUTHORIZE READONLY DELEGATION'}),
  }),
  cancelDynamicDelegates: () => request<any>('/api/studio/dynamic-delegates/cancel',{method:'POST',body:'{}'}),
  getCodingRuns: () => request<any>('/api/studio/coding'),
  getCodingContext: (runId:string,workerId:string) => request<any>(`/api/studio/coding/context?runId=${encodeURIComponent(runId)}&workerId=${encodeURIComponent(workerId)}`),
  getCodingRecovery: (runId:string) => request<any>(`/api/studio/coding/recovery?runId=${encodeURIComponent(runId)}`),
  acknowledgeCodingRecovery: (runId:string,expectedDigest:string) => request<any>('/api/studio/coding/recovery/acknowledge',{method:'POST',body:JSON.stringify({runId,expectedDigest,confirmation:'REVIEW INTERRUPTED RUN'})}),
  planCodingAgents: (prompt:string,modelAssist=false) => request<any>('/api/studio/coding/plan',{method:'POST',body:JSON.stringify({prompt,modelAssist})}),
  runCodingAgents: (tasks:{id:string;prompt:string;verify?:boolean;dependsOn?:string[]}[],maxConcurrency=2) => request<any>('/api/studio/coding/run',{method:'POST',body:JSON.stringify({tasks,maxConcurrency,confirmation:'CREATE WORKTREES'})}),
  cancelCodingAgents: () => request<any>('/api/studio/coding/cancel',{method:'POST',body:'{}'}),
  getWorkerChecks: (workerId:string) => request<{workerId:string;checks:any[]}>(`/api/studio/coding/checks?workerId=${encodeURIComponent(workerId)}`),
  approveIsolatedCheck: (workerId:string,checkId:string,maxAttempts=3) => request<any>('/api/studio/coding/check-grant',{method:'POST',body:JSON.stringify({workerId,checkId,maxAttempts,confirmation:'AUTHORIZE ISOLATED CHECK'})}),
  getCodingDiff: (runId:string,workerId?:string) => request<any>(`/api/studio/coding/review?runId=${encodeURIComponent(runId)}&workerId=${encodeURIComponent(workerId||'')}`),
  integrateCodingAgents: (runId:string,workerIds:string[],reviewTokens:Record<string,string>) => request<any>('/api/studio/coding/integrate',{method:'POST',body:JSON.stringify({runId,workerIds,reviewTokens,confirmation:'INTEGRATE WORKTREES'})}),
  publishCodingAgents: (runId:string,reviewToken:string,workerId?:string) => request<any>('/api/studio/coding/publish',{method:'POST',body:JSON.stringify({runId,workerId:workerId??null,reviewToken,confirmation:'PUBLISH DRAFT PR'})}),
  cancelOrchestrator: () => request<any>('/api/studio/delegates/cancel',{method:'POST',body:'{}'}),

  // GitHub skills registry
  getSkillRegistry: (query='') => request<{sources:any[];skills:any[];updates:any[]}>(`/api/plugins/registry?query=${encodeURIComponent(query)}`),
  refreshSkillRegistry: (sourceId?:string) => request<any>('/api/plugins/registry/refresh',{method:'POST',body:JSON.stringify({sourceId})}),
  installRegistrySkill: (key:string,update=false) => request<any>('/api/plugins/registry/install',{method:'POST',body:JSON.stringify({key,update})}),
  addRegistrySource: (id:string,repo:string,prefix:string) => request<any>('/api/plugins/registry/source/add',{method:'POST',body:JSON.stringify({id,repo,prefix,confirmation:'TRUST GITHUB SOURCE'})}),
  removeRegistrySource: (sourceId:string) => request<any>('/api/plugins/registry/source/remove',{method:'POST',body:JSON.stringify({sourceId,confirmation:'REMOVE GITHUB SOURCE'})}),

  // Skills & Plugins
  getInstalledPlugins: () => request<{ plugins: any[] }>('/api/plugins/installed'),
  getSkills: () => request<{ skills: any[] }>('/api/studio/skills'),
  getMarketplace: (category = '', query = '') =>
    request<{ catalog: MarketplacePlugin[] }>(`/api/plugins/marketplace?category=${encodeURIComponent(category)}&query=${encodeURIComponent(query)}`),
  installPlugin: (id: string) => request<any>('/api/plugins/install', { method: 'POST', body: JSON.stringify({ id }) }),
  uninstallPlugin: (id: string) => request<any>('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) }),
  togglePlugin: (id: string, enabled: boolean) => request<any>('/api/plugins/toggle', { method: 'POST', body: JSON.stringify({ id, enabled }) }),

  // AI & Profiles
  getPresets: () => request<{ presets: ProviderPreset[]; envKeys: string[] }>('/api/ai/presets'),
  // The models the provider says the saved key can use (asks the provider, with the saved key); the Hub's own list of a provider's models (a file read) is getCatalogModels.
  getModels: () => request<{ models: AccountModel[]; source?: string; warning?: string }>('/api/ai/models'),
  getCatalogModels: (query: { preset?: string; apiBaseUrl?: string; limit?: number }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, String(value));
    return request<CatalogModels>(`/api/ai/catalog/models?${params.toString()}`);
  },
  // Which list of models the Hub knows and how old it is; and the one request the Hub makes for a newer one, only because the owner pressed the button (to models.dev, nothing of theirs in it).
  getCatalog: () => request<CatalogStatus>('/api/ai/catalog'),
  refreshCatalog: () => request<CatalogStatus>('/api/ai/catalog/refresh', { method: 'POST', body: '{}' }),
  getModelInfo: (query: { preset?: string; protocol?: string; apiBaseUrl?: string; model: string }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
    return request<ModelInfo>(`/api/ai/model-info?${params.toString()}`);
  },
  getProfiles: () => request<{ profiles: any[]; defaultProfileId?: string }>('/api/ai/profiles'),
  upsertProfile: (profile: any) => request<any>('/api/ai/profiles/upsert', { method: 'POST', body: JSON.stringify(profile) }),
  deleteProfile: (id: string) => request<any>('/api/ai/profiles/delete', { method: 'POST', body: JSON.stringify({ id }) }),
  setDefaultProfile: (id: string) => request<any>('/api/ai/profiles/default', { method: 'POST', body: JSON.stringify({ id }) }),
  testAi: () => request<any>('/api/ai/test', { method: 'POST', body: JSON.stringify({ strictProtocol: true }) }),
  saveAiConfig: (config: any) => request<any>('/api/ai/config', { method: 'POST', body: JSON.stringify(config) }),
  clearAiKey: () => request<any>('/api/ai/clear-key', { method: 'POST' }),
  setAgentMode: (mode: 'api'|'chatgpt-web') => request<any>('/api/agent/mode', { method: 'POST', body: JSON.stringify({ mode }) }),
  // The owner's switch for the project's AGENTS.md / CLAUDE.md. Applies from the next run; the Hub refuses (409) while CHATMCP_PROJECT_INSTRUCTIONS decides.
  setProjectInstructions: (enabled: boolean) => request<HubState>('/api/agent/project-instructions', { method: 'POST', body: JSON.stringify({ enabled }) }),
  createBrowserPairCode: () => request<{code:string;expiresAt:string}>('/api/browser/pair-code',{method:'POST'}),
  unpairBrowser: () => request<any>('/api/browser/unpair',{method:'POST'}),
  // ChatGPT Web privacy: "review before send" (global or for one workspace) and the decision about a held tool result.
  configureBrowserPrivacy: (payload:{reviewBeforeSend?:boolean;workspacePath?:string;workspaceReview?:boolean|null}) =>
    request<HubState>('/api/browser/privacy/config',{method:'POST',body:JSON.stringify(payload)}),
  decideOutboundReview: (id:string,action:'approve'|'redact_more'|'withhold',redact:string[]=[]) =>
    request<{ok:boolean;matched?:number;review?:OutboundReview|null}>('/api/browser/outbound/decide',{method:'POST',body:JSON.stringify({id,action,redact})}),
  recoverBrowserChatUrl: (id:string) => request<{ok:boolean;pending?:boolean;alreadyBound?:boolean;chatUrl?:string}>('/api/browser/recover-url/request',{method:'POST',body:JSON.stringify({id})}),

  // Intelligence
  getIntelligenceStatus: () => request<{ engineHealth?: {checkedAt: string | null; engines: {id: string; status: string; source?: string; version?: string | null; detail?: string}[]} }>('/api/studio/intelligence/status'),
  buildIntelligenceIndex: (force = false) => request<any>('/api/studio/intelligence/index', { method: 'POST', body: JSON.stringify({ force }) }),
  searchSymbols: (query: string) => request<{ matches: any[] }>(`/api/studio/intelligence/symbols?query=${encodeURIComponent(query)}&limit=120`),
  findReferences: (symbol: string) => request<{ matches: any[] }>(`/api/studio/intelligence/references?symbol=${encodeURIComponent(symbol)}`),
  startLsp: (language: string) => request<any>('/api/studio/intelligence/lsp/start', { method: 'POST', body: JSON.stringify({ language }) }),

  // Preview
  getPreview: (port: string, pathname = '/') => request<any>(`/api/studio/preview?port=${encodeURIComponent(port)}&pathname=${encodeURIComponent(pathname)}`),

  // Services
  startServices: () => request<any>('/api/services/start', { method: 'POST' }),
  stopServices: () => request<any>('/api/services/stop', { method: 'POST' }),
  
  // Public Auth
  logout: () => request<any>('/api/auth/logout', { method: 'POST' }),

  // Convenience Aliases for UI Components
  createTask: (opts: { task: string }) => api.startTask(opts.task),
  sendMessage: (id: string, text: string) => api.continueTask(id, text),
  setPermissions: (payload: { mode?: string; executionPolicy?: string; confirmation?: string; leaveFullAccess?: boolean }) =>
    api.configurePermissions(payload),
  approveAction: (id: string) => api.decidePermission(id, true),
  denyAction: (id: string, reason?: string) => api.decidePermission(id, false),
  testConnection: (opts?: any) => api.testAi(),
  updateAiConfig: (config: any) => api.saveAiConfig(config),
  revertCheckpoint: (id: string, expectedShas?: Record<string, string | null>) =>
    request<{ ok: boolean; checkpointId: string; restoredCount: number; files: string[]; undoCheckpointId?: string; warnings?: string[] }>(
      '/api/studio/restore-checkpoint',
      { method: 'POST', body: JSON.stringify({ checkpointId: id, expectedShas }) }
    ),
  previewCheckpoint: (id: string) =>
    request<{
      ok: boolean;
      checkpointId: string;
      dryRun: boolean;
      partial?: boolean;
      limitations?: string[];
      totalFiles: number;
      modifiedFilesCount: number;
      files: { path: string; baselineSha: string; currentSha: string | null; status: string; willOverwriteNewer: boolean }[];
    }>('/api/studio/preview-checkpoint?checkpointId=' + encodeURIComponent(id)),
};
