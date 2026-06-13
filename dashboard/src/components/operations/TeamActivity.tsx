"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { getAPI } from "@/lib/api";
import type { Agent, TeamSession } from "@/lib/types";

const STATUS_COLORS: Record<string, "green" | "red" | "yellow" | "blue" | "zinc"> = {
  succeeded: "green",
  failed: "red",
  running: "blue",
  queued: "yellow",
  cancelled: "zinc",
  "retry-pending": "yellow",
  "quality-gate-retry": "yellow",
};

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  return `${minutes}m ${remainingSec}s`;
}

export function TeamActivity() {
  const [sessions, setSessions] = useState<TeamSession[]>([]);
  const [teamLeads, setTeamLeads] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [res, agents] = await Promise.all([
          getAPI()?.getTeamSessions(),
          getAPI()?.listAgents().catch(() => []),
        ]);
        if (res) {
          setSessions(res.sessions);
        }
        setTeamLeads((agents || []).filter((a) => a.isTeamLead));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load team sessions");
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

  if (error) {
    return (
      <div className="text-center py-12 text-red-400 text-sm">
        Failed to load team activity: {error}
      </div>
    );
  }

  const activeSessions = sessions.filter((s) => s.active);
  const recentSessions = sessions.filter((s) => !s.active).slice(0, 20);

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Active Teams</p>
          <p className="text-2xl font-bold text-blue-400 mt-1">{activeSessions.length}</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Total Sessions</p>
          <p className="text-2xl font-bold text-white mt-1">{sessions.length}</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Succeeded</p>
          <p className="text-2xl font-bold text-green-400 mt-1">
            {sessions.filter((s) => s.status === "succeeded").length}
          </p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Failed</p>
          <p className="text-2xl font-bold text-red-400 mt-1">
            {sessions.filter((s) => s.status === "failed").length}
          </p>
        </div>
      </div>

      {/* Active Team Sessions */}
      {activeSessions.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">
            Active Team Sessions
          </h3>
          <div className="space-y-3">
            {activeSessions.map((session) => (
              <div key={session.teamSessionId} className="bg-zinc-800/50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-teal-400">{session.leadAgent}</span>
                    <Badge color="blue">team lead</Badge>
                    <Badge color={STATUS_COLORS[session.status] || "zinc"}>{session.status}</Badge>
                  </div>
                  <span className="text-xs text-zinc-500">
                    {session.startedAt ? formatDuration(Date.now() - new Date(session.startedAt).getTime()) : "-"}
                  </span>
                </div>
                {session.issueKey && (
                  <p className="text-xs text-zinc-500 mb-2">Issue: {session.issueKey}</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {session.teammates.map((mate) => (
                    <span
                      key={mate}
                      className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-300"
                    >
                      {mate}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Team Configuration — from the runner's registered agents */}
      {teamLeads.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">
            Team Configuration
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {teamLeads.map((lead) => (
              <TeamConfigCard
                key={lead.name}
                lead={lead.name}
                model={lead.model || "default"}
                teammates={lead.teammates || []}
              />
            ))}
          </div>
        </div>
      )}

      {/* Recent Team Sessions */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">
          Recent Team Sessions
        </h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
              <th className="pb-2 pr-4">Lead Agent</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Issue</th>
              <th className="pb-2 pr-4">Teammates</th>
              <th className="pb-2 pr-4">Started</th>
              <th className="pb-2">Duration</th>
            </tr>
          </thead>
          <tbody>
            {recentSessions.map((session) => (
              <tr key={session.teamSessionId} className="border-b border-zinc-800/50">
                <td className="py-2 pr-4 text-teal-400 text-xs">{session.leadAgent}</td>
                <td className="py-2 pr-4">
                  <Badge color={STATUS_COLORS[session.status] || "zinc"}>{session.status}</Badge>
                </td>
                <td className="py-2 pr-4 text-zinc-400 text-xs">{session.issueKey || "-"}</td>
                <td className="py-2 pr-4 text-zinc-400 text-xs">
                  {session.teammates.length > 0 ? session.teammates.join(", ") : "-"}
                </td>
                <td className="py-2 pr-4 text-zinc-400 text-xs">
                  {session.startedAt ? new Date(session.startedAt).toLocaleString() : "-"}
                </td>
                <td className="py-2 text-zinc-400 text-xs">{formatDuration(session.duration)}</td>
              </tr>
            ))}
            {recentSessions.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-zinc-600">
                  No team sessions yet. Sessions appear here when team lead agents execute.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeamConfigCard({
  lead,
  model,
  teammates,
}: {
  lead: string;
  model: string;
  teammates: string[];
}) {
  return (
    <div className="bg-zinc-800/50 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <p className="text-sm font-medium text-teal-400">{lead}</p>
        <Badge color="teal">lead</Badge>
      </div>
      <p className="text-xs text-zinc-500 mb-2">Model: {model}</p>
      <div className="flex flex-wrap gap-1">
        {teammates.map((mate) => (
          <span
            key={mate}
            className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-400"
          >
            {mate}
          </span>
        ))}
      </div>
    </div>
  );
}
