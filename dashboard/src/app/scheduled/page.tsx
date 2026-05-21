"use client";

import { useEffect, useState, useCallback } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { getAPI } from "@/lib/api";
import type { ScheduledItem } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ScheduledPage({ baseUrl }: { baseUrl: string }) {
  const [items, setItems] = useState<ScheduledItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"pending" | "done" | "all">("pending");

  const refresh = useCallback(() => {
    getAPI()
      ?.listScheduled()
      .then((list) => setItems(list))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 15000);
    return () => clearInterval(iv);
  }, [refresh]);

  async function cancel(id: string) {
    try {
      await getAPI()?.cancelScheduled(id);
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: "cancelled" } : i)));
    } catch {
      /* ignore */
    }
  }

  const filtered = items.filter((i) => {
    if (tab === "pending") return i.status === "pending";
    if (tab === "done") return i.status !== "pending";
    return true;
  });

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const doneCount = items.filter((i) => i.status !== "pending").length;

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Scheduled</h2>
        <button
          onClick={() => { setLoading(true); refresh(); }}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 border-b border-zinc-800 pb-0">
        {([
          { key: "pending" as const, label: `Pending${pendingCount > 0 ? ` (${pendingCount})` : ""}` },
          { key: "done" as const, label: `Completed${doneCount > 0 ? ` (${doneCount})` : ""}` },
          { key: "all" as const, label: `All (${items.length})` },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? "border-teal-500 text-teal-400"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Items */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <p className="py-12 text-center text-zinc-600">
            {tab === "pending" ? "No pending scheduled items" : "No scheduled items"}
          </p>
        )}
        {filtered.map((item) => (
          <ScheduledCard key={item.id} item={item} onCancel={cancel} />
        ))}
      </div>
    </div>
  );
}

function ScheduledCard({
  item,
  onCancel,
}: {
  item: ScheduledItem;
  onCancel: (id: string) => void;
}) {
  const scheduledDate = new Date(item.scheduledAt);
  const now = new Date();
  const isPast = scheduledDate <= now;
  const isMeeting = item.type === "meeting";

  const timeLabel = formatRelativeTime(scheduledDate, now);

  return (
    <div className="border border-zinc-800 rounded-lg bg-zinc-900 p-4">
      <div className="flex items-start gap-4">
        {/* Type icon */}
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${
            isMeeting
              ? "bg-purple-500/10 text-purple-400"
              : "bg-teal-500/10 text-teal-400"
          }`}
        >
          {isMeeting ? "M" : "J"}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge color={isMeeting ? "purple" : "blue"}>
              {isMeeting ? "Meeting" : "Job"}
            </Badge>
            <StatusBadge status={item.status} />
            {item.agent && (
              <span className="text-xs text-zinc-400 font-mono">{item.agent}</span>
            )}
            {item.issueKey && (
              <span className="text-xs text-teal-400 font-mono">{item.issueKey}</span>
            )}
          </div>

          {/* Description */}
          <p className="text-sm text-zinc-300 truncate">
            {isMeeting
              ? item.topic || "Follow-up meeting"
              : item.task || item.prompt || "Scheduled task"}
          </p>

          {/* Meeting agents */}
          {isMeeting && item.agents && item.agents.length > 0 && (
            <div className="flex gap-1 mt-1.5">
              {item.agents.map((a: string) => (
                <span
                  key={a}
                  className="text-xs bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded"
                >
                  {a}
                </span>
              ))}
            </div>
          )}

          {/* Time row */}
          <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
            <span>
              Scheduled: {scheduledDate.toLocaleString()}
            </span>
            {item.status === "pending" && (
              <span className={isPast ? "text-yellow-400" : "text-zinc-400"}>
                {isPast ? "Overdue" : timeLabel}
              </span>
            )}
            {item.source && (
              <span className="text-zinc-600">Source: {item.source}</span>
            )}
          </div>

          {/* Result info for done items */}
          {item.status === "done" && item.jobId && (
            <div className="mt-1.5 text-xs text-zinc-500">
              Job: <span className="text-teal-400 font-mono">{item.jobId.slice(0, 16)}</span>
            </div>
          )}
          {item.status === "done" && item.meetingId && (
            <div className="mt-1.5 text-xs text-zinc-500">
              Meeting: <span className="text-purple-400 font-mono">{item.meetingId.slice(0, 24)}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        {item.status === "pending" && (
          <button
            onClick={() => onCancel(item.id)}
            className="text-xs text-zinc-500 hover:text-red-400 transition-colors shrink-0 px-2 py-1"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "pending":
      return <Badge color="yellow">Pending</Badge>;
    case "done":
      return <Badge color="green">Done</Badge>;
    case "cancelled":
      return <Badge color="red">Cancelled</Badge>;
    default:
      return <Badge color="yellow">{status}</Badge>;
  }
}

function formatRelativeTime(target: Date, now: Date): string {
  const diffMs = target.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const minutes = Math.floor(absMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return "now";
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
              <ScheduledPage baseUrl={baseUrl} />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
