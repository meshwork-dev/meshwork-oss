"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import type { Batch } from "@/lib/types";

function timeAgo(date: string) {
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function batchStatus(b: Batch): { label: string; color: string } {
  const done = b.completed + b.failed;
  if (done >= b.total && b.total > 0) {
    return b.failed > 0
      ? { label: "completed (with failures)", color: "yellow" }
      : { label: "completed", color: "green" };
  }
  if (done > 0) return { label: "running", color: "blue" };
  return { label: "pending", color: "gray" };
}

function ProgressBar({ completed, failed, total }: { completed: number; failed: number; total: number }) {
  if (total === 0) return <span className="text-xs text-zinc-600">--</span>;
  const successPct = Math.round((completed / total) * 100);
  const failPct = Math.round((failed / total) * 100);

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full flex">
          {successPct > 0 && (
            <div
              className="bg-emerald-500 transition-all duration-300"
              style={{ width: `${successPct}%` }}
            />
          )}
          {failPct > 0 && (
            <div
              className="bg-red-500 transition-all duration-300"
              style={{ width: `${failPct}%` }}
            />
          )}
        </div>
      </div>
      <span className="text-xs text-zinc-500 tabular-nums w-12 text-right">
        {completed + failed}/{total}
      </span>
    </div>
  );
}

const STATUS_FILTERS = ["all", "pending", "running", "completed"] as const;

export function BatchList({ batches }: { batches: Batch[] }) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(batchId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }

  const filtered = batches.filter((b) => {
    if (statusFilter === "all") return true;
    return batchStatus(b).label.startsWith(statusFilter);
  });

  return (
    <div>
      {/* Status filter */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === f
                  ? "bg-teal-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <span className="text-xs text-zinc-500 ml-auto">
          {filtered.length} batch{filtered.length !== 1 ? "es" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
              <th className="pb-2 pr-4 w-6"></th>
              <th className="pb-2 pr-4">Batch ID</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Progress</th>
              <th className="pb-2 pr-4">Completed</th>
              <th className="pb-2 pr-4">Failed</th>
              <th className="pb-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => {
              const st = batchStatus(b);
              const isExpanded = expanded.has(b.batchId);
              const hasResults = b.resultsCount > 0;

              return (
                <tr key={b.batchId} className="group">
                  <td colSpan={7} className="p-0">
                    <table className="w-full">
                      <tbody>
                        <tr
                          className={`border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors ${
                            hasResults ? "cursor-pointer" : ""
                          }`}
                          onClick={() => hasResults && toggleExpand(b.batchId)}
                        >
                          <td className="py-2.5 pr-4 w-6 text-zinc-600">
                            {hasResults && (
                              <span className="text-xs">{isExpanded ? "\u25BC" : "\u25B6"}</span>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 text-teal-400 font-mono text-xs">
                            {b.batchId.length > 20 ? b.batchId.slice(0, 20) + "..." : b.batchId}
                          </td>
                          <td className="py-2.5 pr-4">
                            <Badge color={st.color}>{st.label}</Badge>
                          </td>
                          <td className="py-2.5 pr-4 w-48">
                            <ProgressBar completed={b.completed} failed={b.failed} total={b.total} />
                          </td>
                          <td className="py-2.5 pr-4 text-emerald-400 tabular-nums">{b.completed}</td>
                          <td className="py-2.5 pr-4 text-red-400 tabular-nums">{b.failed}</td>
                          <td className="py-2.5 text-zinc-500 text-xs">{timeAgo(b.createdAt)}</td>
                        </tr>
                        {isExpanded && b.results && b.results.length > 0 && (
                          <tr>
                            <td colSpan={7} className="px-8 pb-3 pt-1">
                              <div className="bg-zinc-800/50 rounded-lg p-3">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-zinc-500 uppercase tracking-wider">
                                      <th className="text-left pb-1.5 pr-3">Job ID</th>
                                      <th className="text-left pb-1.5 pr-3">Issue</th>
                                      <th className="text-left pb-1.5 pr-3">Status</th>
                                      <th className="text-left pb-1.5">Completed</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {b.results.map((r, i) => (
                                      <tr key={i} className="border-t border-zinc-700/50">
                                        <td className="py-1.5 pr-3 font-mono text-teal-400">
                                          {r.jobId ? r.jobId.slice(0, 12) : "--"}
                                        </td>
                                        <td className="py-1.5 pr-3 text-zinc-400">{r.issueKey || "--"}</td>
                                        <td className="py-1.5 pr-3">
                                          <Badge color={r.status === "succeeded" ? "green" : r.status === "failed" ? "red" : "gray"}>
                                            {r.status}
                                          </Badge>
                                        </td>
                                        <td className="py-1.5 text-zinc-500">
                                          {r.completedAt ? timeAgo(r.completedAt) : "--"}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-zinc-600">
                  {statusFilter === "all" ? "No batches" : `No ${statusFilter} batches`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
