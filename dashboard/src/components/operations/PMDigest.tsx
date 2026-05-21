"use client";

import type { PMDigest as PMDigestType } from "@/lib/types";
import { Card, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

function ComparisonCards({ digest }: { digest: PMDigestType }) {
  const h = digest.last24h || { total: 0, succeeded: 0, failed: 0, costUsd: 0, successRate: 0 };
  const w = digest.lastWeek || { total: 0, succeeded: 0, failed: 0, costUsd: 0, successRate: 0 };
  return (
    <div className="grid grid-cols-2 gap-4">
      <Card>
        <CardTitle>Last 24 Hours</CardTitle>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Stat label="Jobs" value={h.total} />
          <Stat label="Succeeded" value={h.succeeded} color="text-green-400" />
          <Stat label="Failed" value={h.failed} color="text-red-400" />
          <Stat label="Cost" value={`$${(h.costUsd ?? 0).toFixed(2)}`} />
          <Stat
            label="Success Rate"
            value={`${h.successRate ?? 0}%`}
            color={h.successRate >= 80 ? "text-green-400" : h.successRate >= 50 ? "text-yellow-400" : "text-red-400"}
          />
        </div>
      </Card>
      <Card>
        <CardTitle>Last Week</CardTitle>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Stat label="Jobs" value={w.total} />
          <Stat label="Succeeded" value={w.succeeded} color="text-green-400" />
          <Stat label="Failed" value={w.failed} color="text-red-400" />
          <Stat label="Cost" value={`$${(w.costUsd ?? 0).toFixed(2)}`} />
          <Stat
            label="Success Rate"
            value={`${w.successRate ?? 0}%`}
            color={w.successRate >= 80 ? "text-green-400" : w.successRate >= 50 ? "text-yellow-400" : "text-red-400"}
          />
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div>
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-medium ${color || "text-zinc-300"}`}>{value}</p>
    </div>
  );
}

export function PMDigestView({ digest }: { digest: PMDigestType | null }) {
  if (!digest) {
    return <p className="text-sm text-zinc-600 text-center py-8">No digest data available</p>;
  }

  const qgRate = digest.qualityGate?.passRate ?? 0;
  const agentEntries = Object.entries(digest.agentPerformance || {});

  return (
    <div className="space-y-4">
      <ComparisonCards digest={digest} />

      {/* Quality gate */}
      {digest.qualityGate && (
      <Card>
        <CardTitle>Quality Gate</CardTitle>
        <div className="mt-3 flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-32 h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${qgRate >= 80 ? "bg-green-500" : qgRate >= 50 ? "bg-yellow-500" : "bg-red-500"}`}
                style={{ width: `${qgRate}%` }}
              />
            </div>
            <span className={`text-sm font-medium ${qgRate >= 80 ? "text-green-400" : qgRate >= 50 ? "text-yellow-400" : "text-red-400"}`}>
              {qgRate}%
            </span>
          </div>
          <span className="text-xs text-zinc-500">
            {digest.qualityGate.passed} passed / {digest.qualityGate.failed} failed / {digest.qualityGate.total} total
          </span>
        </div>
      </Card>
      )}

      {/* Stalled jobs */}
      {(digest.stalledJobs?.length ?? 0) > 0 && (
        <Card className="border-yellow-500/30">
          <CardTitle>Stalled Jobs</CardTitle>
          <div className="mt-2 space-y-1.5">
            {(digest.stalledJobs || []).map((job) => (
              <div key={job.jobId} className="flex items-center gap-3 text-xs">
                <Badge color="yellow">{job.status || "running"}</Badge>
                <span className="text-zinc-400 font-mono">{job.jobId.slice(0, 12)}</span>
                <span className="text-zinc-500">{job.agent || "-"}</span>
                {job.runningMinutes != null && (
                  <span className="text-yellow-400">{job.runningMinutes}m running</span>
                )}
                {job.waitingMinutes != null && (
                  <span className="text-yellow-400">{job.waitingMinutes}m waiting</span>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Budget status */}
      {digest.budget && (
        <Card className={!digest.budget.ok ? "border-red-500/30" : undefined}>
          <CardTitle>Budget</CardTitle>
          <div className="mt-2 flex items-center gap-4 text-xs">
            <Badge color={digest.budget.ok ? "green" : "red"}>{digest.budget.ok ? "OK" : "Exceeded"}</Badge>
            {digest.budget.costToday != null && (
              <span className="text-zinc-400">Today: <span className="text-zinc-300">${digest.budget.costToday.toFixed(2)}</span></span>
            )}
            {digest.budget.costLastHour != null && (
              <span className="text-zinc-400">Last hour: <span className="text-zinc-300">${digest.budget.costLastHour.toFixed(2)}</span></span>
            )}
            {digest.budget.reason && (
              <span className="text-red-400">{digest.budget.reason}</span>
            )}
          </div>
        </Card>
      )}

      {/* Agent performance */}
      {agentEntries.length > 0 && (
        <Card>
          <CardTitle>Agent Performance</CardTitle>
          <table className="w-full text-xs mt-3">
            <thead>
              <tr className="text-left text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                <th className="pb-1.5 pr-4">Agent</th>
                <th className="pb-1.5 pr-4">Total</th>
                <th className="pb-1.5 pr-4">Success</th>
                <th className="pb-1.5">Avg Duration</th>
              </tr>
            </thead>
            <tbody>
              {agentEntries.map(([agent, ap]) => (
                <tr key={agent} className="border-b border-zinc-800/50">
                  <td className="py-1.5 pr-4 text-zinc-300">{agent}</td>
                  <td className="py-1.5 pr-4 text-zinc-400">{ap.total}</td>
                  <td className="py-1.5 pr-4">
                    <span className={ap.successRate >= 80 ? "text-green-400" : ap.successRate >= 50 ? "text-yellow-400" : "text-red-400"}>
                      {ap.successRate}%
                    </span>
                  </td>
                  <td className="py-1.5 text-zinc-400">
                    {ap.avgDurationMs > 0 ? `${Math.round(ap.avgDurationMs / 1000)}s` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
