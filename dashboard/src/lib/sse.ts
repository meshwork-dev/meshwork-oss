"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { mutate } from "swr";
import { API_BASE } from "./api";
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

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export function useSSE() {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [jobProgress, setJobProgress] = useState<Map<string, JobProgress[]>>(new Map());
  const esRef = useRef<EventSource | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    // Authenticated via httpOnly session cookie — no secret in the URL.
    const url = `${API_BASE}/events`;
    const es = new EventSource(url);
    esRef.current = es;
    setStatus("connecting");

    es.onopen = () => {
      setStatus("connected");
      backoffRef.current = INITIAL_BACKOFF_MS; // reset backoff on success
    };

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
        } catch (err) {
          console.warn(`[sse] Skipping malformed "${eventName}" event:`, err);
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
      } catch (err) {
        console.warn("[sse] Skipping malformed job:progress event:", err);
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
      } catch (err) {
        console.warn("[sse] Skipping malformed message event:", err);
      }
    };

    es.onerror = () => {
      setStatus("disconnected");
      es.close();
      // Exponential backoff: 1s doubling up to 30s, reset on successful open.
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      console.warn(`[sse] Connection lost; reconnecting in ${delay}ms`);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      esRef.current?.close();
    };
  }, [connect]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, status, clearEvents, jobProgress };
}
