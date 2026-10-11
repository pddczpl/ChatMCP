export type PermissionMode = 'readonly' | 'review' | 'autonomous';
export type ExecutionPolicy = 'host-review' | 'sandbox-only' | 'full-access';

export interface TaskSummary {
  id: string;
  prompt?: string;
  status?: string;
  state?: string;
  steps?: number;
  toolCalls?: number;
  promptCount?: number;
  updatedAt?: string;
  startedAt?: string;
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
}

export interface TaskRun {
  status?: string;
  finalText?: string;
}

export interface TaskPrompt {
  text: string;
  at: string;
}

export interface TaskDetail extends TaskSummary {
  prompts?: TaskPrompt[];
  runs?: TaskRun[];
  finalText?: string;
  events?: TaskEvent[];
  stateReason?: string;
  errorCode?: string;
  error?: string;
  chatUrl?: string;
}

export interface ApprovalRequest {
  id: string;
  category: string;
  risk: 'low' | 'medium' | 'high';
  title?: string;
  file?: string;
  command?: string;
  detail?: string;
  summary?: string;
  requestedAt: string;
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
  authMode?: string;
  protocol?: string;
  isDefault?: boolean;
}

export interface ProviderPreset {
  id: string;
  label: string;
  local?: boolean;
  notes?: string;
  keyUrl?: string;
  envKey?: string;
  model?: string;
  protocol?: string;
  apiBaseUrl?: string;
  authMode?: string;
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
  status?: 'running' | 'success' | 'error';
  durationMs?: number;
  summary?: string;
}

export interface Task {
  id: string;
  task?: string;
  status: string;
  phase?: string;
  stage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  messages: Message[];
  toolCalls?: ToolCall[];
  plan?: { title: string; status: string; details?: string }[];
  pendingApprovals?: any[];
  lastMessage?: string;
  error?: string;
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
    mode: string;
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
    companionPhase?: string;
    companionNote?: string;
  };
  studio?: {
    workspace: string;
    permissions?: {
      mode: PermissionMode;
      executionPolicy?: ExecutionPolicy;
      pending?: ApprovalRequest[];
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
  status: 'running' | 'completed' | 'failed';
  exitCode: number | null;
  mode?: string;
  interactive?: boolean;
  logs?: { message: string; type?: string }[];
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
