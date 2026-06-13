"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { getAPI } from "@/lib/api";
import type { Job } from "@/lib/types";

const SALES_AGENTS = ["sales-development", "sales-researcher", "sales-outreach"];

interface SalesStats {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  byAgent: Record<string, { total: number; succeeded: number; failed: number }>;
}

function computeStats(jobs: Job[]): SalesStats {
  const stats: SalesStats = {
    total: jobs.length,
    succeeded: 0,
    failed: 0,
    running: 0,
    byAgent: {},
  };

  for (const agent of SALES_AGENTS) {
    stats.byAgent[agent] = { total: 0, succeeded: 0, failed: 0 };
  }

  for (const job of jobs) {
    const agent = job.agent || "unknown";
    if (!stats.byAgent[agent]) stats.byAgent[agent] = { total: 0, succeeded: 0, failed: 0 };
    stats.byAgent[agent].total++;
    if (job.status === "succeeded") { stats.succeeded++; stats.byAgent[agent].succeeded++; }
    else if (job.status === "failed") { stats.failed++; stats.byAgent[agent].failed++; }
    else if (job.status === "running") { stats.running++; }
  }

  return stats;
}

const STATUS_COLORS: Record<string, "green" | "red" | "yellow" | "blue" | "zinc"> = {
  succeeded: "green",
  failed: "red",
  running: "blue",
  queued: "yellow",
  cancelled: "zinc",
  "retry-pending": "yellow",
  "quality-gate-retry": "yellow",
};

export function SalesPipeline() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const results = await Promise.all(
          SALES_AGENTS.map((agent) =>
            getAPI()?.listJobs({ agent, limit: 50 }).catch(() => null)
          )
        );
        const allJobs = results
          .filter(Boolean)
          .flatMap((r) => r!.jobs)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setJobs(allJobs);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const stats = computeStats(jobs);

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Total Jobs</p>
          <p className="text-2xl font-bold text-white mt-1">{stats.total}</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Succeeded</p>
          <p className="text-2xl font-bold text-green-400 mt-1">{stats.succeeded}</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Failed</p>
          <p className="text-2xl font-bold text-red-400 mt-1">{stats.failed}</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Running</p>
          <p className="text-2xl font-bold text-blue-400 mt-1">{stats.running}</p>
        </div>
      </div>

      {/* Agent Breakdown */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Agent Breakdown</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {SALES_AGENTS.map((agent) => {
            const agentStats = stats.byAgent[agent] || { total: 0, succeeded: 0, failed: 0 };
            return (
              <div key={agent} className="bg-zinc-800/50 rounded-lg p-3">
                <p className="text-sm font-medium text-teal-400">{agent}</p>
                <div className="flex gap-3 mt-2 text-xs text-zinc-400">
                  <span>{agentStats.total} total</span>
                  <span className="text-green-400">{agentStats.succeeded} ok</span>
                  <span className="text-red-400">{agentStats.failed} fail</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Jobs */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Recent Sales Jobs</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
              <th className="pb-2 pr-4">Agent</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Source</th>
              <th className="pb-2 pr-4">Created</th>
              <th className="pb-2">Duration</th>
            </tr>
          </thead>
          <tbody>
            {jobs.slice(0, 20).map((job) => (
              <tr key={job.id} className="border-b border-zinc-800/50">
                <td className="py-2 pr-4 text-teal-400 text-xs">{job.agent}</td>
                <td className="py-2 pr-4">
                  <Badge color={STATUS_COLORS[job.status] || "zinc"}>{job.status}</Badge>
                </td>
                <td className="py-2 pr-4 text-zinc-400 text-xs truncate max-w-[200px]">
                  {job.source?.workflow || job.source?.triggeredBy || "manual"}
                </td>
                <td className="py-2 pr-4 text-zinc-400 text-xs">
                  {new Date(job.createdAt).toLocaleString()}
                </td>
                <td className="py-2 text-zinc-400 text-xs">
                  {job.duration ? `${Math.round(job.duration / 1000)}s` : "-"}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-zinc-600">
                  No sales jobs yet. Runs will appear here after workflows trigger or manual agent execution.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
