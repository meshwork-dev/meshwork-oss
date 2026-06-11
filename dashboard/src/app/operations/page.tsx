"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { SystemHealth } from "@/components/operations/SystemHealth";
import { PMDigestView } from "@/components/operations/PMDigest";
import { SalesPipeline } from "@/components/operations/SalesPipeline";
import { TeamActivity } from "@/components/operations/TeamActivity";
import { useHealth } from "@/hooks/useHealth";
import { getAPI } from "@/lib/api";
import type { FailedCallback, PMDigest } from "@/lib/types";

const TABS = ["health", "callbacks", "digest", "teams", "sales"] as const;
type Tab = (typeof TABS)[number];

function OperationsPage({ baseUrl }: { baseUrl: string }) {
  const { data: health } = useHealth(baseUrl);
  const [tab, setTab] = useState<Tab>("health");
  const [callbacks, setCallbacks] = useState<FailedCallback[]>([]);
  const [digest, setDigest] = useState<PMDigest | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getAPI()?.listFailedCallbacks().catch(() => []),
      getAPI()?.getPMDigest().catch(() => null),
    ]).then(([cb, d]) => {
      setCallbacks(cb || []);
      setDigest(d || null);
    }).finally(() => setLoading(false));
  }, []);

  async function replay(id: string) {
    try {
      await getAPI()?.replayCallback(id);
      setCallbacks((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      console.warn(`[operations] Failed to replay callback ${id}:`, err);
    }
  }

  async function dismiss(id: string) {
    try {
      await getAPI()?.dismissCallback(id);
      setCallbacks((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      console.warn(`[operations] Failed to dismiss callback ${id}:`, err);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-white">Operations</h2>

      {/* Tabs */}
      <div className="flex gap-1.5 border-b border-zinc-800 pb-0">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t
                ? "border-teal-500 text-teal-400"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t === "health" ? "System Health" : t === "callbacks" ? `Callbacks${callbacks.length > 0 ? ` (${callbacks.length})` : ""}` : t === "digest" ? "PM Digest" : t === "teams" ? "Teams" : "Sales Pipeline"}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "health" && <SystemHealth health={health || null} digest={digest} />}

      {tab === "callbacks" && (
        <FailedCallbacksPanel callbacks={callbacks} onReplay={replay} onDismiss={dismiss} />
      )}

      {tab === "digest" && <PMDigestView digest={digest} />}

      {tab === "teams" && <TeamActivity />}

      {tab === "sales" && <SalesPipeline />}
    </div>
  );
}

function FailedCallbacksPanel({
  callbacks,
  onReplay,
  onDismiss,
}: {
  callbacks: FailedCallback[];
  onReplay: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  async function copyPayload(cb: FailedCallback) {
    if (cb.payloadPreview) {
      await navigator.clipboard.writeText(cb.payloadPreview);
      setCopied(cb.id);
      setTimeout(() => setCopied(null), 2000);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Failed Callbacks</h3>
      <div className="space-y-2">
        {callbacks.map((cb) => (
          <div key={cb.id} className="border border-zinc-800 rounded-lg overflow-hidden">
            {/* Summary row */}
            <div
              className="flex items-center gap-4 px-4 py-2.5 cursor-pointer hover:bg-zinc-800/30 transition-colors"
              onClick={() => toggleExpand(cb.id)}
            >
              <span className="text-zinc-600 text-xs">{expandedId === cb.id ? "\u25BC" : "\u25B6"}</span>
              <span className="text-teal-400 font-mono text-xs">{cb.jobId.slice(0, 12)}</span>
              {cb.agent && <span className="text-zinc-400 text-xs">{cb.agent}</span>}
              {cb.responseStatus != null && (
                <Badge color={cb.responseStatus >= 500 ? "red" : "yellow"}>{cb.responseStatus}</Badge>
              )}
              <span className="text-zinc-400 text-xs truncate max-w-[200px]">{cb.url}</span>
              <span className="text-red-400 text-xs truncate max-w-[180px]">{cb.error}</span>
              <Badge color="yellow">{cb.attempts} attempts</Badge>
              <span className="text-zinc-600 text-xs ml-auto">{cb.failedAt ? new Date(cb.failedAt).toLocaleString() : cb.lastAttempt || ""}</span>
              <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => onReplay(cb.id)} className="text-xs text-teal-400 hover:text-teal-300">Replay</button>
                <button onClick={() => onDismiss(cb.id)} className="text-xs text-zinc-500 hover:text-zinc-300">Dismiss</button>
              </div>
            </div>

            {/* Expanded details */}
            {expandedId === cb.id && (
              <div className="px-4 pb-3 pt-1 border-t border-zinc-800 space-y-3">
                {/* Attempt history */}
                {cb.attemptDetails && cb.attemptDetails.length > 0 && (
                  <div>
                    <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1.5">Attempt History</p>
                    <div className="space-y-1">
                      {cb.attemptDetails.map((a, i) => (
                        <div key={i} className="flex items-center gap-3 text-xs">
                          <span className="text-zinc-600 w-5">#{a.attempt}</span>
                          <span className="text-zinc-500">{new Date(a.at).toLocaleTimeString()}</span>
                          {a.status != null && (
                            <Badge color={a.status >= 500 ? "red" : a.status >= 400 ? "yellow" : "green"}>{a.status}</Badge>
                          )}
                          <span className="text-zinc-400 truncate">{a.url}</span>
                          {a.error && <span className="text-red-400 truncate">{a.error}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Payload preview */}
                {cb.payloadPreview && (
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <p className="text-xs text-zinc-500 uppercase tracking-wider">Request Payload</p>
                      <button
                        onClick={() => copyPayload(cb)}
                        className="text-xs text-teal-400 hover:text-teal-300 transition-colors"
                      >
                        {copied === cb.id ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <pre className="text-xs text-zinc-400 bg-zinc-950 rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-all font-mono">
                      {cb.payloadPreview.slice(0, 500)}{cb.payloadPreview.length > 500 ? "..." : ""}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {callbacks.length === 0 && (
          <p className="py-8 text-center text-zinc-600">No failed callbacks</p>
        )}
      </div>
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
              <OperationsPage baseUrl={baseUrl} />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
