const colors: Record<string, string> = {
  green: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  red: "bg-red-500/20 text-red-400 border-red-500/30",
  yellow: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  blue: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  gray: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  teal: "bg-teal-500/20 text-teal-400 border-teal-500/30",
  purple: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};

export function Badge({ color = "gray", children }: { color?: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colors[color] || colors.gray}`}>
      {children}
    </span>
  );
}
