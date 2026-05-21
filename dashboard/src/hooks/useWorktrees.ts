"use client";

import useSWR from "swr";
import { getAPI } from "@/lib/api";
import type { Worktree } from "@/lib/types";

export function useWorktrees() {
  return useSWR<Worktree[]>("worktrees", async () => {
    const api = getAPI();
    if (!api) throw new Error("Not authenticated");
    return api.listWorktrees();
  }, { refreshInterval: 10000 });
}
