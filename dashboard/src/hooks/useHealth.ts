"use client";

import useSWR from "swr";
import type { HealthResponse } from "@/lib/types";

export function useHealth(baseUrl: string | null) {
  return useSWR<HealthResponse>(
    baseUrl ? `${baseUrl}/health` : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Health check failed");
      return res.json();
    },
    { refreshInterval: 60000 } // Reduced from 10s; SSE handles real-time
  );
}
