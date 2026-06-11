"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { StatCard } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { useHealth } from "@/hooks/useHealth";
import { useSSE } from "@/lib/sse";
import { getAPI } from "@/lib/api";
import type { Stats, Job } from "@/lib/types";
import { StatusBadge } from "@/components/jobs/StatusBadge";
import Link from "next/link";

function Overview({ baseUrl }: { baseUrl: string }) {
  const { data: health } = useHealth(baseUrl);
  const { status: sseStatus } = useSSE();
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  function loadData() {
    const api = getAPI();
    if (!api) return;
    Promise.all([api.getStats(), api.listJobs({ limit: 10 })])
      .then(([s, j]) => {
        setStats(s);
        setRecentJobs(j.jobs.slice(0, 10));
      })
      .catch((err) => console.warn("[overview] Failed to load stats/jobs:", err))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadData();
    // Refresh periodically as backup to SSE
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when SSE receives events (sseStatus changes don't trigger, but the SWR mutate in sse.ts handles it)

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Overview</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          sseStatus === "connected" ? "bg-green-900/30 text-green-400" :
          sseStatus === "connecting" ? "bg-yellow-900/30 text-yellow-400" :
          "bg-zinc-800 text-zinc-500"
        }`}>
          SSE: {sseStatus}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Running" value={health?.running ?? 0} />
        <StatCard label="Queued" value={health?.queued ?? 0} />
        <StatCard label="Total Jobs" value={health?.jobs ?? stats?.totalJobs ?? 0} />
        <StatCard
          label="Total Cost"
          value={stats ? `$${(stats.metrics?.totalCostUsd ?? 0).toFixed(2)}` : "$0.00"}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Succeeded" value={stats?.recentSucceeded ?? 0} />
        <StatCard label="Failed" value={stats?.recentFailed ?? 0} />
        <StatCard
          label="Success Rate"
          value={stats && stats.totalJobs > 0 ? `${Math.round((stats.recentSucceeded / stats.totalJobs) * 100)}%` : "N/A"}
        />
        <StatCard
          label="Uptime"
          value={health?.uptime ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m` : "-"}
        />
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Recent Jobs</h3>
        <div className="space-y-2">
          {recentJobs.map((job) => (
            <Link key={job.id} href={`/jobs/${job.id}`} className="flex items-center justify-between py-2 border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30 px-2 rounded transition-colors">
              <div className="flex items-center gap-3">
                <StatusBadge status={job.status} />
                <span className="text-sm text-zinc-300">{job.agent || job.mode}</span>
                {job.issueKey && <span className="text-xs text-zinc-500 font-mono">{job.issueKey}</span>}
              </div>
              <span className="text-xs text-zinc-500 font-mono">{job.id.slice(0, 8)}</span>
            </Link>
          ))}
          {recentJobs.length === 0 && (
            <p className="text-sm text-zinc-600 text-center py-4">No jobs yet</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <AuthGate>
      {({ baseUrl }) => (
        <div className="flex flex-col min-h-screen md:flex-row">
          <Sidebar />
          <div className="flex-1 flex flex-col pb-14 md:pb-0">
            <Header baseUrl={baseUrl} />
            <main className="flex-1 p-2 sm:p-4 md:p-6">
              <Overview baseUrl={baseUrl} />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
