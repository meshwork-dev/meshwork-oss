import type { AgentMetric } from "@/lib/types";

export function AgentTable({ agents }: { agents: AgentMetric[] }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Agent Performance</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
              <th className="pb-2 pr-4">Agent</th>
              <th className="pb-2 pr-4">Total</th>
              <th className="pb-2 pr-4">Success Rate</th>
              <th className="pb-2 pr-4">Tokens</th>
              <th className="pb-2">Cost</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const rate = a.total > 0 ? Math.round((a.succeeded / a.total) * 100) : 0;
              return (
                <tr key={a.agent} className="border-b border-zinc-800/50">
                  <td className="py-2 pr-4 text-zinc-300 font-medium">{a.agent}</td>
                  <td className="py-2 pr-4 text-zinc-400">{a.total}</td>
                  <td className="py-2 pr-4">
                    <span className={rate >= 80 ? "text-emerald-400" : rate >= 50 ? "text-amber-400" : "text-red-400"}>
                      {rate}%
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-zinc-400">{(a.tokens / 1000).toFixed(0)}k</td>
                  <td className="py-2 text-zinc-400">${a.cost.toFixed(2)}</td>
                </tr>
              );
            })}
            {agents.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-zinc-600">No agent data</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
