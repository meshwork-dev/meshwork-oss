"use client";

import { useState, useEffect, useCallback } from "react";
import { checkSession, login, clearAuth } from "@/lib/auth";
import { initAPI, API_BASE } from "@/lib/api";

/**
 * Gates the app on a valid httpOnly session cookie. Auth state is simply
 * "logged in or not" — the runner secret never reaches the browser. All
 * runner traffic goes through the server-side proxy at /api/runner.
 */
export function AuthGate({ children }: { children: (props: { baseUrl: string }) => React.ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    checkSession()
      .then((ok) => {
        if (ok) {
          initAPI();
          setAuthed(true);
        }
      })
      .finally(() => setChecking(false));
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const result = await login(input);
      if (!result.ok) {
        setError(result.error || "Invalid password");
        return;
      }
      initAPI();
      setAuthed(true);
    } catch (err) {
      console.warn("[auth] Login request failed:", err);
      setError("Cannot reach dashboard server");
    }
  }, [input]);

  if (checking) return null;

  if (!authed) {
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

  return <>{children({ baseUrl: API_BASE })}</>;
}

export { clearAuth };
