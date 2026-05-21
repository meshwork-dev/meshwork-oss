"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

const COLORS = ["#10b981", "#ef4444", "#71717a"];

export function SuccessRate({ succeeded, failed, other }: { succeeded: number; failed: number; other: number }) {
  const data = [
    { name: "Succeeded", value: succeeded },
    { name: "Failed", value: failed },
    { name: "Other", value: other },
  ].filter((d) => d.value > 0);

  const total = succeeded + failed + other;
  const rate = total > 0 ? Math.round((succeeded / total) * 100) : 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Success Rate</h3>
      <div className="flex items-center gap-6">
        <ResponsiveContainer width={120} height={120}>
          <PieChart>
            <Pie data={data} innerRadius={35} outerRadius={50} dataKey="value" strokeWidth={0}>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: "8px", fontSize: "12px" }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div>
          <p className="text-3xl font-bold text-white">{rate}%</p>
          <p className="text-xs text-zinc-500">{succeeded} of {total} jobs</p>
        </div>
      </div>
    </div>
  );
}
