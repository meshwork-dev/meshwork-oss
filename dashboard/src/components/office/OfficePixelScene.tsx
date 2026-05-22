"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Types & data                                                        */
/* ------------------------------------------------------------------ */

type AgentInfo = { name: string; description?: string };
type Meeting = {
  id?: string;
  meetingId?: string;
  topic?: string;
  status?: string;
  participants?: string[];
  agents?: string[];
  currentSpeaker?: string | null;
};
type Job = { id?: string; jobId?: string; status?: string; agent?: string; agentName?: string };
type AgentState = "idle" | "working" | "meeting" | "offline";
type TeamId = "engineering" | "sales" | "marketing" | "product" | "sdlc";

type AgentNode = {
  name: string;
  team: TeamId;
  color: string;
  state: AgentState;
  currentJob?: string;
  currentMeeting?: string;
  isSpeaking?: boolean;
  meetingSeatIndex?: number; // assigned seat index in MEETING_SEATS (unique per meeting)
};

const TEAMS: Record<TeamId, { label: string; color: string }> = {
  engineering: { label: "Engineering", color: "#14b8a6" },
  product:     { label: "Product",     color: "#f59e0b" },
  sdlc:        { label: "SDLC / QA",   color: "#a78bfa" },
  sales:       { label: "Sales",       color: "#38bdf8" },
  marketing:   { label: "Marketing",   color: "#f472b6" },
};

const AGENT_TEAM: Record<string, TeamId> = {
  "engineer-planner": "engineering",
  "engineer-implementer": "engineering",
  "engineer-reviewer": "engineering",
  "ui-engineer": "engineering",
  "architect": "engineering",
  "product-manager": "product",
  "ba-agent": "product",
  "sprint-reporter": "product",
  "bug-triage": "product",
  "sales-development": "sales",
  "sales-researcher": "sales",
  "sales-outreach": "sales",
  "marketing": "marketing",
  "creative-assets": "marketing",
  "qa-agent": "sdlc",
  "uat-agent": "sdlc",
  "security-agent": "sdlc",
  "ask-dave-agent": "sdlc",
  "e2e-builder": "sdlc",
  "ux-agent": "sdlc",
};

const STATE_COLOR: Record<AgentState, string> = {
  idle: "#52525b",
  working: "#22c55e",
  meeting: "#fbbf24",
  offline: "#3f3f46",
};

/* ------------------------------------------------------------------ */
/* Data hook (shared with 3D version)                                  */
/* ------------------------------------------------------------------ */

function useOfficeData(baseUrl: string, secret: string, productId: string | null) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    let cancelled = false;
    const headers = { "x-runner-secret": secret };
    const agentsUrl = productId
      ? `${baseUrl}/api/products/${encodeURIComponent(productId)}/agents`
      : `${baseUrl}/agents`;
    const load = async () => {
      try {
        const [aRes, mRes, jRes] = await Promise.all([
          fetch(agentsUrl, { headers }),
          fetch(`${baseUrl}/api/meetings`, { headers }),
          fetch(`${baseUrl}/jobs?limit=50&status=running`, { headers }),
        ]);
        if (cancelled) return;
        if (aRes.ok) { const j = await aRes.json(); setAgents(j.agents ?? []); }
        if (jRes.ok) { const j = await jRes.json(); setJobs(j.jobs ?? j ?? []); }
        if (mRes.ok) {
          const j = await mRes.json();
          const list: Meeting[] = j.meetings ?? j ?? [];
          const active = list.filter((m) => (m.status ?? "active") !== "ended");
          // Fetch detail for each active meeting so we get currentSpeaker (list omits it)
          const details = await Promise.all(
            active.map(async (m) => {
              const mid = m.meetingId ?? m.id;
              if (!mid) return m;
              try {
                const r = await fetch(`${baseUrl}/meeting/${encodeURIComponent(mid)}`, { headers });
                if (!r.ok) return m;
                const d = await r.json();
                return { ...m, ...d };
              } catch {
                return m;
              }
            })
          );
          if (cancelled) return;
          const byId = new Map<string, Meeting>();
          details.forEach((m) => {
            const mid = m.meetingId ?? m.id;
            if (mid) byId.set(mid, m);
          });
          // Replace active entries with enriched details, keep ended as-is
          const merged = list.map((m) => {
            const mid = m.meetingId ?? m.id;
            if (mid && byId.has(mid)) return byId.get(mid)!;
            return m;
          });
          setMeetings(merged);
        }
      } catch { /* retry */ }
    };
    load();
    const iv = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [baseUrl, secret, productId]);

  const nodes = useMemo<AgentNode[]>(() => {
    const activeMeetings = meetings.filter((m) => (m.status ?? "active") !== "ended");
    const runningJobsByAgent = new Map<string, string>();
    jobs.forEach((j) => {
      const agent = j.agent || j.agentName;
      const id = j.id || j.jobId;
      if (agent && id && (j.status === "running" || j.status === "queued")) {
        runningJobsByAgent.set(agent, id);
      }
    });
    return agents.map((a) => {
      const team = AGENT_TEAM[a.name] ?? "sdlc";
      const inMeeting = activeMeetings.find((m) =>
        (m.participants ?? m.agents ?? []).includes(a.name)
      );
      const jobId = runningJobsByAgent.get(a.name);
      let state: AgentState = "idle";
      if (inMeeting) state = "meeting";
      else if (jobId) state = "working";
      let meetingSeatIndex: number | undefined;
      if (inMeeting) {
        const roster = (inMeeting.participants ?? inMeeting.agents ?? []);
        const idx = roster.indexOf(a.name);
        if (idx >= 0) meetingSeatIndex = idx;
      }
      return {
        name: a.name,
        team,
        color: TEAMS[team].color,
        state,
        currentJob: jobId,
        currentMeeting: inMeeting?.meetingId ?? inMeeting?.id,
        isSpeaking: !!inMeeting && inMeeting.currentSpeaker === a.name,
        meetingSeatIndex,
      };
    });
  }, [agents, meetings, jobs]);

  return { nodes, meetings };
}

/* ------------------------------------------------------------------ */
/* Pixel art constants                                                 */
/* ------------------------------------------------------------------ */

const TILE = 16;
const COLS = 48;
const ROWS = 30;
const WIDTH = COLS * TILE;   // 768
const HEIGHT = ROWS * TILE;  // 480

const PAL = {
  bg: "#0b0c10",
  floorA: "#2a2f3a",
  floorB: "#242932",
  wood1: "#7a4e2a",
  wood2: "#8b5a30",
  wallMid: "#3d4250",
  wallLit: "#4b5160",
  wallDark: "#262a34",
  baseboard: "#1a1d25",
  rugTeal1: "#0f766e",
  rugTeal2: "#14857c",
  rugPurple1: "#4c1d95",
  rugPurple2: "#5b28a7",
  desk1: "#5c3a1e",
  desk2: "#7a4e2a",
  deskEdge: "#3a2411",
  monitor: "#0ff",
  monitorFrame: "#1a1a1a",
  chairSeat: "#1f2937",
  glass: "rgba(180,220,255,0.15)",
  glassEdge: "#93c5fd",
  plantPot: "#6b4423",
  plantLeaf1: "#16a34a",
  plantLeaf2: "#22c55e",
  fridge: "#cbd5e1",
  fridgeEdge: "#475569",
  counter: "#e5e7eb",
  counterEdge: "#64748b",
  sofa1: "#6d28d9",
  sofa2: "#7c3aed",
  coffeeTable: "#3f3f46",
  whiteboard: "#f1f5f9",
  signBg: "#111827",
  signText: "#e5e7eb",
  doorBathroom: "#1e293b",
  doorTrim: "#f472b6",
  phoneBooth: "#334155",
  phoneLight: "#fbbf24",
  skin: "#f5c89b",
  hair: "#3f2815",
  shoe: "#18181b",
};

/* ------------------------------------------------------------------ */
/* Pod / desk / waypoint layout (tile coords)                          */
/* ------------------------------------------------------------------ */

type Rect = { x: number; y: number; w: number; h: number };
type Desk = { x: number; y: number; facing: "n" | "s" | "e" | "w"; team: TeamId };

// Team pod anchor rects (used for floor banner + bounding info)
const POD_RECTS: Record<TeamId, Rect> = {
  sdlc:        { x: 14, y: 2,  w: 10, h: 6 },   // top-left interior
  marketing:   { x: 26, y: 2,  w: 10, h: 6 },   // top-right interior
  engineering: { x: 26, y: 22, w: 14, h: 7 },   // bottom-right
  product:     { x: 38, y: 10, w: 8,  h: 10 },  // east
  sales:       { x: 14, y: 22, w: 10, h: 7 },   // bottom-left
};

// 4 desks per pod, pinwheel-ish layout, agents sit facing outward
function podDesks(r: Rect, team: TeamId): Desk[] {
  const cx = r.x + Math.floor(r.w / 2);
  const cy = r.y + Math.floor(r.h / 2);
  return [
    { x: cx - 3, y: cy - 2, facing: "n", team },
    { x: cx + 1, y: cy - 2, facing: "n", team },
    { x: cx - 3, y: cy + 1, facing: "s", team },
    { x: cx + 1, y: cy + 1, facing: "s", team },
  ];
}

const ALL_DESKS: Desk[] = (Object.keys(POD_RECTS) as TeamId[]).flatMap((t) => podDesks(POD_RECTS[t], t));

// Public wander waypoints (tile coords) — NONE inside meeting room (cols 19-31, rows 10-18)
const WAYPOINTS: Array<{ x: number; y: number; name: string }> = [
  { x: 4,  y: 3,  name: "Coffee" },
  { x: 8,  y: 3,  name: "Kitchen Island" },
  { x: 5,  y: 6,  name: "Fridge" },
  { x: 4,  y: 25, name: "Lounge" },
  { x: 8,  y: 26, name: "Sofa" },
  { x: 2,  y: 13, name: "Phone Booth" },
  { x: 2,  y: 17, name: "Phone Booth" },
];

// Meeting table chairs — positioned AROUND the conference table (ellipse at cols 21-30, rows 13-16),
// seated agents face inward toward the table.
const MEETING_SEATS: Array<{ x: number; y: number; facing: "n" | "s" }> = [
  // North side — sit just above the table, face south toward it
  { x: 21, y: 11, facing: "s" },
  { x: 24, y: 11, facing: "s" },
  { x: 27, y: 11, facing: "s" },
  { x: 30, y: 11, facing: "s" },
  // South side — sit just below the table, face north toward it
  { x: 21, y: 17, facing: "n" },
  { x: 24, y: 17, facing: "n" },
  { x: 27, y: 17, facing: "n" },
  { x: 30, y: 17, facing: "n" },
];

/* ------------------------------------------------------------------ */
/* Drawing helpers                                                     */
/* ------------------------------------------------------------------ */

function px(ctx: CanvasRenderingContext2D, x: number, y: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, 1, 1);
}
function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

function drawFloor(ctx: CanvasRenderingContext2D) {
  for (let ty = 0; ty < ROWS; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      rect(ctx, tx * TILE, ty * TILE, TILE, TILE, (tx + ty) & 1 ? PAL.floorA : PAL.floorB);
      // faint grid
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.fillRect(tx * TILE, ty * TILE + TILE - 1, TILE, 1);
      ctx.fillRect(tx * TILE + TILE - 1, ty * TILE, 1, TILE);
    }
  }
}

function drawRug(ctx: CanvasRenderingContext2D, r: Rect, c1: string, c2: string) {
  for (let ty = 0; ty < r.h; ty++) {
    for (let tx = 0; tx < r.w; tx++) {
      rect(ctx, (r.x + tx) * TILE, (r.y + ty) * TILE, TILE, TILE, (tx + ty) & 1 ? c1 : c2);
    }
  }
  // tassels
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(r.x * TILE, r.y * TILE, r.w * TILE, 2);
  ctx.fillRect(r.x * TILE, (r.y + r.h) * TILE - 2, r.w * TILE, 2);
}

function drawWoodFloor(ctx: CanvasRenderingContext2D, r: Rect) {
  for (let ty = 0; ty < r.h; ty++) {
    for (let tx = 0; tx < r.w; tx++) {
      const x = (r.x + tx) * TILE;
      const y = (r.y + ty) * TILE;
      rect(ctx, x, y, TILE, TILE, (tx + ty) & 1 ? PAL.wood1 : PAL.wood2);
      // plank lines
      rect(ctx, x, y + TILE - 1, TILE, 1, "rgba(0,0,0,0.4)");
    }
  }
}

function drawWalls(ctx: CanvasRenderingContext2D) {
  // Outer walls — 1 tile thick, with top lit edge
  const drawWallTile = (x: number, y: number) => {
    rect(ctx, x, y, TILE, TILE, PAL.wallMid);
    rect(ctx, x, y, TILE, 3, PAL.wallLit);
    rect(ctx, x, y + TILE - 2, TILE, 2, PAL.wallDark);
  };
  for (let tx = 0; tx < COLS; tx++) {
    drawWallTile(tx * TILE, 0);
    drawWallTile(tx * TILE, (ROWS - 1) * TILE);
  }
  for (let ty = 1; ty < ROWS - 1; ty++) {
    drawWallTile(0, ty * TILE);
    drawWallTile((COLS - 1) * TILE, ty * TILE);
  }
  // Baseboards inside
  ctx.fillStyle = PAL.baseboard;
  ctx.fillRect(TILE, TILE, (COLS - 2) * TILE, 2);
  ctx.fillRect(TILE, (ROWS - 1) * TILE - 2, (COLS - 2) * TILE, 2);
  ctx.fillRect(TILE, TILE, 2, (ROWS - 2) * TILE);
  ctx.fillRect((COLS - 1) * TILE - 2, TILE, 2, (ROWS - 2) * TILE);
}

function drawWindows(ctx: CanvasRenderingContext2D) {
  // North wall windows
  const ys = 3;
  [6, 16, 32, 42].forEach((tx) => {
    rect(ctx, tx * TILE, ys, 5 * TILE, 10, "#bfe0ff");
    rect(ctx, tx * TILE, ys, 5 * TILE, 2, "#8ec0ef");
    rect(ctx, tx * TILE + Math.floor(2.5 * TILE), ys, 1, 10, "#1e293b");
  });
  // South wall lower windows
  [6, 28, 42].forEach((tx) => {
    rect(ctx, tx * TILE, (ROWS - 1) * TILE + 3, 4 * TILE, 8, "#8ecbd1");
  });
}

function drawKitchen(ctx: CanvasRenderingContext2D) {
  // Kitchen zone: cols 1-12, rows 2-7. Wood floor beneath.
  drawWoodFloor(ctx, { x: 1, y: 1, w: 12, h: 7 });

  // L-shaped counter along north + west
  // North counter (under north wall): row 1 bottom half (just inside wall)
  const counterTopY = 1 * TILE + 8;
  const counterH = 10;
  // Sink + faucet + stove along north counter
  rect(ctx, 1 * TILE + 2, counterTopY, 10 * TILE, counterH, PAL.counter);
  rect(ctx, 1 * TILE + 2, counterTopY + counterH - 2, 10 * TILE, 2, PAL.counterEdge);
  // Sink
  rect(ctx, 3 * TILE, counterTopY + 2, 22, 6, "#64748b");
  rect(ctx, 3 * TILE + 10, counterTopY - 4, 2, 6, "#94a3b8"); // faucet
  // Stove burners
  [0, 1, 2, 3].forEach((i) => {
    rect(ctx, 6 * TILE + i * 10 + 2, counterTopY + 2, 7, 7, "#1a1a1a");
    rect(ctx, 6 * TILE + i * 10 + 3, counterTopY + 3, 5, 5, "#dc2626");
  });

  // West counter + fridge (col 1-2)
  rect(ctx, 1 * TILE + 2, 2 * TILE, 12, 5 * TILE, PAL.counter);
  rect(ctx, 1 * TILE + 12, 2 * TILE, 2, 5 * TILE, PAL.counterEdge);
  // Fridge (tall, upper)
  rect(ctx, 1 * TILE + 2, 2 * TILE, 14, 3 * TILE - 4, PAL.fridge);
  rect(ctx, 1 * TILE + 2, 2 * TILE + TILE, 14, 1, PAL.fridgeEdge);
  rect(ctx, 1 * TILE + 11, 2 * TILE + 6, 2, 4, PAL.fridgeEdge);
  rect(ctx, 1 * TILE + 11, 2 * TILE + TILE + 6, 2, 4, PAL.fridgeEdge);

  // Coffee machine
  rect(ctx, 1 * TILE + 3, 5 * TILE + 2, 11, 12, "#18181b");
  rect(ctx, 1 * TILE + 5, 5 * TILE + 5, 7, 4, "#dc2626");
  rect(ctx, 1 * TILE + 7, 5 * TILE + 10, 3, 3, "#78350f");

  // Kitchen island (bar counter with stools) — cols 4-9, row 5
  rect(ctx, 4 * TILE, 5 * TILE - 4, 6 * TILE, 10, PAL.wood2);
  rect(ctx, 4 * TILE, 5 * TILE - 4, 6 * TILE, 2, "#3f2207");
  // Fruit bowl + mugs on island
  rect(ctx, 5 * TILE, 5 * TILE - 8, 8, 4, "#ef4444");
  rect(ctx, 7 * TILE, 5 * TILE - 7, 5, 3, "#fbbf24");
  rect(ctx, 8 * TILE, 5 * TILE - 7, 5, 3, "#3b82f6");
  // 3 bar stools facing north
  for (let i = 0; i < 3; i++) {
    const x = 5 * TILE + i * 2 * TILE;
    rect(ctx, x + 2, 5 * TILE + 10, 10, 3, "#1f2937");
    rect(ctx, x + 5, 5 * TILE + 13, 4, 4, "#334155");
  }

  // KITCHEN sign
  drawSign(ctx, 7, 2, "KITCHEN");
}

function drawSign(ctx: CanvasRenderingContext2D, tx: number, ty: number, text: string) {
  const w = Math.max(32, text.length * 6 + 8);
  const x = tx * TILE - w / 2 + TILE / 2;
  const y = ty * TILE;
  rect(ctx, x, y, w, 10, PAL.signBg);
  rect(ctx, x, y, w, 1, "#374151");
  rect(ctx, x, y + 9, w, 1, "#111");
  ctx.fillStyle = PAL.signText;
  ctx.font = "bold 8px monospace";
  ctx.textBaseline = "top";
  ctx.fillText(text, x + 4, y + 1);
}

function drawMeetingRoom(ctx: CanvasRenderingContext2D) {
  // Center meeting room: cols 19-31, rows 10-18, glass walls
  const r = { x: 19, y: 10, w: 13, h: 9 };
  // Teal rug inside
  drawRug(ctx, { x: r.x, y: r.y, w: r.w, h: r.h }, PAL.rugTeal1, PAL.rugTeal2);
  // Glass walls
  ctx.fillStyle = PAL.glass;
  ctx.fillRect(r.x * TILE, r.y * TILE, r.w * TILE, 4);
  ctx.fillRect(r.x * TILE, (r.y + r.h) * TILE - 4, r.w * TILE, 4);
  ctx.fillRect(r.x * TILE, r.y * TILE, 4, r.h * TILE);
  ctx.fillRect((r.x + r.w) * TILE - 4, r.y * TILE, 4, r.h * TILE);
  ctx.fillStyle = PAL.glassEdge;
  ctx.fillRect(r.x * TILE, r.y * TILE, r.w * TILE, 1);
  ctx.fillRect(r.x * TILE, (r.y + r.h) * TILE - 1, r.w * TILE, 1);
  ctx.fillRect(r.x * TILE, r.y * TILE, 1, r.h * TILE);
  ctx.fillRect((r.x + r.w) * TILE - 1, r.y * TILE, 1, r.h * TILE);
  // Door gap (middle of south wall)
  rect(ctx, (r.x + Math.floor(r.w / 2)) * TILE - 8, (r.y + r.h) * TILE - 4, 16, 4, "rgba(0,0,0,0)");

  // Central conference table (oval-ish)
  const cx = (r.x + r.w / 2) * TILE;
  const cy = (r.y + r.h / 2) * TILE;
  ctx.fillStyle = "#1e293b";
  ctx.beginPath();
  ctx.ellipse(cx, cy, 80, 30, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#334155";
  ctx.beginPath();
  ctx.ellipse(cx, cy, 78, 28, 0, 0, Math.PI * 2);
  ctx.fill();
  // Laptops on table
  for (let i = -2; i <= 2; i++) {
    rect(ctx, cx + i * 28 - 6, cy - 18, 12, 8, "#0a0a0a");
    rect(ctx, cx + i * 28 - 5, cy - 17, 10, 6, PAL.monitor);
    rect(ctx, cx + i * 28 - 6, cy + 10, 12, 8, "#0a0a0a");
    rect(ctx, cx + i * 28 - 5, cy + 11, 10, 6, PAL.monitor);
  }

  // Sign
  drawSign(ctx, r.x + Math.floor(r.w / 2), r.y - 1, "MEETING");
}

function drawBreakout(ctx: CanvasRenderingContext2D) {
  // SW corner breakout: cols 1-12, rows 22-28
  drawRug(ctx, { x: 1, y: 22, w: 12, h: 6 }, PAL.rugPurple1, PAL.rugPurple2);

  // 2 sofas
  drawSofa(ctx, 2, 23, "h");
  drawSofa(ctx, 8, 23, "h");
  // Coffee table
  rect(ctx, 5 * TILE, 25 * TILE, 3 * TILE, TILE + 6, PAL.coffeeTable);
  rect(ctx, 5 * TILE, 25 * TILE, 3 * TILE, 2, "#52525b");
  // Magazine on table
  rect(ctx, 5 * TILE + 8, 25 * TILE + 5, 16, 10, "#f1f5f9");
  rect(ctx, 5 * TILE + 9, 25 * TILE + 6, 14, 2, "#dc2626");

  // Lounge sign
  drawSign(ctx, 6, 22, "LOUNGE");
}

function drawSofa(ctx: CanvasRenderingContext2D, tx: number, ty: number, orient: "h" | "v") {
  const x = tx * TILE;
  const y = ty * TILE;
  if (orient === "h") {
    rect(ctx, x, y, 4 * TILE, TILE + 8, PAL.sofa1);
    rect(ctx, x, y, 4 * TILE, 6, PAL.sofa2);
    rect(ctx, x, y + TILE - 4, 4 * TILE, 4, "#4c1d95");
    // cushions
    for (let i = 0; i < 2; i++) {
      rect(ctx, x + 6 + i * 2 * TILE, y + 6, 2 * TILE - 4, TILE - 4, PAL.sofa2);
      rect(ctx, x + 6 + i * 2 * TILE, y + 6, 2 * TILE - 4, 2, "#a78bfa");
    }
    // arms
    rect(ctx, x, y, 4, TILE + 8, "#3b0d73");
    rect(ctx, x + 4 * TILE - 4, y, 4, TILE + 8, "#3b0d73");
  }
}

function drawPhoneBooths(ctx: CanvasRenderingContext2D) {
  // 3 phone booths along west wall, cols 1-2, rows 11, 14, 17
  [11, 14, 17].forEach((ty) => {
    const x = 1 * TILE + 2;
    const y = ty * TILE;
    // booth body
    rect(ctx, x, y, 2 * TILE, 2 * TILE, PAL.phoneBooth);
    rect(ctx, x, y, 2 * TILE, 3, PAL.phoneLight);
    // glass door
    ctx.fillStyle = PAL.glass;
    ctx.fillRect(x + 4, y + 6, 2 * TILE - 8, 2 * TILE - 10);
    ctx.fillStyle = PAL.glassEdge;
    ctx.fillRect(x + 4, y + 6, 2 * TILE - 8, 1);
    // ledge + stool inside (suggestion)
    rect(ctx, x + 6, y + 2 * TILE - 6, 2 * TILE - 12, 3, "#6b7280");
  });
}

function drawBathrooms(ctx: CanvasRenderingContext2D) {
  // East wall, 2 doors at rows 3, 7
  [3, 7].forEach((ty, i) => {
    const x = (COLS - 1) * TILE - 2;
    const y = ty * TILE;
    rect(ctx, x, y, 2, 2 * TILE, PAL.doorTrim);
    rect(ctx, x - TILE + 2, y + 2, TILE - 2, 2 * TILE - 4, PAL.doorBathroom);
    // sign
    rect(ctx, x - 10, y + 4, 8, 10, "#374151");
    ctx.fillStyle = "#f1f5f9";
    ctx.font = "bold 7px monospace";
    ctx.fillText(i === 0 ? "WC" : "WC", x - 9, y + 5);
  });
}

function drawDesk(ctx: CanvasRenderingContext2D, d: Desk) {
  const x = d.x * TILE;
  const y = d.y * TILE;
  const w = 3 * TILE;
  const h = TILE + 6;
  rect(ctx, x, y, w, h, PAL.desk1);
  rect(ctx, x, y, w, 3, PAL.desk2);
  rect(ctx, x, y + h - 2, w, 2, PAL.deskEdge);
  // Monitor (on far side, based on facing)
  const mw = 18, mh = 12;
  let mx = x + w / 2 - mw / 2;
  let my = y + 2;
  if (d.facing === "s") my = y + h - mh - 4;
  rect(ctx, mx, my, mw, mh, PAL.monitorFrame);
  rect(ctx, mx + 1, my + 1, mw - 2, mh - 2, PAL.monitor);
  rect(ctx, mx + mw / 2 - 3, my + mh, 6, 2, "#1a1a1a"); // stand
  // Keyboard
  rect(ctx, x + w / 2 - 10, y + (d.facing === "s" ? 4 : h - 8), 20, 4, "#1f2937");
  // Mug
  rect(ctx, x + 4, y + h / 2 - 3, 5, 5, "#ef4444");
  // Plant on corner
  rect(ctx, x + w - 8, y + 2, 6, 6, PAL.plantLeaf2);
  rect(ctx, x + w - 7, y + 6, 4, 3, PAL.plantPot);

  // Chair (on the working-side of desk)
  const chairColor = TEAMS[d.team].color;
  const cx = x + w / 2 - 5;
  const cy = d.facing === "n" ? y + h + 2 : y - TILE + 4;
  drawChair(ctx, cx, cy, chairColor, d.facing);
}

function drawChair(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, facing: "n" | "s" | "e" | "w") {
  // Simple 10x12 ergonomic chair sprite
  rect(ctx, x, y, 10, 10, color);
  rect(ctx, x + 1, y + 1, 8, 8, color);
  rect(ctx, x, y, 10, 2, "rgba(0,0,0,0.35)");
  // Backrest depending on facing
  if (facing === "n") rect(ctx, x, y + 8, 10, 3, "#1f2937");
  else rect(ctx, x, y - 2, 10, 3, "#1f2937");
  // Wheels base
  rect(ctx, x + 2, y + 10, 2, 2, "#3f3f46");
  rect(ctx, x + 6, y + 10, 2, 2, "#3f3f46");
}

function drawPlant(ctx: CanvasRenderingContext2D, tx: number, ty: number) {
  const x = tx * TILE;
  const y = ty * TILE;
  rect(ctx, x + 4, y + 8, 8, 6, PAL.plantPot);
  rect(ctx, x + 4, y + 8, 8, 1, "#8b5a30");
  // leaves
  rect(ctx, x + 3, y + 4, 10, 4, PAL.plantLeaf1);
  rect(ctx, x + 5, y + 1, 6, 3, PAL.plantLeaf2);
  rect(ctx, x + 2, y + 2, 3, 4, PAL.plantLeaf2);
  rect(ctx, x + 11, y + 2, 3, 4, PAL.plantLeaf2);
}

function drawWhiteboard(ctx: CanvasRenderingContext2D, tx: number, ty: number, label: string) {
  const x = tx * TILE;
  const y = ty * TILE;
  rect(ctx, x, y, 4 * TILE, 12, PAL.whiteboard);
  rect(ctx, x, y, 4 * TILE, 2, "#cbd5e1");
  rect(ctx, x, y + 10, 4 * TILE, 2, "#64748b");
  // Scribbles
  rect(ctx, x + 4, y + 3, 20, 1, "#dc2626");
  rect(ctx, x + 4, y + 6, 30, 1, "#2563eb");
  rect(ctx, x + 4, y + 8, 14, 1, "#16a34a");
  ctx.fillStyle = "#111";
  ctx.font = "6px monospace";
  ctx.fillText(label, x + 4 * TILE - 40, y + 9);
}

function drawPodBanner(ctx: CanvasRenderingContext2D, r: Rect, team: TeamId) {
  const cx = (r.x + r.w / 2) * TILE;
  const y = (r.y + r.h - 1) * TILE + 8;
  ctx.fillStyle = TEAMS[team].color;
  ctx.globalAlpha = 0.2;
  ctx.fillRect((r.x + 1) * TILE, y - 2, (r.w - 2) * TILE, 4);
  ctx.globalAlpha = 1;
  ctx.fillStyle = TEAMS[team].color;
  ctx.font = "bold 9px monospace";
  ctx.textAlign = "center";
  ctx.fillText(TEAMS[team].label.toUpperCase(), cx, y + 2);
  ctx.textAlign = "left";
}

function drawStaticScene(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = PAL.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawFloor(ctx);

  // Zones
  drawKitchen(ctx);
  drawMeetingRoom(ctx);
  drawBreakout(ctx);

  // Whiteboards flanking engineering & SDLC
  drawWhiteboard(ctx, 28, 21, "SPRINT BOARD");
  drawWhiteboard(ctx, 15, 8, "SDLC QA");

  // Pods: desks + chairs + banners
  (Object.keys(POD_RECTS) as TeamId[]).forEach((team) => {
    const r = POD_RECTS[team];
    drawPodBanner(ctx, r, team);
  });
  ALL_DESKS.forEach((d) => drawDesk(ctx, d));

  // Fixtures along walls
  drawPhoneBooths(ctx);
  drawBathrooms(ctx);

  // Plants in corners + between zones
  [
    [14, 2], [25, 2], [37, 2],
    [14, 21], [25, 27], [37, 27],
    [2, 9], [2, 20],
    [45, 14], [45, 22],
  ].forEach(([tx, ty]) => drawPlant(ctx, tx, ty));

  // Walls last so they overlap
  drawWalls(ctx);
  drawWindows(ctx);

  // Top light bloom
  const g = ctx.createRadialGradient(WIDTH / 2, 0, 40, WIDTH / 2, 0, 400);
  g.addColorStop(0, "rgba(255,244,214,0.25)");
  g.addColorStop(1, "rgba(255,244,214,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Subtle vignette
  const v = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, 200, WIDTH / 2, HEIGHT / 2, 480);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

/* ------------------------------------------------------------------ */
/* Agent sprite                                                        */
/* ------------------------------------------------------------------ */

const SPRITE_W = 12;
const SPRITE_H = 18;

// Deterministic hash → pick hair/skin palette
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const HAIR_COLORS = ["#3f2815", "#6b4423", "#a16207", "#1e293b", "#dc2626", "#0ea5e9"];
const SKIN_COLORS = ["#f5c89b", "#e2b48c", "#c69575", "#8d5524", "#ffcaa3"];

function drawAgent(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  name: string,
  walkPhase: number,
  state: AgentState,
  speaking: boolean,
  facing: "n" | "s" | "e" | "w",
) {
  const h = hashString(name);
  const hair = HAIR_COLORS[h % HAIR_COLORS.length];
  const skin = SKIN_COLORS[(h >> 3) % SKIN_COLORS.length];
  const ix = Math.floor(x);
  const iy = Math.floor(y);

  // Shadow
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath();
  ctx.ellipse(ix + SPRITE_W / 2, iy + SPRITE_H - 1, 5, 2, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair/head
  rect(ctx, ix + 3, iy,     6, 2, hair);
  rect(ctx, ix + 2, iy + 1, 8, 3, hair);
  rect(ctx, ix + 3, iy + 3, 6, 3, skin);
  // Eyes (depend on facing)
  if (facing === "s") {
    px(ctx, ix + 4, iy + 4, "#000");
    px(ctx, ix + 7, iy + 4, "#000");
  } else if (facing === "n") {
    // back of head: no eyes, extra hair
    rect(ctx, ix + 3, iy + 3, 6, 2, hair);
  } else if (facing === "e") {
    px(ctx, ix + 7, iy + 4, "#000");
  } else {
    px(ctx, ix + 4, iy + 4, "#000");
  }
  // Neck
  rect(ctx, ix + 5, iy + 6, 2, 1, skin);

  // Torso (team color shirt)
  rect(ctx, ix + 2, iy + 7,  8, 5, color);
  // Shirt shading
  rect(ctx, ix + 2, iy + 7,  8, 1, "rgba(255,255,255,0.15)");
  rect(ctx, ix + 2, iy + 11, 8, 1, "rgba(0,0,0,0.25)");
  // Arms
  rect(ctx, ix + 1, iy + 7, 1, 4, color);
  rect(ctx, ix + 10, iy + 7, 1, 4, color);
  // Hands
  rect(ctx, ix + 1, iy + 11, 1, 1, skin);
  rect(ctx, ix + 10, iy + 11, 1, 1, skin);

  // Pants / legs — walk cycle
  const legSwing = Math.sin(walkPhase) > 0 ? 1 : 0;
  rect(ctx, ix + 3, iy + 12, 3, 4, "#1f2937");
  rect(ctx, ix + 6, iy + 12, 3, 4, "#1f2937");
  // Shoes
  rect(ctx, ix + 3 - legSwing, iy + 16, 3, 2, PAL.shoe);
  rect(ctx, ix + 6 + legSwing, iy + 16, 3, 2, PAL.shoe);

  // State indicator ring above head
  const ring = STATE_COLOR[state];
  rect(ctx, ix + 4, iy - 4, 4, 1, ring);
  rect(ctx, ix + 3, iy - 3, 6, 1, ring);
  rect(ctx, ix + 3, iy - 2, 6, 1, ring);
  rect(ctx, ix + 4, iy - 1, 4, 1, ring);

  // Speaking speech bubble
  if (speaking) {
    const bx = ix + SPRITE_W + 2;
    const by = iy - 6;
    rect(ctx, bx, by, 12, 8, "#fff");
    rect(ctx, bx + 1, by + 1, 10, 6, "#fff");
    rect(ctx, bx - 2, by + 4, 2, 2, "#fff");
    px(ctx, bx + 3, by + 3, "#000");
    px(ctx, bx + 6, by + 3, "#000");
    px(ctx, bx + 9, by + 3, "#000");
  }
}

/* ------------------------------------------------------------------ */
/* Agent simulation                                                    */
/* ------------------------------------------------------------------ */

type Waypoint = { x: number; y: number };
type Sim = {
  x: number;       // pixel x (of sprite top-left)
  y: number;       // pixel y
  tx: number;      // target pixel x
  ty: number;      // target pixel y
  facing: "n" | "s" | "e" | "w";
  walkPhase: number;
  nextChoice: number; // epoch ms at which to pick next destination
  phase: "working" | "wandering" | "meeting" | "seated";
};

function deskForAgent(name: string, team: TeamId): Desk {
  const pool = ALL_DESKS.filter((d) => d.team === team);
  const h = hashString(name);
  return pool[h % pool.length] ?? ALL_DESKS[0];
}
function meetingSeatForAgent(name: string, seatIndex?: number): { x: number; y: number; facing: "n" | "s" } {
  const idx = typeof seatIndex === "number" ? seatIndex : hashString(name);
  const s = MEETING_SEATS[idx % MEETING_SEATS.length];
  return { x: s.x * TILE + 2, y: s.y * TILE + 2, facing: s.facing };
}
function chairPixelForDesk(d: Desk): Waypoint {
  const x = d.x * TILE + TILE + 2;
  const y = d.facing === "n" ? (d.y * TILE + TILE + 6) : (d.y * TILE - TILE + 6);
  return { x, y };
}
function randomIdleWaypoint(name: string, seed: number): Waypoint {
  const h = hashString(name + ":" + seed);
  if ((h & 3) === 0) {
    const d = deskForAgent(name, AGENT_TEAM[name] ?? "sdlc");
    return chairPixelForDesk(d);
  }
  const w = WAYPOINTS[h % WAYPOINTS.length];
  return { x: w.x * TILE + 2, y: w.y * TILE + 2 };
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export default function OfficePixelScene({ baseUrl, secret, productId = null }: { baseUrl: string; secret: string; productId?: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Map<string, Sim>>(new Map());
  const nodesRef = useRef<AgentNode[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; node: AgentNode } | null>(null);
  const { nodes } = useOfficeData(baseUrl, secret, productId);

  // Pre-render static scene once
  useEffect(() => {
    const off = document.createElement("canvas");
    off.width = WIDTH;
    off.height = HEIGHT;
    const octx = off.getContext("2d");
    if (octx) {
      octx.imageSmoothingEnabled = false;
      drawStaticScene(octx);
    }
    staticRef.current = off;
  }, []);

  // Keep nodes ref fresh for render loop
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      // Paint static bg
      if (staticRef.current) ctx.drawImage(staticRef.current, 0, 0);

      // Update agents
      const currentNodes = nodesRef.current;
      const sims = simRef.current;

      currentNodes.forEach((n) => {
        let s = sims.get(n.name);
        if (!s) {
          const d = deskForAgent(n.name, n.team);
          const p = chairPixelForDesk(d);
          s = {
            x: p.x, y: p.y, tx: p.x, ty: p.y,
            facing: d.facing === "n" ? "n" : "s",
            walkPhase: 0, nextChoice: now, phase: "seated",
          };
          sims.set(n.name, s);
        }

        // Determine target based on state
        let seatFacing: "n" | "s" | null = null;
        if (n.state === "meeting") {
          const seat = meetingSeatForAgent(n.name, n.meetingSeatIndex);
          if (s.phase !== "meeting") {
            s.tx = seat.x; s.ty = seat.y;
            s.phase = "meeting";
          }
          seatFacing = seat.facing;
        } else if (n.state === "working") {
          if (s.phase !== "working" && s.phase !== "seated") {
            const d = deskForAgent(n.name, n.team);
            const p = chairPixelForDesk(d);
            s.tx = p.x; s.ty = p.y;
            s.phase = "working";
          } else if (Math.hypot(s.tx - s.x, s.ty - s.y) < 1) {
            s.phase = "seated";
          }
        } else {
          // idle — wander occasionally
          if (now >= s.nextChoice) {
            const seed = Math.floor(now / 10000);
            const w = randomIdleWaypoint(n.name, seed + hashString(n.name));
            s.tx = w.x; s.ty = w.y;
            s.phase = "wandering";
            s.nextChoice = now + 8000 + (hashString(n.name + seed) % 12000);
          }
        }

        // Move toward target
        const dx = s.tx - s.x;
        const dy = s.ty - s.y;
        const dist = Math.hypot(dx, dy);
        const speed = 32; // px/sec
        if (dist > 0.5) {
          const step = Math.min(dist, speed * dt);
          s.x += (dx / dist) * step;
          s.y += (dy / dist) * step;
          s.walkPhase += dt * 9;
          if (Math.abs(dx) > Math.abs(dy)) s.facing = dx > 0 ? "e" : "w";
          else s.facing = dy > 0 ? "s" : "n";
        } else if (seatFacing) {
          // Arrived at meeting seat — face the table
          s.facing = seatFacing;
        }
      });

      // Sort by y for depth, then draw
      const ordered = [...currentNodes].sort((a, b) => {
        const sa = sims.get(a.name);
        const sb = sims.get(b.name);
        return (sa?.y ?? 0) - (sb?.y ?? 0);
      });
      ordered.forEach((n) => {
        const s = sims.get(n.name);
        if (!s) return;
        drawAgent(ctx, s.x, s.y, n.color, n.name, s.walkPhase, n.state, !!n.isSpeaking, s.facing);
      });

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Hover detection
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const mx = (e.clientX - rect.left) * scale;
    const my = (e.clientY - rect.top) * scale;
    const sims = simRef.current;
    let best: { dist: number; node: AgentNode; sx: number; sy: number } | null = null;
    nodesRef.current.forEach((n) => {
      const s = sims.get(n.name);
      if (!s) return;
      const cx = s.x + SPRITE_W / 2;
      const cy = s.y + SPRITE_H / 2;
      const d = Math.hypot(cx - mx, cy - my);
      if (d < 14 && (!best || d < best.dist)) {
        best = { dist: d, node: n, sx: cx, sy: cy };
      }
    });
    if (best) {
      const b = best as { dist: number; node: AgentNode; sx: number; sy: number };
      const tx = (b.sx / canvas.width) * rect.width + rect.left;
      const ty = (b.sy / canvas.height) * rect.height + rect.top;
      setHover({ x: tx, y: ty, node: b.node });
    } else {
      setHover(null);
    }
  };
  const onLeave = () => setHover(null);

  // Counts
  const counts = useMemo(() => {
    let working = 0, meeting = 0, idle = 0;
    nodes.forEach((n) => {
      if (n.state === "working") working++;
      else if (n.state === "meeting") meeting++;
      else idle++;
    });
    return { working, meeting, idle, total: nodes.length };
  }, [nodes]);

  return (
    <div className="relative w-full">
      <div className="relative w-full" style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}>
        <canvas
          ref={canvasRef}
          width={WIDTH}
          height={HEIGHT}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
          className="absolute inset-0 w-full h-full"
          style={{ imageRendering: "pixelated" }}
        />
        {hover && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs text-white whitespace-nowrap shadow-lg"
            style={{
              left: hover.x - (canvasRef.current?.getBoundingClientRect().left ?? 0),
              top: hover.y - (canvasRef.current?.getBoundingClientRect().top ?? 0) - 20,
            }}
          >
            <div className="font-bold" style={{ color: hover.node.color }}>{hover.node.name}</div>
            <div className="text-zinc-400">
              {TEAMS[hover.node.team].label} · {hover.node.state}
              {hover.node.currentJob ? ` · job ${hover.node.currentJob.slice(0, 6)}` : ""}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-3 px-2 py-2 text-xs text-zinc-400 border-t border-zinc-800 bg-zinc-950/60">
        <div><span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1" />Working {counts.working}</div>
        <div><span className="inline-block w-2 h-2 rounded-full bg-yellow-400 mr-1" />Meeting {counts.meeting}</div>
        <div><span className="inline-block w-2 h-2 rounded-full bg-zinc-500 mr-1" />Idle {counts.idle}</div>
        <div className="ml-auto">Total {counts.total} agents · retro pixel view</div>
      </div>
    </div>
  );
}
