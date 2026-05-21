import type {
  HealthResponse, Job, JobOutput, Agent, RunAgentRequest,
  Stats, Metrics, PMDigest, Batch, Conversation, FailedCallback,
  PaginatedJobs, TaskProgress, SubtaskGroup, JobsQueryParams,
  TeamSessionsResponse, PipelineListResponse, Pipeline, TimelineResponse,
  Worktree, WorktreeListResponse, StreamEvent,
  ScheduledItem, SkillUsageMap,
  Issue, IssueSearchResult, IssueDetail, IssueTransition, Notification,
} from "./types";

// Team config known from runner config.json — enriches agents client-side
const TEAM_CONFIG: Record<string, { teammates: string[]; disallowedTools?: string[] }> = {
  "engineer-planner": {
    teammates: ["engineer-implementer", "ui-engineer", "engineer-reviewer"],
    disallowedTools: ["Edit", "Write", "Bash", "NotebookEdit"],
  },
  "product-manager": {
    teammates: ["ba-agent"],
  },
  "sales-development": {
    teammates: ["sales-researcher", "sales-outreach"],
  },
};

// Map runner's jobId field to dashboard's id field
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapJob(raw: any): Job {
  return {
    ...raw,
    id: raw.jobId || raw.id || "",
    model: raw.selectedModel || raw.model || undefined,
    selectedModel: raw.selectedModel || undefined,
    provider: raw.provider || undefined,
    estimatedCostUsd: raw.usage?.estimatedCostUsd ?? raw.estimatedCostUsd ?? undefined,
    inputTokens: raw.usage?.inputTokens ?? raw.inputTokens ?? undefined,
    outputTokens: raw.usage?.outputTokens ?? raw.outputTokens ?? undefined,
    qualityGate: raw.qualityGate ?? undefined,
    chromeEnabled: raw.chromeEnabled ?? undefined,
    teamSessionId: raw.teamSessionId ?? undefined,
    teamRole: raw.teamRole ?? undefined,
    teammates: raw.teammates ?? undefined,
  };
}

class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "APIError";
  }
}

export class RunnerAPI {
  constructor(private baseUrl: string, private secret: string) {}

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "x-runner-secret": this.secret,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      throw new APIError(res.status, await res.text());
    }
    return res.json();
  }

  // Health (no auth needed)
  async health(): Promise<HealthResponse> {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json();
  }

  // Jobs
  async listJobs(params?: JobsQueryParams): Promise<PaginatedJobs> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.status) qs.set("status", params.status);
    if (params?.agent) qs.set("agent", params.agent);
    if (params?.product) qs.set("product", params.product);
    if (params?.search) qs.set("search", params.search);
    if (params?.sort) qs.set("sort", params.sort);
    if (params?.order) qs.set("order", params.order);
    const query = qs.toString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await this.fetch<any>(`/api/jobs${query ? `?${query}` : ""}`);
    return {
      ...res,
      jobs: (res.jobs || []).map(mapJob),
    } as PaginatedJobs;
  }

  async getJob(id: string): Promise<Job> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await this.fetch<any>(`/jobs/${id}`);
    return mapJob(res.job || res);
  }

  getJobOutput(id: string): Promise<JobOutput> {
    return this.fetch(`/jobs/${id}/output`);
  }

  async getStreamEvents(id: string): Promise<{ events: StreamEvent[]; sessionId: string | null }> {
    return this.fetch(`/jobs/${id}/stream-events`);
  }

  async cancelJob(id: string): Promise<void> {
    await this.fetch(`/jobs/${id}`, { method: "DELETE" });
  }

  retryJob(id: string): Promise<{ jobId: string }> {
    return this.fetch(`/jobs/${id}/retry`, { method: "POST" });
  }

  // Log stream URL (for fetch with ReadableStream)
  getLogStreamUrl(jobId: string): string {
    return `${this.baseUrl}/jobs/${jobId}/log/stream?secret=${encodeURIComponent(this.secret)}`;
  }

  // Agents
  async listAgents(): Promise<Agent[]> {
    const res = await this.fetch<{ agents: Agent[] }>("/agents");
    return res.agents.map((a) => {
      // Server now provides team data; fall back to client-side config
      const team = TEAM_CONFIG[a.name];
      return {
        ...a,
        isTeamLead: a.isTeamLead ?? !!team,
        teammates: a.teammates?.length ? a.teammates : team?.teammates,
        disallowedTools: a.disallowedTools?.length ? a.disallowedTools : team?.disallowedTools,
      };
    });
  }

  // Teams
  async getTeamSessions(): Promise<TeamSessionsResponse> {
    return this.fetch<TeamSessionsResponse>("/api/teams/active");
  }

  runAgent(req: RunAgentRequest): Promise<{ jobId: string }> {
    return this.fetch("/agent", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  // Metrics & Stats
  async getStats(): Promise<Stats> {
    const res = await this.fetch<{ stats: Stats }>("/api/stats");
    return res.stats;
  }

  async getMetrics(): Promise<Metrics> {
    const res = await this.fetch<{ metrics: Metrics }>("/api/metrics");
    return res.metrics;
  }

  async getPMDigest(): Promise<PMDigest> {
    const res = await this.fetch<{ digest: PMDigest }>("/api/pm-digest");
    return res.digest;
  }

  // Batches
  async listBatches(): Promise<Batch[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await this.fetch<{ batches: any[] }>("/api/batches");
    return (res.batches || []).map((b) => ({
      batchId: b.batchId || b.id || "",
      total: b.total ?? b.totalJobs ?? 0,
      completed: b.completed ?? b.completedJobs ?? 0,
      failed: b.failed ?? b.failedJobs ?? 0,
      createdAt: b.createdAt || "",
      resultsCount: b.resultsCount ?? 0,
      slack: b.slack ?? null,
    }));
  }

  async getBatch(id: string): Promise<Batch & { isComplete: boolean }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await this.fetch<any>(`/batches/${id}`);
    const b = res.batch || res;
    return {
      batchId: b.batchId || id,
      total: b.total ?? 0,
      completed: b.completed ?? 0,
      failed: b.failed ?? 0,
      createdAt: b.createdAt || "",
      resultsCount: b.results?.length ?? b.resultsCount ?? 0,
      slack: b.slack ?? null,
      results: b.results,
      isComplete: res.isComplete ?? ((b.completed + b.failed) >= b.total),
    };
  }

  // Conversations
  async listConversations(): Promise<Conversation[]> {
    const res = await this.fetch<{ conversations: Conversation[] }>("/api/conversations");
    return res.conversations;
  }

  getConversation(id: string): Promise<{ messages: unknown[] }> {
    return this.fetch(`/api/conversations/${id}`);
  }

  // Tasks & Subtasks
  getTaskProgress(issueKey: string): Promise<TaskProgress> {
    return this.fetch(`/api/tasks/${encodeURIComponent(issueKey)}`);
  }

  getSubtaskGroup(parentKey: string): Promise<SubtaskGroup> {
    return this.fetch(`/api/subtasks/${encodeURIComponent(parentKey)}`);
  }

  // Pipelines
  async listPipelines(): Promise<PipelineListResponse> {
    return this.fetch<PipelineListResponse>("/api/pipelines");
  }

  async getPipeline(id: string): Promise<Pipeline> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await this.fetch<{ pipeline: any }>(`/pipelines/${id}`);
    const raw = res.pipeline || {};
    return {
      id: raw.pipelineId || raw.id || id,
      issueKey: raw.issueKey || "",
      definition: raw.pipelineType || raw.definition || "",
      status: raw.status || "pending",
      phases: (raw.phases || []).map((ph: Record<string, unknown>) => ({
        name: ph.name || "",
        agent: ph.agent || "",
        status: ph.status || "pending",
        gate: ph.gateResult ?? ph.gate ?? undefined,
        jobId: ph.jobId,
        startedAt: ph.startedAt,
        completedAt: ph.completedAt,
        error: ph.error,
      })),
      currentPhase: raw.currentPhase ?? 0,
      createdAt: raw.createdAt || "",
      updatedAt: raw.updatedAt,
      completedAt: raw.completedAt,
    };
  }

  async cancelPipeline(id: string): Promise<void> {
    await this.fetch(`/pipelines/${id}/cancel`, { method: "POST" });
  }

  async restartPipeline(id: string): Promise<{ pipelineId: string }> {
    return this.fetch(`/pipelines/${id}/restart`, { method: "POST" });
  }

  async getTimeline(issueKey: string): Promise<TimelineResponse> {
    return this.fetch<TimelineResponse>(`/api/timeline/${encodeURIComponent(issueKey)}`);
  }

  // Worktrees
  async listWorktrees(): Promise<Worktree[]> {
    const res = await this.fetch<WorktreeListResponse>("/api/worktrees");
    return res.worktrees;
  }

  async mergeWorktree(id: string): Promise<{ branch: string; output: string }> {
    return this.fetch(`/api/worktrees/${id}/merge`, { method: "POST" });
  }

  async deleteWorktree(id: string, deleteBranch = false): Promise<void> {
    await this.fetch(`/api/worktrees/${id}?deleteBranch=${deleteBranch}`, { method: "DELETE" });
  }

  async createWorktreePR(id: string): Promise<{ prUrl: string }> {
    return this.fetch(`/api/worktrees/${id}/pr`, { method: "POST" });
  }

  // Operations
  async listFailedCallbacks(): Promise<FailedCallback[]> {
    const res = await this.fetch<{ failedCallbacks: FailedCallback[] }>("/api/failed-callbacks");
    return res.failedCallbacks;
  }

  async replayCallback(id: string): Promise<void> {
    await this.fetch(`/api/failed-callbacks/${id}/replay`, { method: "POST" });
  }

  async dismissCallback(id: string): Promise<void> {
    await this.fetch(`/api/failed-callbacks/${id}`, { method: "DELETE" });
  }

  // Scheduled items
  async listScheduled(): Promise<ScheduledItem[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await this.fetch<any>("/api/scheduled");
    const pending: ScheduledItem[] = (res.pending || []).map((i: ScheduledItem) => ({ ...i, status: i.status || "pending" }));
    const done: ScheduledItem[] = (res.done || []).map((i: ScheduledItem) => ({ ...i }));
    return [...pending, ...done];
  }

  async cancelScheduled(id: string): Promise<void> {
    await this.fetch(`/api/scheduled/${id}`, { method: "DELETE" });
  }

  // Skill usage telemetry
  async getSkillUsage(skill?: string): Promise<SkillUsageMap> {
    const qs = skill ? `?skill=${encodeURIComponent(skill)}` : "";
    return this.fetch<SkillUsageMap>(`/api/skill-usage${qs}`);
  }

  // Issues
  async listIssues(params?: { status?: string; type?: string; project?: string; label?: string; assignee?: string; search?: string; limit?: number; offset?: number }): Promise<IssueSearchResult> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.type) qs.set("type", params.type);
    if (params?.project) qs.set("project", params.project);
    if (params?.label) qs.set("label", params.label);
    if (params?.assignee) qs.set("assignee", params.assignee);
    if (params?.search) qs.set("search", params.search);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return this.fetch<IssueSearchResult>(`/api/issues${query ? `?${query}` : ""}`);
  }

  async getIssue(key: string): Promise<IssueDetail> {
    return this.fetch<IssueDetail>(`/api/issues/${encodeURIComponent(key)}`);
  }

  async createIssue(data: { project: string; type?: string; summary: string; description?: string; priority?: string; labels?: string[]; parentKey?: string }): Promise<{ ok: boolean; issue: Issue }> {
    return this.fetch("/api/issues", { method: "POST", body: JSON.stringify(data) });
  }

  async updateIssue(key: string, data: Partial<Issue>): Promise<{ ok: boolean; issue: Issue }> {
    return this.fetch(`/api/issues/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify(data) });
  }

  async deleteIssue(key: string): Promise<void> {
    await this.fetch(`/api/issues/${encodeURIComponent(key)}`, { method: "DELETE" });
  }

  async transitionIssue(key: string, status: string, actor?: string): Promise<{ ok: boolean; issue: Issue }> {
    return this.fetch(`/api/issues/${encodeURIComponent(key)}/transition`, { method: "POST", body: JSON.stringify({ status, actor }) });
  }

  async getIssueTransitions(key: string): Promise<{ ok: boolean; transitions: IssueTransition[] }> {
    return this.fetch(`/api/issues/${encodeURIComponent(key)}/transitions`);
  }

  async addIssueComment(key: string, body: string, author?: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/issues/${encodeURIComponent(key)}/comments`, { method: "POST", body: JSON.stringify({ body, author }) });
  }

  async createIssueLink(sourceKey: string, targetKey: string, linkType: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/issues/${encodeURIComponent(sourceKey)}/link`, { method: "POST", body: JSON.stringify({ targetKey, linkType }) });
  }

  // Notifications
  async listNotifications(): Promise<{ ok: boolean; notifications: Notification[] }> {
    return this.fetch("/api/notifications");
  }

  async getNotificationCount(): Promise<{ ok: boolean; count: number }> {
    return this.fetch("/api/notifications/count");
  }

  async markNotificationRead(id: number): Promise<void> {
    await this.fetch(`/api/notifications/${id}/read`, { method: "POST" });
  }

  async markAllNotificationsRead(): Promise<void> {
    await this.fetch("/api/notifications/read-all", { method: "POST" });
  }
}

let instance: RunnerAPI | null = null;

export function getAPI(): RunnerAPI | null {
  return instance;
}

export function initAPI(baseUrl: string, secret: string): RunnerAPI {
  instance = new RunnerAPI(baseUrl, secret);
  return instance;
}

export { APIError };
