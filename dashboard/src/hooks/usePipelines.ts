"use client";

import useSWR from "swr";
import { getAPI } from "@/lib/api";
import type { Pipeline } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizePipeline(raw: any): Pipeline {
  return {
    id: raw.pipelineId || raw.id || "",
    issueKey: raw.issueKey || "",
    definition: raw.pipelineType || raw.definition || "",
    status: raw.status || "pending",
    phases: raw.phases || [],
    currentPhase: raw.currentPhase ?? 0,
    createdAt: raw.createdAt || "",
    updatedAt: raw.updatedAt,
    completedAt: raw.completedAt,
    // Pass through summary fields for list view
    totalPhases: raw.totalPhases,
    completedPhases: raw.completedPhases,
    skippedPhases: raw.skippedPhases,
  } as Pipeline;
}

export function usePipelines() {
  return useSWR<Pipeline[]>("pipelines", async () => {
    const api = getAPI();
    if (!api) throw new Error("Not authenticated");
    const res = await api.listPipelines();
    return (res.pipelines || []).map(normalizePipeline);
  }, { refreshInterval: 15000 });
}
