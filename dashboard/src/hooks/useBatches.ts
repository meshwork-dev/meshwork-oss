"use client";

import useSWR from "swr";
import { getAPI } from "@/lib/api";
import type { Batch } from "@/lib/types";

export function useBatches() {
  return useSWR<Batch[]>("batches", async () => {
    const api = getAPI();
    if (!api) throw new Error("Not authenticated");
    return api.listBatches();
  }, { refreshInterval: 30000 });
}
