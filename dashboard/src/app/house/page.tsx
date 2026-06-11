"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";

const HousePixelScene = dynamic(() => import("@/components/house/HousePixelScene"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[420px] text-zinc-500">
      Loading the house…
    </div>
  ),
});

type Persona = {
  id: string;
  name: string;
  archetype: string;
  persona: string;
  opener: string;
  color: string;
};

type Belief = { id: string; day: number; note: string; weight: number; sourceEventId?: string | null };
type PrivateThought = {
  id: string;
  day: number;
  beat: number;
  target: string | null;
  publicFacade: string;
  trueFeeling: string;
  eventId?: string;
};
type SecretMission = { id: string; day: number; brief: string; status: string };
type Agent = Persona & {
  status: "in" | "evicted";
  mood: string;
  evictedDay: number | null;
  nominationsReceived?: number;
  beliefs?: Record<string, Belief[]>;
  privateThoughts?: PrivateThought[];
  secretMission?: SecretMission | null;
  lastReflectedDay?: number;
};

type Relationship = { strength: number; type: string; history: Array<{ day: number; delta: number }> };

type Plan = {
  id: string;
  ownerId: string;
  targetId: string | null;
  action: string;
  trigger: { type: string; value?: number };
  status: "pending" | "executed" | "foiled" | "expired";
  secrecy: "secret" | "shared";
  createdDay: number;
};

type Pact = {
  id: string;
  members: string[];
  type: "alliance" | "final_two" | "voting_bloc";
  name?: string | null;
  formedDay: number;
  strength: number;
  secret: boolean;
  status: "active" | "broken" | "dissolved";
  brokenDay?: number;
  brokenBy?: string | null;
};

type ShowEvent = {
  id: string;
  ts: string;
  day: number;
  beat: number;
  phase: string;
  type: string;
  actors: string[];
  narration: string;
  quote?: string;
  nominations?: Array<{ voter: string; nominee: string }>;
  eviction?: { evicted: string; votes: Record<string, number> };
  twistType?: string;
  twistLabel?: string;
  pactId?: string;
  secondaryActor?: string | null;
  speaker?: string;
  line?: string;
  conversationType?: string;
  conversation?: boolean;
  transcript?: Array<{ speaker: string; line: string }>;
};

type State = {
  season: number;
  enabled: boolean;
  day: number;
  beat: number;
  phase: string;
  agents: Agent[];
  relationships: Record<string, Relationship>;
  plans?: Plan[];
  pacts?: Pact[];
  events: ShowEvent[];
  evictions: Array<{ day: number; evicted: string }>;
  winner: string | null;
  lastTickAt: string | null;
  nextTickAt: string | null;
  totalTicks: number;
  forceNextVotePublic?: boolean;
};

function pairKey(a: string, b: string) {
  return [a, b].sort().join(":");
}

const EVENT_TYPE_STYLES: Record<string, { bg: string; border: string; label: string }> = {
  chat: { bg: "bg-zinc-900", border: "border-zinc-700", label: "CHAT" },
  alliance: { bg: "bg-emerald-950/40", border: "border-emerald-700/50", label: "ALLIANCE" },
  betrayal: { bg: "bg-rose-950/40", border: "border-rose-700/50", label: "BETRAYAL" },
  romance: { bg: "bg-pink-950/40", border: "border-pink-700/50", label: "ROMANCE" },
  prank: { bg: "bg-amber-950/40", border: "border-amber-700/50", label: "PRANK" },
  confessional: { bg: "bg-indigo-950/40", border: "border-indigo-700/50", label: "CONFESSIONAL" },
  challenge: { bg: "bg-cyan-950/40", border: "border-cyan-700/50", label: "CHALLENGE" },
  nomination: { bg: "bg-yellow-950/40", border: "border-yellow-600/50", label: "NOMINATIONS" },
  eviction: { bg: "bg-red-950/50", border: "border-red-600/60", label: "EVICTION" },
  finale: { bg: "bg-violet-950/60", border: "border-violet-500/70", label: "FINALE" },
  scheme_plan:      { bg: "bg-fuchsia-950/40", border: "border-fuchsia-600/50", label: "PLAN ⚙️" },
  scheme_execution: { bg: "bg-orange-950/50", border: "border-orange-500/60", label: "FOLLOW-THROUGH" },
  scheme_foiled:    { bg: "bg-slate-900/60", border: "border-slate-500/50", label: "FOILED" },
  reflection:       { bg: "bg-sky-950/40", border: "border-sky-600/50", label: "REFLECTION" },
  diary_room:       { bg: "bg-purple-950/50", border: "border-purple-500/60", label: "DIARY ROOM" },
  twist:            { bg: "bg-yellow-900/60", border: "border-yellow-400/70", label: "BB VOICE ⚡" },
  pact_formed:      { bg: "bg-teal-950/50", border: "border-teal-500/60", label: "PACT FORMED" },
  pact_broken:      { bg: "bg-rose-950/60", border: "border-rose-500/70", label: "PACT SHATTERED" },
  entrance:         { bg: "bg-orange-950/40", border: "border-orange-500/50", label: "ENTRANCE" },
  dialogue_turn:    { bg: "bg-zinc-900/60", border: "border-zinc-700/50", label: "DIALOGUE" },
};

function HouseView({ baseUrl }: { baseUrl: string }) {
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${baseUrl}/bigbrother/state`);
      const j = await r.json();
      if (j?.ok) setState(j.state);
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  const call = async (path: string) => {
    setBusy(true);
    try {
      await fetch(`${baseUrl}${path}`, { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading || !state) {
    return <div className="text-zinc-500 p-8">Loading The Loop…</div>;
  }

  const alive = state.agents.filter((a) => a.status === "in");
  const evicted = state.agents.filter((a) => a.status === "evicted");
  const recentEvents = [...state.events].reverse().slice(0, 50);

  return (
    <div className="space-y-4">
      {/* Control bar */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-white tracking-tight">
              THE LOOP <span className="text-zinc-500 text-sm font-normal">— Season {state.season}</span>
            </h2>
            <p className="text-xs text-zinc-500">
              24/7 AI Big Brother · powered by Z.ai · {alive.length} housemates remaining
            </p>
          </div>
          <div className="flex items-center gap-2">
            {state.winner ? (
              <>
                <span className="px-3 py-1.5 rounded bg-violet-900/60 text-violet-200 text-sm font-bold">
                  🏆 {state.winner} wins
                </span>
                <button
                  onClick={() => call("/bigbrother/reset")}
                  disabled={busy}
                  className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm disabled:opacity-50"
                >
                  New season
                </button>
              </>
            ) : state.enabled ? (
              <button
                onClick={() => call("/bigbrother/stop")}
                disabled={busy}
                className="px-4 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-sm font-semibold disabled:opacity-50"
              >
                ⏸ Pause stream
              </button>
            ) : (
              <button
                onClick={() => call("/bigbrother/start")}
                disabled={busy}
                className="px-4 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-semibold disabled:opacity-50"
              >
                ▶ Start stream
              </button>
            )}
            <button
              onClick={() => call("/bigbrother/tick")}
              disabled={busy}
              className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm disabled:opacity-50"
              title="Generate one event immediately"
            >
              Force beat
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-zinc-400">
          <span>
            <span className="text-zinc-600">Day</span>{" "}
            <span className="text-white font-bold">{state.day}</span>
          </span>
          <span>
            <span className="text-zinc-600">Phase</span>{" "}
            <span className="text-white font-bold uppercase">{state.phase}</span>
          </span>
          <span>
            <span className="text-zinc-600">Beat</span>{" "}
            <span className="text-white">
              {state.beat + 1}/6
            </span>
          </span>
          <span>
            <span className="text-zinc-600">Stream</span>{" "}
            <span className={state.enabled ? "text-teal-400 font-bold" : "text-zinc-500"}>
              {state.enabled ? "LIVE" : "PAUSED"}
            </span>
          </span>
          <span>
            <span className="text-zinc-600">Next beat</span>{" "}
            <span className="text-zinc-300">
              {state.nextTickAt ? new Date(state.nextTickAt).toLocaleTimeString() : "—"}
            </span>
          </span>
          <span>
            <span className="text-zinc-600">Total beats</span>{" "}
            <span className="text-zinc-300">{state.totalTicks}</span>
          </span>
        </div>
      </div>

      {/* Pending plans strip — shows active scheduled intentions */}
      {(() => {
        const pending = (state.plans || []).filter((p) => p.status === "pending");
        if (!pending.length) return null;
        return (
          <div className="rounded-lg border border-fuchsia-900/40 bg-fuchsia-950/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs uppercase tracking-wider text-fuchsia-300 font-semibold">
                ⚙️ Scheduled Schemes
              </span>
              <span className="text-[10px] text-zinc-500">{pending.length} pending</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {pending.slice(0, 6).map((p) => {
                const owner = state.agents.find((a) => a.id === p.ownerId);
                const target = p.targetId ? state.agents.find((a) => a.id === p.targetId) : null;
                const trig =
                  p.trigger.type === "day"
                    ? `day ${p.trigger.value}`
                    : p.trigger.type === "before_nomination"
                    ? "before nomination"
                    : `+${p.trigger.value ?? 0} beats`;
                return (
                  <div key={p.id} className="text-xs rounded border border-fuchsia-900/30 bg-zinc-950 p-2">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="font-bold" style={{ color: owner?.color || "#fff" }}>
                        {owner?.name || p.ownerId}
                      </span>
                      <span className="text-zinc-600">→</span>
                      <span className="text-zinc-300">{target?.name || "house"}</span>
                      <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-900/40 text-fuchsia-200">
                        {trig}
                      </span>
                    </div>
                    <div className="text-zinc-400 leading-tight">{p.action}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Active pacts strip */}
      {(() => {
        const active = (state.pacts || []).filter((p) => p.status === "active");
        if (!active.length) return null;
        return (
          <div className="rounded-lg border border-teal-900/40 bg-teal-950/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs uppercase tracking-wider text-teal-300 font-semibold">
                🤝 Active Pacts
              </span>
              <span className="text-[10px] text-zinc-500">{active.length} coalition{active.length === 1 ? "" : "s"}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {active.map((p) => {
                const members = p.members
                  .map((mid) => state.agents.find((a) => a.id === mid))
                  .filter(Boolean) as Agent[];
                const typeLabel = p.type === "final_two" ? "FINAL TWO" : p.type === "voting_bloc" ? "VOTING BLOC" : "ALLIANCE";
                return (
                  <div key={p.id} className="text-xs rounded border border-teal-900/30 bg-zinc-950 p-2">
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-900/50 text-teal-200 font-bold">
                        {typeLabel}
                      </span>
                      {p.name && <span className="text-zinc-300 italic">&ldquo;{p.name}&rdquo;</span>}
                      {p.secret && <span className="text-[10px] text-zinc-500">· secret</span>}
                      <span className="ml-auto text-[10px] text-zinc-500">since D{p.formedDay}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mb-1">
                      {members.map((m) => (
                        <span key={m.id} className="text-[11px] font-bold" style={{ color: m.color }}>
                          {m.name}
                        </span>
                      ))}
                    </div>
                    <div className="w-full h-1 bg-zinc-900 rounded overflow-hidden">
                      <div className="h-full bg-teal-500" style={{ width: `${p.strength}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Twist state indicator */}
      {state.forceNextVotePublic && (
        <div className="rounded-lg border border-yellow-500/60 bg-yellow-900/30 p-3 text-sm text-yellow-200">
          <span className="font-bold">⚡ BB VOICE</span> — next eviction vote will be <span className="underline">public</span>. Every voter must say the name to their face.
        </div>
      )}

      {/* Pixel house view */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        <HousePixelScene baseUrl={baseUrl} />
      </div>

      {/* Daily highlights reel */}
      <DailyHighlights baseUrl={baseUrl} currentDay={state.day} eventsCount={state.events.length} />

      {/* Diary Room — public/private gap */}
      {(() => {
        const entries = alive
          .flatMap((a) =>
            (a.privateThoughts || []).slice(-3).map((t) => ({
              agent: a,
              ...t,
            })),
          )
          .sort((a, b) => (b.day * 1000 + b.beat) - (a.day * 1000 + a.beat))
          .slice(0, 6);
        if (!entries.length) return null;
        return (
          <div className="rounded-lg border border-purple-900/50 bg-purple-950/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs uppercase tracking-wider text-purple-300 font-semibold">
                🎤 Diary Room — Public vs Private
              </span>
              <span className="text-[10px] text-zinc-500">latest confessions</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {entries.map((e) => {
                const target = e.target ? state.agents.find((a) => a.id === e.target) : null;
                return (
                  <div key={e.id} className="text-xs rounded border border-purple-900/30 bg-zinc-950 p-2">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="font-bold" style={{ color: e.agent.color }}>{e.agent.name}</span>
                      <span className="text-zinc-600">on</span>
                      <span className="text-zinc-300">{target?.name || "—"}</span>
                      <span className="ml-auto text-[10px] text-zinc-500">D{e.day}</span>
                    </div>
                    <div className="text-[11px] text-zinc-500 mb-0.5">
                      <span className="text-zinc-600">says:</span> &ldquo;{e.publicFacade}&rdquo;
                    </div>
                    <div className="text-[11px] text-purple-200">
                      <span className="text-purple-400">thinks:</span> &ldquo;{e.trueFeeling}&rdquo;
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Secret missions */}
      {(() => {
        const onMission = alive.filter((a) => a.secretMission?.status === "active");
        if (!onMission.length) return null;
        return (
          <div className="rounded-lg border border-amber-500/50 bg-amber-950/20 p-3">
            <div className="text-xs uppercase tracking-wider text-amber-300 font-semibold mb-2">
              🕵️ Active Secret Missions
            </div>
            <div className="space-y-1">
              {onMission.map((a) => (
                <div key={a.id} className="text-xs text-amber-100">
                  <span className="font-bold" style={{ color: a.color }}>{a.name}</span>
                  <span className="text-zinc-500"> — </span>
                  <span className="text-zinc-300 italic">&ldquo;{a.secretMission!.brief}&rdquo;</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Housemates */}
        <div className="lg:col-span-1 space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-zinc-500 px-1">
            Housemates — {alive.length} in, {evicted.length} out
          </h3>
          {state.agents.map((a) => {
            const isEvicted = a.status === "evicted";
            return (
              <div
                key={a.id}
                className={`rounded-lg border p-3 ${
                  isEvicted ? "border-zinc-900 bg-zinc-950 opacity-50" : "border-zinc-800 bg-zinc-950"
                }`}
                style={
                  !isEvicted
                    ? { borderLeftWidth: 4, borderLeftColor: a.color }
                    : undefined
                }
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white">{a.name}</span>
                      {isEvicted && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-950 text-red-300">
                          EVICTED D{a.evictedDay}
                        </span>
                      )}
                      {!isEvicted && state.winner === a.name && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-700 text-white">
                          🏆 WINNER
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500">{a.archetype}</div>
                  </div>
                  {!isEvicted && (
                    <div className="text-right">
                      <div className="text-[10px] text-zinc-600 uppercase">Mood</div>
                      <div className="text-xs text-zinc-300">{a.mood}</div>
                    </div>
                  )}
                </div>
                {!isEvicted && alive.length > 1 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {alive
                      .filter((o) => o.id !== a.id)
                      .map((o) => {
                        const rel = state.relationships[pairKey(a.id, o.id)];
                        const s = rel?.strength ?? 0;
                        const color =
                          s > 40
                            ? "bg-emerald-900/60 text-emerald-300"
                            : s < -40
                            ? "bg-rose-900/60 text-rose-300"
                            : s > 10
                            ? "bg-emerald-950/40 text-emerald-400"
                            : s < -10
                            ? "bg-rose-950/40 text-rose-400"
                            : "bg-zinc-900 text-zinc-500";
                        // Surface strongest belief as tooltip — this is the "grudges never forgotten" signal
                        const beliefs = a.beliefs?.[o.id] || [];
                        const topBelief = beliefs.length
                          ? [...beliefs].sort((x, y) => y.weight - x.weight)[0]
                          : null;
                        const tipBase = `${o.name}: ${s} (${rel?.type || "neutral"})`;
                        const tip = topBelief
                          ? `${tipBase}\n\nBelief (w${topBelief.weight}, day ${topBelief.day}):\n"${topBelief.note}"`
                          : tipBase;
                        return (
                          <span
                            key={o.id}
                            className={`text-[10px] px-1.5 py-0.5 rounded ${color} ${topBelief ? "ring-1 ring-sky-500/40" : ""}`}
                            title={tip}
                          >
                            {o.name[0]}
                            {s >= 0 ? `+${s}` : s}
                            {topBelief ? <span className="ml-0.5 text-sky-300">●</span> : null}
                          </span>
                        );
                      })}
                  </div>
                )}
                {!isEvicted && a.beliefs && Object.values(a.beliefs).some((arr) => arr.length) && (
                  <div className="mt-1.5 text-[10px] text-sky-400/80">
                    {Object.values(a.beliefs).reduce((n, arr) => n + arr.length, 0)} core belief{Object.values(a.beliefs).reduce((n, arr) => n + arr.length, 0) === 1 ? "" : "s"} held
                    {a.lastReflectedDay ? ` · last reflected day ${a.lastReflectedDay}` : ""}
                  </div>
                )}
                {!isEvicted && (() => {
                  const myPacts = (state.pacts || []).filter((p) => p.status === "active" && p.members.includes(a.id));
                  if (!myPacts.length) return null;
                  return (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {myPacts.map((p) => {
                        const mates = p.members
                          .filter((m) => m !== a.id)
                          .map((m) => state.agents.find((x) => x.id === m)?.name)
                          .filter(Boolean)
                          .join(", ");
                        return (
                          <span
                            key={p.id}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-teal-900/50 text-teal-200"
                            title={`${p.type}${p.name ? ` "${p.name}"` : ""} with ${mates} — strength ${p.strength}${p.secret ? " (secret)" : ""}`}
                          >
                            🤝 {mates}
                          </span>
                        );
                      })}
                    </div>
                  );
                })()}
                {!isEvicted && a.secretMission?.status === "active" && (
                  <div className="mt-1 text-[10px] px-1.5 py-0.5 inline-block rounded bg-amber-900/40 text-amber-200" title={a.secretMission.brief}>
                    🕵️ on a secret mission
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Live feed */}
        <div className="lg:col-span-2">
          <h3 className="text-xs uppercase tracking-wider text-zinc-500 px-1 mb-2">
            Live feed {state.enabled && <span className="text-teal-400">● LIVE</span>}
          </h3>
          <div className="space-y-2 max-h-[80vh] overflow-y-auto pr-1">
            {recentEvents.length === 0 && (
              <div className="text-center text-zinc-600 p-8 border border-dashed border-zinc-800 rounded-lg">
                No events yet. Hit <span className="text-teal-400">Start stream</span> to begin
                Season {state.season}.
              </div>
            )}
            {recentEvents.map((ev) => {
              const style = EVENT_TYPE_STYLES[ev.type] || EVENT_TYPE_STYLES.chat;
              return (
                <div
                  key={ev.id}
                  className={`rounded-lg border p-3 ${style.bg} ${style.border}`}
                >
                  <div className="flex items-center justify-between text-[10px] mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold tracking-wider text-zinc-300">{style.label}</span>
                      <span className="text-zinc-600">Day {ev.day}</span>
                      <span className="text-zinc-700">·</span>
                      <span className="text-zinc-600">{ev.actors.join(", ")}</span>
                    </div>
                    <span className="text-zinc-600">
                      {new Date(ev.ts).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-sm text-zinc-200 leading-snug">{ev.narration}</div>
                  {ev.quote && ev.type !== "dialogue_turn" && (
                    <div className="mt-1.5 text-sm italic text-zinc-400 pl-3 border-l-2 border-zinc-700">
                      {ev.quote}
                    </div>
                  )}
                  {ev.transcript && ev.transcript.length > 0 && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300 uppercase tracking-wider">
                        Full transcript ({ev.transcript.length} turns)
                      </summary>
                      <div className="mt-1.5 space-y-1 pl-3 border-l-2 border-zinc-700">
                        {ev.transcript.map((t, i) => (
                          <div key={i} className="text-zinc-400">
                            <span className="font-semibold text-zinc-200">{t.speaker}:</span>{" "}
                            <span className="italic">&ldquo;{t.line}&rdquo;</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

type HighlightJob = {
  id: string;
  day: number | null;
  synthetic: boolean;
  status: "running" | "done" | "failed";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  hasVideo: boolean;
  log?: string;
};

function DailyHighlights({
  baseUrl, currentDay, eventsCount,
}: {
  baseUrl: string; currentDay: number; eventsCount: number;
}) {
  const [jobs, setJobs] = useState<HighlightJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<HighlightJob | null>(null);

  const loadJobs = useCallback(async () => {
    const r = await fetch(`${baseUrl}/bigbrother/highlights`);
    const j = await r.json();
    if (j?.ok) {
      setJobs(j.jobs || []);
      if (!selectedId && j.jobs?.[0]) setSelectedId(j.jobs[0].id);
    }
  }, [baseUrl, selectedId]);

  const loadJobDetail = useCallback(async (id: string) => {
    const r = await fetch(`${baseUrl}/bigbrother/highlights/${id}`);
    const j = await r.json();
    if (j?.ok) setSelectedJob(j.job);
  }, [baseUrl]);

  useEffect(() => { loadJobs(); }, [loadJobs]);
  useEffect(() => {
    if (!selectedId) return;
    loadJobDetail(selectedId);
    // Poll running jobs every 3s until done/failed so the UI reflects render progress.
    const iv = setInterval(() => {
      if (selectedJob?.status === "running" || !selectedJob) loadJobDetail(selectedId);
    }, 3000);
    return () => clearInterval(iv);
  }, [selectedId, loadJobDetail, selectedJob]);

  const dispatch = async (opts: { synthetic?: boolean; day?: number }) => {
    setBusy(true);
    try {
      const r = await fetch(`${baseUrl}/bigbrother/highlights`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts),
      });
      const j = await r.json();
      if (j?.ok) {
        setSelectedId(j.id);
        await loadJobs();
      }
    } finally {
      setBusy(false);
    }
  };

  const videoSrc = selectedJob?.hasVideo
    ? `${baseUrl}/bigbrother/highlights/${selectedJob.id}/video`
    : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-300">
            🎬 Daily Highlights
          </h3>
          <p className="text-xs text-zinc-500">
            TTS-narrated recap of Day {currentDay} · {eventsCount} event{eventsCount === 1 ? "" : "s"} in loop state
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => dispatch({ day: currentDay })}
            disabled={busy || eventsCount === 0}
            className="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-semibold disabled:opacity-40"
            title={eventsCount === 0 ? "No events yet — start the loop or use Synthetic preview" : `Render highlights for Day ${currentDay}`}
          >
            {busy ? "Dispatching…" : `Render Day ${currentDay}`}
          </button>
          <button
            onClick={() => dispatch({ synthetic: true })}
            disabled={busy}
            className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm disabled:opacity-40"
            title="Render a fixture-day reel to prove the pipeline works"
          >
            Synthetic preview
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Job list */}
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">Recent reels</div>
          {jobs.length === 0 && (
            <div className="text-xs text-zinc-600 italic">No reels rendered yet.</div>
          )}
          {jobs.slice(0, 8).map((j) => {
            const active = j.id === selectedId;
            const color =
              j.status === "done" ? "text-emerald-300"
              : j.status === "failed" ? "text-rose-300"
              : "text-amber-300 animate-pulse";
            return (
              <button
                key={j.id}
                onClick={() => setSelectedId(j.id)}
                className={`w-full text-left text-xs rounded border p-2 ${
                  active ? "border-teal-700 bg-teal-950/30" : "border-zinc-800 bg-zinc-950 hover:bg-zinc-900"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`font-bold ${color}`}>
                    {j.status.toUpperCase()}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {new Date(j.startedAt).toLocaleTimeString()}
                  </span>
                </div>
                <div className="text-zinc-400 mt-0.5">
                  {j.synthetic ? "Synthetic preview" : `Day ${j.day}`}
                </div>
              </button>
            );
          })}
        </div>

        {/* Video + detail */}
        <div className="lg:col-span-2">
          {!selectedJob && (
            <div className="text-xs text-zinc-600 italic p-4 border border-dashed border-zinc-800 rounded">
              Pick a reel or render a new one.
            </div>
          )}
          {selectedJob && (
            <div className="space-y-2">
              <div className="aspect-square lg:aspect-video max-w-xl mx-auto bg-black rounded overflow-hidden border border-zinc-800">
                {videoSrc ? (
                  <video
                    key={selectedJob.id}
                    src={videoSrc}
                    controls
                    className="w-full h-full object-contain"
                  />
                ) : selectedJob.status === "running" ? (
                  <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                    Rendering… this takes 8–12 minutes.
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-rose-400 text-sm p-4 text-center">
                    {selectedJob.error || "No video"}
                  </div>
                )}
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300 uppercase tracking-wider">
                  Render log
                </summary>
                <pre className="mt-1 p-2 bg-black rounded border border-zinc-900 text-zinc-500 text-[10px] overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {selectedJob.log || "(no output yet)"}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      {({ baseUrl }) => (
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col">
            <Header baseUrl={baseUrl} />
            <main className="flex-1 p-2 sm:p-4 md:p-6 pb-24 md:pb-6">
              <HouseView baseUrl={baseUrl} />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
