"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { CostChart } from "@/components/metrics/CostChart";
import { SuccessRate } from "@/components/metrics/SuccessRate";
import { AgentTable } from "@/components/metrics/AgentTable";
import { Spinner } from "@/components/ui/Spinner";
import { getAPI } from "@/lib/api";
import type { Metrics, Stats, AgentMetric } from "@/lib/types";

function MetricsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = getAPI();
    if (!api) return;
    Promise.all([api.getMetrics(), api.getStats()])
      .then(([m, s]) => {
        setMetrics(m);
        setStats(s);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load metrics"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-sm">Failed to load metrics: {error}</p>
        <p className="text-zinc-500 text-xs mt-2">Is the runner reachable?</p>
      </div>
    );
  }

  // Build agent table data from byAgent map
  const agentData: AgentMetric[] = metrics?.byAgent
    ? Object.entries(metrics.byAgent).map(([name, d]) => ({
        agent: name, total: d.total, succeeded: d.succeeded, failed: d.failed, tokens: d.tokens, cost: d.cost,
      }))
    : [];

  // Build chart data from agent costs
  const agentChartData = agentData.map((a) => ({ label: a.agent, cost: a.cost, count: a.total }));

  // Build per-product data
  const productData: AgentMetric[] = stats?.byProduct
    ? Object.entries(stats.byProduct).map(([name, d]) => ({
        agent: name, total: d.total, succeeded: d.succeeded, failed: d.failed, tokens: d.tokens, cost: d.cost,
      }))
    : [];
  const productChartData = productData.map((p) => ({ label: p.agent, cost: p.cost, count: p.total }));

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-white">Metrics</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SuccessRate
          succeeded={metrics?.jobs?.succeeded ?? stats?.recentSucceeded ?? 0}
          failed={metrics?.jobs?.failed ?? stats?.recentFailed ?? 0}
          other={(metrics?.jobs?.cancelled ?? 0)}
        />
        <CostChart data={agentChartData} title="Cost & Jobs by Agent" />
      </div>

      <AgentTable agents={agentData} />

      {productData.length > 0 && (
        <>
          <h3 className="text-lg font-semibold text-white mt-8">By Product</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CostChart data={productChartData} title="Cost & Jobs by Product" />
          </div>
          <AgentTable agents={productData} />
        </>
      )}
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
              <MetricsPage />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
