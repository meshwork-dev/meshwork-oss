"use client";

import { useEffect, useRef, useState } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { useSSE } from "@/lib/sse";
import { usePipelines } from "@/hooks/usePipelines";
import type { Agent, Pipeline, PipelinePhase, PipelineDefinition, PipelineRoutingRule } from "@/lib/types";
import { getAPI } from "@/lib/api";
import type { TimelineEntry } from "@/lib/types";
import { PipelineFlowView } from "@/components/pipelines/PipelineFlowView";

const phaseStatusColor: Record<string, string> = {
  pending: "gray",
  running: "yellow",
  succeeded: "green",
  completed: "green",
  failed: "red",
  skipped: "gray",
  "awaiting-approval": "blue",
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
        phase.status === "awaiting-approval" ? "bg-blue-400 animate-pulse" :
        phase.status === "succeeded" || phase.status === "completed" ? "bg-emerald-400" :
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

  useEffect(() => {
    const api = getAPI();
    if (!api) { setLoading(false); return; }
    setLoading(true);
    api.getTimeline(issueKey)
      .then(res => setTimeline(res.entries))
      .catch(() => setTimeline([]))
      .finally(() => setLoading(false));
  }, [issueKey]);

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

  useEffect(() => {
    const api = getAPI();
    if (!api) { setLoading(false); return; }
    setLoading(true);
    api.getPipeline(summary.id)
      .then(full => setPipeline(full))
      .catch(() => setPipeline(summary))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.id]);

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
  const awaitingApprovalPhase = phases.find(ph => ph.status === "awaiting-approval");

  const handleApprove = async () => {
    const api = getAPI();
    if (!api || actionLoading) return;
    setActionLoading("approve");
    try {
      await api.approvePipeline(p.id);
      setPipeline({ ...p, phases: p.phases.map(ph =>
        ph.status === "awaiting-approval" ? { ...ph, status: "completed" } : ph
      )});
    } catch (err) {
      console.warn("Failed to approve:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    const api = getAPI();
    if (!api || actionLoading) return;
    setActionLoading("reject");
    try {
      await api.rejectPipeline(p.id);
      setPipeline({ ...p, status: "failed" });
    } catch (err) {
      console.warn("Failed to reject:", err);
    } finally {
      setActionLoading(null);
    }
  };

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
          {awaitingApprovalPhase && (
            <>
              <button
                onClick={handleApprove}
                disabled={!!actionLoading}
                className="px-3 py-1.5 text-xs font-medium rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
              >
                {actionLoading === "approve" ? "Approving..." : `Approve "${awaitingApprovalPhase.name}"`}
              </button>
              <button
                onClick={handleReject}
                disabled={!!actionLoading}
                className="px-3 py-1.5 text-xs font-medium rounded bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                {actionLoading === "reject" ? "Rejecting..." : "Reject"}
              </button>
            </>
          )}
          <span className="text-xs text-zinc-500 font-mono">{p.id}</span>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Phases</CardTitle></CardHeader>
        {loading ? (
          <div className="flex justify-center py-6"><Spinner size="sm" /></div>
        ) : phases.length > 0 ? (
          <>
            <div className="px-3 pb-2 border-b border-zinc-800/50">
              <PipelineFlowView pipeline={p} />
            </div>
            <div>
              {phases.map((phase, i) => (
                <PhaseRow key={i} phase={phase} index={i} />
              ))}
            </div>
          </>
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

const GATE_TYPES = ["none", "quality-gate", "comment-prefix", "file-exists", "human-approval"] as const;
type GateType = typeof GATE_TYPES[number];

interface PhaseInput {
  name: string;
  agent: string;
  gateType: GateType;
  gatePrefix: string;
  gateFile: string;
  maxRetries: number | null;
  maxCostUsd: number | null;
}

function emptyPhase(): PhaseInput {
  return { name: "", agent: "", gateType: "none", gatePrefix: "", gateFile: "", maxRetries: null, maxCostUsd: null };
}

function PipelineBuilder({ agents, onClose, onCreated }: {
  agents: Agent[];
  onClose: () => void;
  onCreated: (pipelineId: string) => void;
}) {
  const [issueKey, setIssueKey] = useState("");
  const [description, setDescription] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [phases, setPhases] = useState<PhaseInput[]>([emptyPhase()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Template load
  const [definitions, setDefinitions] = useState<PipelineDefinition[]>([]);
  useEffect(() => {
    const api = getAPI();
    if (!api) return;
    api.listPipelineDefinitions().then(setDefinitions).catch(() => {});
  }, []);

  // Save as template
  const [saveMode, setSaveMode] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const updatePhase = (i: number, patch: Partial<PhaseInput>) => {
    setPhases(prev => prev.map((p, idx) => idx === i ? { ...p, ...patch } : p));
  };

  const addPhase = () => setPhases(prev => [...prev, emptyPhase()]);

  const removePhase = (i: number) => {
    setPhases(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev);
  };

  const movePhase = (i: number, dir: -1 | 1) => {
    setPhases(prev => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const buildPhasePayload = () => phases.map(p => ({
    name: p.name.trim(),
    agent: p.agent,
    ...(p.gateType !== "none" ? {
      gate: {
        type: p.gateType,
        ...(p.gateType === "comment-prefix" ? { prefix: p.gatePrefix.trim() } : {}),
        ...(p.gateType === "file-exists" ? { file: p.gateFile.trim() } : {}),
      },
    } : {}),
    ...(p.maxRetries != null ? { maxRetries: p.maxRetries } : {}),
    ...(p.maxCostUsd != null ? { maxCostUsd: p.maxCostUsd } : {}),
  }));

  const handleSubmit = async () => {
    setError(null);
    if (!issueKey.trim()) { setError("Issue key is required"); return; }
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      if (!p.name.trim()) { setError(`Phase ${i + 1}: name is required`); return; }
      if (!p.agent) { setError(`Phase ${i + 1}: agent is required`); return; }
      if (p.gateType === "comment-prefix" && !p.gatePrefix.trim()) {
        setError(`Phase ${i + 1}: gate prefix is required`); return;
      }
      if (p.gateType === "file-exists" && !p.gateFile.trim()) {
        setError(`Phase ${i + 1}: gate file path is required`); return;
      }
    }
    const api = getAPI();
    if (!api) { setError("Not connected"); return; }
    setSubmitting(true);
    try {
      const res = await api.createPipeline({
        issueKey: issueKey.trim(),
        description: description.trim() || undefined,
        workingDir: workingDir.trim() || undefined,
        phases: buildPhasePayload(),
      });
      onCreated(res.pipelineId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create pipeline");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveTemplate = async () => {
    setSaveError(null);
    if (!saveName.trim()) { setSaveError("Template name is required"); return; }
    if (!/^[a-z0-9-]+$/.test(saveName.trim())) {
      setSaveError("Name must match /^[a-z0-9-]+$/"); return;
    }
    const api = getAPI();
    if (!api) { setSaveError("Not connected"); return; }
    try {
      await api.savePipelineDefinition({
        name: saveName.trim(),
        description: description.trim() || undefined,
        phases: buildPhasePayload(),
      });
      setSaveSuccess(true);
      setTimeout(() => {
        setSaveSuccess(false);
        setSaveMode(false);
        setSaveName("");
        // Refresh the definitions list
        api.listPipelineDefinitions().then(setDefinitions).catch(() => {});
      }, 2000);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Failed to save template");
    }
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-white">New Pipeline</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Top fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Issue Key <span className="text-red-400">*</span></label>
              <input
                value={issueKey}
                onChange={e => setIssueKey(e.target.value)}
                placeholder="PRJ-42"
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-teal-500"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Working Directory</label>
              <input
                value={workingDir}
                onChange={e => setWorkingDir(e.target.value)}
                placeholder="(default)"
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-teal-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Description</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional description"
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-teal-500"
            />
          </div>

          {/* Load Template */}
          {definitions.length > 0 && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Start from template</label>
              <select
                onChange={async e => {
                  const name = e.target.value;
                  if (!name) return;
                  const api = getAPI();
                  if (!api) return;
                  try {
                    const def = await api.getPipelineDefinition(name);
                    setPhases(def.phases.map(p => {
                      const pAny = p as { maxRetries?: number | null; maxCostUsd?: number | null };
                      return {
                        name: p.name,
                        agent: p.agent,
                        gateType: (p.gate?.type ?? "none") as GateType,
                        gatePrefix: p.gate?.prefix ?? "",
                        gateFile: p.gate?.file ?? "",
                        maxRetries: pAny.maxRetries ?? null,
                        maxCostUsd: pAny.maxCostUsd ?? null,
                      };
                    }));
                    if (def.description) setDescription(def.description);
                  } catch { /* ignore */ }
                  e.target.value = "";
                }}
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 focus:outline-none focus:border-teal-500"
              >
                <option value="">— load template (optional) —</option>
                {definitions.map(d => (
                  <option key={d.name} value={d.name}>{d.name}{d.builtin ? " (built-in)" : ""}</option>
                ))}
              </select>
            </div>
          )}

          {/* Phases */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-zinc-400 font-medium">Phases</label>
              <button
                onClick={addPhase}
                disabled={phases.length >= 20}
                className="text-xs text-teal-400 hover:text-teal-300 disabled:opacity-40"
              >
                + Add phase
              </button>
            </div>

            <div className="space-y-2">
              {phases.map((phase, i) => (
                <div key={i} className="bg-zinc-800/60 border border-zinc-700/50 rounded-lg p-3 space-y-2">
                  {/* Phase header row */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-600 font-mono w-5 shrink-0">{i + 1}</span>
                    <input
                      value={phase.name}
                      onChange={e => updatePhase(i, { name: e.target.value })}
                      placeholder="phase-name"
                      className="flex-1 px-2.5 py-1.5 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-teal-500 font-mono"
                    />
                    <select
                      value={phase.agent}
                      onChange={e => updatePhase(i, { agent: e.target.value })}
                      className="flex-1 px-2.5 py-1.5 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-200 focus:outline-none focus:border-teal-500"
                    >
                      <option value="">— agent —</option>
                      {agents.map(a => (
                        <option key={a.name} value={a.name}>{a.name}</option>
                      ))}
                    </select>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => movePhase(i, -1)}
                        disabled={i === 0}
                        className="text-zinc-600 hover:text-zinc-400 disabled:opacity-20 text-xs px-1"
                        title="Move up"
                      >↑</button>
                      <button
                        onClick={() => movePhase(i, 1)}
                        disabled={i === phases.length - 1}
                        className="text-zinc-600 hover:text-zinc-400 disabled:opacity-20 text-xs px-1"
                        title="Move down"
                      >↓</button>
                      <button
                        onClick={() => removePhase(i)}
                        disabled={phases.length === 1}
                        className="text-zinc-600 hover:text-red-400 disabled:opacity-20 text-xs px-1"
                        title="Remove"
                      >✕</button>
                    </div>
                  </div>

                  {/* Gate row */}
                  <div className="flex items-center gap-2 pl-7">
                    <span className="text-xs text-zinc-600 shrink-0">gate:</span>
                    <select
                      value={phase.gateType}
                      onChange={e => updatePhase(i, { gateType: e.target.value as GateType })}
                      className="px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-400 focus:outline-none focus:border-teal-500"
                    >
                      {GATE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {phase.gateType === "comment-prefix" && (
                      <input
                        value={phase.gatePrefix}
                        onChange={e => updatePhase(i, { gatePrefix: e.target.value })}
                        placeholder="[AUTO-REVIEW]"
                        className="flex-1 px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-teal-500 font-mono"
                      />
                    )}
                    {phase.gateType === "file-exists" && (
                      <input
                        value={phase.gateFile}
                        onChange={e => updatePhase(i, { gateFile: e.target.value })}
                        placeholder=".meshwork/done.txt"
                        className="flex-1 px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-teal-500 font-mono"
                      />
                    )}
                  </div>

                  {/* Retry budget row */}
                  <div className="flex items-center gap-2 pl-7 mt-1">
                    <span className="text-xs text-zinc-600 shrink-0">retries:</span>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={phase.maxRetries ?? ""}
                      onChange={e => updatePhase(i, { maxRetries: e.target.value === "" ? null : parseInt(e.target.value, 10) })}
                      placeholder="default"
                      className="w-20 px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-teal-500"
                    />
                    <span className="text-xs text-zinc-600 shrink-0">max cost $:</span>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={phase.maxCostUsd ?? ""}
                      onChange={e => updatePhase(i, { maxCostUsd: e.target.value === "" ? null : parseFloat(e.target.value) })}
                      placeholder="none"
                      className="w-24 px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-teal-500"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-zinc-800">
          {saveMode ? (
            <div className="flex items-center gap-2 w-full">
              <input
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                placeholder="template-name"
                className="flex-1 px-3 py-2 text-xs bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-teal-500 font-mono"
              />
              <button
                onClick={handleSaveTemplate}
                className="px-3 py-2 text-xs font-medium rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
              >
                Save
              </button>
              <button
                onClick={() => { setSaveMode(false); setSaveError(null); setSaveName(""); }}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
              {saveError && <span className="text-xs text-red-400">{saveError}</span>}
              {saveSuccess && <span className="text-xs text-emerald-400">Saved!</span>}
            </div>
          ) : (
            <>
              <button
                onClick={() => setSaveMode(true)}
                className="mr-auto px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Save as template
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-50 transition-colors"
              >
                {submitting ? "Starting..." : "Start Pipeline"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const ISSUE_TYPE_OPTIONS = ["any", "story", "bug", "subtask", "task", "epic"] as const;

function PipelineRoutingCard({ definitions }: { definitions: PipelineDefinition[] }) {
  const [rules, setRules] = useState<PipelineRoutingRule[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    const api = getAPI();
    if (!api) return;
    api.listPipelineRouting().then(setRules).catch(() => {});
  }, []);

  const markDirty = () => setDirty(true);

  type RulePatch =
    | { field: "pipelineType"; value: string }
    | { field: "issueType"; value: string }
    | { field: "labelsStr"; value: string };

  const updateRule = (i: number, patch: RulePatch) => {
    setRules(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      if (patch.field === "pipelineType") {
        return { ...r, pipelineType: patch.value };
      }
      if (patch.field === "issueType") {
        return {
          ...r,
          match: {
            ...r.match,
            issueType: patch.value === "any" ? undefined : patch.value,
          },
        };
      }
      // labelsStr
      const labels = patch.value.split(",").map(s => s.trim()).filter(Boolean);
      return {
        ...r,
        match: {
          ...r.match,
          labels: labels.length > 0 ? labels : undefined,
        },
      };
    }));
    markDirty();
  };

  const addRule = () => {
    setRules(prev => [...prev, { match: {}, pipelineType: "" }]);
    markDirty();
  };

  const removeRule = (i: number) => {
    setRules(prev => prev.filter((_, idx) => idx !== i));
    markDirty();
  };

  const moveRule = (i: number, dir: -1 | 1) => {
    setRules(prev => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    markDirty();
  };

  const handleSave = async () => {
    setSaveError(null);
    const api = getAPI();
    if (!api) return;
    setSaving(true);
    try {
      await api.savePipelineRouting(rules);
      setDirty(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Failed to save routing rules");
    } finally {
      setSaving(false);
    }
  };

  const canSave = dirty && !saving && rules.every(r => r.pipelineType !== "");

  return (
    <Card>
      {/* Toggle header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-zinc-300">
          Pipeline Routing {collapsed ? "▸" : "▾"}
        </span>
        <span className="text-xs text-zinc-500">{rules.length} rule{rules.length !== 1 ? "s" : ""}</span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-3 border-t border-zinc-800/50 pt-3">
          {rules.length === 0 ? (
            <p className="text-xs text-zinc-600 text-center py-2">No routing rules. Add one below.</p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule, i) => (
                <div key={i} className="bg-zinc-800/60 border border-zinc-700/50 rounded-lg p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-zinc-500 shrink-0 font-mono w-4">{i + 1}</span>

                    {/* Issue type */}
                    <select
                      value={rule.match.issueType ?? "any"}
                      onChange={e => updateRule(i, { field: "issueType", value: e.target.value })}
                      className="px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-300 focus:outline-none focus:border-teal-500"
                    >
                      {ISSUE_TYPE_OPTIONS.map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>

                    {/* Labels */}
                    <input
                      value={(rule.match.labels ?? []).join(", ")}
                      onChange={e => updateRule(i, { field: "labelsStr", value: e.target.value })}
                      placeholder="labels (comma-separated)"
                      className="flex-1 min-w-[120px] px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-teal-500"
                    />

                    <span className="text-xs text-zinc-500 shrink-0">→</span>

                    {/* Pipeline type */}
                    <select
                      value={rule.pipelineType}
                      onChange={e => updateRule(i, { field: "pipelineType", value: e.target.value })}
                      className="px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-300 focus:outline-none focus:border-teal-500"
                    >
                      <option value="">— pipeline type —</option>
                      {definitions.map(d => (
                        <option key={d.name} value={d.name}>{d.name}{d.builtin ? " (built-in)" : ""}</option>
                      ))}
                    </select>

                    {/* Reorder + remove */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => moveRule(i, -1)}
                        disabled={i === 0}
                        className="text-zinc-600 hover:text-zinc-400 disabled:opacity-20 text-xs px-1"
                        title="Move up"
                      >↑</button>
                      <button
                        onClick={() => moveRule(i, 1)}
                        disabled={i === rules.length - 1}
                        className="text-zinc-600 hover:text-zinc-400 disabled:opacity-20 text-xs px-1"
                        title="Move down"
                      >↓</button>
                      <button
                        onClick={() => removeRule(i)}
                        className="text-zinc-600 hover:text-red-400 text-xs px-1"
                        title="Remove"
                      >✕</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={addRule}
              className="text-xs text-teal-400 hover:text-teal-300"
            >
              + Add rule
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="ml-auto px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-40 transition-colors"
            >
              {saving ? "Saving..." : "Save routing"}
            </button>
            {saveError && <span className="text-xs text-red-400">{saveError}</span>}
            {saveSuccess && <span className="text-xs text-emerald-400">Saved!</span>}
          </div>
        </div>
      )}
    </Card>
  );
}

function PipelinesPage() {
  useSSE();
  const { data: pipelines, isLoading, mutate: refreshPipelines } = usePipelines();
  const [selected, setSelected] = useState<Pipeline | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [definitions, setDefinitions] = useState<PipelineDefinition[]>([]);

  useEffect(() => {
    const api = getAPI();
    if (!api) return;
    api.listAgents().then(setAgents).catch(() => {});
    api.listPipelineDefinitions().then(setDefinitions).catch(() => {});
  }, []);

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
    <>
      {showBuilder && (
        <PipelineBuilder
          agents={agents}
          onClose={() => setShowBuilder(false)}
          onCreated={() => {
            setShowBuilder(false);
            refreshPipelines();
          }}
        />
      )}

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-white">Pipelines</h2>
          <div className="flex items-center gap-3">
            {pipelines && (
              <span className="text-xs text-zinc-500">{pipelines.length} pipeline{pipelines.length !== 1 ? "s" : ""}</span>
            )}
            <button
              onClick={() => setShowBuilder(true)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 text-white hover:bg-teal-500 transition-colors"
            >
              + New Pipeline
            </button>
          </div>
        </div>

        {(!pipelines || pipelines.length === 0) ? (
          <Card>
            <div className="text-center py-8">
              <p className="text-sm text-zinc-500 mb-2">No pipelines running</p>
              <p className="text-xs text-zinc-600">
                Start one with the button above or via{" "}
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

        <PipelineRoutingCard definitions={definitions} />
      </div>
    </>
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
