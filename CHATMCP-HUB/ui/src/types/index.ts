/** A tool result held on this computer until the owner decides (ChatGPT Web "review before send"). */
export interface OutboundReview {
  id: string;
  taskId: string;
  turn: number;
  tool: string;
  kind: string;
  at: string;
  expiresAt: string;
  bytes: number;
  /** exactly the text that would be typed into the ChatGPT tab */
  preview: string;
  /** labels and counts of what was masked automatically; never the matches */
  redactions: Record<string, number>;
  withheld: string[];
  manualCount: number;
}
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
  contextPolicy?: { source:string;capacityTokens:number;maxHistoryTokens:number;compactAtTokens:number;reservedOutputTokens:number;plannedOutputTokens?:number;approximate:boolean };
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

/**
 * The owner's switch for AGENTS.md / CLAUDE.md, as /api/state serves it (lib/project-instructions.mjs). `source` is who decided:
 * the environment variable of the Hub (then a click cannot change it), the choice saved in Settings, or the default (on).
 */
export interface ProjectInstructionsSetting {
  enabled: boolean;
  source: 'env' | 'config' | 'default' | 'option';
  /** The choice saved in Settings, whatever decided; null when there is none. */
  saved?: boolean | null;
  variable: string;
  maxBytes: number;
  files: string[];
}

/** What the Hub recorded about one project file in one run: names, sizes and hashes, never a text. */
export interface ProjectInstructionFile {
  path: string;
  status: 'loaded' | 'truncated' | 'alias' | 'skipped';
  reason: string | null;
  sizeBytes: number | null;
  textBytes: number;
  loadedBytes: number;
  cutBytes: number;
  aliasOf: string | null;
}

/** `task.projectInstructions`: what the latest run was given of the project's AGENTS.md / CLAUDE.md. */
export interface ProjectInstructionsRecord {
  enabled: boolean;
  maxBytes: number;
  blockBytes: number;
  truncated: boolean;
  error: string | null;
  files: ProjectInstructionFile[];
}

/** The receipt of one skill_load call (lib/skill-index.mjs): hashes and sizes, never the text. */
export interface SkillLoadReceipt {
  id: string;
  loadedBytes?: number;
  textBytes?: number;
  cutBytes?: number;
  truncated?: boolean;
  forced?: boolean;
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
  skillLoad?: SkillLoadReceipt;
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
  /** What the latest run was given of AGENTS.md / CLAUDE.md; absent for a ChatGPT Web task and for one from before the record existed. */
  projectInstructions?: ProjectInstructionsRecord | null;
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
  /** Route template of the endpoint, e.g. /proxy/{model}/messages. Not a secret. */
  customPath?: string;
  /** Names and sources of the custom headers. The values are sealed on the Hub and never returned. */
  customHeaders?: {name:string;source:'protected'|'environment';envKeyName?:string}[];
  isDefault?: boolean;
  ratesUsdPerMillion?: {input:number;output:number;cacheRead?:number;cacheWrite?:number}|null;
  /** How much the model is asked to think: 'auto' (send nothing) or a level. See ModelInfo.reasoning.levels for the levels this model takes. */
  reasoningEffort?: string;
}

/** What the Hub knows about a model before anything is sent to it (GET /api/ai/model-info): its limits, and the levels of thinking effort that can be offered. */
export interface ModelInfo {
  model: string;
  protocol: string;
  preset: string | null;
  found: boolean;
  confidence: 'exact' | 'normalized' | 'alias' | 'none';
  /** Where the answer comes from, e.g. catalog@2026-10-19; null when the catalog does not know the model. */
  source: string | null;
  provider: string | null;
  local: boolean;
  contextWindow: number | null;
  maxOutput: number | null;
  toolCall: boolean | null;
  vision: boolean | null;
  reasoning: {
    supported: boolean | null;
    toggle: boolean;
    budget: { min: number | null; max: number | null } | null;
    efforts: string[];
    /** The levels a settings page offers: the ones that would really be sent. */
    levels: string[];
    /** false: the catalog does not know the model, so `levels` are the common ones and a guess. */
    known: boolean;
    /** Why there is nothing to offer: model_does_not_reason | no_effort_control | protocol_not_supported. */
    why: string | null;
  };
  catalog: { generatedAt: string; ageDays: number };
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
  /** The sentences of the Hub's own that the runner put after the agent's words (lib/final-text.mjs), apart from `resultPreview`, which is the agent's words alone. */
  resultNotice?:string|null;
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
  projectInstructions?: ProjectInstructionsRecord | null;
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
  contextPolicy?: { source:string;capacityTokens:number;maxHistoryTokens:number;compactAtTokens:number;reservedOutputTokens:number;plannedOutputTokens?:number;approximate:boolean };
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
    /** 'auto' (send nothing) or a level. */
    reasoningEffort?: string;
    /** Whether the level is sent, why not (see ModelInfo.reasoning.why, or value_not_offered / value_not_valid_here), and whether the provider refused it. */
    reasoning?: { effort: string; sent: boolean; why: string | null; refused: boolean };
    /** The AI connection (provider, model, key) is being changed; the Hub refuses to start model work meanwhile. */
    busy?: boolean;
  };
  /** The id of the task the Hub is running for the main agent (null when none). */
  taskId?: string | null;
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
    /** "Review before send": the global switch and the per-workspace overrides. */
    privacy?: { reviewBeforeSend: boolean; workspaces: { path: string; review: boolean }[] };
    /** The tool result held for the owner right now (null when nothing is held). */
    outboundReview?: OutboundReview | null;
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
    /** The group of read-only helpers: `running` while it works. */
    delegates?: { running?: boolean } | null;
  };
  plugins?: {
    count: number;
    active: number;
  };
  /** The owner's switch for AGENTS.md / CLAUDE.md (Settings → Dự án). */
  projectInstructions?: ProjectInstructionsSetting;
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
