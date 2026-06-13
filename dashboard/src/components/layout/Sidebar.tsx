"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/", label: "Overview", icon: "H" },
  { href: "/issues", label: "Issues", icon: "I" },
  { href: "/chat", label: "Chat", icon: "T" },
  { href: "/jobs", label: "Jobs", icon: "J" },
  { href: "/pipelines", label: "Pipelines", icon: "P" },
  { href: "/worktrees", label: "Worktrees", icon: "W" },
  { href: "/agents", label: "Agents", icon: "A" },
  { href: "/office", label: "Office", icon: "3" },
  { href: "/metrics", label: "Metrics", icon: "M" },
  { href: "/batches", label: "Batches", icon: "B" },
  { href: "/conversations", label: "Conversations", icon: "C" },
  { href: "/skills", label: "Skills", icon: "K" },
  { href: "/scheduled", label: "Scheduled", icon: "S" },
  { href: "/operations", label: "Operations", icon: "O" },
  { href: "/guide", label: "Guide", icon: "?" },
];

const mobileNav = [
  { href: "/", label: "Home", icon: "H" },
  { href: "/issues", label: "Issues", icon: "I" },
  { href: "/chat", label: "Chat", icon: "T" },
  { href: "/jobs", label: "Jobs", icon: "J" },
  { href: "/pipelines", label: "Pipe", icon: "P" },
  { href: "/agents", label: "Agents", icon: "A" },
];

export function Sidebar() {
  const pathname = usePathname();
  // Responsive sidebar: show as top nav on mobile
  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-56 bg-zinc-950 border-r border-zinc-800 flex-col min-h-screen">
        <div className="p-4 border-b border-zinc-800">
          <h1 className="text-lg font-bold text-teal-400 tracking-tight">Meshwork</h1>
          <p className="text-xs text-zinc-500">Runner Dashboard</p>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {nav.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  active
                    ? "bg-teal-500/10 text-teal-400"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                }`}
              >
                <span className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold ${
                  active ? "bg-teal-500/20 text-teal-400" : "bg-zinc-800 text-zinc-500"
                }`}>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      {/* Mobile Bottom Nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 flex md:hidden bg-zinc-950 border-t border-zinc-800 px-1 py-1 justify-between shadow-lg">
        {mobileNav.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center flex-1 py-1 px-0.5 rounded transition-colors ${
                active
                  ? "bg-teal-500/10 text-teal-400"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <span className={`w-7 h-7 mb-0.5 rounded-md flex items-center justify-center text-xs font-bold ${
                active ? "bg-teal-500/20 text-teal-400" : "bg-zinc-800 text-zinc-500"
              }`}>
                {item.icon}
              </span>
              <span className="text-[10px] leading-none">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
