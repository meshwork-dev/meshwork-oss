"use client";

import type { HealthResponse, PMDigest } from "@/lib/types";
import { Card, CardTitle } from "@/components/ui/Card";

function HealthCard({ title, items }: { title: string; items: { label: string; value: string; color?: string }[] }) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between text-sm">
            <span className="text-zinc-500">{item.label}</span>
            <span className={item.color || "text-zinc-300"}>{item.value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function SystemHealth({ health, digest }: { health: HealthResponse | null; digest: PMDigest | null }) {
  const uptime = health?.uptime
    ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m`
    : "-";

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Runner health */}
      <HealthCard
        title="Runner"
        items={[
          { label: "Status", value: health?.ok ? "Healthy" : "Unhealthy", color: health?.ok ? "text-green-400" : "text-red-400" },
          { label: "Running", value: String(health?.running ?? 0) },
          { label: "Queued", value: String(health?.queued ?? 0) },
          { label: "Total Jobs", value: String(health?.jobs ?? 0) },
          { label: "Max Concurrency", value: String(health?.maxConcurrency ?? 0) },
          { label: "Uptime", value: uptime },
        ]}
      />

      {/* N8N health */}
      <HealthCard
        title="N8N"
        items={[
          {
            label: "Status",
            value: health?.n8n?.reachable ? "Reachable" : "Unreachable",
            color: health?.n8n?.reachable ? "text-green-400" : "text-red-400",
          },
          { label: "Latency", value: health?.n8n?.latencyMs ? `${health.n8n.latencyMs}ms` : "-" },
          { label: "URL", value: health?.n8n?.url || "-" },
          { label: "Last Check", value: health?.n8n?.lastCheck ? new Date(health.n8n.lastCheck).toLocaleTimeString() : "-" },
          {
            label: "Internal",
            value: health?.n8n?.internalReachable ? "Yes" : "No",
            color: health?.n8n?.internalReachable ? "text-green-400" : "text-zinc-500",
          },
          {
            label: "External",
            value: health?.n8n?.externalReachable ? "Yes" : "No",
            color: health?.n8n?.externalReachable ? "text-green-400" : "text-zinc-500",
          },
        ]}
      />

      {/* Budget */}
      <HealthCard
        title="Budget"
        items={[
          {
            label: "Status",
            value: digest?.budget ? (digest.budget.ok ? "OK" : "Exceeded") : "-",
            color: digest?.budget ? (digest.budget.ok ? "text-green-400" : "text-red-400") : "text-zinc-300",
          },
          {
            label: "Today",
            value: digest?.budget?.costToday != null ? `$${digest.budget.costToday.toFixed(2)}` : "-",
          },
          {
            label: "Last Hour",
            value: digest?.budget?.costLastHour != null ? `$${digest.budget.costLastHour.toFixed(2)}` : "-",
          },
        ]}
      />
    </div>
  );
}
