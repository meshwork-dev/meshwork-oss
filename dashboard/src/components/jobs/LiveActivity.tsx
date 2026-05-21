"use client";

import { useEffect, useRef } from "react";
import type { JobProgress } from "@/lib/types";
import { Card, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

const TOOL_COLORS: Record<string, string> = {
  Read: "teal",
  Edit: "yellow",
  Write: "yellow",
  Bash: "red",
  Grep: "blue",
  Glob: "blue",
  Agent: "purple",
  WebSearch: "purple",
  WebFetch: "purple",
  NotebookEdit: "yellow",
  SendMessage: "green",
  TeamCreate: "green",
  Skill: "purple",
};

function getToolColor(tool: string): string {
  // Check exact match first
  if (TOOL_COLORS[tool]) return TOOL_COLORS[tool];
  // Check prefix for MCP tools
  if (tool.startsWith("mcp__")) return "blue";
  return "gray";
}

function formatToolInput(input?: string): string {
  if (!input) return "";
  // Try to extract meaningful info from JSON input
  try {
    const parsed = JSON.parse(input);
    if (parsed.command) return parsed.command;
    if (parsed.file_path) return parsed.file_path;
    if (parsed.pattern) return parsed.pattern;
    if (parsed.query) return parsed.query;
  } catch {
    // not JSON, return as-is
  }
  return input.length > 80 ? input.slice(0, 80) + "..." : input;
}

export function LiveActivity({ progress }: { progress: JobProgress[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [progress.length]);

  if (progress.length === 0) return null;

  // Compute live stats
  const toolCalls = progress.filter(p => p.streamType === "tool_use");
  const lastResult = [...progress].reverse().find(p => p.streamType === "result");
  const initEvent = progress.find(p => p.streamType === "init");

  return (
    <Card className="border-teal-500/20">
      <div className="flex items-center gap-3 mb-3">
        <CardTitle>Live Activity</CardTitle>
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500" />
          </span>
          <span className="text-xs text-teal-400">Streaming</span>
        </div>
        {initEvent?.model && (
          <Badge color="teal">{initEvent.model}</Badge>
        )}
        <div className="ml-auto flex gap-3 text-xs text-zinc-500">
          <span>{toolCalls.length} tool calls</span>
          {lastResult?.costUsd != null && (
            <span>${lastResult.costUsd.toFixed(4)}</span>
          )}
          {lastResult?.numTurns != null && (
            <span>{lastResult.numTurns} turns</span>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="max-h-[300px] overflow-y-auto space-y-1 font-mono text-xs"
      >
        {progress.map((p, i) => {
          if (p.streamType === "init") {
            return (
              <div key={i} className="flex items-center gap-2 text-zinc-500 py-0.5">
                <span className="text-zinc-600 w-16 shrink-0">init</span>
                <span>Session started &middot; {p.tools?.length || 0} tools available</span>
              </div>
            );
          }
          if (p.streamType === "tool_use") {
            const color = getToolColor(p.tool || "");
            const inputPreview = formatToolInput(p.input);
            return (
              <div key={i} className="flex items-start gap-2 py-0.5">
                <Badge color={color}>{p.tool}</Badge>
                {inputPreview && (
                  <span className="text-zinc-500 truncate">{inputPreview}</span>
                )}
              </div>
            );
          }
          if (p.streamType === "assistant" && p.text) {
            return (
              <div key={i} className="text-zinc-400 py-0.5 pl-1 border-l-2 border-zinc-700">
                {p.text}
              </div>
            );
          }
          if (p.streamType === "result") {
            return (
              <div key={i} className="flex items-center gap-2 text-green-400 py-0.5 mt-1 pt-1 border-t border-zinc-800">
                <span>Complete</span>
                {p.durationMs != null && <span>&middot; {(p.durationMs / 1000).toFixed(1)}s</span>}
                {p.costUsd != null && <span>&middot; ${p.costUsd.toFixed(4)}</span>}
                {p.numTurns != null && <span>&middot; {p.numTurns} turns</span>}
              </div>
            );
          }
          return null;
        })}
      </div>
    </Card>
  );
}
