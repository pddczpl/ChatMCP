import type { HubState, HubHealth, TaskDetail, TreeEntry, FileData, GitStatus, Checkpoint, GitReview, TerminalState, Plan, MarketplacePlugin } from '@/types';

const UI_BUILD = '2.3.0-react-agent';
let currentCsrfToken = '';

export function setCsrfToken(token: string) {
  currentCsrfToken = token;
}

export async function request<T>(route: string, options: RequestInit = {}): Promise<T> {
  const method = options.method || 'GET';
  const headers: Record<string, string> = {
    'X-ChatMCP-Request': 'local-dashboard',
    'X-ChatMCP-UI-Build': UI_BUILD,
    ...(options.headers as Record<string, string>),
  };

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

  const data = await res.json().catch(() => null);

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
    return st;
  }),
  getCapabilities: () => request<any>('/api/capabilities'),
  
  // Tasks
  getTask: (id: string) => request<{ task: TaskDetail } | TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`).then((r) => ('task' in r ? r.task : r)),
  startTask: (prompt: string) => request<{ task: TaskDetail }>('/api/tasks/start', { method: 'POST', body: JSON.stringify({ prompt }) }),
  continueTask: (id: string, prompt: string) => request<{ task: TaskDetail }>('/api/tasks/continue', { method: 'POST', body: JSON.stringify({ id, prompt }) }),
  cancelTask: (id: string) => request<{ task: TaskDetail }>('/api/tasks/cancel', { method: 'POST', body: JSON.stringify({ id }) }),
  deleteTask: (id: string) => request<{ ok: boolean; removed: string }>('/api/tasks/delete', { method: 'POST', body: JSON.stringify({ id }) }),
  setAutoResume: (id: string, enabled: boolean) => request<{ task: TaskDetail }>('/api/tasks/auto-resume', { method: 'POST', body: JSON.stringify({ id, enabled }) }),
  
  // Workspace
  selectWorkspace: (path: string) => request<HubState>('/api/workspace/select', { method: 'POST', body: JSON.stringify({ path }) }),
  browseWorkspace: () => request<{ path?: string }>('/api/workspace/browse', { method: 'POST' }),
  
  // Permissions & Approvals
  configurePermissions: (payload: { mode?: string; executionPolicy?: string; confirmation?: string }) =>
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
  getGitDiff: () => request<{ diff: string }>('/api/studio/git/diff'),
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
  getCodingRuns: () => request<any>('/api/studio/coding'),
  runCodingAgents: (tasks:{id:string;prompt:string}[],maxConcurrency=2) => request<any>('/api/studio/coding/run',{method:'POST',body:JSON.stringify({tasks,maxConcurrency,confirmation:'CREATE WORKTREES'})}),
  cancelCodingAgents: () => request<any>('/api/studio/coding/cancel',{method:'POST',body:'{}'}),
  integrateCodingAgents: (runId:string,workerIds:string[]) => request<any>('/api/studio/coding/integrate',{method:'POST',body:JSON.stringify({runId,workerIds,confirmation:'INTEGRATE WORKTREES'})}),
  publishCodingAgents: (runId:string) => request<any>('/api/studio/coding/publish',{method:'POST',body:JSON.stringify({runId,confirmation:'PUBLISH DRAFT PR'})}),
  cancelOrchestrator: () => request<any>('/api/studio/delegates/cancel',{method:'POST',body:'{}'}),

  // GitHub skills registry
  getSkillRegistry: (query='') => request<{sources:any[];skills:any[]}>(`/api/plugins/registry?query=${encodeURIComponent(query)}`),
  refreshSkillRegistry: (sourceId?:string) => request<any>('/api/plugins/registry/refresh',{method:'POST',body:JSON.stringify({sourceId})}),
  installRegistrySkill: (key:string) => request<any>('/api/plugins/registry/install',{method:'POST',body:JSON.stringify({key})}),

  // Skills & Plugins
  getSkills: () => request<{ skills: any[] }>('/api/studio/skills'),
  getMarketplace: (category = '', query = '') =>
    request<{ catalog: MarketplacePlugin[] }>(`/api/plugins/marketplace?category=${encodeURIComponent(category)}&query=${encodeURIComponent(query)}`),
  installPlugin: (id: string) => request<any>('/api/plugins/install', { method: 'POST', body: JSON.stringify({ id }) }),
  uninstallPlugin: (id: string) => request<any>('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) }),
  togglePlugin: (id: string, enabled: boolean) => request<any>('/api/plugins/toggle', { method: 'POST', body: JSON.stringify({ id, enabled }) }),

  // AI & Profiles
  getPresets: () => request<{ presets: any[]; envKeys: string[] }>('/api/ai/presets'),
  getModels: () => request<{ models: string[]; source?: string }>('/api/ai/models'),
  getProfiles: () => request<{ profiles: any[]; defaultProfileId?: string }>('/api/ai/profiles'),
  upsertProfile: (profile: any) => request<any>('/api/ai/profiles/upsert', { method: 'POST', body: JSON.stringify(profile) }),
  deleteProfile: (id: string) => request<any>('/api/ai/profiles/delete', { method: 'POST', body: JSON.stringify({ id }) }),
  setDefaultProfile: (id: string) => request<any>('/api/ai/profiles/default', { method: 'POST', body: JSON.stringify({ id }) }),
  testAi: () => request<any>('/api/ai/test', { method: 'POST' }),
  saveAiConfig: (config: any) => request<any>('/api/ai/config', { method: 'POST', body: JSON.stringify(config) }),
  clearAiKey: () => request<any>('/api/ai/clear-key', { method: 'POST' }),
  setAgentMode: (mode: string) => request<any>('/api/agent/mode', { method: 'POST', body: JSON.stringify({ mode }) }),

  // Intelligence
  getIntelligenceStatus: () => request<any>('/api/studio/intelligence/status'),
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
  setPermissions: (payload: { mode?: string; executionPolicy?: string; confirmation?: string }) =>
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
