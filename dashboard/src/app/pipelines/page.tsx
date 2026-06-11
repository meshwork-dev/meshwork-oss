"use client";

import { useState } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { useSSE } from "@/lib/sse";
import { usePipelines } from "@/hooks/usePipelines";
import type { Pipeline, PipelinePhase } from "@/lib/types";
import { getAPI } from "@/lib/api";
import type { TimelineEntry } from "@/lib/types";

const phaseStatusColor: Record<string, string> = {
  pending: "gray",
  running: "yellow",
  succeeded: "green",
  failed: "red",
  skipped: "gray",
};

const pipelineStatusColor: Record<string, string> = {
  pending: "blue",
  running: "yellow",
  succeeded: "green",
  failed: "red",
  cancelled: "gray",
};

function PhaseRow({ phase, index }: { phase: PipelinePhase; index: number }) {
  return (
    <div className="flex items-center gap-3 py-2 px-3 border-b border-zinc-800/50 last:border-0">
      <span className="text-xs text-zinc-600 font-mono w-5">{index + 1}</span>
      <div className={`w-2 h-2 rounded-full ${
        phase.status === "running" ? "bg-amber-400 animate-pulse" :
        phase.status === "succeeded" ? "bg-emerald-400" :
        phase.status === "failed" ? "bg-red-400" :
        "bg-zinc-600"
      }`} />
      <div className="flex-1 min-w-0">
        <span className="text-sm text-zinc-300">{phase.name}</span>
        <span className="text-xs text-zinc-500 ml-2">{phase.agent}</span>
      </div>
      <Badge color={phaseStatusColor[phase.status] || "gray"}>{phase.status}</Badge>
      {phase.gate && (
        <span className={`text-xs px-1.5 py-0.5 rounded ${
          phase.gate.passed ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-800 text-zinc-500"
        }`}>
          gate: {phase.gate.type}
        </span>
      )}
    </div>
  );
}

function PipelineCard({ pipeline, onSelect }: { pipeline: Pipeline; onSelect: (p: Pipeline) => void }) {
  const phases = pipeline.phases || [];
  // Use summary fields from list API if phases aren't loaded
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = pipeline as any;
  const completedPhases = phases.length > 0
    ? phases.filter(ph => ph.status === "succeeded" || ph.status === "skipped").length
    : (p.completedPhases ?? 0) + (p.skippedPhases ?? 0);
  const totalPhases = phases.length > 0 ? phases.length : (p.totalPhases ?? 0);
  const progress = totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : 0;

  return (
    <Card className="cursor-pointer hover:border-zinc-700 transition-colors" >
      <div onClick={() => onSelect(pipeline)}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-teal-400">{pipeline.issueKey}</span>
            <Badge color={pipelineStatusColor[pipeline.status] || "gray"}>{pipeline.status}</Badge>
          </div>
          <span className="text-xs text-zinc-500">{pipeline.definition}</span>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-zinc-800 rounded-full h-1.5 mb-3">
          <div
            className={`h-1.5 rounded-full transition-all ${
              pipeline.status === "failed" ? "bg-red-500" :
              pipeline.status === "succeeded" ? "bg-emerald-500" :
              "bg-teal-500"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Phase summary - only if phases loaded */}
        {phases.length > 0 && (
          <div className="flex items-center gap-1.5">
            {phases.map((phase, i) => (
              <div
                key={i}
                title={`${phase.name} (${phase.agent}): ${phase.status}`}
                className={`h-6 flex-1 rounded-sm flex items-center justify-center text-[10px] font-medium ${
                  phase.status === "running" ? "bg-amber-500/20 text-amber-400" :
                  phase.status === "succeeded" ? "bg-emerald-500/20 text-emerald-400" :
                  phase.status === "failed" ? "bg-red-500/20 text-red-400" :
                  phase.status === "skipped" ? "bg-zinc-800/50 text-zinc-700" :
                  "bg-zinc-800 text-zinc-600"
                }`}
              >
                {phase.name.slice(0, 3).toUpperCase()}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mt-3 text-xs text-zinc-500">
          <span>{completedPhases}/{totalPhases} phases</span>
          <span>{new Date(pipeline.createdAt).toLocaleString()}</span>
        </div>
      </div>
    </Card>
  );
}

const eventIconMap: Record<string, string> = {
  "pipeline:created": "🔵",
  "pipeline:phase-started": "▶",
  "pipeline:phase-complete": "✓",
  "pipeline:gate-passed": "🔓",
  "pipeline:gate-failed": "🔒",
  "pipeline:completed": "✅",
  "pipeline:failed": "❌",
  "job:started": "▶",
  "job:succeeded": "✓",
  "job:failed": "✗",
  "teammate:started": "→",
  "teammate:completed": "←",
};

const eventColor: Record<string, string> = {
  "pipeline:created": "text-blue-400",
  "pipeline:phase-started": "text-amber-400",
  "pipeline:phase-complete": "text-emerald-400",
  "pipeline:gate-passed": "text-emerald-400",
  "pipeline:gate-failed": "text-red-400",
  "pipeline:completed": "text-emerald-400",
  "pipeline:failed": "text-red-400",
  "job:started": "text-amber-400",
  "job:succeeded": "text-emerald-400",
  "job:failed": "text-red-400",
  "teammate:started": "text-teal-400",
  "teammate:completed": "text-teal-400",
};

function TimelineNode({ entry, isTeammate }: { entry: TimelineEntry; isTeammate: boolean }) {
  const icon = eventIconMap[entry.event] || "•";
  const color = eventColor[entry.event] || "text-zinc-400";
  const ts = new Date(entry.timestamp);
  const time = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = ts.toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div className={`relative flex gap-3 ${isTeammate ? "ml-8" : ""}`}>
      {/* Vertical connector line */}
      <div className="flex flex-col items-center">
        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0 ${
          isTeammate
            ? "bg-zinc-800 border border-zinc-700"
            : entry.event.includes("failed") ? "bg-red-500/20 border border-red-500/40"
            : entry.event.includes("complete") || entry.event.includes("succeeded") || entry.event.includes("passed") ? "bg-emerald-500/20 border border-emerald-500/40"
            : entry.event.includes("started") || entry.event.includes("created") ? "bg-amber-500/20 border border-amber-500/40"
            : "bg-zinc-800 border border-zinc-700"
        }`}>
          <span className={`${color} text-[10px]`}>{icon}</span>
        </div>
        <div className="w-px flex-1 bg-zinc-800 min-h-2" />
      </div>

      {/* Content */}
      <div className="pb-4 flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-zinc-600">{date} {time}</span>
          <Badge color={
            entry.agent.includes("planner") ? "blue" :
            entry.agent.includes("implement") ? "green" :
            entry.agent.includes("review") ? "purple" :
            entry.agent.includes("pm") || entry.agent.includes("product") ? "yellow" :
            entry.agent.includes("qa") ? "green" :
            entry.agent.includes("security") ? "red" :
            entry.agent.includes("ux") ? "blue" :
            entry.agent.includes("ba") || entry.agent.includes("architect") ? "blue" :
            "gray"
          }>{entry.agent}</Badge>
          {entry.phase && (
            <span className="text-xs text-zinc-600 font-mono">({entry.phase})</span>
          )}
        </div>
        <p className={`text-sm mt-1 ${color}`}>{entry.event.replace(/^(pipeline|job|teammate):/, "")}</p>
        {entry.detail && (
          <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{entry.detail}</p>
        )}
        {entry.jobId && (
          <a href={`/jobs/${entry.jobId}`} className="text-xs text-teal-500/60 hover:text-teal-400 mt-1 inline-block font-mono">
            {entry.jobId.slice(0, 12)}...
          </a>
        )}
      </div>
    </div>
  );
}

function PipelineTimeline({ issueKey }: { issueKey: string }) {
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

  useState(() => {
    const api = getAPI();
    if (!api) { setLoading(false); return; }
    api.getTimeline(issueKey)
      .then(res => setTimeline(res.entries))
      .catch(() => setTimeline([]))
      .finally(() => setLoading(false));
  });

  if (loading) {
    return <div className="flex justify-center py-6"><Spinner size="sm" /></div>;
  }

  if (!timeline || timeline.length === 0) {
    return <p className="text-sm text-zinc-600 text-center py-6">No timeline entries yet</p>;
  }

  return (
    <div className="pl-1 pt-2">
      {timeline.map((entry, i) => (
        <TimelineNode
          key={i}
          entry={entry}
          isTeammate={entry.event.startsWith("teammate:")}
        />
      ))}
    </div>
  );
}

function PipelineDetail({ pipeline: summary, onBack }: { pipeline: Pipeline; onBack: () => void }) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useState(() => {
    const api = getAPI();
    if (!api) { setLoading(false); return; }
    api.getPipeline(summary.id)
      .then(full => setPipeline(full))
      .catch(() => setPipeline(summary))
      .finally(() => setLoading(false));
  });

  const p = pipeline || summary;
  const phases = p.phases || [];

  const handleCancel = async () => {
    const api = getAPI();
    if (!api || actionLoading) return;
    setActionLoading("cancel");
    try {
      await api.cancelPipeline(p.id);
      setPipeline({ ...p, status: "cancelled" });
    } catch (err) {
      console.warn(`[pipelines] Failed to cancel pipeline ${p.id}:`, err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = async () => {
    const api = getAPI();
    if (!api || actionLoading) return;
    setActionLoading("restart");
    try {
      await api.restartPipeline(p.id);
      onBack(); // go back to list so they see the new pipeline
    } catch (err) {
      console.warn(`[pipelines] Failed to restart pipeline ${p.id}:`, err);
    } finally {
      setActionLoading(null);
    }
  };

  const canCancel = p.status === "running" || p.status === "pending";
  const canRestart = p.status === "failed" || p.status === "cancelled";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-lg text-teal-400">{p.issueKey}</span>
          <Badge color={pipelineStatusColor[p.status] || "gray"}>{p.status}</Badge>
          <span className="text-sm text-zinc-500">{p.definition} pipeline</span>
        </div>
        <div className="flex items-center gap-2">
          {canCancel && (
            <button
              onClick={handleCancel}
              disabled={!!actionLoading}
              className="px-3 py-1.5 text-xs font-medium rounded bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
            >
              {actionLoading === "cancel" ? "Cancelling..." : "Cancel Pipeline"}
            </button>
          )}
          {canRestart && (
            <button
              onClick={handleRestart}
              disabled={!!actionLoading}
              className="px-3 py-1.5 text-xs font-medium rounded bg-teal-500/10 text-teal-400 border border-teal-500/20 hover:bg-teal-500/20 transition-colors disabled:opacity-50"
            >
              {actionLoading === "restart" ? "Restarting..." : "Restart Pipeline"}
            </button>
          )}
          <span className="text-xs text-zinc-500 font-mono">{p.id}</span>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Phases</CardTitle></CardHeader>
        {loading ? (
          <div className="flex justify-center py-6"><Spinner size="sm" /></div>
        ) : phases.length > 0 ? (
          <div>
            {phases.map((phase, i) => (
              <PhaseRow key={i} phase={phase} index={i} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-600 text-center py-6">Phase details not available</p>
        )}
      </Card>

      <Card>
        <CardHeader><CardTitle>Issue Timeline</CardTitle></CardHeader>
        <PipelineTimeline issueKey={p.issueKey} />
      </Card>
    </div>
  );
}

function PipelinesPage() {
  useSSE();
  const { data: pipelines, isLoading } = usePipelines();
  const [selected, setSelected] = useState<Pipeline | null>(null);

  if (isLoading) {
    return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;
  }

  if (selected) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => setSelected(null)}
          className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          &larr; Back to pipelines
        </button>
        <PipelineDetail pipeline={selected} onBack={() => setSelected(null)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Pipelines</h2>
        {pipelines && (
          <span className="text-xs text-zinc-500">{pipelines.length} pipeline{pipelines.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      {(!pipelines || pipelines.length === 0) ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-sm text-zinc-500 mb-2">No pipelines running</p>
            <p className="text-xs text-zinc-600">
              Pipelines are created when issues enter the SDLC workflow via{" "}
              <span className="font-mono text-teal-500/70">POST /pipeline</span>
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4">
          {pipelines.map(p => (
            <PipelineCard key={p.id} pipeline={p} onSelect={setSelected} />
          ))}
        </div>
      )}
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
            <main className="flex-1 p-6">
              <PipelinesPage />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
