"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { getAPI } from "@/lib/api";
import type { SkillUsageMap } from "@/lib/types";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie,
} from "recharts";

const COLORS = [
  "#14b8a6", "#f59e0b", "#8b5cf6", "#ef4444", "#3b82f6",
  "#ec4899", "#10b981", "#f97316", "#6366f1", "#84cc16",
];

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function SkillsPage() {
  const [usage, setUsage] = useState<SkillUsageMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = getAPI();
    if (!api) return;
    api.getSkillUsage()
      .then(setUsage)
      .catch((e) => setError(e.message || "Failed to load skill usage"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-sm">{error}</p>
        <p className="text-zinc-500 text-xs mt-2">Is the runner reachable? Rebuild if you just added the endpoint.</p>
      </div>
    );
  }

  const skills = Object.entries(usage || {});
  const totalReads = skills.reduce((s, [, v]) => s + v.reads, 0);
  const totalRuns = skills.reduce((s, [, v]) => s + v.scriptRuns, 0);
  const activeSkills = skills.filter(([, v]) => v.reads > 0 || v.scriptRuns > 0).length;

  // Bar chart: reads + scriptRuns per skill
  const barData = skills
    .map(([name, v]) => ({ name, reads: v.reads, scriptRuns: v.scriptRuns, total: v.reads + v.scriptRuns }))
    .sort((a, b) => b.total - a.total);

  // Pie chart: total interactions per skill
  const pieData = barData.filter((d) => d.total > 0);

  // Agent breakdown: aggregate across all skills
  const agentMap: Record<string, number> = {};
  for (const [, v] of skills) {
    for (const [agent, count] of Object.entries(v.byAgent || {})) {
      agentMap[agent] = (agentMap[agent] || 0) + count;
    }
  }
  const agentBarData = Object.entries(agentMap)
    .map(([agent, count]) => ({ agent, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-white">Skill Usage</h2>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Total Skills" value={skills.length} />
        <StatCard label="Active Skills" value={activeSkills} accent={activeSkills > 0} />
        <StatCard label="File Reads" value={totalReads} />
        <StatCard label="Script Runs" value={totalRuns} accent={totalRuns > 0} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Bar chart */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Usage by Skill</h3>
          {barData.length === 0 ? (
            <p className="text-zinc-500 text-sm py-8 text-center">No skill usage recorded yet</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={barData} layout="vertical" margin={{ left: 20, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis type="number" tick={{ fill: "#a1a1aa", fontSize: 11 }} />
                <YAxis dataKey="name" type="category" tick={{ fill: "#a1a1aa", fontSize: 11 }} width={110} />
                <Tooltip
                  contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
                  labelStyle={{ color: "#e4e4e7" }}
                />
                <Bar dataKey="reads" stackId="a" fill="#14b8a6" name="File Reads" radius={[0, 0, 0, 0]} />
                <Bar dataKey="scriptRuns" stackId="a" fill="#f59e0b" name="Script Runs" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Pie chart */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Skill Distribution</h3>
          {pieData.length === 0 ? (
            <p className="text-zinc-500 text-sm py-8 text-center">No usage data</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="total"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  innerRadius={50}
                  paddingAngle={2}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={{ stroke: "#71717a" }}
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Agent breakdown */}
      {agentBarData.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Usage by Agent</h3>
          <ResponsiveContainer width="100%" height={Math.max(200, agentBarData.length * 36)}>
            <BarChart data={agentBarData} layout="vertical" margin={{ left: 20, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis type="number" tick={{ fill: "#a1a1aa", fontSize: 11 }} />
              <YAxis dataKey="agent" type="category" tick={{ fill: "#a1a1aa", fontSize: 11 }} width={140} />
              <Tooltip
                contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
                labelStyle={{ color: "#e4e4e7" }}
              />
              <Bar dataKey="count" fill="#8b5cf6" name="Interactions" radius={[0, 4, 4, 0]}>
                {agentBarData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Detail table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Skill Details</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
                <th className="text-left py-2 px-3">Skill</th>
                <th className="text-right py-2 px-3">Reads</th>
                <th className="text-right py-2 px-3">Script Runs</th>
                <th className="text-right py-2 px-3">Total</th>
                <th className="text-left py-2 px-3">Last Used</th>
                <th className="text-left py-2 px-3">Agents</th>
              </tr>
            </thead>
            <tbody>
              {skills.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-zinc-500">No skills tracked yet</td>
                </tr>
              ) : (
                skills
                  .sort(([, a], [, b]) => (b.reads + b.scriptRuns) - (a.reads + a.scriptRuns))
                  .map(([name, v]) => (
                    <tr key={name} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                      <td className="py-2.5 px-3 font-medium text-zinc-200">{name}</td>
                      <td className="py-2.5 px-3 text-right text-teal-400 tabular-nums">{v.reads}</td>
                      <td className="py-2.5 px-3 text-right text-amber-400 tabular-nums">{v.scriptRuns}</td>
                      <td className="py-2.5 px-3 text-right text-white font-semibold tabular-nums">{v.reads + v.scriptRuns}</td>
                      <td className="py-2.5 px-3 text-zinc-400">{timeAgo(v.lastUsed)}</td>
                      <td className="py-2.5 px-3">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(v.byAgent || {}).map(([agent, count]) => (
                            <span key={agent} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-800 text-xs text-zinc-300">
                              {agent} <span className="text-zinc-500">{count}</span>
                            </span>
                          ))}
                          {Object.keys(v.byAgent || {}).length === 0 && (
                            <span className="text-zinc-600 text-xs">--</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${accent ? "text-teal-400" : "text-white"}`}>
        {value}
      </p>
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
              <SkillsPage />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
