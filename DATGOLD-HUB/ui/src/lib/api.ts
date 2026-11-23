import { browseNativeWorkspace } from './native-folder-picker.ts';
import type { OutboundReview, HubState, HubHealth, Task, TaskDetail, ChatAttachment, WorkspaceCollection, BackgroundRun, BackgroundWorkflow, TreeEntry, FileData, GitStatus, Checkpoint, GitReview, TaskReviewAnswer, TerminalState, Plan, MarketplacePlugin, ProviderPreset, ModelInfo, AccountModel, CatalogModels, CatalogStatus, UpdateInfo, UpdateCheckAnswer, UpdateDownloadAnswer, UpdateCancelAnswer } from '@/types';
import type { RestorePreview, RestoreResult, Shas } from './rollback.ts';
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

// ---- external MCP servers (GET /api/mcp/servers and the POST routes under /api/mcp/, lib/mcp/http-api.mjs of the Hub) ----------------------------
export type McpPolicyWord = 'ask' | 'allow' | 'deny';
export type McpConnectionState = 'idle' | 'connecting' | 'connected' | 'needs_review' | 'needs_launch_approval' | 'failed' | 'lost' | 'closed';
/** A value of an env or headers map as the Hub shows it: a plain value, or only that a secret is set (never the secret). */
export interface McpMapEntry { value?: string; secret: boolean }
export interface McpLaunchState { required: boolean; approved: boolean; fingerprint: string | null }
export interface McpListDiff { added: { kind: string; name: string }[]; removed: { kind: string; name: string }[]; changed: { kind: string; name: string; fields: string[] }[] }
export interface McpServerStatus {
  id: string; transport: 'stdio' | 'http'; state: McpConnectionState; enabled: boolean;
  review: { state: 'unpinned' | 'pinned' | 'needs_review'; fingerprint: string | null; reason?: string; diff?: McpListDiff | null } | null;
  launch: McpLaunchState | null; refused: { tools: number; prompts: number; resources: number };
  protocolVersion: string | null; server: { name: string; version: string } | null; tools: number | null; connectedAt: string | null; calls: number;
  lastError: { code: string; message: string } | null; retryAt: string | null;
}
export interface McpToolView { name: string; title?: string; description: string; annotations: Record<string, boolean>; rule: McpPolicyWord | null; policy: McpPolicyWord }
export interface McpServerView {
  id: string; transport: 'stdio' | 'http'; enabled: boolean; timeouts: { connectMs: number; callMs: number };
  policy: { default?: McpPolicyWord; tools?: Record<string, McpPolicyWord> }; trust: { annotations: boolean }; touchesWorkspace: boolean;
  env: Record<string, McpMapEntry>; command?: string; args?: string[]; cwd?: string; url?: string; headers?: Record<string, McpMapEntry>;
  status: McpServerStatus | null; tools: McpToolView[];
  toolReview: { state: 'unpinned' | 'pinned' | 'needs_review' | 'not_connected'; fingerprint: string | null; refused: { tools: number; prompts: number; resources: number } | null };
}
export interface McpServersAnswer {
  runtime: { state: string; version?: string; code?: string }; configLoaded: boolean; configError: { code: string; message: string } | null;
  closed: boolean; maxServers: number; servers: McpServerView[];
}
export interface McpLaunchRecord {
  required: boolean; approved: boolean; fingerprint: string | null;
  record: { version: number; transport: 'stdio'; command: string; args: string[]; cwd: string | null; envKeys: string[]; executable: string | null; sha256: string | null } | null;
}
export interface McpToolDefinition { name: string; title?: string; description: string; inputSchema?: unknown; annotations?: Record<string, unknown> }
export interface McpToolReview {
  state: 'unpinned' | 'pinned' | 'needs_review' | 'not_connected'; fingerprint: string | null; diff?: McpListDiff | null; reason?: string;
  tools: McpToolDefinition[]; prompts: { name: string; description?: string }[]; refused: { tools: number; prompts: number; resources: number } | null;
}
/** A value of an env or headers map as the page sends it: plain text, a secret to store protected, or "keep the secret already stored". */
export type McpMapInput = string | { value: string; secret: true } | { keep: true };
export interface McpServerInput {
  transport: 'stdio' | 'http'; command?: string; args?: string[]; cwd?: string; url?: string; headers?: Record<string, McpMapInput>; env: Record<string, McpMapInput>;
  enabled: boolean; trust: { annotations: boolean }; touchesWorkspace: boolean; timeouts?: { connectMs: number; callMs: number };
}
export interface McpTestAnswer { ok: boolean; error: { code: string; message: string } | null; status: McpServerStatus | null }

const UI_BUILD = '3.11.2-react-agent';

// ---- the plan of a task and the answer to it (POST /api/studio/plan/set and /api/studio/plan/decide, P9 ac-10) --------------------------------
export type PlanDecision = 'approve' | 'request_changes';
export type PlanExecution = 'review' | 'autonomous';
export interface PermissionDecisionExtras { feedback?: string; plan?: string; execution?: PlanExecution; revision?: number }
export interface PlanDecisionAnswer { ok: true; taskId: string; id: string; decision: PlanDecision; revision: number; execution: PlanExecution | null }
/** The fields of `value` that hold something: an optional field the caller did not give is not sent. */
const definedOnly = (value: object) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
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
  // `planMode` (docs/PLAN-MODE.md) is sent only when it is chosen: false would ask the Hub to leave plan mode, which only an approval of the plan does.
  startTask: (prompt: string, attachments: ChatAttachment[] = [], baseRef: string | null = null,
    dependsOn: string[] = [], workspacePath: string | null = null,
    profileId: string | null = null, roleProfiles: Record<string,string> = {}, reasoningEffort: string | null = null, planMode = false) =>
    request<{ task: TaskDetail }>('/api/tasks/start', { method: 'POST',
      body: JSON.stringify({ prompt, attachments, baseRef, dependsOn, workspacePath, profileId, roleProfiles, ...(reasoningEffort ? { reasoningEffort } : {}), ...(planMode ? { planMode } : {}) }) })
      .then((r) => ({ task: normalizeTask(r.task) })),
  continueTask: (id: string, prompt: string, attachments: ChatAttachment[] = [], reasoningEffort: string | null = null, planMode = false) =>
    request<{ task: TaskDetail }>('/api/tasks/continue', { method: 'POST', body: JSON.stringify({ id, prompt, attachments, ...(reasoningEffort ? { reasoningEffort } : {}), ...(planMode ? { planMode } : {}) }) }).then((r) => ({ task: normalizeTask(r.task) })),
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
  // `extras` answer a plan request only (docs/PLAN-MODE.md): the owner's feedback (a denial's reason is one), an edited plan and the execution chosen with an approval. Nothing is sent that the caller did not give.
  decidePermission: (id: string, approved: boolean, extras: PermissionDecisionExtras = {}) =>
    request<any>('/api/studio/permissions/decide', { method: 'POST', body: JSON.stringify({ id, approved, ...definedOnly(extras) }) }),
    
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
  /** What changed in the files of a checkpoint since it was made; `file` limits it to one (its unified diff against the copy the checkpoint holds). */
  getReview: (checkpointId: string, file = '') =>
    request<GitReview>(`/api/studio/review?checkpointId=${encodeURIComponent(checkpointId)}${file ? `&file=${encodeURIComponent(file)}` : ''}`),
  /** The files a conversation changed, as full texts (docs/REVIEW-API.md). */
  getTaskReview: (taskId: string) => request<TaskReviewAnswer>(`/api/studio/task-review?taskId=${encodeURIComponent(taskId)}`),
  /** Moves a file the conversation created to the Hub's undo folder, if it still has the sha that was reviewed. */
  rejectCreated: (taskId: string, file: string, expectedSha: string) =>
    request<any>('/api/studio/review/reject-created', { method: 'POST', body: JSON.stringify({ taskId, file, expectedSha }) }),
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
  // The owner's edit of a plan. `baseRevision` is the revision the page showed: the Hub answers 409 plan_conflict (with the revision it is at) when the plan has changed since; without it the edit is unconditional. `text` replaces the text of the plan; without it the text stays.
  savePlan: (taskId: string, title: string, items: any[], baseRevision: number | null = null, text?: string) =>
    request<Plan>('/api/studio/plan/set', { method: 'POST', body: JSON.stringify({ taskId, title, items, ...definedOnly({ baseRevision, text }) }) }),
  // The owner's decision on the plan a task waits with: approve it (`execution`: Review or Autonomous for the task afterwards) or request changes with feedback. `revision` is the revision the page showed (409 plan_conflict when the plan has changed since).
  decidePlan: (taskId: string, revision: number, decision: PlanDecision, extras: { feedback?: string; execution?: PlanExecution } = {}) =>
    request<PlanDecisionAnswer>('/api/studio/plan/decide', { method: 'POST', body: JSON.stringify({ taskId, revision, decision, ...definedOnly(extras) }) }),

  // Coding workers: the Hub still runs them in their own Git worktrees, but this page no longer starts, reviews or merges them. It only shows the test commands a worker waits for the owner to allow.
  getCodingRuns: () => request<any>('/api/studio/coding'),
  getWorkerChecks: (workerId:string) => request<{workerId:string;checks:any[]}>(`/api/studio/coding/checks?workerId=${encodeURIComponent(workerId)}`),
  approveIsolatedCheck: (workerId:string,checkId:string,maxAttempts=3) => request<any>('/api/studio/coding/check-grant',{method:'POST',body:JSON.stringify({workerId,checkId,maxAttempts,confirmation:'AUTHORIZE ISOLATED CHECK'})}),

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
  // The owner's agent options: `autoCompactPercent` (a whole number from 50 to 95, or null for the default 80) and/or `autoAcceptChecks` (true or false). Applies from the next model request.
  setAgentOptions: (patch: { autoCompactPercent?: number | null; autoAcceptChecks?: boolean }) => request<HubState>('/api/agent/options', { method: 'POST', body: JSON.stringify(patch) }),
  // The update notice (lib/update-check.mjs). getUpdateStatus reads what the Hub knows and never asks GitHub; checkForUpdates is the owner's "Check now" (one request at most a minute: a second
  // press comes back with throttled: true and no request); the answer of each is the state under `update`.
  getUpdateStatus: () => request<{ update: UpdateInfo }>('/api/update/status'),
  checkForUpdates: () => request<UpdateCheckAnswer>('/api/update/check', { method: 'POST', body: '{}' }),
  skipUpdate: (version: string | null) => request<{ update: UpdateInfo }>('/api/update/skip', { method: 'POST', body: JSON.stringify({ version }) }),
  setAutoCheckUpdates: (enabled: boolean) => request<{ update: UpdateInfo }>('/api/update/auto-check', { method: 'POST', body: JSON.stringify({ enabled }) }),
  // The download of the installer (lib/update-download.mjs): only the owner's click. The body is the version the page showed; the Hub refuses (409) when that is no longer the release on offer.
  // "Download again" (after the desktop app found the folder gone or damaged) is the same click with again: true, which drops what the Hub calls ready and fetches it anew; nothing else is read.
  downloadUpdate: (version: string, again = false) => request<UpdateDownloadAnswer>('/api/update/download', { method: 'POST', body: JSON.stringify(again ? { version, again: true } : { version }) }),
  cancelUpdateDownload: () => request<UpdateCancelAnswer>('/api/update/download-cancel', { method: 'POST', body: '{}' }),
  // What the last update left (`Updated to x.y.z`, or why it did not go through) is dismissed with an empty POST: the Hub keeps it in memory, and nothing in the body is read.
  dismissAppliedUpdate: () => request<{ update: UpdateInfo }>('/api/update/applied-dismiss', { method: 'POST', body: '{}' }),
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
  denyAction: (id: string, reason?: string) => api.decidePermission(id, false, reason ? { feedback: reason } : {}),
  testConnection: (opts?: any) => api.testAi(),
  updateAiConfig: (config: any) => api.saveAiConfig(config),
  /**
   * Restores a checkpoint (docs/REVIEW-API.md, "Restoring"): `files` limits it to some of its files, `onConflict: 'skip'` leaves a file that is not what was expected alone and lists
   * it instead of refusing the whole request. The answer has the backup (`undoCheckpointId`) that restoring puts everything back.
   */
  revertCheckpoint: (id: string, expectedShas: Shas, options: { files?: string[]; onConflict?: 'abort' | 'skip' } = {}) =>
    request<RestoreResult>('/api/studio/restore-checkpoint', { method: 'POST', body: JSON.stringify({ checkpointId: id, expectedShas, ...options }) }),
  /** Restores the baseline of a task (for each file, the earliest checkpoint of the task that knows it) in one restore. */
  revertTask: (taskId: string, expectedShas: Shas, options: { files?: string[]; onConflict?: 'abort' | 'skip' } = {}) =>
    request<RestoreResult>('/api/studio/restore-checkpoint', { method: 'POST', body: JSON.stringify({ taskId, expectedShas, ...options }) }),
  /** What restoring a checkpoint would do to each file; nothing is changed. */
  previewCheckpoint: (id: string) => request<RestorePreview>('/api/studio/preview-checkpoint?checkpointId=' + encodeURIComponent(id)),
  /** The same for the baseline of a task. */
  previewTaskRestore: (taskId: string) =>
    request<RestorePreview>('/api/studio/restore-checkpoint', { method: 'POST', body: JSON.stringify({ taskId, dryRun: true }) }),
  // External MCP servers (the MCP tab). Every write is refused with 409 mcp_task_active while a task runs; an approval sends the fingerprint the owner was shown.
  getMcpServers: () => request<McpServersAnswer>('/api/mcp/servers'),
  upsertMcpServer: (id: string, server: McpServerInput) => request<{ server: McpServerView; created: boolean }>('/api/mcp/server/upsert', { method: 'POST', body: JSON.stringify({ id, server }) }),
  deleteMcpServer: (id: string) => request<{ deleted: boolean; id: string }>('/api/mcp/server/delete', { method: 'POST', body: JSON.stringify({ id }) }),
  testMcpServer: (id: string) => request<McpTestAnswer>('/api/mcp/server/test', { method: 'POST', body: JSON.stringify({ id }) }),
  getMcpLaunchRecord: (id: string) => request<McpLaunchRecord>('/api/mcp/server/launch-record', { method: 'POST', body: JSON.stringify({ id }) }),
  approveMcpLaunch: (id: string, expectedFingerprint: string) => request<{ ok: boolean; fingerprint: string | null }>('/api/mcp/server/approve-launch', { method: 'POST', body: JSON.stringify({ id, expectedFingerprint }) }),
  getMcpToolReview: (id: string) => request<McpToolReview>('/api/mcp/server/tool-review', { method: 'POST', body: JSON.stringify({ id }) }),
  approveMcpTools: (id: string, expectedFingerprint: string) => request<{ ok: boolean; fingerprint: string }>('/api/mcp/server/approve-tools', { method: 'POST', body: JSON.stringify({ id, expectedFingerprint }) }),
  setMcpToolPolicy: (id: string, patch: { default?: McpPolicyWord | null; tools?: Record<string, McpPolicyWord | null> }) =>
    request<{ server: McpServerView }>('/api/mcp/server/tool-policy', { method: 'POST', body: JSON.stringify({ id, ...patch }) }),
  reloadMcpServers: () => request<McpServersAnswer>('/api/mcp/reload', { method: 'POST', body: '{}' }),
};
