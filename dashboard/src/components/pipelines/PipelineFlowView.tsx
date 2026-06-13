import type { Pipeline, PipelinePhase } from "@/lib/types";

// Status dot color classes
function getStatusDotClass(status: string): string {
  switch (status) {
    case "running":
      return "bg-amber-400 animate-pulse";
    case "succeeded":
      return "bg-emerald-400";
    case "failed":
      return "bg-red-400";
    case "skipped":
      return "bg-zinc-700";
    case "awaiting-approval":
      return "bg-blue-400 animate-pulse";
    default:
      return "bg-zinc-600";
  }
}

// Phase box border/background classes
function getBoxClass(status: string): string {
  switch (status) {
    case "running":
      return "bg-zinc-800/60 border border-amber-500/40 shadow-[0_0_12px_-2px_rgba(245,158,11,0.15)]";
    case "awaiting-approval":
      return "bg-zinc-800/60 border border-blue-500/40 shadow-[0_0_12px_-2px_rgba(59,130,246,0.15)]";
    case "succeeded":
      return "bg-zinc-800/60 border border-emerald-500/20";
    case "failed":
      return "bg-zinc-800/60 border border-red-500/30";
    case "skipped":
      return "bg-zinc-900/40 border border-zinc-800/50 opacity-60";
    default:
      return "bg-zinc-800/60 border border-zinc-700/50";
  }
}

// Arrow color between phases: turns emerald if the source phase succeeded
function getArrowClass(sourceStatus: string): string {
  if (sourceStatus === "succeeded") {
    return "text-emerald-500/70";
  }
  return "text-zinc-700";
}

// Gate type label color
function getGateLabelClass(passed?: boolean): string {
  if (passed === true) return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
  if (passed === false) return "bg-red-500/10 text-red-400 border border-red-500/20";
  return "bg-zinc-800 text-zinc-500 border border-zinc-700/50";
}

function PhaseBox({ phase }: { phase: PipelinePhase }) {
  // Cast to string so helpers and comparisons handle future statuses (e.g. "awaiting-approval")
  const status: string = phase.status;
  const isActive = status === "running" || status === "awaiting-approval";

  return (
    <div
      className={`
        relative flex flex-col gap-1.5 px-3 py-2.5 rounded-lg min-w-[120px] max-w-[160px] shrink-0
        ${getBoxClass(status)}
        ${isActive ? "ring-1 ring-offset-0" : ""}
        ${status === "running" ? "ring-amber-500/30" : ""}
        ${status === "awaiting-approval" ? "ring-blue-500/30" : ""}
        transition-all
      `}
    >
      {/* Status dot + phase name */}
      <div className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full shrink-0 ${getStatusDotClass(status)}`} />
        <span className="font-mono text-xs text-zinc-200 truncate leading-tight">
          {phase.name}
        </span>
      </div>

      {/* Agent name */}
      <span className="text-[11px] text-zinc-500 truncate pl-3.5 leading-tight">
        {phase.agent}
      </span>

      {/* Gate badge or awaiting-approval indicator */}
      {status === "awaiting-approval" ? (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 leading-tight">
          awaiting approval
        </span>
      ) : phase.gate ? (
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded leading-tight truncate ${getGateLabelClass(phase.gate.passed)}`}
          title={`Gate: ${phase.gate.type}${phase.gate.passed === true ? " (passed)" : phase.gate.passed === false ? " (failed)" : ""}`}
        >
          {phase.gate.passed === true
            ? `gate: ${phase.gate.type}`
            : phase.gate.passed === false
            ? `gate: ${phase.gate.type}`
            : `gate: ${phase.gate.type}`}
        </span>
      ) : null}
    </div>
  );
}

function FlowArrow({ sourceStatus }: { sourceStatus: string }) {
  return (
    <span
      aria-hidden="true"
      className={`self-center shrink-0 text-lg leading-none select-none ${getArrowClass(sourceStatus)} hidden sm:block`}
    >
      →
    </span>
  );
}

function MobileArrow({ sourceStatus }: { sourceStatus: string }) {
  return (
    <span
      aria-hidden="true"
      className={`self-center shrink-0 text-sm leading-none select-none ${getArrowClass(sourceStatus)} sm:hidden`}
    >
      ↓
    </span>
  );
}

export function PipelineFlowView({ pipeline }: { pipeline: Pipeline }) {
  const phases = pipeline.phases;

  if (!phases || phases.length === 0) {
    return (
      <p className="text-xs text-zinc-600 text-center py-4">No phases to display</p>
    );
  }

  return (
    <div
      className="
        flex sm:flex-row flex-col
        sm:items-start items-center
        sm:overflow-x-auto
        gap-1
        py-2 px-1
        w-full
      "
      role="list"
      aria-label="Pipeline phases"
    >
      {phases.map((phase, i) => (
        <div
          key={i}
          className="flex sm:flex-row flex-col sm:items-start items-center gap-1"
          role="listitem"
        >
          <PhaseBox phase={phase} />
          {i < phases.length - 1 && (
            <>
              <FlowArrow sourceStatus={phase.status} />
              <MobileArrow sourceStatus={phase.status} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export default PipelineFlowView;
