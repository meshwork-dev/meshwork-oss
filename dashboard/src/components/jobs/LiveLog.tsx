"use client";

import { useEffect, useRef, useState } from "react";
import { getAPI } from "@/lib/api";

export function LiveLog({ jobId, jobStatus }: { jobId: string; jobStatus: string }) {
  const [content, setContent] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLPreElement>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  useEffect(() => {
    const api = getAPI();
    if (!api) return;

    const url = api.getLogStreamUrl(jobId);
    let cancelled = false;

    async function stream() {
      try {
        const res = await fetch(url);
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        readerRef.current = reader;
        const decoder = new TextDecoder();

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          setContent((prev) => prev + text);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn(`[live-log] Log stream for job ${jobId} ended unexpectedly:`, err);
        }
      }
    }

    stream();

    return () => {
      cancelled = true;
      readerRef.current?.cancel().catch(() => {});
    };
  }, [jobId]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [content, autoScroll]);

  const isRunning = jobStatus === "running" || jobStatus === "queued";

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            {isRunning ? "Live Log" : "Job Log"}
          </h3>
          {isRunning && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-green-400">Streaming</span>
            </span>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded border-zinc-600 bg-zinc-800 text-teal-500 focus:ring-teal-500"
          />
          Auto-scroll
        </label>
      </div>
      <pre
        ref={containerRef}
        className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 text-xs text-green-400 font-mono whitespace-pre-wrap max-h-[500px] overflow-y-auto leading-relaxed"
      >
        {content || (isRunning ? "Waiting for output..." : "No log content")}
      </pre>
    </div>
  );
}
