"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { mutate } from "swr";
import type { SSEEvent, JobProgress } from "./types";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const JOB_EVENTS = [
  "job:queued",
  "job:started",
  "job:succeeded",
  "job:failed",
  "job:cancelled",
  "job:retry",
  "job:quality-gate-retry",
];

export function useSSE(baseUrl: string | null, secret: string | null) {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [jobProgress, setJobProgress] = useState<Map<string, JobProgress[]>>(new Map());
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (!baseUrl || !secret) return;

    const url = `${baseUrl}/events?secret=${encodeURIComponent(secret)}`;
    const es = new EventSource(url);
    esRef.current = es;
    setStatus("connecting");

    es.onopen = () => setStatus("connected");

    // Handle named events from the runner (event: job:started\ndata: {...})
    for (const eventName of JOB_EVENTS) {
      es.addEventListener(eventName, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const event: SSEEvent = {
            type: eventName,
            data,
            timestamp: new Date().toISOString(),
          };
          setEvents((prev) => [event, ...prev].slice(0, 100));

          // Invalidate SWR caches so pages auto-refresh
          mutate("jobs");
          mutate("stats");
          mutate((key) => typeof key === "string" && key.startsWith("job:"), undefined, { revalidate: true });

          // For specific job events, also mutate the individual job cache
          if (data.jobId) {
            mutate(`job:${data.jobId}`);
          }

          // Clear progress for completed jobs
          if (eventName === "job:succeeded" || eventName === "job:failed" || eventName === "job:cancelled") {
            if (data.jobId) {
              setJobProgress((prev) => {
                const next = new Map(prev);
                next.delete(data.jobId as string);
                return next;
              });
            }
          }
        } catch {
          // skip malformed events
        }
      });
    }

    // Handle real-time job progress events (tool calls, messages, cost)
    es.addEventListener("job:progress", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as JobProgress;
        if (data.jobId) {
          setJobProgress((prev) => {
            const next = new Map(prev);
            const existing = next.get(data.jobId) || [];
            // Keep last 50 progress events per job
            next.set(data.jobId, [...existing, data].slice(-50));
            return next;
          });
        }
      } catch {
        // skip
      }
    });

    // Also listen for unnamed messages as fallback
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const event: SSEEvent = {
          type: data.type || "message",
          data,
          timestamp: new Date().toISOString(),
        };
        setEvents((prev) => [event, ...prev].slice(0, 100));
      } catch {
        // skip malformed events
      }
    };

    es.onerror = () => {
      setStatus("disconnected");
      es.close();
      setTimeout(connect, 5000);
    };
  }, [baseUrl, secret]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
    };
  }, [connect]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, status, clearEvents, jobProgress };
}
