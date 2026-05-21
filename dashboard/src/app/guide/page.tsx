"use client";

import { useState } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";

const TABS = ["quickstart", "triggers", "agents", "pipelines", "schedules", "api"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  quickstart: "Quick Start",
  triggers: "Triggers",
  agents: "Agents",
  pipelines: "Pipelines",
  schedules: "Schedules",
  api: "API",
};

/* ------------------------------------------------------------------ */
/*  Section Components                                                 */
/* ------------------------------------------------------------------ */

function QuickStartSection() {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>How It Works</CardTitle></CardHeader>
        <p className="text-sm text-zinc-300 leading-relaxed">
          OrchestraCode connects <strong className="text-white">Jira</strong>, <strong className="text-white">Slack</strong>, <strong className="text-white">N8N</strong>, and <strong className="text-white">Claude Code</strong> into
          an automated development pipeline. Tasks flow in from multiple sources, get routed to specialised AI agents,
          and results are posted back automatically.
        </p>
        <div className="mt-4 rounded-lg bg-zinc-950 border border-zinc-800 p-4 text-xs text-zinc-400 font-mono leading-relaxed">
          Jira / Slack / Schedules<br />
          {"  "}→ N8N Workflows (validation, routing)<br />
          {"    "}→ Claude Runner (job queue, agent dispatch)<br />
          {"      "}→ Claude Code (AI execution)<br />
          {"        "}→ Callback → Slack / Jira / Follow-ups
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>Common Use Cases</CardTitle></CardHeader>
        <div className="space-y-3">
          {[
            { title: "Build a new feature", desc: "Create a Jira Story, add label needs-requirements, move to In Progress. Full SDLC pipeline runs automatically.", color: "teal" },
            { title: "Fix a bug", desc: "Create a Bug in Jira. It gets triaged automatically. High/Critical bugs trigger the planner for a fix.", color: "emerald" },
            { title: "Quick code change (no ticket)", desc: "Dashboard → Agents tab → pick engineer-implementer → describe what you need.", color: "blue" },
            { title: "Security review", desc: "Run via Dashboard with security-agent, or add agent:security-review label to a Jira subtask.", color: "amber" },
            { title: "Marketing content", desc: "Create a Jira issue with [Marketing] prefix in the summary.", color: "purple" },
            { title: "Ask about the codebase", desc: "Dashboard → Agents → ask-tom-agent → ask your question.", color: "rose" },
          ].map((item) => (
            <div key={item.title} className="flex gap-3 items-start">
              <span className={`mt-1 w-2 h-2 rounded-full bg-${item.color}-400 shrink-0`} />
              <div>
                <p className="text-sm font-medium text-white">{item.title}</p>
                <p className="text-xs text-zinc-400 mt-0.5">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function TriggersSection() {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Jira Triggers (Automatic)</CardTitle></CardHeader>
        <p className="text-xs text-zinc-400 mb-4">Work in Jira normally — agents respond automatically to these events.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left">
                <th className="py-2 pr-4 text-xs font-medium text-zinc-500 uppercase">What You Do</th>
                <th className="py-2 pr-4 text-xs font-medium text-zinc-500 uppercase">What Happens</th>
                <th className="py-2 text-xs font-medium text-zinc-500 uppercase">Agent</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {[
                ["Create a Bug", "Auto-triaged with severity & root cause", "bug-triage"],
                ["Move Story/Task to In Progress", "Implementation plan created", "engineer-planner"],
                ["Planner posts [AUTO-PLAN]", "Code gets written + tests", "engineer-implementer"],
                ["Implementer posts [AUTO-IMPLEMENT]", "Code review", "engineer-reviewer"],
                ["Reviewer posts [AUTO-REVIEW]", "Acceptance review", "product-manager"],
                ["PM posts [AUTO-ACCEPT]", "PR created + release notes", "engineer-implementer + PM"],
                ["Add label needs-requirements", "Full SDLC pipeline starts", "Pipeline (7 phases)"],
                ["Add label needs-ux-design", "Full pipeline with UX phase", "Pipeline + UX"],
                ["Bug with security-fix label", "Security fix pipeline", "Pipeline (3 phases)"],
                ["Create subtask with agent:* label", "That agent runs the subtask", "Any agent"],
                ["Subtask completed", "Blocked siblings auto-unblock", "Automatic chaining"],
                ["All subtasks Done", "Parent transitions to Done", "Automatic"],
                ["High/Critical bug triaged", "Planner dispatched for fix", "engineer-planner"],
              ].map(([action, result, agent]) => (
                <tr key={action} className="border-b border-zinc-800/50 last:border-0">
                  <td className="py-2.5 pr-4 text-white text-xs font-medium">{action}</td>
                  <td className="py-2.5 pr-4 text-xs">{result}</td>
                  <td className="py-2.5 text-xs"><code className="text-teal-400">{agent}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Dashboard UI</CardTitle></CardHeader>
          <p className="text-xs text-zinc-300">Go to the <strong className="text-teal-400">Agents</strong> tab, pick an agent, type a prompt, and click Run. No Jira ticket needed.</p>
        </Card>
        <Card>
          <CardHeader><CardTitle>Slack DM</CardTitle></CardHeader>
          <p className="text-xs text-zinc-300">Message the Slack PM Bot directly. It routes to the chat endpoint with conversation memory.</p>
        </Card>
        <Card>
          <CardHeader><CardTitle>API</CardTitle></CardHeader>
          <p className="text-xs text-zinc-300">POST to <code className="text-teal-400">/agent</code>, <code className="text-teal-400">/run</code>, <code className="text-teal-400">/chat</code>, or <code className="text-teal-400">/pipeline</code>. See the API tab for details.</p>
        </Card>
      </div>
    </div>
  );
}

function AgentsSection() {
  const agents: { name: string; purpose: string; label: string; model: string }[] = [
    { name: "engineer-planner", purpose: "Breaking down stories into plans, issue linking", label: "agent:planner", model: "Opus" },
    { name: "engineer-implementer", purpose: "Writing code, tests, creating PRs", label: "agent:implementer", model: "Sonnet" },
    { name: "engineer-reviewer", purpose: "Code review (read-only)", label: "agent:reviewer", model: "Opus" },
    { name: "product-manager", purpose: "Acceptance review, release notes, prioritisation", label: "agent:pm", model: "Opus" },
    { name: "ui-engineer", purpose: "Brand-heavy frontend work", label: "agent:ui", model: "Sonnet" },
    { name: "bug-triage", purpose: "Bug severity & root cause analysis", label: "agent:bug-triage", model: "Opus" },
    { name: "security-agent", purpose: "Security review, SAST, scheduled scanning", label: "agent:security-review", model: "Sonnet" },
    { name: "sprint-reporter", purpose: "Velocity reports, daily standups", label: "agent:sprint-report", model: "Sonnet" },
    { name: "marketing", purpose: "Confluence content, website stories", label: "agent:marketing", model: "Sonnet" },
    { name: "creative-assets", purpose: "Images/videos via Z.ai CogView/CogVideoX", label: "agent:creative-assets", model: "Z.ai" },
    { name: "sales-development", purpose: "Sales pipeline lead, Attio CRM", label: "agent:sales-dev", model: "Opus" },
    { name: "sales-researcher", purpose: "Prospect research & enrichment", label: "agent:sales-research", model: "Sonnet" },
    { name: "sales-outreach", purpose: "Cold emails, LinkedIn messages", label: "agent:sales-outreach", model: "Sonnet" },
    { name: "ba-agent", purpose: "Story enrichment, acceptance criteria", label: "agent:ba", model: "Sonnet" },
    { name: "architect-jets", purpose: "System architecture, ADRs", label: "agent:architect", model: "Opus" },
    { name: "ux-agent", purpose: "UX/UI design specifications", label: "agent:ux", model: "Sonnet" },
    { name: "qa-agent", purpose: "Integration/E2E test validation", label: "agent:qa", model: "Sonnet" },
    { name: "ask-tom-agent", purpose: "Troubleshooting, root cause analysis", label: "agent:troubleshoot", model: "Opus" },
    { name: "e2e-builder", purpose: "Full lifecycle: requirements to tests", label: "agent:e2e-builder", model: "Sonnet" },
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Available Agents (19)</CardTitle></CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left">
                <th className="py-2 pr-4 text-xs font-medium text-zinc-500 uppercase">Agent</th>
                <th className="py-2 pr-4 text-xs font-medium text-zinc-500 uppercase">Purpose</th>
                <th className="py-2 pr-4 text-xs font-medium text-zinc-500 uppercase">Jira Label</th>
                <th className="py-2 text-xs font-medium text-zinc-500 uppercase">Model</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {agents.map((a) => (
                <tr key={a.name} className="border-b border-zinc-800/50 last:border-0">
                  <td className="py-2.5 pr-4"><code className="text-teal-400 text-xs">{a.name}</code></td>
                  <td className="py-2.5 pr-4 text-xs">{a.purpose}</td>
                  <td className="py-2.5 pr-4"><code className="text-zinc-400 text-xs">{a.label}</code></td>
                  <td className="py-2.5 text-xs">
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${
                      a.model === "Opus" ? "bg-purple-500/10 text-purple-400" :
                      a.model === "Z.ai" ? "bg-amber-500/10 text-amber-400" :
                      "bg-blue-500/10 text-blue-400"
                    }`}>{a.model}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>Agent Teams</CardTitle></CardHeader>
        <p className="text-xs text-zinc-400 mb-3">Team leads spawn teammates within a single session for seamless handoffs.</p>
        <div className="space-y-3">
          {[
            { lead: "engineer-planner", teammates: ["engineer-implementer", "ui-engineer", "engineer-reviewer"], flow: "Plan → Implement → Review" },
            { lead: "product-manager", teammates: ["ba-agent"], flow: "Acceptance → Story enrichment" },
            { lead: "sales-development", teammates: ["sales-researcher", "sales-outreach"], flow: "Prospecting → Research → Outreach" },
          ].map((team) => (
            <div key={team.lead} className="rounded-lg bg-zinc-950 border border-zinc-800 p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <code className="text-teal-400 text-xs font-bold">{team.lead}</code>
                <span className="text-zinc-600 text-xs">(lead)</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {team.teammates.map((t) => (
                  <code key={t} className="text-xs bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded">{t}</code>
                ))}
              </div>
              <p className="text-xs text-zinc-500">{team.flow}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function PipelinesSection() {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Pipeline Types</CardTitle></CardHeader>
        <p className="text-xs text-zinc-400 mb-4">Pipelines sequence SDLC phases as isolated, retryable jobs with gate checks between each phase.</p>
        <div className="space-y-4">
          {[
            {
              name: "new-feature",
              trigger: "Label: needs-requirements or needs-ux-design",
              phases: ["Requirements (ba-agent)", "Architecture (architect-jets)", "UX Design (ux-agent, optional)", "Implementation (engineer-planner + team)", "Security Review (security-agent, optional)", "QA (qa-agent)", "Acceptance (product-manager)"],
              color: "teal",
            },
            {
              name: "bug-fix",
              trigger: "Default for bugs",
              phases: ["Implementation (engineer-planner + team)", "Acceptance (product-manager)"],
              color: "emerald",
            },
            {
              name: "security-fix",
              trigger: "Label: security-fix or security-vulnerability on bugs",
              phases: ["Implementation (engineer-planner + team)", "Security Review (security-agent)", "Acceptance (product-manager)"],
              color: "amber",
            },
          ].map((p) => (
            <div key={p.name} className="rounded-lg bg-zinc-950 border border-zinc-800 p-4">
              <div className="flex items-center gap-2 mb-1">
                <code className={`text-${p.color}-400 font-bold text-sm`}>{p.name}</code>
                <span className="text-xs text-zinc-500">({p.phases.length} phases)</span>
              </div>
              <p className="text-xs text-zinc-400 mb-3">{p.trigger}</p>
              <div className="flex flex-wrap items-center gap-1">
                {p.phases.map((phase, i) => (
                  <span key={phase} className="flex items-center gap-1">
                    <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded">{phase}</span>
                    {i < p.phases.length - 1 && <span className="text-zinc-600">→</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>Gate Checks</CardTitle></CardHeader>
        <p className="text-xs text-zinc-400 mb-3">Between each phase, a gate must pass before the next phase starts.</p>
        <div className="space-y-2">
          {[
            { gate: "comment-prefix", desc: "Job output contains the expected [AUTO-*] prefix" },
            { gate: "quality-gate", desc: "Type-check + lint + test all pass" },
            { gate: "file-exists", desc: "Specified file exists in working directory" },
          ].map((g) => (
            <div key={g.gate} className="flex gap-3 items-start">
              <code className="text-xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded shrink-0">{g.gate}</code>
              <p className="text-xs text-zinc-300">{g.desc}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function SchedulesSection() {
  const schedules = [
    { name: "Daily Standup", time: "Weekdays 9:00 AM", agent: "sprint-reporter", desc: "Sprint progress, blockers, completed work posted to Slack" },
    { name: "Backlog Grooming", time: "Monday 9:00 AM", agent: "product-manager", desc: "Stale issues reviewed and cleaned" },
    { name: "Outcome Review", time: "Bi-weekly Monday 10:00 AM", agent: "product-manager", desc: "Reviews recently accepted features for bugs/gaps" },
    { name: "Sales Prospecting", time: "Monday 10:00 AM", agent: "sales-development", desc: "Find new prospects from Contracts Finder, ADS Group" },
    { name: "Sales Enrichment", time: "Wednesday 10:00 AM", agent: "sales-development", desc: "Enrich high-priority prospects with missing data" },
    { name: "Sales Outreach", time: "Thursday 10:00 AM", agent: "sales-development", desc: "Draft outreach for hot/warm prospects" },
    { name: "Sales Pipeline Report", time: "Friday 4:00 PM", agent: "sales-development", desc: "Weekly pipeline summary to Confluence + Slack" },
    { name: "Sprint Report", time: "Friday 5:00 PM", agent: "sprint-reporter", desc: "Velocity report with metrics and analysis" },
    { name: "Security Scan", time: "Sunday 8:00 PM", agent: "security-agent", desc: "npm audit + secrets detection, creates Jira issues for findings" },
    { name: "Health Monitor", time: "Every 5 minutes", agent: "system", desc: "Checks /health, alerts Slack if runner goes down" },
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Automated Schedules</CardTitle></CardHeader>
        <p className="text-xs text-zinc-400 mb-4">These run automatically via N8N cron triggers. No manual action needed.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left">
                <th className="py-2 pr-4 text-xs font-medium text-zinc-500 uppercase">Schedule</th>
                <th className="py-2 pr-4 text-xs font-medium text-zinc-500 uppercase">When</th>
                <th className="py-2 pr-4 text-xs font-medium text-zinc-500 uppercase">Agent</th>
                <th className="py-2 text-xs font-medium text-zinc-500 uppercase">What It Does</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {schedules.map((s) => (
                <tr key={s.name} className="border-b border-zinc-800/50 last:border-0">
                  <td className="py-2.5 pr-4 text-white text-xs font-medium">{s.name}</td>
                  <td className="py-2.5 pr-4 text-xs whitespace-nowrap">{s.time}</td>
                  <td className="py-2.5 pr-4"><code className="text-teal-400 text-xs">{s.agent}</code></td>
                  <td className="py-2.5 text-xs">{s.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>Weekly Overview</CardTitle></CardHeader>
        <div className="grid grid-cols-7 gap-1 text-center">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
            <div key={day} className="text-xs font-medium text-zinc-500 py-1">{day}</div>
          ))}
          {[
            ["Standup\nGrooming\nProspecting\nOutcome Review", "", "Standup\nEnrichment", "Standup\nOutreach", "Standup\nPipeline Report\nSprint Report", "", "Security Scan"],
          ][0].map((events, i) => (
            <div key={i} className={`rounded-lg p-1.5 text-xs leading-relaxed min-h-[60px] ${
              events ? "bg-zinc-800/50 text-zinc-400" : "bg-zinc-900/30 text-zinc-600"
            }`}>
              {events ? events.split("\n").map((e, j) => (
                <div key={j} className="truncate">{e}</div>
              )) : "-"}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function APISection() {
  const endpoints = [
    { method: "POST", path: "/agent", desc: "Run any agent directly (no Jira ticket needed)", body: '{ "agent": "engineer-planner", "prompt": "...", "workingDir": "..." }' },
    { method: "POST", path: "/run", desc: "Jira-driven delivery mode", body: '{ "agent": "engineer-planner", "issueKey": "PROJ-123", "workingDir": "..." }' },
    { method: "POST", path: "/chat", desc: "Conversational mode with memory", body: '{ "message": "...", "channel": "slack-dev" }' },
    { method: "POST", path: "/pipeline", desc: "Start a full SDLC pipeline", body: '{ "issueKey": "PROJ-123", "pipelineType": "new-feature", "workingDir": "..." }' },
    { method: "GET", path: "/health", desc: "Queue status (no auth required)", body: null },
    { method: "GET", path: "/agents", desc: "List all available agents", body: null },
    { method: "GET", path: "/jobs/:id", desc: "Get job status", body: null },
    { method: "GET", path: "/jobs/:id/output", desc: "Get parsed job output", body: null },
    { method: "GET", path: "/api/stats", desc: "Aggregated statistics & costs", body: null },
    { method: "GET", path: "/api/metrics", desc: "Detailed per-agent metrics", body: null },
    { method: "GET", path: "/api/pipelines", desc: "List all pipelines", body: null },
    { method: "GET", path: "/api/pm-digest", desc: "Curated PM telemetry digest", body: null },
    { method: "GET", path: "/events", desc: "SSE stream for real-time job events", body: null },
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Authentication</CardTitle></CardHeader>
        <p className="text-xs text-zinc-300 mb-2">All endpoints except <code className="text-teal-400">/health</code> require the runner secret:</p>
        <div className="rounded-lg bg-zinc-950 border border-zinc-800 p-3 font-mono text-xs text-zinc-400">
          <span className="text-zinc-500">Header:</span> <span className="text-teal-400">x-runner-secret</span>: <span className="text-amber-400">your-secret</span>
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>Key Endpoints</CardTitle></CardHeader>
        <div className="space-y-2">
          {endpoints.map((ep) => (
            <div key={ep.path + ep.method} className="rounded-lg bg-zinc-950 border border-zinc-800 p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                  ep.method === "POST" ? "bg-emerald-500/10 text-emerald-400" : "bg-blue-500/10 text-blue-400"
                }`}>{ep.method}</span>
                <code className="text-xs text-white">{ep.path}</code>
              </div>
              <p className="text-xs text-zinc-400">{ep.desc}</p>
              {ep.body && (
                <pre className="mt-2 text-xs text-zinc-500 overflow-x-auto">{ep.body}</pre>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>Example: Run Agent via cURL</CardTitle></CardHeader>
        <pre className="rounded-lg bg-zinc-950 border border-zinc-800 p-3 font-mono text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap">{`curl -X POST http://localhost:3210/agent \\
  -H "x-runner-secret: $SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent": "engineer-planner",
    "prompt": "Plan the implementation of user preferences API",
    "workingDir": "/path/to/repo"
  }'`}</pre>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

function GuidePage() {
  const [tab, setTab] = useState<Tab>("quickstart");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Guide</h2>
        <p className="text-sm text-zinc-400 mt-0.5">How to use OrchestraCode automation — triggers, agents, pipelines, and API</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              tab === t
                ? "border-teal-500 text-teal-400"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "quickstart" && <QuickStartSection />}
      {tab === "triggers" && <TriggersSection />}
      {tab === "agents" && <AgentsSection />}
      {tab === "pipelines" && <PipelinesSection />}
      {tab === "schedules" && <SchedulesSection />}
      {tab === "api" && <APISection />}
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      {({ baseUrl }) => (
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col">
            <Header baseUrl={baseUrl} />
            <main className="flex-1 p-6 overflow-y-auto">
              <GuidePage />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
