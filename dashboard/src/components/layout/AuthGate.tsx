"use client";

import { useState, useEffect, useCallback } from "react";
import { getRunnerSecret, setRunnerSecret, clearAuth } from "@/lib/auth";
import { initAPI } from "@/lib/api";

function getRunnerUrl() {
  if (typeof window === "undefined") return "http://localhost:3210";
  if (process.env.NEXT_PUBLIC_RUNNER_URL) return process.env.NEXT_PUBLIC_RUNNER_URL;
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:3210`;
}

export function AuthGate({ children }: { children: (props: { baseUrl: string; secret: string }) => React.ReactNode }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const stored = getRunnerSecret();
    if (stored) {
      initAPI(getRunnerUrl(), stored);
      setSecret(stored);
    }
    setChecking(false);
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: input }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Invalid password");
        return;
      }
      const { runnerSecret } = await res.json();
      setRunnerSecret(runnerSecret);
      initAPI(getRunnerUrl(), runnerSecret);
      setSecret(runnerSecret);
    } catch {
      setError("Cannot reach dashboard server");
    }
  }, [input]);

  if (checking) return null;

  if (!secret) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 p-8">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-teal-400">Meshwork</h1>
            <p className="text-sm text-zinc-500 mt-1">Enter your dashboard password</p>
          </div>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Dashboard password"
            className="w-full px-4 py-2.5 bg-zinc-900 border border-zinc-700 rounded-lg text-white placeholder:text-zinc-600 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
            autoFocus
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            className="w-full py-2.5 bg-teal-600 hover:bg-teal-500 text-white rounded-lg font-medium transition-colors"
          >
            Sign In
          </button>
        </form>
      </div>
    );
  }

  return <>{children({ baseUrl: getRunnerUrl(), secret })}</>;
}

export { clearAuth };
