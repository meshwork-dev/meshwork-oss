"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  OrbitControls,
  PointerLockControls,
  Text,
  Html,
  useGLTF,
  useAnimations,
} from "@react-three/drei";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { SkeletonUtils } from "three-stdlib";
import type { GLTF } from "three-stdlib";
import type { ObjectMap } from "@react-three/fiber";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

type AvatarModel = {
  path: string;
  naturalHeight: number;
  bodyMatNames: string[];
  idleName: string;
  walkName: string;
  runName?: string;
};

const AVATAR_MODELS: AvatarModel[] = [
  { path: "/avatars/human.glb",    naturalHeight: 1.8, bodyMatNames: ["VanguardBodyMat"], idleName: "Idle", walkName: "Walk", runName: "Run" },
  { path: "/avatars/xbot.glb",     naturalHeight: 1.8, bodyMatNames: [], idleName: "idle", walkName: "walk", runName: "run" },
  { path: "/avatars/michelle.glb", naturalHeight: 1.8, bodyMatNames: [], idleName: "Idle", walkName: "Walking" },
  { path: "/avatars/robot.glb",    naturalHeight: 1.8, bodyMatNames: [], idleName: "Idle", walkName: "Walking", runName: "Running" },
];
AVATAR_MODELS.forEach((m) => useGLTF.preload(m.path));

// L-shape room: 40×40 square with SE corner cut out (x > CUT AND z > CUT).
const ROOM_HALF = 20;
const CUT = 8;
const EYE_HEIGHT = 1.62;
const TARGET_HEIGHT = 1.7;

// Shortest-arc angle lerp — avoids the model spinning the long way round.
function lerpAngle(from: number, to: number, t: number): number {
  const twoPi = Math.PI * 2;
  let d = ((to - from + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
  return from + d * t;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type AgentInfo = { name: string; description?: string };
type Meeting = {
  id: string;
  topic?: string;
  status?: string;
  participants?: string[];
  currentSpeaker?: string;
};
type Job = {
  id?: string;
  jobId?: string;
  status?: string;
  agent?: string;
  agentName?: string;
};
type AgentState = "idle" | "working" | "meeting" | "offline";
type AgentNode = {
  name: string;
  label: string;
  team: TeamId;
  color: string;
  state: AgentState;
  currentJob?: string;
  currentMeeting?: string;
  isSpeaking?: boolean;
};
type TeamId = "engineering" | "sales" | "marketing" | "product" | "sdlc";
type ViewMode = "orbit" | "firstPerson";

/**
 * Team pods — pinwheel cluster of 4 desks around a central point.
 * Kitchen (NW), Meeting room (center), Breakout (SW).
 * Engineering pod SE, Product NE, Sales E, SDLC N, Marketing NW-ish.
 */
const TEAMS: Record<TeamId, { label: string; color: string; pod: [number, number] }> = {
  engineering: { label: "Engineering", color: "#14b8a6", pod: [ 10, -10] },
  product:     { label: "Product",     color: "#f59e0b", pod: [ 11,   6] },
  sdlc:        { label: "SDLC / QA",   color: "#a78bfa", pod: [ -6,  12] },
  sales:       { label: "Sales",       color: "#38bdf8", pod: [-15,   5] },
  marketing:   { label: "Marketing",   color: "#f472b6", pod: [  6,  12] },
};

const AGENT_TEAM: Record<string, TeamId> = {
  "engineer-planner": "engineering",
  "engineer-implementer": "engineering",
  "engineer-reviewer": "engineering",
  "ui-engineer": "engineering",
  "architect-jets": "engineering",
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
  "ask-tom-agent": "sdlc",
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
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* ------------------------------------------------------------------ */
/* Data hook                                                           */
/* ------------------------------------------------------------------ */

function useOfficeData(baseUrl: string, secret: string) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    let cancelled = false;
    const headers = { "x-runner-secret": secret };
    const load = async () => {
      try {
        const [aRes, mRes, jRes] = await Promise.all([
          fetch(`${baseUrl}/agents`, { headers }),
          fetch(`${baseUrl}/api/meetings`, { headers }),
          fetch(`${baseUrl}/jobs?limit=50&status=running`, { headers }),
        ]);
        if (cancelled) return;
        if (aRes.ok) { const j = await aRes.json(); setAgents(j.agents ?? []); }
        if (mRes.ok) { const j = await mRes.json(); setMeetings(j.meetings ?? j ?? []); }
        if (jRes.ok) { const j = await jRes.json(); setJobs(j.jobs ?? j ?? []); }
      } catch { /* retry */ }
    };
    load();
    const iv = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [baseUrl, secret]);

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
      const inMeeting = activeMeetings.find((m) => (m.participants ?? []).includes(a.name));
      const jobId = runningJobsByAgent.get(a.name);
      let state: AgentState = "idle";
      if (inMeeting) state = "meeting";
      else if (jobId) state = "working";
      return {
        name: a.name,
        label: a.name,
        team,
        color: TEAMS[team].color,
        state,
        currentJob: jobId,
        currentMeeting: inMeeting?.id,
        isSpeaking: inMeeting?.currentSpeaker === a.name,
      };
    });
  }, [agents, meetings, jobs]);

  return { nodes, meetings };
}

/* ------------------------------------------------------------------ */
/* Architecture                                                        */
/* ------------------------------------------------------------------ */

function Floor() {
  return (
    <>
      {/* Main body of L: x=-20..20, z=-20..CUT */}
      <mesh position={[0, 0, (CUT - 20) / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[40, 20 + CUT]} />
        <meshStandardMaterial color="#1c1917" roughness={0.85} metalness={0.05} />
      </mesh>
      {/* Upper-left leg of L: x=-20..CUT, z=CUT..20 */}
      <mesh position={[(CUT - 20) / 2, 0, (CUT + 20) / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[20 + CUT, 20 - CUT]} />
        <meshStandardMaterial color="#1c1917" roughness={0.85} metalness={0.05} />
      </mesh>
      {/* Wood floor strip under kitchen */}
      <mesh position={[-13, 0.01, -13]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[12, 12]} />
        <meshStandardMaterial color="#78350f" roughness={0.7} />
      </mesh>
      {/* Central teal rug under meeting room */}
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[9, 9]} />
        <meshStandardMaterial color="#0f766e" roughness={0.95} />
      </mesh>
      {/* Breakout lounge rug (SW corner) */}
      <mesh position={[-13, 0.01, 13]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[10, 8]} />
        <meshStandardMaterial color="#4c1d95" roughness={0.95} />
      </mesh>
    </>
  );
}

function Ceiling() {
  const mat = <meshStandardMaterial color="#18181b" roughness={0.9} />;
  return (
    <>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 4.2, (CUT - 20) / 2]}>
        <planeGeometry args={[40, 20 + CUT]} />
        {mat}
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[(CUT - 20) / 2, 4.2, (CUT + 20) / 2]}>
        <planeGeometry args={[20 + CUT, 20 - CUT]} />
        {mat}
      </mesh>
    </>
  );
}

function Walls() {
  const wallMat = <meshStandardMaterial color="#2a2a30" roughness={0.9} />;
  const windowMat = (
    <meshStandardMaterial
      color="#cfe8ff"
      emissive="#a9d4ff"
      emissiveIntensity={1.6}
      roughness={0.25}
    />
  );
  const southLen = 20 + CUT;            // south wall only covers west half (x: -20..CUT)
  const southCenterX = (CUT - 20) / 2;
  const eastLen = 20 + CUT;             // east wall only covers north half (z: -20..CUT)
  const eastCenterZ = (CUT - 20) / 2;
  const innerLen = 20 - CUT;            // inner-corner walls, length 12
  const innerCenter = (CUT + 20) / 2;   // center of inner wall = 14
  return (
    <group>
      {/* North wall (full width) */}
      <mesh position={[0, 2.1, -20]}>
        <boxGeometry args={[40, 4.2, 0.3]} />
        {wallMat}
      </mesh>
      {[-13, -4.5, 4.5, 13].map((x) => (
        <mesh key={`win-n-${x}`} position={[x, 2.4, -19.82]}>
          <planeGeometry args={[5.5, 2.2]} />
          {windowMat}
        </mesh>
      ))}

      {/* South wall — shortened: x=-20..CUT */}
      <mesh position={[southCenterX, 2.1, 20]}>
        <boxGeometry args={[southLen, 4.2, 0.3]} />
        {wallMat}
      </mesh>
      <mesh position={[-13, 2.4, 19.82]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[5.5, 2.2]} />
        {windowMat}
      </mesh>

      {/* West wall (full depth) */}
      <mesh position={[-20, 2.1, 0]}>
        <boxGeometry args={[0.3, 4.2, 40]} />
        {wallMat}
      </mesh>

      {/* East wall — shortened: z=-20..CUT */}
      <mesh position={[20, 2.1, eastCenterZ]}>
        <boxGeometry args={[0.3, 4.2, eastLen]} />
        {wallMat}
      </mesh>

      {/* Inner corner walls forming the SE cut-out */}
      <mesh position={[CUT, 2.1, innerCenter]}>
        <boxGeometry args={[0.3, 4.2, innerLen]} />
        {wallMat}
      </mesh>
      <mesh position={[innerCenter, 2.1, CUT]}>
        <boxGeometry args={[innerLen, 4.2, 0.3]} />
        {wallMat}
      </mesh>
      {/* Accent pillar where the two cut walls meet */}
      <mesh position={[CUT, 2.1, CUT]}>
        <boxGeometry args={[0.5, 4.2, 0.5]} />
        <meshStandardMaterial color="#0f766e" metalness={0.4} roughness={0.5} />
      </mesh>

      {/* Baseboards matching L-shape */}
      <mesh position={[-20, 0.1, 0]}>
        <boxGeometry args={[0.35, 0.2, 40]} />
        <meshStandardMaterial color="#3f3f46" />
      </mesh>
      <mesh position={[20, 0.1, eastCenterZ]}>
        <boxGeometry args={[0.35, 0.2, eastLen]} />
        <meshStandardMaterial color="#3f3f46" />
      </mesh>
      <mesh position={[0, 0.1, -20]}>
        <boxGeometry args={[40, 0.2, 0.35]} />
        <meshStandardMaterial color="#3f3f46" />
      </mesh>
      <mesh position={[southCenterX, 0.1, 20]}>
        <boxGeometry args={[southLen, 0.2, 0.35]} />
        <meshStandardMaterial color="#3f3f46" />
      </mesh>
      <mesh position={[CUT, 0.1, innerCenter]}>
        <boxGeometry args={[0.35, 0.2, innerLen]} />
        <meshStandardMaterial color="#3f3f46" />
      </mesh>
      <mesh position={[innerCenter, 0.1, CUT]}>
        <boxGeometry args={[innerLen, 0.2, 0.35]} />
        <meshStandardMaterial color="#3f3f46" />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function Pendant({ position, color = "#fde68a" }: { position: [number, number, number]; color?: string }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.6, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 1.2, 8]} />
        <meshStandardMaterial color="#27272a" />
      </mesh>
      <mesh position={[0, 0, 0]} castShadow>
        <cylinderGeometry args={[0.35, 0.22, 0.25, 20, 1, true]} />
        <meshStandardMaterial color="#1f2937" roughness={0.6} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -0.12, 0]}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={3} toneMapped={false} />
      </mesh>
      <pointLight position={[0, -0.15, 0]} intensity={6} color={color} distance={18} decay={1.6} />
    </group>
  );
}

function WallSconce({ position, rotationY = 0, color = "#fed7aa" }: {
  position: [number, number, number];
  rotationY?: number;
  color?: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <boxGeometry args={[0.08, 0.5, 0.15]} />
        <meshStandardMaterial color="#3f3f46" metalness={0.4} />
      </mesh>
      <mesh position={[0, 0, 0.08]}>
        <planeGeometry args={[0.06, 0.45]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2} toneMapped={false} />
      </mesh>
      <pointLight position={[0, 0, 0.2]} intensity={2.5} color={color} distance={8} decay={1.6} />
    </group>
  );
}

function Plant({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.25, 0]} castShadow>
        <cylinderGeometry args={[0.3, 0.22, 0.5, 16]} />
        <meshStandardMaterial color="#7c2d12" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.9, 0]} castShadow>
        <coneGeometry args={[0.5, 1.1, 12]} />
        <meshStandardMaterial color="#166534" roughness={0.85} />
      </mesh>
      <mesh position={[0.12, 1.35, 0.05]} castShadow>
        <coneGeometry args={[0.35, 0.8, 10]} />
        <meshStandardMaterial color="#15803d" roughness={0.85} />
      </mesh>
    </group>
  );
}

function Sofa({ position, rotationY = 0, color = "#1e3a8a" }: {
  position: [number, number, number];
  rotationY?: number;
  color?: string;
}) {
  const cushion = <meshStandardMaterial color={color} roughness={0.8} />;
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.25, 0]} castShadow>
        <boxGeometry args={[3, 0.4, 1]} />
        {cushion}
      </mesh>
      <mesh position={[0, 0.75, -0.4]} castShadow>
        <boxGeometry args={[3, 0.7, 0.2]} />
        {cushion}
      </mesh>
      <mesh position={[-1.45, 0.5, 0]} castShadow>
        <boxGeometry args={[0.15, 0.5, 1]} />
        {cushion}
      </mesh>
      <mesh position={[1.45, 0.5, 0]} castShadow>
        <boxGeometry args={[0.15, 0.5, 1]} />
        {cushion}
      </mesh>
    </group>
  );
}

function CoffeeTable({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.4, 0]} castShadow>
        <boxGeometry args={[1.6, 0.08, 0.9]} />
        <meshStandardMaterial color="#78350f" roughness={0.5} />
      </mesh>
      {[[-0.7, 0.2, -0.4], [0.7, 0.2, -0.4], [-0.7, 0.2, 0.4], [0.7, 0.2, 0.4]].map((p, i) => (
        <mesh key={i} position={p as [number, number, number]}>
          <boxGeometry args={[0.08, 0.4, 0.08]} />
          <meshStandardMaterial color="#44403c" />
        </mesh>
      ))}
    </group>
  );
}

function Whiteboard({ position, rotationY = 0, accent = "#14b8a6" }: {
  position: [number, number, number];
  rotationY?: number;
  accent?: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <boxGeometry args={[3.2, 1.8, 0.08]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.3} />
      </mesh>
      <mesh position={[0, 0, 0.045]}>
        <planeGeometry args={[3.1, 1.7]} />
        <meshStandardMaterial color="#e2e8f0" emissive={accent} emissiveIntensity={0.08} />
      </mesh>
      <Text position={[-1.3, 0.5, 0.055]} fontSize={0.18} color="#0f172a" anchorX="left">
        SPRINT BOARD
      </Text>
      <Text position={[-1.3, 0.1, 0.055]} fontSize={0.12} color={accent} anchorX="left">
        TO DO · IN PROGRESS · DONE
      </Text>
    </group>
  );
}

function WallArt({ position, rotationY, color }: {
  position: [number, number, number];
  rotationY: number;
  color: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <boxGeometry args={[2.2, 1.4, 0.05]} />
        <meshStandardMaterial color="#09090b" />
      </mesh>
      <mesh position={[0, 0, 0.03]}>
        <planeGeometry args={[2, 1.2]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Kitchen                                                             */
/* ------------------------------------------------------------------ */

function Kitchen() {
  return (
    <group position={[-13, 0, -13]}>
      {/* L-shaped counter along south + west walls of kitchen zone */}
      <mesh position={[0, 0.45, -5]} castShadow>
        <boxGeometry args={[10, 0.9, 0.7]} />
        <meshStandardMaterial color="#e7e5e4" roughness={0.4} />
      </mesh>
      <mesh position={[-5, 0.45, -2]} castShadow>
        <boxGeometry args={[0.7, 0.9, 6]} />
        <meshStandardMaterial color="#e7e5e4" roughness={0.4} />
      </mesh>
      {/* Counter tops (dark) */}
      <mesh position={[0, 0.92, -5]}>
        <boxGeometry args={[10.1, 0.06, 0.75]} />
        <meshStandardMaterial color="#1c1917" roughness={0.35} metalness={0.1} />
      </mesh>
      <mesh position={[-5, 0.92, -2]}>
        <boxGeometry args={[0.75, 0.06, 6.1]} />
        <meshStandardMaterial color="#1c1917" roughness={0.35} metalness={0.1} />
      </mesh>

      {/* Backsplash */}
      <mesh position={[0, 1.5, -5.32]}>
        <planeGeometry args={[10, 0.8]} />
        <meshStandardMaterial color="#78716c" roughness={0.6} />
      </mesh>

      {/* Sink */}
      <mesh position={[-1.5, 0.93, -5]}>
        <boxGeometry args={[1.0, 0.08, 0.5]} />
        <meshStandardMaterial color="#a8a29e" metalness={0.7} roughness={0.2} />
      </mesh>
      {/* Faucet */}
      <mesh position={[-1.5, 1.15, -5.2]}>
        <cylinderGeometry args={[0.02, 0.02, 0.45, 8]} />
        <meshStandardMaterial color="#71717a" metalness={0.8} roughness={0.15} />
      </mesh>

      {/* Coffee machine */}
      <group position={[2.5, 0.95, -5]}>
        <mesh castShadow>
          <boxGeometry args={[0.7, 0.7, 0.5]} />
          <meshStandardMaterial color="#111113" roughness={0.3} metalness={0.5} />
        </mesh>
        <mesh position={[0, 0.1, 0.18]}>
          <planeGeometry args={[0.4, 0.25]} />
          <meshStandardMaterial color="#0ea5e9" emissive="#0ea5e9" emissiveIntensity={0.5} />
        </mesh>
      </group>

      {/* Fridge (tall) */}
      <mesh position={[-5, 1.1, 2]} castShadow>
        <boxGeometry args={[0.7, 2.2, 1]} />
        <meshStandardMaterial color="#d6d3d1" roughness={0.3} metalness={0.4} />
      </mesh>
      <mesh position={[-4.63, 1.5, 2]}>
        <boxGeometry args={[0.02, 0.4, 0.04]} />
        <meshStandardMaterial color="#292524" metalness={0.7} />
      </mesh>

      {/* Microwave on counter */}
      <mesh position={[4, 1.1, -5]} castShadow>
        <boxGeometry args={[0.8, 0.45, 0.45]} />
        <meshStandardMaterial color="#18181b" metalness={0.3} />
      </mesh>

      {/* Kitchen island */}
      <group position={[0, 0, -0.5]}>
        <mesh position={[0, 0.5, 0]} castShadow>
          <boxGeometry args={[3.5, 1.0, 1.4]} />
          <meshStandardMaterial color="#e7e5e4" roughness={0.4} />
        </mesh>
        <mesh position={[0, 1.02, 0]}>
          <boxGeometry args={[3.6, 0.06, 1.5]} />
          <meshStandardMaterial color="#1c1917" roughness={0.35} metalness={0.1} />
        </mesh>
        {/* Fruit bowl + coffee cups */}
        <mesh position={[-1.1, 1.12, 0]}>
          <cylinderGeometry args={[0.22, 0.15, 0.1, 16]} />
          <meshStandardMaterial color="#b45309" />
        </mesh>
        <mesh position={[-1.1, 1.22, 0]}>
          <sphereGeometry args={[0.08, 10, 10]} />
          <meshStandardMaterial color="#dc2626" />
        </mesh>
        <mesh position={[-0.95, 1.22, 0.05]}>
          <sphereGeometry args={[0.07, 10, 10]} />
          <meshStandardMaterial color="#16a34a" />
        </mesh>
        <mesh position={[0.9, 1.1, 0]}>
          <cylinderGeometry args={[0.08, 0.06, 0.12, 12]} />
          <meshStandardMaterial color="#fafaf9" />
        </mesh>
        <mesh position={[1.15, 1.1, 0.05]}>
          <cylinderGeometry args={[0.08, 0.06, 0.12, 12]} />
          <meshStandardMaterial color="#fafaf9" />
        </mesh>
      </group>

      {/* Bar stools around island (facing island) */}
      {[[-1.0, 1.7], [0, 1.7], [1.0, 1.7]].map((p, i) => (
        <group key={`stool-${i}`} position={[p[0], 0, p[1]]}>
          <mesh position={[0, 0.65, 0]} castShadow>
            <cylinderGeometry args={[0.22, 0.22, 0.08, 16]} />
            <meshStandardMaterial color="#111113" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.32, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.65, 8]} />
            <meshStandardMaterial color="#71717a" metalness={0.6} />
          </mesh>
          {/* 4 feet */}
          {[[-0.2, 0], [0.2, 0], [0, -0.2], [0, 0.2]].map((fp, j) => (
            <mesh key={j} position={[fp[0], 0.05, fp[1]]}>
              <boxGeometry args={[0.04, 0.1, 0.04]} />
              <meshStandardMaterial color="#3f3f46" />
            </mesh>
          ))}
        </group>
      ))}

      {/* KITCHEN sign */}
      <Text position={[0, 2.7, -5.35]} fontSize={0.32} color="#fde68a" anchorX="center" outlineWidth={0.02} outlineColor="#000">
        KITCHEN
      </Text>

      {/* Warm pendant over island */}
      <Pendant position={[0, 3.4, -0.5]} color="#fbbf24" />
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Restrooms (doors along east wall, behind-the-scenes private)        */
/* ------------------------------------------------------------------ */

function RestroomDoors() {
  const door = (z: number, label: string, color: string) => (
    <group position={[19.7, 0, z]}>
      <mesh position={[0, 1.05, 0]}>
        <boxGeometry args={[0.1, 2.1, 1.0]} />
        <meshStandardMaterial color="#44403c" roughness={0.5} />
      </mesh>
      {/* handle */}
      <mesh position={[-0.08, 1.05, 0.35]}>
        <sphereGeometry args={[0.06, 10, 10]} />
        <meshStandardMaterial color="#a8a29e" metalness={0.8} roughness={0.2} />
      </mesh>
      {/* label plaque */}
      <mesh position={[-0.08, 1.85, 0]}>
        <boxGeometry args={[0.02, 0.25, 0.6]} />
        <meshStandardMaterial color="#18181b" />
      </mesh>
      <Text
        position={[-0.1, 1.85, 0]}
        rotation={[0, -Math.PI / 2, 0]}
        fontSize={0.15}
        color={color}
        anchorX="center"
      >
        {label}
      </Text>
    </group>
  );
  return (
    <group>
      {door(-16, "RESTROOM", "#38bdf8")}
      {door(-14, "RESTROOM", "#f472b6")}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Phone booths (focus pods along west wall)                           */
/* ------------------------------------------------------------------ */

function PhoneBooth({ position, color = "#0891b2" }: { position: [number, number, number]; color?: string }) {
  const frame = <meshStandardMaterial color="#1f2937" metalness={0.4} roughness={0.5} />;
  const glass = (
    <meshPhysicalMaterial
      color={color}
      transparent
      opacity={0.2}
      roughness={0.1}
      transmission={0.85}
      thickness={0.2}
    />
  );
  return (
    <group position={position}>
      {/* 3 glass walls (open front) */}
      <mesh position={[-0.6, 1.1, 0]}>
        <boxGeometry args={[0.05, 2.2, 1.2]} />
        {glass}
      </mesh>
      <mesh position={[0, 1.1, -0.6]}>
        <boxGeometry args={[1.25, 2.2, 0.05]} />
        {glass}
      </mesh>
      <mesh position={[0, 1.1, 0.6]}>
        <boxGeometry args={[1.25, 2.2, 0.05]} />
        {glass}
      </mesh>
      {/* Frame */}
      <mesh position={[0, 2.2, 0]}>
        <boxGeometry args={[1.3, 0.05, 1.3]} />
        {frame}
      </mesh>
      {/* Built-in ledge + stool */}
      <mesh position={[-0.3, 0.8, 0]} castShadow>
        <boxGeometry args={[0.6, 0.04, 0.6]} />
        <meshStandardMaterial color="#78350f" roughness={0.6} />
      </mesh>
      <mesh position={[0.25, 0.45, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.18, 0.06, 14]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      <mesh position={[0.25, 0.22, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.45, 8]} />
        <meshStandardMaterial color="#52525b" metalness={0.6} />
      </mesh>
      {/* Emissive strip on top */}
      <mesh position={[0, 2.23, 0]}>
        <boxGeometry args={[1.25, 0.02, 1.25]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.5} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Desk pod (4-desk pinwheel cluster)                                  */
/* ------------------------------------------------------------------ */

function DeskWithChair({
  position,
  rotationY,
  accent,
}: {
  position: [number, number, number];
  rotationY: number;
  accent: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Desktop */}
      <mesh position={[0, 0.75, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.6, 0.08, 1.0]} />
        <meshStandardMaterial color="#3f3f46" roughness={0.6} />
      </mesh>
      {/* Legs */}
      {[[-0.7, 0.375, -0.45],[0.7, 0.375, -0.45],[-0.7, 0.375, 0.45],[0.7, 0.375, 0.45]].map((p, i) => (
        <mesh key={i} position={p as [number, number, number]}>
          <boxGeometry args={[0.05, 0.75, 0.05]} />
          <meshStandardMaterial color="#27272a" />
        </mesh>
      ))}
      {/* Monitor */}
      <mesh position={[0, 1.15, -0.35]}>
        <boxGeometry args={[0.9, 0.55, 0.05]} />
        <meshStandardMaterial color="#09090b" emissive={accent} emissiveIntensity={0.35} />
      </mesh>
      {/* Monitor stand */}
      <mesh position={[0, 0.85, -0.35]}>
        <boxGeometry args={[0.15, 0.1, 0.05]} />
        <meshStandardMaterial color="#18181b" />
      </mesh>
      {/* Keyboard */}
      <mesh position={[0, 0.8, 0.1]}>
        <boxGeometry args={[0.7, 0.03, 0.22]} />
        <meshStandardMaterial color="#18181b" />
      </mesh>
      {/* Mouse */}
      <mesh position={[0.42, 0.8, 0.15]}>
        <boxGeometry args={[0.1, 0.025, 0.15]} />
        <meshStandardMaterial color="#27272a" />
      </mesh>
      {/* Coffee mug */}
      <mesh position={[-0.55, 0.82, -0.1]}>
        <cylinderGeometry args={[0.06, 0.055, 0.1, 14]} />
        <meshStandardMaterial color="#fafaf9" />
      </mesh>

      {/* Office chair: swivel base + seat + back + armrests */}
      <group position={[0, 0, 0.75]}>
        {/* 5-star base */}
        {[0, 1, 2, 3, 4].map((i) => {
          const a = (i / 5) * Math.PI * 2;
          return (
            <mesh key={i} position={[Math.cos(a) * 0.22, 0.05, Math.sin(a) * 0.22]} rotation={[0, -a, 0]}>
              <boxGeometry args={[0.45, 0.05, 0.08]} />
              <meshStandardMaterial color="#18181b" metalness={0.4} />
            </mesh>
          );
        })}
        {/* Gas lift */}
        <mesh position={[0, 0.3, 0]}>
          <cylinderGeometry args={[0.04, 0.04, 0.5, 10]} />
          <meshStandardMaterial color="#52525b" metalness={0.7} />
        </mesh>
        {/* Seat */}
        <mesh position={[0, 0.55, 0]} castShadow>
          <boxGeometry args={[0.55, 0.1, 0.55]} />
          <meshStandardMaterial color="#1f2937" roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.58, 0]}>
          <boxGeometry args={[0.52, 0.05, 0.52]} />
          <meshStandardMaterial color={accent} roughness={0.7} />
        </mesh>
        {/* Backrest */}
        <mesh position={[0, 0.95, 0.26]} castShadow>
          <boxGeometry args={[0.52, 0.7, 0.08]} />
          <meshStandardMaterial color="#1f2937" roughness={0.7} />
        </mesh>
        {/* Armrests */}
        <mesh position={[-0.3, 0.75, 0]}>
          <boxGeometry args={[0.06, 0.05, 0.35]} />
          <meshStandardMaterial color="#111113" />
        </mesh>
        <mesh position={[0.3, 0.75, 0]}>
          <boxGeometry args={[0.06, 0.05, 0.35]} />
          <meshStandardMaterial color="#111113" />
        </mesh>
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Meeting room                                                        */
/* ------------------------------------------------------------------ */

function MeetingRoom() {
  const glass = (
    <meshPhysicalMaterial
      color="#5eead4"
      transparent
      opacity={0.18}
      roughness={0.05}
      transmission={0.9}
      thickness={0.4}
    />
  );
  const frame = <meshStandardMaterial color="#0f766e" metalness={0.6} roughness={0.3} />;
  return (
    <group>
      {[
        { pos: [0, 1.6, -3.5] as [number, number, number], size: [7, 3.2, 0.1] as [number, number, number] },
        { pos: [0, 1.6,  3.5] as [number, number, number], size: [7, 3.2, 0.1] as [number, number, number] },
        { pos: [-3.5, 1.6, 0] as [number, number, number], size: [0.1, 3.2, 7] as [number, number, number] },
        { pos: [ 3.5, 1.6, 0] as [number, number, number], size: [0.1, 3.2, 7] as [number, number, number] },
      ].map((w, i) => (
        <mesh key={i} position={w.pos}>
          <boxGeometry args={w.size} />
          {glass}
        </mesh>
      ))}
      <mesh position={[0, 3.2, 0]}>
        <boxGeometry args={[7.2, 0.1, 7.2]} />
        {frame}
      </mesh>
      <mesh position={[0, 0.5, 0]} castShadow>
        <cylinderGeometry args={[1.6, 1.6, 0.15, 32]} />
        <meshStandardMaterial color="#57534e" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.25, 0]}>
        <cylinderGeometry args={[0.1, 0.15, 0.5, 16]} />
        <meshStandardMaterial color="#3f3f46" />
      </mesh>
      <Text
        position={[0, 0.02, -2.5]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.35}
        color="#5eead4"
        anchorX="center"
      >
        MEETING ROOM
      </Text>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Avatar with wandering + seated support                              */
/* ------------------------------------------------------------------ */

type WaypointKind = "desk" | "kitchen" | "lounge" | "booth" | "meeting";
type Waypoint = { kind: WaypointKind; pos: [number, number]; face?: [number, number] };

const PUBLIC_WAYPOINTS: Waypoint[] = [
  { kind: "kitchen", pos: [-12, -12], face: [-13, -13.5] },  // stand at island
  { kind: "kitchen", pos: [-14, -12], face: [-13, -13.5] },
  { kind: "kitchen", pos: [-13, -11], face: [-13, -13.5] },
  { kind: "lounge",  pos: [-12, 12],  face: [-13, 13] },
  { kind: "lounge",  pos: [-14, 14],  face: [-13, 13] },
  { kind: "lounge",  pos: [-11, 13],  face: [-13, 13] },
  { kind: "booth",   pos: [-17.5, 0], face: [-19, 0] },
  { kind: "booth",   pos: [-17.5, -4], face: [-19, -4] },
  { kind: "booth",   pos: [-17.5, 4], face: [-19, 4] },
];

function Avatar({
  node,
  deskPos,
  deskYaw,
  meetingPos,
  gltfs,
}: {
  node: AgentNode;
  deskPos: [number, number];
  deskYaw: number;
  meetingPos?: [number, number, number];
  gltfs: (GLTF & ObjectMap)[];
}) {
  const modelIdx = useMemo(
    () => hashString(node.name) % AVATAR_MODELS.length,
    [node.name],
  );
  const modelInfo = AVATAR_MODELS[modelIdx];
  const gltf = gltfs[modelIdx];
  const groupRef = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const statusColor = STATE_COLOR[node.state];
  const phase = useMemo(() => (hashString(node.name) % 628) / 100, [node.name]);

  // Wander state
  const targetRef = useRef<{ pos: THREE.Vector3; yaw: number; until: number; seated: boolean }>({
    pos: new THREE.Vector3(deskPos[0], 0, deskPos[1]),
    yaw: deskYaw,
    until: 0,
    seated: true,
  });
  const currentRef = useRef<THREE.Vector3>(new THREE.Vector3(deskPos[0], 0, deskPos[1]));
  const currentYawRef = useRef<number>(deskYaw);
  const movingRef = useRef(false);
  const seatedRef = useRef(true);

  // Clone + optional tint once per (name, color, model).
  const clonedScene = useMemo(() => {
    const clone = SkeletonUtils.clone(gltf.scene) as THREE.Group;
    const scale = TARGET_HEIGHT / modelInfo.naturalHeight;
    clone.scale.setScalar(scale);
    const agentColor = new THREE.Color(node.color);
    const bodyMatSet = new Set(modelInfo.bodyMatNames);
    clone.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((mat) => {
          if (mat instanceof THREE.MeshStandardMaterial) {
            const m = mat.clone() as THREE.MeshStandardMaterial;
            if (bodyMatSet.has(mat.name)) m.color.set(agentColor);
            mesh.material = m;
          }
        });
      }
    });
    return clone;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltf.scene, node.name, node.color, modelInfo]);

  const { actions } = useAnimations(gltf.animations, groupRef);

  // Drive animation by (state, moving) — resolves per-model clip names with fallbacks.
  useEffect(() => {
    const pickClip = (names: (string | undefined)[]) => {
      for (const n of names) if (n && actions[n]) return actions[n];
      const first = Object.values(actions)[0];
      return first ?? null;
    };
    const idle = pickClip([modelInfo.idleName, "Idle", "idle"]);
    const walk = pickClip([modelInfo.walkName, "Walk", "Walking", "walk"]);
    const run = pickClip([modelInfo.runName, "Run", "Running", "run"]);
    const pick = () => (movingRef.current ? (walk ?? run ?? idle) : idle);
    const active = pick();
    active?.reset().fadeIn(0.4).play();
    const tick = setInterval(() => {
      const want = pick();
      if (want && !want.isRunning()) {
        [idle, walk, run].forEach((a) => a && a !== want && a.isRunning() && a.fadeOut(0.25));
        want.reset().fadeIn(0.25).play();
      }
    }, 400);
    return () => {
      clearInterval(tick);
      [idle, walk, run].forEach((a) => a?.fadeOut(0.2));
    };
  }, [actions, modelInfo]);

  // Decide next target based on state
  useEffect(() => {
    // Pick a new target immediately when state changes
    const nowMs = performance.now();
    targetRef.current.until = nowMs; // trigger retarget in the frame loop
  }, [node.state, node.currentMeeting]);

  useFrame((s, delta) => {
    if (!groupRef.current) return;
    const nowMs = performance.now();

    // Retarget logic
    if (nowMs >= targetRef.current.until) {
      if (node.state === "meeting" && meetingPos) {
        // Stand at meeting spot, face center
        const ang = Math.atan2(meetingPos[0] - 0, meetingPos[2] - 0);
        targetRef.current.pos.set(meetingPos[0], 0, meetingPos[2]);
        targetRef.current.yaw = ang + Math.PI;
        targetRef.current.seated = false;
        targetRef.current.until = nowMs + 60_000;
      } else if (node.state === "working") {
        // Sit at desk
        targetRef.current.pos.set(deskPos[0], 0, deskPos[1]);
        targetRef.current.yaw = deskYaw;
        targetRef.current.seated = true;
        targetRef.current.until = nowMs + 60_000;
      } else if (node.state === "idle") {
        // Occasionally wander to public waypoint, otherwise sit at desk
        const rand = Math.random();
        const goWander = rand < 0.6;
        if (goWander) {
          const wp = PUBLIC_WAYPOINTS[
            (hashString(node.name + String(Math.floor(nowMs / 30_000))) % PUBLIC_WAYPOINTS.length)
          ];
          const face = wp.face ?? wp.pos;
          const yaw = Math.atan2(face[0] - wp.pos[0], face[1] - wp.pos[1]);
          targetRef.current.pos.set(wp.pos[0], 0, wp.pos[1]);
          targetRef.current.yaw = yaw;
          targetRef.current.seated = false;
          targetRef.current.until = nowMs + 12_000 + Math.random() * 10_000;
        } else {
          targetRef.current.pos.set(deskPos[0], 0, deskPos[1]);
          targetRef.current.yaw = deskYaw;
          targetRef.current.seated = true;
          targetRef.current.until = nowMs + 15_000 + Math.random() * 10_000;
        }
      } else {
        // offline — stay put
        targetRef.current.until = nowMs + 60_000;
      }
    }

    // Move toward target
    const walkSpeed = 1.8;
    const toTarget = targetRef.current.pos.clone().sub(currentRef.current);
    toTarget.y = 0;
    const dist = toTarget.length();
    if (dist > 0.04) {
      toTarget.normalize();
      const step = Math.min(dist, walkSpeed * delta);
      currentRef.current.add(toTarget.multiplyScalar(step));
      movingRef.current = true;
      // face walking direction (shortest-arc lerp — avoids spinning the long way)
      const desiredYaw = Math.atan2(toTarget.x, toTarget.z);
      currentYawRef.current = lerpAngle(currentYawRef.current, desiredYaw, 0.2);
      seatedRef.current = false;
    } else {
      movingRef.current = false;
      currentRef.current.copy(targetRef.current.pos);
      currentYawRef.current = lerpAngle(
        currentYawRef.current,
        targetRef.current.yaw,
        0.15,
      );
      seatedRef.current = targetRef.current.seated;
    }

    // Seated offset: drop slightly and nudge forward so the model appears on the chair
    // Chair seat is at y=0.55, offset 0.75 behind desk in local space.
    // Compute world-space chair pos from deskPos + deskYaw:
    let baseY = 0;
    let posX = currentRef.current.x;
    let posZ = currentRef.current.z;
    if (seatedRef.current && !movingRef.current) {
      baseY = 0.45; // raise body so legs bend and butt meets the seat (approximate)
      // Shift onto chair (0.75 behind the desk, local +z)
      const sx = Math.sin(deskYaw);
      const sz = Math.cos(deskYaw);
      posX = deskPos[0] + sx * 0.75;
      posZ = deskPos[1] + sz * 0.75;
    }

    // subtle breathing / speaking float
    const amp = node.isSpeaking ? 0.04 : node.state === "working" ? 0.014 : 0.006;
    const speed = node.isSpeaking ? 5 : node.state === "working" ? 2.5 : 0.8;
    const tClock = s.clock.elapsedTime * speed + phase;

    groupRef.current.position.set(
      posX,
      baseY + Math.sin(tClock) * amp,
      posZ,
    );
    groupRef.current.rotation.y = currentYawRef.current;
  });

  return (
    <group
      ref={groupRef}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); }}
      onPointerOut={() => setHover(false)}
    >
      <primitive object={clonedScene} castShadow />
      <mesh position={[0, TARGET_HEIGHT + 0.15, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.14, 0.19, 24]} />
        <meshStandardMaterial
          color={statusColor}
          emissive={statusColor}
          emissiveIntensity={1.3}
          side={THREE.DoubleSide}
        />
      </mesh>
      <Text position={[0, TARGET_HEIGHT + 0.38, 0]} fontSize={0.115} color="#fafafa"
            outlineWidth={0.009} outlineColor="#000" anchorX="center">
        {node.label}
      </Text>
      <Text position={[0, TARGET_HEIGHT + 0.24, 0]} fontSize={0.075} color={statusColor} anchorX="center">
        {node.state}
      </Text>
      {hover && (
        <Html position={[0, TARGET_HEIGHT + 0.62, 0]} center distanceFactor={8}>
          <div className="px-2 py-1 rounded-md bg-zinc-900/95 border border-zinc-700 text-[10px] text-zinc-200 whitespace-nowrap shadow-lg">
            <div className="font-semibold text-teal-400">{node.name}</div>
            <div className="text-zinc-500">{TEAMS[node.team].label}</div>
            {node.currentJob && <div className="text-green-400">job {node.currentJob.slice(0, 8)}</div>}
            {node.currentMeeting && <div className="text-amber-400">in meeting</div>}
          </div>
        </Html>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Layout: 4-desk pinwheel pods per team                               */
/* ------------------------------------------------------------------ */

type Placement = {
  deskPos: [number, number];
  deskYaw: number;
  meetingPos?: [number, number, number];
};

// 4 pinwheel slots relative to pod center — desks face outward.
// Offsets: (dx, dz, yaw facing outward from pod center).
const PINWHEEL: Array<{ dx: number; dz: number; yaw: number }> = [
  { dx:  1.2, dz:  0.0, yaw:  Math.PI / 2 },   // east, monitor on east
  { dx:  0.0, dz:  1.2, yaw:  0 },              // south, monitor on south
  { dx: -1.2, dz:  0.0, yaw: -Math.PI / 2 },   // west
  { dx:  0.0, dz: -1.2, yaw:  Math.PI },        // north
];

function layoutAgents(nodes: AgentNode[]): Map<string, Placement> {
  const placements = new Map<string, Placement>();
  const byTeam: Record<TeamId, AgentNode[]> = { engineering: [], sales: [], marketing: [], product: [], sdlc: [] };
  nodes.forEach((n) => byTeam[n.team].push(n));

  (Object.keys(byTeam) as TeamId[]).forEach((team) => {
    const members = byTeam[team];
    const [cx, cz] = TEAMS[team].pod;
    members.forEach((m, i) => {
      // Rotate through 4 pinwheel slots. If >4 teammates, place further out.
      const slot = PINWHEEL[i % 4];
      const ring = Math.floor(i / 4);
      const scale = 1 + ring * 1.6;
      placements.set(m.name, {
        deskPos: [cx + slot.dx * scale, cz + slot.dz * scale],
        deskYaw: slot.yaw,
      });
    });
  });

  // Meeting participants: distribute around meeting-room table
  const inMeeting = nodes.filter((n) => n.state === "meeting");
  const radius = 2.5;
  inMeeting.forEach((n, i) => {
    const angle = (i / Math.max(inMeeting.length, 1)) * Math.PI * 2;
    const p = placements.get(n.name);
    if (p) p.meetingPos = [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
  });

  return placements;
}

/* ------------------------------------------------------------------ */
/* First-person rig                                                    */
/* ------------------------------------------------------------------ */

function FirstPersonRig({ onExit }: { onExit: () => void }) {
  const { camera } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const velocity = useRef(new THREE.Vector3());
  const direction = useRef(new THREE.Vector3());

  useEffect(() => {
    camera.position.set(0, EYE_HEIGHT, 12);
    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
      if (e.code === "Escape") onExit();
    };
    const up = (e: KeyboardEvent) => { keys.current[e.code] = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [camera, onExit]);

  useFrame((_, delta) => {
    const k = keys.current;
    const fwd   = (k["KeyW"] || k["ArrowUp"])    ? 1 : 0;
    const back  = (k["KeyS"] || k["ArrowDown"])  ? 1 : 0;
    const left  = (k["KeyA"] || k["ArrowLeft"])  ? 1 : 0;
    const right = (k["KeyD"] || k["ArrowRight"]) ? 1 : 0;
    const run   = k["ShiftLeft"] || k["ShiftRight"] ? 1.8 : 1;

    direction.current.set(right - left, 0, back - fwd).normalize();
    velocity.current.multiplyScalar(Math.max(0, 1 - 10 * delta));
    const speed = 6 * run;
    if (direction.current.lengthSq() > 0) {
      const yaw = Math.atan2(
        -camera.getWorldDirection(new THREE.Vector3()).x,
        -camera.getWorldDirection(new THREE.Vector3()).z,
      );
      const dx = direction.current.x;
      const dz = direction.current.z;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      velocity.current.x += (dx * cos + dz * sin) * speed * delta;
      velocity.current.z += (dz * cos - dx * sin) * speed * delta;
    }

    const next = camera.position.clone().addScaledVector(velocity.current, delta);
    next.x = THREE.MathUtils.clamp(next.x, -ROOM_HALF, ROOM_HALF);
    next.z = THREE.MathUtils.clamp(next.z, -ROOM_HALF, ROOM_HALF);

    // L-shape: block SE cut-out corner
    if (next.x > CUT && next.z > CUT) {
      const prev = camera.position;
      if (prev.x <= CUT) next.x = CUT;
      else if (prev.z <= CUT) next.z = CUT;
      else next.x = CUT;
    }

    // Meeting-room glass collision
    const inMeetX = Math.abs(next.x) < 3.6;
    const inMeetZ = Math.abs(next.z) < 3.6;
    if (inMeetX && inMeetZ) {
      const prev = camera.position;
      if (Math.abs(prev.x) >= 3.6) next.x = prev.x;
      if (Math.abs(prev.z) >= 3.6) next.z = prev.z;
      if (Math.abs(next.x) < 3.6 && Math.abs(next.z) < 3.6) {
        if (Math.abs(next.x) > Math.abs(next.z)) next.x = Math.sign(next.x || 1) * 3.6;
        else                                     next.z = Math.sign(next.z || 1) * 3.6;
      }
    }

    const moving = velocity.current.lengthSq() > 0.4;
    const bob = moving ? Math.sin(performance.now() * 0.012) * 0.035 : 0;
    next.y = EYE_HEIGHT + bob;

    camera.position.copy(next);
  });

  return <PointerLockControls onUnlock={onExit} />;
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

function SceneContent({
  baseUrl,
  secret,
  mode,
  onExitFP,
}: {
  baseUrl: string;
  secret: string;
  mode: ViewMode;
  onExitFP: () => void;
}) {
  const { nodes, meetings } = useOfficeData(baseUrl, secret);
  const placements = useMemo(() => layoutAgents(nodes), [nodes]);

  const summary = useMemo(() => {
    const working = nodes.filter((n) => n.state === "working").length;
    const meeting = nodes.filter((n) => n.state === "meeting").length;
    const idle    = nodes.filter((n) => n.state === "idle").length;
    return { working, meeting, idle, total: nodes.length };
  }, [nodes]);

  const gltf0 = useGLTF(AVATAR_MODELS[0].path) as GLTF & ObjectMap;
  const gltf1 = useGLTF(AVATAR_MODELS[1].path) as GLTF & ObjectMap;
  const gltf2 = useGLTF(AVATAR_MODELS[2].path) as GLTF & ObjectMap;
  const gltf3 = useGLTF(AVATAR_MODELS[3].path) as GLTF & ObjectMap;
  const gltfs = useMemo(() => [gltf0, gltf1, gltf2, gltf3], [gltf0, gltf1, gltf2, gltf3]);

  return (
    <>
      <color attach="background" args={["#11141c"]} />
      <fog attach="fog" args={["#11141c", 60, 120]} />

      <ambientLight intensity={1.2} />
      <hemisphereLight args={["#cfe9ff", "#3b3a4a", 1.0]} />
      <directionalLight
        position={[15, 22, 12]}
        intensity={1.8}
        color="#fff4d6"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-25}
        shadow-camera-right={25}
        shadow-camera-top={25}
        shadow-camera-bottom={-25}
      />
      <directionalLight position={[-12, 10, -14]} intensity={0.7} color="#a7c8ff" />

      <Floor />
      <Ceiling />
      <Walls />

      {/* Ceiling pendants */}
      {[
        [-12, 3.5, -12], [0, 3.5, -12], [12, 3.5, -12],
        [-12, 3.5,   0],                 [12, 3.5,   0],
        [-12, 3.5,  12], [0, 3.5,  12], [12, 3.5,  12],
      ].map((p, i) => (
        <Pendant key={`pd-${i}`} position={p as [number, number, number]}
                 color={i % 3 === 0 ? "#fde68a" : i % 3 === 1 ? "#fef3c7" : "#ffedd5"} />
      ))}

      <Pendant position={[0, 3.4, 0]} color="#5eead4" />

      <WallSconce position={[-19.7, 2.4,  -8]} rotationY={ Math.PI / 2} />
      <WallSconce position={[-19.7, 2.4,   8]} rotationY={ Math.PI / 2} />
      <WallSconce position={[ 19.7, 2.4,  -8]} rotationY={-Math.PI / 2} />
      <WallSconce position={[ 19.7, 2.4,   8]} rotationY={-Math.PI / 2} />

      <MeetingRoom />
      <Kitchen />
      <RestroomDoors />

      {/* Phone booths along west wall */}
      <PhoneBooth position={[-18, 0, -4]} color="#0891b2" />
      <PhoneBooth position={[-18, 0,  0]} color="#a78bfa" />
      <PhoneBooth position={[-18, 0,  4]} color="#22c55e" />

      {/* Breakout lounge (SW) */}
      <Sofa position={[-13, 0, 11.5]} rotationY={0} color="#4c1d95" />
      <Sofa position={[-13, 0, 14.5]} rotationY={Math.PI} color="#6d28d9" />
      <CoffeeTable position={[-13, 0, 13]} />

      {/* Plants — SE corner plants removed (cut-out zone) */}
      <Plant position={[-18, 0, -18]} />
      <Plant position={[ 18, 0, -18]} />
      <Plant position={[-18, 0,  18]} />
      <Plant position={[ -4, 0,  18]} />
      <Plant position={[ 18, 0, -10]} />
      <Plant position={[  6,  0,   6]} />   {/* near the cut-out's inner corner */}

      {/* Whiteboards + wall art */}
      <Whiteboard position={[-19.74, 1.8, -5]} rotationY={Math.PI / 2} accent={TEAMS.engineering.color} />
      <Whiteboard position={[ 19.74, 1.8,   6]} rotationY={-Math.PI / 2} accent={TEAMS.product.color} />
      <WallArt position={[-19.74, 2.6, -1]} rotationY={Math.PI / 2} color={TEAMS.sdlc.color} />
      <WallArt position={[ 19.74, 2.6,  -4]} rotationY={-Math.PI / 2} color={TEAMS.sales.color} />
      <WallArt position={[  0,    2.6, 19.74]} rotationY={Math.PI} color={TEAMS.marketing.color} />

      {/* Floor banners per zone */}
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <Text position={[ 10,  10, 0.02]} fontSize={0.42} color={TEAMS.engineering.color}>ENGINEERING</Text>
        <Text position={[ 11,  -6, 0.02]} fontSize={0.42} color={TEAMS.product.color}>PRODUCT</Text>
        <Text position={[ -6, -12, 0.02]} fontSize={0.42} color={TEAMS.sdlc.color}>SDLC / QA</Text>
        <Text position={[-15,  -5, 0.02]} fontSize={0.42} color={TEAMS.sales.color}>SALES</Text>
        <Text position={[  6, -12, 0.02]} fontSize={0.42} color={TEAMS.marketing.color}>MARKETING</Text>
        <Text position={[-13,  -13, 0.02]} fontSize={0.36} color="#fde68a">BREAKOUT</Text>
      </group>

      {/* Desks (with chairs) */}
      {nodes.map((n) => {
        const p = placements.get(n.name);
        if (!p) return null;
        return (
          <DeskWithChair
            key={`desk-${n.name}`}
            position={[p.deskPos[0], 0, p.deskPos[1]]}
            rotationY={p.deskYaw}
            accent={n.color}
          />
        );
      })}

      {/* Avatars */}
      {nodes.map((n) => {
        const p = placements.get(n.name);
        if (!p) return null;
        return (
          <Avatar
            key={n.name}
            node={n}
            deskPos={p.deskPos}
            deskYaw={p.deskYaw}
            meetingPos={p.meetingPos}
            gltfs={gltfs}
          />
        );
      })}

      {mode === "orbit" ? (
        <OrbitControls enablePan maxPolarAngle={Math.PI / 2.1} minDistance={8} maxDistance={45} />
      ) : (
        <FirstPersonRig onExit={onExitFP} />
      )}

      <Html fullscreen>
        <div className="absolute top-3 left-3 flex gap-2 text-[11px] pointer-events-none">
          <div className="px-2 py-1 rounded bg-zinc-900/80 border border-zinc-700 text-zinc-300">
            <span className="text-zinc-500">agents</span> {summary.total}
          </div>
          <div className="px-2 py-1 rounded bg-zinc-900/80 border border-green-800 text-green-400">working {summary.working}</div>
          <div className="px-2 py-1 rounded bg-zinc-900/80 border border-amber-800 text-amber-400">meeting {summary.meeting}</div>
          <div className="px-2 py-1 rounded bg-zinc-900/80 border border-zinc-700 text-zinc-500">idle {summary.idle}</div>
          {meetings.length > 0 && (
            <div className="px-2 py-1 rounded bg-zinc-900/80 border border-amber-800 text-amber-300">
              {meetings.length} active meeting{meetings.length > 1 ? "s" : ""}
            </div>
          )}
        </div>
      </Html>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Top-level export                                                    */
/* ------------------------------------------------------------------ */

export default function OfficeScene({ baseUrl, secret }: { baseUrl: string; secret: string }) {
  const [mode, setMode] = useState<ViewMode>("orbit");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const enterFP = () => setMode("firstPerson");
  const exitFP = () => setMode("orbit");

  return (
    <div className="relative h-[720px] w-full">
      <Canvas
        shadows
        camera={{ position: [0, 18, 22], fov: 40 }}
        onCreated={({ gl }) => {
          canvasRef.current = gl.domElement;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.6;
        }}
      >
        <Suspense fallback={null}>
          <SceneContent baseUrl={baseUrl} secret={secret} mode={mode} onExitFP={exitFP} />
        </Suspense>
      </Canvas>

      <div className="absolute top-3 right-3 flex flex-col gap-2 items-end">
        {mode === "orbit" ? (
          <button
            onClick={enterFP}
            className="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-white text-xs font-medium shadow-lg"
          >
            Enter first-person
          </button>
        ) : (
          <button
            onClick={exitFP}
            className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-medium shadow-lg border border-zinc-700"
          >
            Exit (Esc)
          </button>
        )}
        {mode === "firstPerson" && (
          <div className="px-3 py-2 rounded bg-zinc-900/90 border border-zinc-700 text-[10px] text-zinc-300 shadow-lg">
            <div className="font-semibold text-teal-400 mb-1">Walk controls</div>
            <div>Click to capture mouse</div>
            <div>WASD / arrows — move</div>
            <div>Mouse — look</div>
            <div>Shift — run</div>
            <div>Esc — exit</div>
          </div>
        )}
      </div>
    </div>
  );
}
