"use client";

import useSWR from "swr";
import { getAPI } from "@/lib/api";
import type { Job, PaginatedJobs, JobsQueryParams } from "@/lib/types";

export function useJobs(params?: JobsQueryParams) {
  const key = params
    ? `jobs:${JSON.stringify(params)}`
    : "jobs";

  return useSWR<PaginatedJobs>(key, async () => {
    const api = getAPI();
    if (!api) throw new Error("Not authenticated");
    return api.listJobs(params);
  }, { refreshInterval: 30000 }); // Reduced from 5s; SSE handles real-time
}

export function useJob(id: string | null) {
  return useSWR<Job>(id ? `job:${id}` : null, async () => {
    const api = getAPI();
    if (!api || !id) throw new Error("Not authenticated");
    return api.getJob(id);
  }, { refreshInterval: 30000 }); // Reduced from 3s; SSE handles real-time
}
