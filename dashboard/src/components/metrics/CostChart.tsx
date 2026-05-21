"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

interface DataPoint {
  label: string;
  cost: number;
  count: number;
}

export function CostChart({ data, title }: { data: DataPoint[]; title: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#71717a" }} />
          <YAxis tick={{ fontSize: 11, fill: "#71717a" }} />
          <Tooltip
            contentStyle={{ backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: "8px" }}
            labelStyle={{ color: "#a1a1aa" }}
            itemStyle={{ color: "#2dd4bf" }}
          />
          <Line type="monotone" dataKey="cost" stroke="#0d9488" strokeWidth={2} dot={false} name="Cost ($)" />
          <Line type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={2} dot={false} name="Jobs" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
