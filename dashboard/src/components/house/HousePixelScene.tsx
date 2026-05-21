"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Types — mirror the engine shape                                    */
/* ------------------------------------------------------------------ */

type LocationId =
  | "kitchen" | "lounge" | "bedroom" | "bathroom" | "diary_room" | "garden" | "hot_tub";

type Agent = {
  id: string;
  name: string;
  archetype: string;
  color: string;
  status: "in" | "evicted";
  mood: string;
  location?: LocationId;
  activity?: string;
};

type ShowEvent = {
  id: string;
  ts: string;
  type: string;
  actors: string[];
  narration: string;
  quote?: string;
};

type State = {
  agents: Agent[];
  events: ShowEvent[];
  enabled: boolean;
  day: number;
  phase: string;
};

/* ------------------------------------------------------------------ */
/* Pixel canvas constants                                              */
/* ------------------------------------------------------------------ */

const TILE = 16;
const COLS = 48;
const ROWS = 30;
const WIDTH = COLS * TILE;   // 768
const HEIGHT = ROWS * TILE;  // 480

const PAL = {
  bg:           "#0b0b14",
  floorA:       "#2a2438",
  floorB:       "#231d30",
  wallLit:      "#5b3a8c",
  wallMid:      "#3a2664",
  wallDark:     "#22153f",
  wood1:        "#7a4e2a",
  wood2:        "#5c3a1e",
  tile1:        "#cbd5e1",
  tile2:        "#94a3b8",
  grass1:       "#16a34a",
  grass2:       "#15803d",
  water1:       "#0ea5e9",
  water2:       "#0284c7",
  counter:      "#e5e7eb",
  counterEdge:  "#475569",
  fridge:       "#cbd5e1",
  fridgeEdge:   "#475569",
  bedFrame:     "#3f2207",
  bedSheet:     "#a78bfa",
  bedPillow:    "#fde68a",
  sofa1:        "#7c3aed",
  sofa2:        "#5b21b6",
  table:        "#52525b",
  toilet:       "#e2e8f0",
  signBg:       "#111827",
  signText:     "#fbbf24",
  diaryRed:     "#dc2626",
  shoe:         "#18181b",
};

type Rect = { x: number; y: number; w: number; h: number };

const ROOMS: Record<LocationId, { rect: Rect; label: string; standX: number; standY: number; theme: "kitchen" | "lounge" | "bedroom" | "bathroom" | "diary" | "garden" | "tub" }> = {
  kitchen:    { rect: { x: 1,  y: 1,  w: 15, h: 12 }, label: "KITCHEN",    standX: 8,  standY: 7,  theme: "kitchen" },
  bathroom:   { rect: { x: 16, y: 1,  w: 8,  h: 9 },  label: "BATHROOM",   standX: 19, standY: 5,  theme: "bathroom" },
  diary_room: { rect: { x: 24, y: 1,  w: 8,  h: 9 },  label: "DIARY ROOM", standX: 27, standY: 5,  theme: "diary"   },
  garden:     { rect: { x: 32, y: 1,  w: 15, h: 14 }, label: "GARDEN",     standX: 39, standY: 7,  theme: "garden"  },
  lounge:     { rect: { x: 16, y: 11, w: 16, h: 11 }, label: "LOUNGE",     standX: 23, standY: 16, theme: "lounge"  },
  bedroom:    { rect: { x: 1,  y: 14, w: 15, h: 14 }, label: "BEDROOM",    standX: 8,  standY: 21, theme: "bedroom" },
  hot_tub:    { rect: { x: 32, y: 16, w: 15, h: 12 }, label: "HOT TUB",    standX: 39, standY: 22, theme: "tub"     },
};

/* ------------------------------------------------------------------ */
/* Drawing helpers                                                     */
/* ------------------------------------------------------------------ */

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}
function px(ctx: CanvasRenderingContext2D, x: number, y: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, 1, 1);
}

function drawCheckerFloor(ctx: CanvasRenderingContext2D, r: Rect, a: string, b: string) {
  for (let ty = 0; ty < r.h; ty++) {
    for (let tx = 0; tx < r.w; tx++) {
      rect(ctx, (r.x + tx) * TILE, (r.y + ty) * TILE, TILE, TILE, (tx + ty) & 1 ? a : b);
    }
  }
}

function drawSign(ctx: CanvasRenderingContext2D, tx: number, ty: number, text: string) {
  const w = Math.max(40, text.length * 6 + 10);
  const x = tx * TILE - w / 2;
  const y = ty * TILE;
  rect(ctx, x, y, w, 11, PAL.signBg);
  rect(ctx, x, y, w, 1, "#374151");
  rect(ctx, x, y + 10, w, 1, "#000");
  ctx.fillStyle = PAL.signText;
  ctx.font = "bold 8px monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  ctx.fillText(text, x + w / 2, y + 2);
  ctx.textAlign = "left";
}

function drawWalls(ctx: CanvasRenderingContext2D) {
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
}

function drawKitchen(ctx: CanvasRenderingContext2D) {
  const r = ROOMS.kitchen.rect;
  drawCheckerFloor(ctx, r, PAL.wood1, PAL.wood2);
  // North counter run
  const cx = r.x * TILE + 8;
  const cy = r.y * TILE + 8;
  rect(ctx, cx, cy, (r.w - 2) * TILE, 12, PAL.counter);
  rect(ctx, cx, cy + 10, (r.w - 2) * TILE, 2, PAL.counterEdge);
  // Stove burners
  for (let i = 0; i < 4; i++) {
    rect(ctx, cx + 24 + i * 14, cy + 2, 8, 8, "#1a1a1a");
    rect(ctx, cx + 25 + i * 14, cy + 3, 6, 6, "#dc2626");
  }
  // Sink
  rect(ctx, cx + 90, cy + 2, 22, 8, "#64748b");
  // Fridge in NE corner of kitchen
  rect(ctx, (r.x + r.w - 3) * TILE, (r.y + 1) * TILE, 28, 40, PAL.fridge);
  rect(ctx, (r.x + r.w - 3) * TILE, (r.y + 1) * TILE + 18, 28, 1, PAL.fridgeEdge);
  rect(ctx, (r.x + r.w - 3) * TILE + 22, (r.y + 1) * TILE + 8, 2, 4, PAL.fridgeEdge);
  // Island table center-low
  const islandX = (r.x + 3) * TILE;
  const islandY = (r.y + 7) * TILE;
  rect(ctx, islandX, islandY, 7 * TILE, 18, PAL.wood2);
  rect(ctx, islandX, islandY, 7 * TILE, 2, "#3f2207");
  // Stools
  for (let i = 0; i < 3; i++) {
    rect(ctx, islandX + 12 + i * 24, islandY + 18, 10, 4, "#1f2937");
    rect(ctx, islandX + 16 + i * 24, islandY + 22, 4, 4, "#334155");
  }
  drawSign(ctx, r.x + Math.floor(r.w / 2), r.y, "KITCHEN");
}

function drawLounge(ctx: CanvasRenderingContext2D) {
  const r = ROOMS.lounge.rect;
  drawCheckerFloor(ctx, r, PAL.floorA, PAL.floorB);
  // Big rug
  for (let ty = 1; ty < r.h - 1; ty++) {
    for (let tx = 1; tx < r.w - 1; tx++) {
      rect(ctx, (r.x + tx) * TILE, (r.y + ty) * TILE, TILE, TILE, (tx + ty) & 1 ? "#7c3aed" : "#5b21b6");
    }
  }
  // Sofa along south
  const sofaX = (r.x + 2) * TILE;
  const sofaY = (r.y + r.h - 3) * TILE;
  rect(ctx, sofaX, sofaY, 8 * TILE, TILE + 4, PAL.sofa1);
  rect(ctx, sofaX, sofaY - 6, 8 * TILE, 8, PAL.sofa2);
  // Coffee table
  rect(ctx, (r.x + 5) * TILE, (r.y + 5) * TILE, 5 * TILE, TILE, PAL.table);
  rect(ctx, (r.x + 5) * TILE, (r.y + 5) * TILE, 5 * TILE, 2, "#27272a");
  // TV unit + TV
  rect(ctx, (r.x + 5) * TILE, (r.y + 1) * TILE + 4, 6 * TILE, 18, "#0a0a0a");
  rect(ctx, (r.x + 5) * TILE + 4, (r.y + 1) * TILE + 8, 6 * TILE - 8, 8, "#0ea5e9");
  drawSign(ctx, r.x + Math.floor(r.w / 2), r.y, "LOUNGE");
}

function drawBedroom(ctx: CanvasRenderingContext2D) {
  const r = ROOMS.bedroom.rect;
  drawCheckerFloor(ctx, r, PAL.floorA, PAL.floorB);
  // 3 single beds along the south wall
  for (let i = 0; i < 3; i++) {
    const bx = (r.x + 1 + i * 4) * TILE;
    const by = (r.y + r.h - 5) * TILE;
    // Frame
    rect(ctx, bx, by, 3 * TILE, 4 * TILE, PAL.bedFrame);
    // Sheet
    rect(ctx, bx + 2, by + 2, 3 * TILE - 4, 4 * TILE - 4, PAL.bedSheet);
    // Pillow
    rect(ctx, bx + 4, by + 4, 3 * TILE - 8, 10, PAL.bedPillow);
  }
  // Wardrobes along north
  rect(ctx, (r.x + 1) * TILE, (r.y + 1) * TILE, 4 * TILE, 22, PAL.wood2);
  rect(ctx, (r.x + 1) * TILE + 2 * TILE - 1, (r.y + 1) * TILE, 2, 22, "#27272a");
  rect(ctx, (r.x + 6) * TILE, (r.y + 1) * TILE, 4 * TILE, 22, PAL.wood2);
  rect(ctx, (r.x + 6) * TILE + 2 * TILE - 1, (r.y + 1) * TILE, 2, 22, "#27272a");
  drawSign(ctx, r.x + Math.floor(r.w / 2), r.y, "BEDROOM");
}

function drawBathroom(ctx: CanvasRenderingContext2D) {
  const r = ROOMS.bathroom.rect;
  drawCheckerFloor(ctx, r, PAL.tile1, PAL.tile2);
  // Toilet
  rect(ctx, (r.x + 1) * TILE, (r.y + r.h - 3) * TILE, 16, 18, PAL.toilet);
  rect(ctx, (r.x + 1) * TILE + 2, (r.y + r.h - 3) * TILE - 6, 12, 8, PAL.toilet);
  // Sink
  rect(ctx, (r.x + r.w - 3) * TILE, (r.y + 1) * TILE + 10, 22, 12, PAL.toilet);
  rect(ctx, (r.x + r.w - 3) * TILE + 8, (r.y + 1) * TILE + 4, 4, 8, "#94a3b8");
  // Shower stall
  rect(ctx, (r.x + r.w - 4) * TILE, (r.y + r.h - 4) * TILE, 3 * TILE, 3 * TILE, "rgba(180,220,255,0.18)");
  rect(ctx, (r.x + r.w - 4) * TILE, (r.y + r.h - 4) * TILE, 3 * TILE, 1, "#93c5fd");
  drawSign(ctx, r.x + Math.floor(r.w / 2), r.y, "BATHROOM");
}

function drawDiaryRoom(ctx: CanvasRenderingContext2D) {
  const r = ROOMS.diary_room.rect;
  drawCheckerFloor(ctx, r, "#1f1530", "#160e22");
  // Big red chair
  const cx = r.x * TILE + (r.w * TILE) / 2;
  const cy = (r.y + r.h - 4) * TILE;
  rect(ctx, cx - 18, cy, 36, 28, PAL.diaryRed);
  rect(ctx, cx - 22, cy - 14, 4, 38, PAL.diaryRed);
  rect(ctx, cx + 18, cy - 14, 4, 38, PAL.diaryRed);
  rect(ctx, cx - 22, cy - 14, 44, 8, "#7f1d1d");
  // Camera lens on north wall
  const camX = r.x * TILE + (r.w * TILE) / 2;
  rect(ctx, camX - 6, (r.y + 1) * TILE + 4, 12, 10, "#0a0a0a");
  rect(ctx, camX - 3, (r.y + 1) * TILE + 7, 6, 4, "#dc2626");
  drawSign(ctx, r.x + Math.floor(r.w / 2), r.y, "DIARY ROOM");
}

function drawGarden(ctx: CanvasRenderingContext2D) {
  const r = ROOMS.garden.rect;
  drawCheckerFloor(ctx, r, PAL.grass1, PAL.grass2);
  // Loungers
  for (let i = 0; i < 2; i++) {
    const lx = (r.x + 2 + i * 6) * TILE;
    const ly = (r.y + 4) * TILE;
    rect(ctx, lx, ly, 4 * TILE, 18, "#fbbf24");
    rect(ctx, lx, ly - 6, 4 * TILE, 8, "#f59e0b");
  }
  // Trees
  for (let i = 0; i < 3; i++) {
    const tx = (r.x + 2 + i * 4) * TILE;
    const ty = (r.y + r.h - 4) * TILE;
    rect(ctx, tx + 6, ty + 8, 4, 12, "#7c2d12");
    rect(ctx, tx, ty - 4, 16, 16, "#15803d");
    rect(ctx, tx + 2, ty - 8, 12, 8, "#166534");
  }
  drawSign(ctx, r.x + Math.floor(r.w / 2), r.y, "GARDEN");
}

function drawHotTub(ctx: CanvasRenderingContext2D) {
  const r = ROOMS.hot_tub.rect;
  drawCheckerFloor(ctx, r, "#3f2207", "#5c3a1e");
  // Tub
  const tx = (r.x + 3) * TILE;
  const ty = (r.y + 3) * TILE;
  const tw = (r.w - 6) * TILE;
  const th = (r.h - 6) * TILE;
  rect(ctx, tx - 4, ty - 4, tw + 8, th + 8, "#7c2d12");
  // Water (animated bubbles handled in dynamic layer is overkill — static is fine)
  rect(ctx, tx, ty, tw, th, PAL.water2);
  for (let yy = 0; yy < th; yy += 6) {
    for (let xx = 0; xx < tw; xx += 6) {
      if (((xx + yy) >> 1) & 1) px(ctx, tx + xx, ty + yy, PAL.water1);
    }
  }
  // Bubbles
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.arc(tx + 12 + i * 16, ty + 10 + (i % 2) * 8, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  drawSign(ctx, r.x + Math.floor(r.w / 2), r.y, "HOT TUB");
}

function drawStaticScene(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = PAL.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawKitchen(ctx);
  drawBathroom(ctx);
  drawDiaryRoom(ctx);
  drawGarden(ctx);
  drawLounge(ctx);
  drawBedroom(ctx);
  drawHotTub(ctx);
  drawWalls(ctx);
  // Vignette
  const v = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, 220, WIDTH / 2, HEIGHT / 2, 520);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

/* ------------------------------------------------------------------ */
/* Sprite                                                              */
/* ------------------------------------------------------------------ */

const SPRITE_W = 12;
const SPRITE_H = 18;

const HAIR_COLORS = ["#3f2815", "#6b4423", "#a16207", "#1e293b", "#dc2626", "#0ea5e9"];
const SKIN_COLORS = ["#f5c89b", "#e2b48c", "#c69575", "#8d5524", "#ffcaa3"];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function drawAgent(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  name: string,
  walkPhase: number,
  facing: "n" | "s" | "e" | "w",
  evicted: boolean,
  activityLabel: string | null,
  speaking: boolean,
) {
  const h = hashString(name);
  const hair = HAIR_COLORS[h % HAIR_COLORS.length];
  const skin = SKIN_COLORS[(h >> 3) % SKIN_COLORS.length];
  const ix = Math.floor(x);
  const iy = Math.floor(y);

  // Shadow
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath();
  ctx.ellipse(ix + SPRITE_W / 2, iy + SPRITE_H - 1, 5, 2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = evicted ? 0.35 : 1;

  // Hair/head
  rect(ctx, ix + 3, iy,     6, 2, hair);
  rect(ctx, ix + 2, iy + 1, 8, 3, hair);
  rect(ctx, ix + 3, iy + 3, 6, 3, skin);
  if (facing === "s") {
    px(ctx, ix + 4, iy + 4, "#000");
    px(ctx, ix + 7, iy + 4, "#000");
  } else if (facing === "n") {
    rect(ctx, ix + 3, iy + 3, 6, 2, hair);
  } else if (facing === "e") {
    px(ctx, ix + 7, iy + 4, "#000");
  } else {
    px(ctx, ix + 4, iy + 4, "#000");
  }
  rect(ctx, ix + 5, iy + 6, 2, 1, skin);

  // Torso (persona-color shirt)
  rect(ctx, ix + 2, iy + 7, 8, 5, color);
  rect(ctx, ix + 2, iy + 7, 8, 1, "rgba(255,255,255,0.18)");
  rect(ctx, ix + 2, iy + 11, 8, 1, "rgba(0,0,0,0.3)");
  // Arms
  rect(ctx, ix + 1, iy + 7, 1, 4, color);
  rect(ctx, ix + 10, iy + 7, 1, 4, color);
  rect(ctx, ix + 1, iy + 11, 1, 1, skin);
  rect(ctx, ix + 10, iy + 11, 1, 1, skin);

  // Legs + walk cycle
  const legSwing = Math.sin(walkPhase) > 0 ? 1 : 0;
  rect(ctx, ix + 3, iy + 12, 3, 4, "#1f2937");
  rect(ctx, ix + 6, iy + 12, 3, 4, "#1f2937");
  rect(ctx, ix + 3 - legSwing, iy + 16, 3, 2, PAL.shoe);
  rect(ctx, ix + 6 + legSwing, iy + 16, 3, 2, PAL.shoe);

  ctx.globalAlpha = 1;

  // Name tag below feet
  ctx.font = "bold 7px monospace";
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(ix - 6, iy + SPRITE_H + 1, SPRITE_W + 12, 9);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(name, ix + SPRITE_W / 2, iy + SPRITE_H + 8);
  ctx.textAlign = "left";

  // Activity label above head
  if (activityLabel && !evicted) {
    const label = activityLabel.toUpperCase();
    const w = label.length * 4 + 6;
    const bx = ix + SPRITE_W / 2 - w / 2;
    const by = iy - 12;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(bx, by, w, 8);
    ctx.fillStyle = "#fde68a";
    ctx.fillRect(bx, by, w, 1);
    ctx.fillStyle = "#fbbf24";
    ctx.font = "bold 6px monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, ix + SPRITE_W / 2, by + 6);
    ctx.textAlign = "left";
  }

  // Speech bubble for active speaker
  if (speaking) {
    const bx = ix + SPRITE_W + 2;
    const by = iy - 6;
    rect(ctx, bx, by, 14, 9, "#fff");
    rect(ctx, bx - 2, by + 5, 2, 2, "#fff");
    px(ctx, bx + 3, by + 4, "#000");
    px(ctx, bx + 7, by + 4, "#000");
    px(ctx, bx + 11, by + 4, "#000");
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

type Sim = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  facing: "n" | "s" | "e" | "w";
  walkPhase: number;
  jitter: number;
};

function standingPosFor(loc: LocationId, name: string): { x: number; y: number } {
  const r = ROOMS[loc] ?? ROOMS.lounge;
  // Spread agents inside the room with a deterministic jitter so they don't stack
  const h = hashString(name);
  const offsetX = ((h % 5) - 2) * 8;
  const offsetY = (((h >> 3) % 4) - 1) * 6;
  return {
    x: r.standX * TILE + offsetX,
    y: r.standY * TILE + offsetY,
  };
}

export default function HousePixelScene({ baseUrl, secret }: { baseUrl: string; secret: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Map<string, Sim>>(new Map());
  const stateRef = useRef<State | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; agent: Agent } | null>(null);

  // Poll state
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${baseUrl}/bigbrother/state`, { headers: { "x-runner-secret": secret } });
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled || !j?.ok) return;
        setState(j.state);
        stateRef.current = j.state;
      } catch { /* ignore */ }
    };
    load();
    const iv = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [baseUrl, secret]);

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

  // Determine current speaker (most recent event within last 8s)
  const currentSpeaker = useMemo(() => {
    if (!state?.events?.length) return null;
    const last = state.events[state.events.length - 1];
    if (!last) return null;
    const ageMs = Date.now() - new Date(last.ts).getTime();
    if (ageMs > 8000) return null;
    return last.actors?.[0] ?? null;
  }, [state]);

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

      if (staticRef.current) ctx.drawImage(staticRef.current, 0, 0);

      const s = stateRef.current;
      const agents = s?.agents ?? [];
      const sims = simRef.current;

      agents.forEach((a) => {
        const target = standingPosFor((a.location as LocationId) ?? "lounge", a.name);
        let sim = sims.get(a.id);
        if (!sim) {
          sim = {
            x: target.x, y: target.y, tx: target.x, ty: target.y,
            facing: "s", walkPhase: 0, jitter: hashString(a.id) % 100,
          };
          sims.set(a.id, sim);
        } else {
          sim.tx = target.x;
          sim.ty = target.y;
        }

        const dx = sim.tx - sim.x;
        const dy = sim.ty - sim.y;
        const dist = Math.hypot(dx, dy);
        const speed = 36;
        if (dist > 0.5) {
          const step = Math.min(dist, speed * dt);
          sim.x += (dx / dist) * step;
          sim.y += (dy / dist) * step;
          sim.walkPhase += dt * 9;
          if (Math.abs(dx) > Math.abs(dy)) sim.facing = dx > 0 ? "e" : "w";
          else sim.facing = dy > 0 ? "s" : "n";
        } else {
          // Idle bob
          sim.walkPhase += dt * 0.5;
          sim.facing = "s";
        }
      });

      // Sort by y for depth
      const ordered = [...agents].sort((a, b) => {
        const sa = sims.get(a.id);
        const sb = sims.get(b.id);
        return (sa?.y ?? 0) - (sb?.y ?? 0);
      });

      ordered.forEach((a) => {
        const sim = sims.get(a.id);
        if (!sim) return;
        const evicted = a.status === "evicted";
        const activityLabel = a.activity ? a.activity.replace(/_/g, " ") : null;
        drawAgent(
          ctx,
          sim.x, sim.y,
          a.color,
          a.name,
          sim.walkPhase,
          sim.facing,
          evicted,
          activityLabel,
          !evicted && currentSpeaker === a.name,
        );
      });

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [currentSpeaker]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rectBox = canvas.getBoundingClientRect();
    const scale = canvas.width / rectBox.width;
    const mx = (e.clientX - rectBox.left) * scale;
    const my = (e.clientY - rectBox.top) * scale;
    const sims = simRef.current;
    const agents = stateRef.current?.agents ?? [];
    let best: { dist: number; agent: Agent; sx: number; sy: number } | null = null;
    agents.forEach((a) => {
      const sim = sims.get(a.id);
      if (!sim) return;
      const cx = sim.x + SPRITE_W / 2;
      const cy = sim.y + SPRITE_H / 2;
      const d = Math.hypot(cx - mx, cy - my);
      if (d < 16 && (!best || d < best.dist)) {
        best = { dist: d, agent: a, sx: cx, sy: cy };
      }
    });
    if (best) {
      const b = best as { dist: number; agent: Agent; sx: number; sy: number };
      const tx = (b.sx / canvas.width) * rectBox.width + rectBox.left;
      const ty = (b.sy / canvas.height) * rectBox.height + rectBox.top;
      setHover({ x: tx, y: ty, agent: b.agent });
    } else {
      setHover(null);
    }
  };
  const onLeave = () => setHover(null);

  const counts = useMemo(() => {
    const agents = state?.agents ?? [];
    return {
      total: agents.length,
      alive: agents.filter((a) => a.status === "in").length,
      evicted: agents.filter((a) => a.status === "evicted").length,
    };
  }, [state]);

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
            <div className="font-bold" style={{ color: hover.agent.color }}>{hover.agent.name}</div>
            <div className="text-zinc-400">
              {hover.agent.archetype} · {hover.agent.status === "evicted" ? "evicted" : (hover.agent.activity ?? "—").replace(/_/g, " ")}
            </div>
            <div className="text-zinc-500 text-[10px]">mood: {hover.agent.mood}</div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-3 px-2 py-2 text-xs text-zinc-400 border-t border-zinc-800 bg-zinc-950/60">
        <div><span className="inline-block w-2 h-2 rounded-full bg-teal-400 mr-1" />Alive {counts.alive}</div>
        <div><span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1" />Evicted {counts.evicted}</div>
        {state && <div><span className="text-zinc-600">Day</span> {state.day}</div>}
        {state && <div><span className="text-zinc-600">Phase</span> {state.phase.toUpperCase()}</div>}
        <div className="ml-auto">{state?.enabled ? "● LIVE" : "PAUSED"} · pixel house view</div>
      </div>
    </div>
  );
}
