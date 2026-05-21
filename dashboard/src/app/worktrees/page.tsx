"use client";

import { useState } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { useWorktrees } from "@/hooks/useWorktrees";
import { getAPI } from "@/lib/api";
import type { Worktree } from "@/lib/types";

const STATUS_COLORS: Record<string, "green" | "blue" | "yellow" | "red"> = {
  active: "green",
  merged: "blue",
  "pr-created": "blue",
  orphaned: "yellow",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function WorktreeCard({
  wt,
  onRefresh,
}: {
  wt: Worktree;
  onRefresh: () => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(wt.prUrl || null);
  const [error, setError] = useState<string | null>(null);

  async function handleMerge() {
    if (!confirm(`Merge branch "${wt.branch}" into main?`)) return;
    setLoading("merge");
    setError(null);
    try {
      await getAPI()?.mergeWorktree(wt.id);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setLoading(null);
    }
  }

  async function handleCreatePR() {
    setLoading("pr");
    setError(null);
    try {
      const result = await getAPI()?.createWorktreePR(wt.id);
      if (result?.prUrl) setPrUrl(result.prUrl);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "PR creation failed");
    } finally {
      setLoading(null);
    }
  }

  async function handleDelete() {
    const deleteBranch = confirm(
      `Delete worktree for ${wt.issueKey}?\n\nClick OK to also delete the branch "${wt.branch}", or Cancel to keep the branch.`
    );
    setLoading("delete");
    setError(null);
    try {
      await getAPI()?.deleteWorktree(wt.id, deleteBranch);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <span className="text-white font-semibold">{wt.issueKey}</span>
          <span className="text-zinc-500 text-sm font-mono">{wt.branch}</span>
        </div>
        <Badge color={STATUS_COLORS[wt.status] || "yellow"}>
          {wt.status}
        </Badge>
      </div>

      {/* Stats */}
      <div className="px-5 py-3 space-y-1.5 text-sm">
        <div className="flex items-center gap-4 text-zinc-400">
          <span className="text-teal-400 font-medium">
            {wt.commits} commit{wt.commits !== 1 ? "s" : ""} ahead
          </span>
          <span>&middot;</span>
          <span>{wt.filesChanged} file{wt.filesChanged !== 1 ? "s" : ""} changed</span>
        </div>
        {wt.pipelineId && (
          <div className="text-zinc-500">
            Pipeline: <span className="text-zinc-400 font-mono text-xs">{wt.pipelineId}</span>
          </div>
        )}
        {wt.lastJobAgent && (
          <div className="text-zinc-500">
            Last agent: <span className="text-zinc-400">{wt.lastJobAgent}</span>
          </div>
        )}
        <div className="text-zinc-600">Created {timeAgo(wt.createdAt)}</div>
        {prUrl && (
          <div>
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal-400 hover:text-teal-300 text-xs underline"
            >
              {prUrl}
            </a>
          </div>
        )}
        {error && (
          <div className="text-red-400 text-xs mt-1">{error}</div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-5 py-3 border-t border-zinc-800">
        <button
          onClick={handleMerge}
          disabled={!!loading || wt.status === "merged"}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading === "merge" ? "Merging..." : "Merge to Main"}
        </button>
        <button
          onClick={handleCreatePR}
          disabled={!!loading || wt.status === "pr-created" || wt.status === "merged"}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading === "pr" ? "Creating PR..." : "Create PR"}
        </button>
        <button
          onClick={handleDelete}
          disabled={!!loading}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ml-auto"
        >
          {loading === "delete" ? "Deleting..." : "Delete"}
        </button>
      </div>
    </div>
  );
}

function WorktreesPage({ baseUrl }: { baseUrl: string }) {
  const { data: worktrees, error, isLoading, mutate } = useWorktrees();

  // Suppress unused warning — baseUrl is required by AuthGate pattern
  void baseUrl;

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red-400 py-10 text-center">
        Failed to load worktrees: {error.message}
      </div>
    );
  }

  const active = worktrees?.filter((w) => w.status === "active") || [];
  const other = worktrees?.filter((w) => w.status !== "active") || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Worktrees</h2>
        <span className="text-sm text-zinc-500">
          {worktrees?.length || 0} total &middot; {active.length} active
        </span>
      </div>

      {active.length === 0 && other.length === 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-10 text-center text-zinc-600">
          No worktrees. Pipeline jobs with worktree isolation will appear here.
        </div>
      )}

      {active.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
            Active
          </h3>
          {active.map((wt) => (
            <WorktreeCard key={wt.id} wt={wt} onRefresh={() => mutate()} />
          ))}
        </div>
      )}

      {other.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
            Completed / Orphaned
          </h3>
          {other.map((wt) => (
            <WorktreeCard key={wt.id} wt={wt} onRefresh={() => mutate()} />
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
              <WorktreesPage baseUrl={baseUrl} />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
