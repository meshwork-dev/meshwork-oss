"use client";

import Link from "next/link";
import type { Job, JobsQueryParams } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

function timeAgo(date: string) {
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface JobsTableProps {
  jobs: Job[];
  pagination?: { page: number; limit: number; total: number; pages: number };
  params?: JobsQueryParams;
  onParamsChange?: (params: JobsQueryParams) => void;
}

const STATUS_FILTERS = ["all", "running", "queued", "succeeded", "failed", "cancelled"] as const;

export function JobsTable({ jobs, pagination, params, onParamsChange }: JobsTableProps) {
  const currentStatus = params?.status || "all";
  const currentSearch = params?.search || "";
  const currentAgent = params?.agent || "";
  const currentProduct = params?.product || "";

  function updateParams(updates: Partial<JobsQueryParams>) {
    onParamsChange?.({ ...params, page: 1, ...updates });
  }

  // Collect unique agents and products from current results for dropdowns
  const agents = [...new Set(jobs.map((j) => j.agent).filter(Boolean))] as string[];
  const productSet = new Map<string, string>();
  for (const j of jobs) {
    if (j.product?.id) productSet.set(j.product.id, j.product.name);
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Status filter buttons */}
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => updateParams({ status: f === "all" ? undefined : f })}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                currentStatus === f || (f === "all" && !currentStatus)
                  ? "bg-teal-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {/* Agent filter */}
        {agents.length > 0 && (
          <select
            value={currentAgent}
            onChange={(e) => updateParams({ agent: e.target.value || undefined })}
            className="px-2.5 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-300 border border-zinc-700 focus:outline-none focus:border-teal-500"
          >
            <option value="">All Agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        )}

        {/* Product filter */}
        {productSet.size > 0 && (
          <select
            value={currentProduct}
            onChange={(e) => updateParams({ product: e.target.value || undefined })}
            className="px-2.5 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-300 border border-zinc-700 focus:outline-none focus:border-teal-500"
          >
            <option value="">All Products</option>
            {[...productSet.entries()].map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        )}

        {/* Search */}
        <input
          type="text"
          value={currentSearch}
          onChange={(e) => updateParams({ search: e.target.value || undefined })}
          placeholder="Search jobs..."
          className="px-3 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-300 border border-zinc-700 placeholder:text-zinc-600 focus:outline-none focus:border-teal-500 w-48"
        />

        {/* Total count */}
        {pagination && (
          <span className="text-xs text-zinc-500 ml-auto">
            {pagination.total} jobs
          </span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
              <th className="pb-2 pr-4">ID</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Product</th>
              <th className="pb-2 pr-4">Agent</th>
              <th className="pb-2 pr-4">Issue</th>
              <th className="pb-2 pr-4">Provider</th>
              <th className="pb-2 pr-4">Model</th>
              <th className="pb-2 pr-4">QG</th>
              <th className="pb-2 pr-4">Cost</th>
              <th className="pb-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                <td className="py-2.5 pr-4">
                  <Link href={`/jobs/${job.id}`} className="text-teal-400 hover:text-teal-300 font-mono text-xs">
                    {job.id.slice(0, 12)}
                  </Link>
                </td>
                <td className="py-2.5 pr-4"><StatusBadge status={job.status} /></td>
                <td className="py-2.5 pr-4 text-xs">
                  {job.product ? (
                    <span className="px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-300">{job.product.name}</span>
                  ) : <span className="text-zinc-700">-</span>}
                </td>
                <td className="py-2.5 pr-4 text-zinc-300">
                  {job.agent || "-"}
                  {job.chromeEnabled && (
                    <span className="ml-1.5 text-blue-400/60 text-xs" title={`Chrome: ${job.chromeReason || "enabled"}`}>
                      &#9683;
                    </span>
                  )}
                </td>
                <td className="py-2.5 pr-4 text-zinc-400 font-mono text-xs">{job.issueKey || "-"}</td>
                <td className="py-2.5 pr-4 text-xs">
                  {job.provider ? (
                    <span className={job.provider === "zai" ? "text-blue-400" : "text-teal-400"}>
                      {job.provider === "zai" ? "Z.ai" : "Claude"}
                    </span>
                  ) : "-"}
                </td>
                <td className="py-2.5 pr-4 text-zinc-500 text-xs">{job.model || "-"}</td>
                <td className="py-2.5 pr-4 text-xs">
                  {job.qualityGate && !job.qualityGate.skipped ? (
                    <span className={job.qualityGate.passed ? "text-green-400" : "text-red-400"}>
                      {job.qualityGate.passed ? "\u2713" : "\u2717"}
                    </span>
                  ) : <span className="text-zinc-700">-</span>}
                </td>
                <td className="py-2.5 pr-4 text-zinc-400 text-xs">
                  {job.estimatedCostUsd != null ? `$${job.estimatedCostUsd.toFixed(3)}` : "-"}
                </td>
                <td className="py-2.5 text-zinc-500 text-xs">{timeAgo(job.createdAt)}</td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr><td colSpan={10} className="py-8 text-center text-zinc-600">No jobs found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && pagination.pages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => onParamsChange?.({ ...params, page: (params?.page || 1) - 1 })}
            disabled={!params?.page || params.page <= 1}
            className="px-3 py-1 text-xs rounded-lg bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Previous
          </button>
          <span className="text-xs text-zinc-500">
            Page {pagination.page} of {pagination.pages}
          </span>
          <button
            onClick={() => onParamsChange?.({ ...params, page: (params?.page || 1) + 1 })}
            disabled={pagination.page >= pagination.pages}
            className="px-3 py-1 text-xs rounded-lg bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
