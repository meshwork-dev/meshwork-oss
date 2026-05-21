import { Badge } from "@/components/ui/Badge";
import type { Agent } from "@/lib/types";

const MODEL_COLORS: Record<string, string> = {
  opus: "teal",
  sonnet: "blue",
  haiku: "gray",
};

const PROVIDER_COLORS: Record<string, string> = {
  claude: "teal",
  zai: "yellow",
};

export function AgentCard({ agent }: { agent: Agent }) {
  const modelColor = MODEL_COLORS[agent.model || ""] || "gray";
  const providerColor = PROVIDER_COLORS[agent.provider || ""] || "gray";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white">{agent.name}</h3>
          {agent.isTeamLead && (
            <Badge color="yellow">Team Lead</Badge>
          )}
        </div>
        <Badge color={modelColor}>{agent.model || "default"}</Badge>
      </div>

      {agent.description && (
        <p className="text-xs text-zinc-500 mb-2">{agent.description}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        <Badge color={providerColor}>{agent.provider || "claude"}</Badge>
        {agent.disallowedTools && agent.disallowedTools.length > 0 && (
          agent.disallowedTools.map((tool) => (
            <span
              key={tool}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-500 border border-zinc-700"
            >
              No {tool}
            </span>
          ))
        )}
      </div>

      {agent.isTeamLead && agent.teammates && agent.teammates.length > 0 && (
        <div className="mt-3 pt-2 border-t border-zinc-800">
          <p className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">Teammates</p>
          <div className="flex flex-wrap gap-1">
            {agent.teammates.map((t) => (
              <span
                key={t}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-400 border border-zinc-700/50"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
