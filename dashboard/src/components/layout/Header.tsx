"use client";

import { useHealth } from "@/hooks/useHealth";
import { Badge } from "@/components/ui/Badge";
import { logout } from "@/lib/auth";
import { NotificationBell } from "@/components/layout/NotificationBell";

export function Header({ baseUrl }: { baseUrl: string | null }) {
  const { data: health } = useHealth(baseUrl);

  return (
    <header className="h-12 border-b border-zinc-800 bg-zinc-950 flex items-center justify-between px-4">
      <div className="flex items-center gap-3">
        {health ? (
          <>
            <Badge color="green">Connected</Badge>
            <span className="text-xs text-zinc-500">
              {health.running} running / {health.queued} queued
            </span>
          </>
        ) : (
          <Badge color="red">Disconnected</Badge>
        )}

        {/* N8N health indicator */}
        {health?.n8n && (
          <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-zinc-800" title={
            `N8N: ${health.n8n.reachable ? "Reachable" : "Unreachable"}\nLatency: ${health.n8n.latencyMs}ms\nURL: ${health.n8n.url || "-"}\nLast check: ${health.n8n.lastCheck || "-"}`
          }>
            <span className={`h-2 w-2 rounded-full ${health.n8n.reachable ? "bg-green-500" : "bg-red-500"}`} />
            <span className="text-xs text-zinc-500">
              N8N {health.n8n.reachable ? `${health.n8n.latencyMs}ms` : "down"}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <NotificationBell />
        <button
          onClick={async () => { await logout(); window.location.reload(); }}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Logout
        </button>
      </div>
    </header>
  );
}
