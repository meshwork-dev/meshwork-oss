"use client";

import { useState } from "react";
import { getAPI } from "@/lib/api";
import type { Agent } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";

export function RunAgentForm({ agents }: { agents: Agent[] }) {
  const [agentName, setAgentName] = useState(agents[0]?.name || "");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ jobId: string } | null>(null);
  const [error, setError] = useState("");

  const selectedAgent = agents.find((a) => a.name === agentName);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setResult(null);
    setSubmitting(true);
    try {
      const res = await getAPI()!.runAgent({
        agent: agentName,
        prompt,
        model: model || undefined,
        provider: provider || undefined,
      });
      setResult(res);
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run agent");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Run Agent</h3>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Agent</label>
          <select
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-teal-500"
          >
            {agents.map((a) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-teal-500"
          >
            <option value="">Default</option>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-teal-500"
          >
            <option value="">Default</option>
            <option value="claude">Claude</option>
            <option value="zai">Z.ai (GLM)</option>
          </select>
        </div>
      </div>

      {/* Agent info panel */}
      {selectedAgent && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge color={selectedAgent.provider === "zai" ? "yellow" : "teal"}>
            {selectedAgent.provider || "claude"}
          </Badge>
          <Badge color={selectedAgent.model === "opus" ? "teal" : selectedAgent.model === "sonnet" ? "blue" : "gray"}>
            {selectedAgent.model || "default"}
          </Badge>
          {selectedAgent.disallowedTools && selectedAgent.disallowedTools.length > 0 && (
            <span className="text-zinc-500">
              Restricted: {selectedAgent.disallowedTools.join(", ")}
            </span>
          )}
        </div>
      )}

      {/* Team lead warning */}
      {selectedAgent?.isTeamLead && selectedAgent.teammates && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
          <span className="mt-0.5 shrink-0">*</span>
          <span>
            This agent is a team lead and will spawn teammates:{" "}
            <span className="text-amber-200 font-medium">{selectedAgent.teammates.join(", ")}</span>
          </span>
        </div>
      )}

      <div>
        <label className="block text-xs text-zinc-500 mb-1">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          required
          placeholder="Describe the task..."
          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-teal-500 resize-none"
        />
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {result && (
        <p className="text-emerald-400 text-sm">
          Job started: <a href={`/jobs/${result.jobId}`} className="underline">{result.jobId.slice(0, 8)}</a>
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !prompt}
        className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
      >
        {submitting && <Spinner size="sm" />}
        Run Agent
      </button>
    </form>
  );
}
