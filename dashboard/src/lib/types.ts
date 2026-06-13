export interface HealthResponse {
  ok: boolean;
  time: string;
  running: number;
  queued: number;
  jobs: number;
  maxConcurrencyPerProduct: number;
  uptime?: number;
  n8n?: {
    reachable: boolean;
    lastCheck: string;
    latencyMs: number;
    url: string;
    internalReachable?: boolean;
    externalReachable?: boolean;
  };
}

export interface JobSource {
  workflow?: string;
  triggeredBy?: string;
  parentJobId?: string;
}

export interface QualityGateCheck {
  name: string;
  passed: boolean;
  duration?: number;
  output?: string;
}

export interface QualityGateResult {
  passed: boolean;
  skipped?: boolean;
  results?: QualityGateCheck[];
  failedCheck?: { name: string };
  retryContext?: string;
}

export interface ProductRef {
  id: string;
  name: string;
}

export interface Job {
  id: string;
  mode: "delivery" | "chat" | "agent";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "retry-pending" | "quality-gate-retry";
  agent?: string;
  issueKey?: string;
  product?: ProductRef | null;
  model?: string;
  selectedModel?: string;
  provider?: string;
  prompt?: string;
  workingDir?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  finishedAt?: string;
  duration?: number;
  retryCount?: number;
  lastError?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  callbackStatus?: string;
  source?: JobSource;
  parentKey?: string;
  isSubtask?: boolean;
  qualityGate?: QualityGateResult | null;
  chromeEnabled?: boolean;
  chromeReason?: string;
  chromeUsage?: { used: boolean; tools: string[]; count: number };
  teamSessionId?: string | null;
  teamRole?: "lead" | "teammate" | null;
  teammates?: string[];
}

export interface PaginatedJobs {
  ok: boolean;
  jobs: Job[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface JobOutput {
  ok: boolean;
  jobId: string;
  result?: string;
  raw?: string;
}

export interface Agent {
  name: string;
  description?: string;
  model?: string;
  provider?: string;
  isTeamLead?: boolean;
  teammates?: string[];
  disallowedTools?: string[];
}

export interface RunAgentRequest {
  agent: string;
  prompt: string;
  context?: string;
  workingDir?: string;
  model?: string;
  provider?: string;
}

export interface Stats {
  running: number;
  queued: number;
  totalJobs: number;
  recentSucceeded: number;
  recentFailed: number;
  metrics: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
    avgLatencyMs: number;
  };
  byAgent: Record<string, {
    total: number;
    succeeded: number;
    failed: number;
    tokens: number;
    cost: number;
  }>;
  byProduct?: Record<string, {
    total: number;
    succeeded: number;
    failed: number;
    tokens: number;
    cost: number;
  }>;
  chrome?: {
    sessionsEnabled: number;
    sessionsUsed: number;
    toolCalls: number;
    byTool: Record<string, number>;
  };
  pipelines?: {
    active: number;
    completed: number;
    failed: number;
    total: number;
    totalCostUsd: number;
  };
}

export interface AgentMetric {
  agent: string;
  total: number;
  succeeded: number;
  failed: number;
  tokens: number;
  cost: number;
}

export interface Metrics {
  jobs: { total: number; succeeded: number; failed: number; cancelled: number; retried: number };
  byAgent: Record<string, { total: number; succeeded: number; failed: number; tokens: number; cost: number }>;
  tokens: { total: number; input: number; output: number };
  costs: { total: number };
  avgLatencyMs: number;
}

export interface PMDigestPeriod {
  total: number;
  succeeded: number;
  failed: number;
  costUsd: number;
  successRate: number;
}

export interface StalledJob {
  jobId: string;
  agent?: string;
  issueKey?: string;
  runningMinutes?: number;
  waitingMinutes?: number;
  status?: string;
}

export interface PMDigestAgentPerformance {
  total: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number;
  successRate: number;
}

export interface PMDigestBudget {
  ok: boolean;
  costToday?: number;
  costLastHour?: number;
  reason?: string;
}

export interface PMDigest {
  generatedAt?: string;
  last24h: PMDigestPeriod;
  lastWeek: PMDigestPeriod;
  qualityGate: { passed: number; failed: number; total: number; passRate: number };
  stalledJobs: StalledJob[];
  agentPerformance: Record<string, PMDigestAgentPerformance>;
  budget: PMDigestBudget;
  queueDepth?: number;
  runningCount?: number;
}

export interface BatchResult {
  jobId: string | null;
  issueKey: string | null;
  status: string;
  result: string | null;
  error: string | null;
  completedAt: string;
}

export interface Batch {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
  resultsCount: number;
  slack?: { channel?: string; threadTs?: string } | null;
  results?: BatchResult[];
}

export interface Conversation {
  id: string;
  channelId: string;
  messageCount: number;
  lastUpdated: string;
}

export interface CallbackAttempt {
  at: string;
  url: string;
  attempt: number;
  status: number | null;
  error: string | null;
}

export interface FailedCallback {
  id: string;
  jobId: string;
  url: string;
  error: string;
  attempts: number;
  lastAttempt: string;
  failedAt?: string;
  agent?: string | null;
  issueKey?: string | null;
  payloadPreview?: string;
  responseStatus?: number | null;
  attemptDetails?: CallbackAttempt[];
}

export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface StreamEvent {
  type: "tool_use";
  tool: string;
  ts: string;
}

export interface JobProgress {
  jobId: string;
  agent?: string;
  streamType: "init" | "assistant" | "tool_use" | "tool_result" | "result";
  tool?: string;
  toolId?: string;
  input?: string;
  text?: string;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  model?: string;
  tools?: string[];
  sessionId?: string;
}

export interface TaskItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  description?: string;
  blocks?: string[];
  blockedBy?: string[];
}

export interface TaskProgress {
  ok: boolean;
  found: boolean;
  issueKey: string;
  tasks: TaskItem[];
  total?: number;
  completed?: number;
  inProgress?: number;
  pending?: number;
}

export interface SubtaskInfo {
  key: string;
  agent: string;
  status: string;
  blockedBy: string[];
  files: string[];
  jobId: string | null;
  jobStatus: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface SubtaskGroup {
  ok: boolean;
  found: boolean;
  parentKey: string;
  total: number;
  completed: number;
  running: number;
  pending: number;
  failed: number;
  progress: number;
  subtasks: SubtaskInfo[];
  createdAt?: string;
}

export interface TeamSession {
  teamSessionId: string;
  leadJobId: string;
  leadAgent: string;
  teammates: string[];
  status: string;
  issueKey?: string | null;
  model?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  duration?: number | null;
  active: boolean;
}

export interface TeamSessionsResponse {
  ok: boolean;
  active: number;
  total: number;
  sessions: TeamSession[];
}

export interface JobsQueryParams {
  page?: number;
  limit?: number;
  status?: string;
  agent?: string;
  product?: string;
  search?: string;
  sort?: string;
  order?: "asc" | "desc";
}

// Pipeline definition (template) types
export interface PipelineDefinition {
  name: string;
  description?: string;
  phases: number; // count only, for list display
  builtin: boolean;
}

export interface PipelineDefinitionDetail {
  name: string;
  description?: string;
  phases: Array<{
    name: string;
    agent: string;
    gate?: { type: string; prefix?: string; file?: string };
  }>;
}

export interface PipelineRoutingRule {
  match: { issueType?: string; labels?: string[] };
  pipelineType: string;
}

// Pipeline types
export interface PipelineGate {
  type: "comment-prefix" | "file-exists" | "quality-gate" | "security-pass" | "acceptance" | "human-approval";
  value: string;
  passed?: boolean;
  checkedAt?: string;
}

export interface PipelinePhase {
  name: string;
  agent: string;
  status: "pending" | "running" | "succeeded" | "completed" | "failed" | "skipped" | "awaiting-approval";
  gate?: PipelineGate;
  jobId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
}

export interface Pipeline {
  id: string;
  issueKey: string;
  definition: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  phases: PipelinePhase[];
  currentPhase: number;
  contextBridgePath?: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string | null;
}

export interface PipelineListResponse {
  ok: boolean;
  pipelines: Pipeline[];
  total: number;
}

export interface TimelineEntry {
  timestamp: string;
  agent: string;
  phase?: string;
  event: string;
  detail?: string;
  jobId?: string;
}

export interface TimelineResponse {
  ok: boolean;
  issueKey: string;
  entries: TimelineEntry[];
}

// Worktree types
export interface Worktree {
  id: string;
  issueKey: string;
  branch: string;
  path: string;
  baseRepo: string;
  pipelineId?: string | null;
  status: "active" | "merged" | "pr-created" | "orphaned";
  createdAt: string;
  lastJobId?: string | null;
  lastJobAgent?: string | null;
  commits: number;
  filesChanged: number;
  prUrl?: string | null;
}

export interface WorktreeListResponse {
  ok: boolean;
  worktrees: Worktree[];
  total: number;
}

// Skill usage telemetry
export interface SkillUsageEntry {
  reads: number;
  scriptRuns: number;
  lastUsed: string | null;
  byAgent: Record<string, number>;
}

export type SkillUsageMap = Record<string, SkillUsageEntry>;

// Scheduled items
export interface ScheduledItem {
  id: string;
  type: "job" | "meeting";
  status: "pending" | "done" | "cancelled";
  scheduledAt: string;
  createdAt: string;
  source?: string;
  // Meeting fields
  topic?: string;
  agents?: string[];
  meetingId?: string;
  // Job fields
  agent?: string;
  task?: string;
  issueKey?: string;
  jobId?: string;
  prompt?: string;
}

// Issue tracker types
export interface Issue {
  id: number;
  key: string;
  project: string;
  type: "epic" | "story" | "task" | "bug" | "subtask";
  status: "todo" | "in_progress" | "done" | "cancelled";
  summary: string;
  description?: string;
  priority: "highest" | "high" | "medium" | "low" | "lowest";
  labels: string[];
  assignee?: string;
  parentKey?: string;
  storyPoints?: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface IssueComment {
  id: number;
  issueKey: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueLink {
  id: number;
  sourceKey: string;
  targetKey: string;
  linkType: string;
  createdAt: string;
}

export interface IssueTransition {
  id: string;
  name: string;
  to: { name: string };
}

export interface IssueSearchResult {
  ok: boolean;
  issues: Issue[];
  total: number;
}

export interface IssueDetail {
  ok: boolean;
  issue: Issue;
  comments: IssueComment[];
  links: IssueLink[];
  subtasks: Issue[];
}

export interface Product {
  id: string;
  name: string;
  description?: string;
  workingDir: string;
  pluginDir?: string | null;
  projectKey?: string | null;
}

// Integration status types
export interface IntegrationStatus {
  jira: { enabled: boolean; domain?: string; email?: string; hasToken: boolean };
  telegram: { enabled: boolean; hasToken: boolean; chatId?: string };
  n8n: { enabled: boolean; callbackUrl?: string };
  slack: { enabled: boolean; webhookUrl?: string };
}

// Notification types
export interface Notification {
  id: number;
  type: string;
  title: string;
  body?: string;
  severity: "info" | "success" | "warning" | "error";
  read: boolean;
  link?: string;
  createdAt: string;
}

// Product onboarding input — mirrors the wizard's 6 sections
export interface OnboardProductInput {
  name: string;
  description: string;
  workingDir: string;
  industry?: string;
  targetMarket?: string;
  jira?: {
    projectKey?: string;
    projectName?: string;
    boardId?: string;
    domain?: string;
  };
  confluence?: {
    space?: string;
    marketingSpace?: string;
  };
  techStack?: {
    frontend?: string;
    backend?: string;
    database?: string;
    orm?: string;
    auth?: string;
    packageManager?: string;
    commands?: {
      dev?: string;
      build?: string;
      test?: string;
      lint?: string;
      typeCheck?: string;
    };
  };
  domain?: {
    regulators?: Array<{ name: string; relevance?: string; keyRequirements?: string }>;
    keyProcesses?: Array<{ name: string; mandatedSequence?: boolean; description?: string }>;
    terminology?: Array<{ term: string; meaning?: string; commonMistake?: string }>;
    domainPitfalls?: string[];
    productAreas?: Array<{ name: string; description?: string }>;
    competitors?: Array<{ name: string; url?: string }>;
  };
  branding?: {
    companyName?: string;
    website?: string;
    email?: string;
    tone?: string;
    spelling?: string;
    colors?: { primary?: string };
  };
  sprint?: { enabled?: boolean };
  sales?: { crm?: string; enabled?: boolean };
  marketing?: { linkedin?: { enabled?: boolean; competitors?: string[] } };
  agents?: string[];
}
