export type PermissionMode = 'readonly' | 'review' | 'autonomous';
export type ExecutionPolicy = 'host-review' | 'sandbox-only' | 'full-access';
export type TaskStatus = 'blocked' | 'created' | 'queued' | 'planning' | 'running' | 'waiting_approval' | 'verifying' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'uncertain' | 'unknown';

export interface TaskSummary {
  id: string;
  effectiveProfile?: {id:string;name:string;revision?:string|null;provider:string;protocol:string;model:string;endpointOrigin:string;credentialSource:string}|null;
  roleProfiles?: Record<string,string>;
  branch?: string | null;
  worktree?: string | null;
  dependsOn?: string[];
  parentTaskId?: string | null;
  parentRunId?: string | null;
  linkedFromTaskId?: string | null;
  conversationId?: string;
  workspacePath?: string;
  queuedMessagesCount?: number;
  prompt?: string;
  status?: string;
  state?: string;
  steps?: number;
  toolCalls?: number;
  usage?: { inputTokens?: number; outputTokens?: number; httpRequests?: number; cachedInputTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; telemetrySchema?:number; inputUsageReported?:number; inputUsageMissing?:number; outputUsageReported?:number; outputUsageMissing?:number };
  verificationOutcome?: { ready: boolean; missing: string[]; reason?: string };
  completionOutcome?: {execution:string;requirements:string;verification:string;unresolvedObjectiveIds:string[];missingChecks:string[];note?:string};
  contextPolicy?: { source:string;capacityTokens:number;maxHistoryTokens:number;compactAtTokens:number;reservedOutputTokens:number;approximate:boolean };
  modelCost?: {schema:number;knownSubtotalUsd:number;pricedResponses:number;unpricedResponses:number;unknownResponses:number;totalUsd:number|null;complete:boolean;lastPriceStatus?:string};
  promptCount?: number;
  updatedAt?: string;
  startedAt?: string;
  createdAt?: string;
  finishedAt?: string;
  workspace?: { path: string };
  transport?: string;
  autoResume?: boolean;
}

export interface TaskEvent {
  type: string;
  toolName?: string;
  message?: string;
  at: string;
  durationMs?: number;
  input?: any;
  output?: any;
  status?: string;
  state?: string;
}

export interface TaskRun {
  status?: string;
  finalText?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskPrompt {
  text: string;
  at: string;
}

export interface TaskDetail extends TaskSummary {
  dialogue?: { role: 'user' | 'assistant' | 'system'; at?: string; text: string; run?: number }[];
  prompts?: TaskPrompt[];
  runs?: TaskRun[];
  finalText?: string;
  events?: TaskEvent[];
  stateReason?: string;
  errorCode?: string;
  error?: string;
  chatUrl?: string;
  handoff?: {fromTaskId:string;toTransport:string;note:string};
}

export interface ApprovalRequest {
  id: string;
  category: string;
  risk?: string;
  taskId?: string;
  toolName?: string;
  reason?: string;
  preview?: string;
  at?: string;
  decision?: string;
  decidedAt?: string;
  title?: string;
  file?: string;
  command?: string;
  detail?: Record<string, unknown> | string;
  summary?: string;
  requestedAt?: string;
  expiresAt?: string;
  diff?: string;
  currentSha?: string;
}

export interface AiProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiBaseUrl?: string;
  apiKey?: string;
  hasKey?: boolean;
  envKeyName?: string | null;
  revision?: string | null;
  contextWindow?: number | null;
  authMode?: string;
  protocol?: string;
  isDefault?: boolean;
  ratesUsdPerMillion?: {input:number;output:number;cacheRead?:number;cacheWrite?:number}|null;
}

export interface ProviderPreset {
  id: string;
  label: string;
  local?: boolean;
  notes?: string;
  keyUrl?: string;
  envKey?: string;
  model?: string;
  defaultModel?: string;
  protocol?: string;
  apiBaseUrl?: string;
  authMode?: string;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  addedAt?: string;
  lastUsedAt?: string;
}
export interface WorkspaceCollection {
  activePath: string | null;
  items: WorkspaceEntry[];
}
export interface WorkflowAgent {
  id:string;
  taskId:string;
  role:string;
  goal:string;
  status:string;
  branch?:string|null;
  worktree?:string|null;
  startedAt?:string|null;
  finishedAt?:string|null;
  model?:string|null;
  resultPreview?:string|null;
  usage?: {inputTokens:number;outputTokens:number;httpRequests:number}|null;
}
export interface WorkflowPhase {
  id:string;
  name:string;
  dependsOn:string[];
  status:string;
  completed:number;
  total:number;
  agents:WorkflowAgent[];
}
export interface BackgroundWorkflow {
  id:string;
  name:string;
  conversationId:string;
  parentRunId:string|null;
  workspacePath:string;
  createdAt:string;
  updatedAt:string;
  finishedAt?:string|null;
  status:string;
  error?:string|null;
  completed:number;
  total:number;
  activeAgents:number;
  failedAgents:number;
  usage?:{inputTokens:number;outputTokens:number;httpRequests:number};
  phases:WorkflowPhase[];
}

export interface BackgroundRun {
  id: string; taskId: string; conversationId: string; workspacePath: string;
  title: string; status: string; startedAt?: string; finishedAt?: string;
  stepCount?: number | null;
  conversationUsage?: { inputTokens?:number; outputTokens?:number; httpRequests?:number } | null;
  subagents: {
    id:string;taskId:string;parentTaskId:string;parentRunId?:string|null;title:string;status:string;
    startedAt?:string;finishedAt?:string;branch?:string|null;workspacePath?:string;
  }[];
}
export interface ChatAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
  size: number;
}

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string | number;
}

export interface ToolCall {
  id?: string;
  name: string;
  args?: any;
  result?: any;
  status?: 'running' | 'success' | 'error' | 'unknown';
  timestamp?: string;
  durationMs?: number;
  summary?: string;
}

export interface Task {
  id: string;
  effectiveProfile?: {id:string;name:string;revision?:string|null;provider:string;protocol:string;model:string;endpointOrigin:string;credentialSource:string}|null;
  roleProfiles?: Record<string,string>;
  goalPlan?: {objectives:Array<{
    id:string;text:string;status:string;dependsOn?:string[];acceptanceCriteria:string[];
    evidence?:Array<{criterionIndex:number;receiptId:string;acceptedAt:string}>;
  }>};
  objectiveReceipts?: Array<{receiptId:string;kind:'inspect'|'edit'|'verify'|'review';step:number;path?:string}>;
  prompt?: string;
  branch?: string | null;
  worktree?: string | null;
  dependsOn?: string[];
  parentTaskId?: string | null;
  parentRunId?: string | null;
  linkedFromTaskId?: string | null;
  conversationId?: string;
  workspacePath?: string;
  queuedMessagesCount?: number;
  task?: string;
  workspace?: {path:string};
  status: TaskStatus;
  state?: string;
  runnerStatus?: string;
  stateReason?: string;
  updatedAt?: string;
  events?: TaskEvent[];
  phase?: string;
  stage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  messages: Message[];
  toolCalls?: ToolCall[];
  plan?: { title: string; status: string; details?: string }[];
  pendingApprovals?: any[];
  usage?: { inputTokens?: number; outputTokens?: number; httpRequests?: number; cachedInputTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; telemetrySchema?:number; inputUsageReported?:number; inputUsageMissing?:number; outputUsageReported?:number; outputUsageMissing?:number };
  verificationOutcome?: { ready: boolean; missing: string[]; reason?: string };
  completionOutcome?: {execution:string;requirements:string;verification:string;unresolvedObjectiveIds:string[];missingChecks:string[];note?:string};
  contextPolicy?: { source:string;capacityTokens:number;maxHistoryTokens:number;compactAtTokens:number;reservedOutputTokens:number;approximate:boolean };
  modelCost?: {schema:number;knownSubtotalUsd:number;pricedResponses:number;unpricedResponses:number;unknownResponses:number;totalUsd:number|null;complete:boolean;lastPriceStatus?:string};
  lastMessage?: string;
  error?: string;
  transport?: string;
  chatUrl?: string | null;
  handoff?: {fromTaskId:string;toTransport:string;note:string};
}

export interface HubHealth {
  app: string;
  version: string;
  uiBuild: string;
  initialized: boolean;
  backend: string;
}

export interface HubState {
  version: string;
  csrfToken: string;
  backend?: string;
  workspaces?: WorkspaceCollection;
  workspace?: { 
    path: string;
    git?: {
      branch?: string;
      dirty?: boolean;
      checkpoints?: any[];
    };
    modifiedFiles?: any[];
  };
  services?: Record<string, { state: string; detail?: string }>;
  ai?: {
    configured?: boolean;
    provider?: string;
    preset?: string;
    keySource?: 'saved' | 'environment' | 'session' | 'none';
    model?: string;
    apiBaseUrl?: string;
    protocol?: string;
    authMode?: string;
    agentRequestMode?: string;
    profiles?: AiProfile[];
    defaultProfileId?: string;
    secretStorage?: { protection?: string };
    toolCalling?: boolean;
    toolCallingNote?: string;
  };
  agent?: {
    mode: 'api'|'chatgpt-web';
    activeTaskId: string | null;
    active: TaskSummary | null;
    tasks: TaskSummary[];
  };
  tasks?: Task[];
  recentFiles?: any[];
  activity?: any[];
  auditLogs?: any[];
  terminalLogs?: any[];
  user?: {
    role?: string;
    name?: string;
  };
  browser?: {
    paired: boolean;
    connected: boolean;
    lastSeenAt?: string|null;
    extensionId?: string|null;
    pairedAt?: string|null;
    pairingAvailable?: boolean;
    companionPhase?: string;
    companionNote?: string;
  };
  studio?: {
    workspace: string;
    permissions?: {
      mode: PermissionMode;
      executionPolicy?: ExecutionPolicy;
      pending?: ApprovalRequest[];
      recent?: ApprovalRequest[];
      approvalTimeoutMs?: number;
      fullAccess?: boolean;
    };
    terminals?: TerminalState[];
    features?: string[];
  };
  plugins?: {
    count: number;
    active: number;
  };
  publicMode?: {
    enabled: boolean;
    execMode: string;
    ephemeralStorage?: boolean;
    storageNote?: string;
    workspaces?: { count: number; max?: number; items?: any[] };
    disabled?: string[];
  } | null;
  logs?: string[];
  [key: string]: any;
}

export interface TerminalState {
  id: string;
  command: string;
  status: 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';
  exitCode: number | null;
  mode?: string;
  interactive?: boolean;
  logs?: { message: string; type?: string; seq?: number; at?: string }[];
}

export interface VerificationRun {
  id: string;
  terminalId?: string;
  command: string;
  status: string;
  exitCode: number | null;
  startedAt: string;
  outputPreview?: string;
}

export interface PlanItem {
  text: string;
  status: 'todo' | 'doing' | 'done' | 'blocked';
  evidence?: string;
}

export interface Plan {
  title: string;
  items: PlanItem[];
}

export interface TreeEntry {
  name: string;
  kind: 'file' | 'directory';
  path: string;
  size?: number;
}

export interface FileData {
  path: string;
  size: number;
  sha256: string;
  content: string;
}

export interface GitStatus {
  branch?: string;
  head?: string;
  dirty?: boolean;
  entries?: string[];
  partial?: boolean;
}

export interface Checkpoint {
  id: string;
  at: string;
  label: string;
  fileCount?: number;
  partial?: boolean;
  targeted?: boolean;
  limitations?: string[];
}

export interface GitReview {
  checkpointId: string;
  changes: {
    path: string;
    diff: string;
    currentSha: string;
  }[];
}

export interface CodeMatch {
  path: string;
  line?: number;
  text: string;
}

export interface SymbolMatch {
  name: string;
  path: string;
  line: number;
  kind: string;
  precision: string;
}

export interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  author: string;
  installed?: boolean;
  enabled?: boolean;
  skills?: string[];
}
