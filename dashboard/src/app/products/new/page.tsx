"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { getAPI } from "@/lib/api";
import type { OnboardProductInput } from "@/lib/types";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FormState {
  // Step 1: Basic
  name: string;
  description: string;
  workingDir: string;
  industry: string;
  targetMarket: string;
  // Step 2: Project
  jiraProjectKey: string;
  jiraProjectName: string;
  jiraBoardId: string;
  jiraDomain: string;
  confluenceSpace: string;
  sprintEnabled: boolean;
  // Step 3: Tech Stack
  frontend: string;
  backend: string;
  database: string;
  orm: string;
  auth: string;
  packageManager: string;
  devCmd: string;
  buildCmd: string;
  testCmd: string;
  lintCmd: string;
  typeCheckCmd: string;
  // Step 4: Domain Expertise (stored as JSON-like text areas)
  regulatorsText: string;
  keyProcessesText: string;
  terminologyText: string;
  domainPitfallsText: string;
  productAreasText: string;
  // Step 5: Agents
  selectedAgents: string[];
}

const AGENT_GROUPS = [
  {
    label: "Core",
    description: "Always included — implementation, review, bug triage, PM, sprint reporting, security",
    agents: ["engineer-planner", "engineer-implementer", "engineer-reviewer", "bug-triage", "product-manager", "sprint-reporter", "security-agent"],
    required: true,
  },
  {
    label: "UI",
    description: "Frontend engineering agent",
    agents: ["ui-engineer"],
    required: false,
  },
  {
    label: "Advanced Engineering",
    description: "BA, architect, QA, UX, E2E builder, UAT",
    agents: ["ba-agent", "architect", "qa-agent", "ux-agent", "e2e-builder", "uat-agent"],
    required: false,
  },
  {
    label: "Sales",
    description: "SDR, researcher, outreach agents",
    agents: ["sales-development", "sales-researcher", "sales-outreach"],
    required: false,
  },
  {
    label: "Marketing",
    description: "Content drafting and creative assets",
    agents: ["marketing", "creative-assets"],
    required: false,
  },
  {
    label: "Documentation",
    description: "User guides and video tutorials",
    agents: ["user-guide-agent", "video-renderer"],
    required: false,
  },
];

const CORE_AGENTS = AGENT_GROUPS.find((g) => g.required)!.agents;

const INITIAL: FormState = {
  name: "",
  description: "",
  workingDir: "",
  industry: "",
  targetMarket: "",
  jiraProjectKey: "",
  jiraProjectName: "",
  jiraBoardId: "",
  jiraDomain: "",
  confluenceSpace: "",
  sprintEnabled: false,
  frontend: "",
  backend: "",
  database: "",
  orm: "",
  auth: "",
  packageManager: "pnpm",
  devCmd: "pnpm dev",
  buildCmd: "pnpm build",
  testCmd: "pnpm test",
  lintCmd: "pnpm lint",
  typeCheckCmd: "",
  regulatorsText: "",
  keyProcessesText: "",
  terminologyText: "",
  domainPitfallsText: "",
  productAreasText: "",
  selectedAgents: [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function buildPayload(form: FormState): OnboardProductInput {
  const agents = [...CORE_AGENTS, ...form.selectedAgents];
  const payload: OnboardProductInput = {
    name: form.name.trim(),
    description: form.description.trim(),
    workingDir: form.workingDir.trim(),
    industry: form.industry.trim() || undefined,
    targetMarket: form.targetMarket.trim() || undefined,
    agents,
  };

  if (form.jiraProjectKey || form.jiraProjectName || form.jiraBoardId) {
    payload.jira = {
      projectKey: form.jiraProjectKey.trim().toUpperCase() || undefined,
      projectName: form.jiraProjectName.trim() || undefined,
      boardId: form.jiraBoardId.trim() || undefined,
      domain: form.jiraDomain.trim() || undefined,
    };
  }

  if (form.confluenceSpace) {
    payload.confluence = { space: form.confluenceSpace.trim() };
  }

  payload.sprint = { enabled: form.sprintEnabled };

  payload.techStack = {
    frontend: form.frontend.trim() || undefined,
    backend: form.backend.trim() || undefined,
    database: form.database.trim() || undefined,
    orm: form.orm.trim() || undefined,
    auth: form.auth.trim() || undefined,
    packageManager: form.packageManager,
    commands: {
      dev: form.devCmd.trim() || undefined,
      build: form.buildCmd.trim() || undefined,
      test: form.testCmd.trim() || undefined,
      lint: form.lintCmd.trim() || undefined,
      typeCheck: form.typeCheckCmd.trim() || undefined,
    },
  };

  // Parse domain fields from free-text
  const domain: OnboardProductInput["domain"] = {};
  if (form.regulatorsText.trim()) {
    domain.regulators = form.regulatorsText.trim().split("\n").filter(Boolean).map((line) => ({ name: line.trim() }));
  }
  if (form.keyProcessesText.trim()) {
    domain.keyProcesses = form.keyProcessesText.trim().split("\n").filter(Boolean).map((line) => ({ name: line.trim() }));
  }
  if (form.terminologyText.trim()) {
    domain.terminology = form.terminologyText.trim().split("\n").filter(Boolean).map((line) => {
      const [term, ...rest] = line.split(":");
      return { term: term.trim(), meaning: rest.join(":").trim() || undefined };
    });
  }
  if (form.domainPitfallsText.trim()) {
    domain.domainPitfalls = form.domainPitfallsText.trim().split("\n").filter(Boolean).map((l) => l.trim());
  }
  if (form.productAreasText.trim()) {
    domain.productAreas = form.productAreasText.trim().split("\n").filter(Boolean).map((line) => {
      const [name, ...rest] = line.split(":");
      return { name: name.trim(), description: rest.join(":").trim() || undefined };
    });
  }
  if (Object.keys(domain).length > 0) payload.domain = domain;

  return payload;
}

// ─── Field Components ─────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-zinc-200">{label}</label>
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
      {children}
    </div>
  );
}

const inputCls = "w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/50 transition-colors";
const textareaCls = `${inputCls} resize-none`;

// ─── Steps ───────────────────────────────────────────────────────────────────

function Step1({ form, set }: { form: FormState; set: (k: keyof FormState, v: string) => void }) {
  const slug = slugify(form.name);
  return (
    <div className="space-y-5">
      <Field label="Product name *" hint='e.g. "AcmePay", "FleetTracker"'>
        <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="My Product" />
        {slug && <p className="text-xs text-zinc-500 mt-1">Product ID: <span className="font-mono text-teal-400">{slug}</span></p>}
      </Field>
      <Field label="Description *" hint="One-line description of what the product does.">
        <input className={inputCls} value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="A platform for…" />
      </Field>
      <Field label="Codebase path *" hint="Absolute path on the host machine where the codebase lives.">
        <input className={inputCls} value={form.workingDir} onChange={(e) => set("workingDir", e.target.value)} placeholder="/srv/projects/my-product" />
      </Field>
      <Field label="Industry / domain" hint="e.g. fintech, healthcare, logistics, estate planning">
        <input className={inputCls} value={form.industry} onChange={(e) => set("industry", e.target.value)} placeholder="SaaS B2B" />
      </Field>
      <Field label="Target market" hint="Geography and company size — e.g. UK SMEs, 10-100 employees">
        <input className={inputCls} value={form.targetMarket} onChange={(e) => set("targetMarket", e.target.value)} placeholder="UK SMEs" />
      </Field>
    </div>
  );
}

function Step2({ form, set, toggle }: { form: FormState; set: (k: keyof FormState, v: string) => void; toggle: (k: keyof FormState) => void }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-zinc-400">All fields are optional — skip if you&apos;re not using Jira.</p>
      <Field label="Jira project key" hint="2–4 uppercase letters e.g. ACM, FLT">
        <input className={inputCls} value={form.jiraProjectKey} onChange={(e) => set("jiraProjectKey", e.target.value.toUpperCase())} placeholder="ACM" maxLength={6} />
      </Field>
      <Field label="Jira project name">
        <input className={inputCls} value={form.jiraProjectName} onChange={(e) => set("jiraProjectName", e.target.value)} placeholder="AcmePay Dev" />
      </Field>
      <Field label="Jira board ID" hint="Number in the board URL — used for sprint tracking">
        <input className={inputCls} value={form.jiraBoardId} onChange={(e) => set("jiraBoardId", e.target.value)} placeholder="42" />
      </Field>
      <Field label="Jira domain" hint="e.g. https://mycompany.atlassian.net">
        <input className={inputCls} value={form.jiraDomain} onChange={(e) => set("jiraDomain", e.target.value)} placeholder="https://mycompany.atlassian.net" />
      </Field>
      <Field label="Confluence space key" hint="e.g. ACM, CE">
        <input className={inputCls} value={form.confluenceSpace} onChange={(e) => set("confluenceSpace", e.target.value)} placeholder="ACM" />
      </Field>
      <label className="flex items-center gap-3 cursor-pointer">
        <input type="checkbox" checked={form.sprintEnabled} onChange={() => toggle("sprintEnabled")} className="w-4 h-4 rounded border-zinc-600 text-teal-500 focus:ring-teal-500/50 bg-zinc-800" />
        <span className="text-sm text-zinc-200">Enable automatic sprint execution</span>
      </label>
      {form.sprintEnabled && (
        <p className="text-xs text-zinc-500 pl-7">The sprint runner will pick up &quot;To Do&quot; issues from active sprints and auto-dispatch them to agents every 10 minutes. Requires a valid board ID.</p>
      )}
    </div>
  );
}

function Step3({ form, set }: { form: FormState; set: (k: keyof FormState, v: string) => void }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Frontend framework">
          <input className={inputCls} value={form.frontend} onChange={(e) => set("frontend", e.target.value)} placeholder="Next.js, React, Vue…" />
        </Field>
        <Field label="Backend framework">
          <input className={inputCls} value={form.backend} onChange={(e) => set("backend", e.target.value)} placeholder="Express, tRPC, FastAPI…" />
        </Field>
        <Field label="Database">
          <input className={inputCls} value={form.database} onChange={(e) => set("database", e.target.value)} placeholder="PostgreSQL, MySQL…" />
        </Field>
        <Field label="ORM / query layer">
          <input className={inputCls} value={form.orm} onChange={(e) => set("orm", e.target.value)} placeholder="Prisma, Drizzle, SQLAlchemy…" />
        </Field>
        <Field label="Auth provider">
          <input className={inputCls} value={form.auth} onChange={(e) => set("auth", e.target.value)} placeholder="Clerk, Auth0, custom…" />
        </Field>
        <Field label="Package manager">
          <select className={inputCls} value={form.packageManager} onChange={(e) => set("packageManager", e.target.value)}>
            <option value="pnpm">pnpm</option>
            <option value="npm">npm</option>
            <option value="yarn">yarn</option>
            <option value="bun">bun</option>
          </select>
        </Field>
      </div>
      <p className="text-xs text-zinc-500 pt-1">These commands become the quality-gate checks — run by the runner after every implementation job.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Dev server command">
          <input className={inputCls} value={form.devCmd} onChange={(e) => set("devCmd", e.target.value)} placeholder="pnpm dev" />
        </Field>
        <Field label="Build command">
          <input className={inputCls} value={form.buildCmd} onChange={(e) => set("buildCmd", e.target.value)} placeholder="pnpm build" />
        </Field>
        <Field label="Test command">
          <input className={inputCls} value={form.testCmd} onChange={(e) => set("testCmd", e.target.value)} placeholder="pnpm test" />
        </Field>
        <Field label="Lint command">
          <input className={inputCls} value={form.lintCmd} onChange={(e) => set("lintCmd", e.target.value)} placeholder="pnpm lint" />
        </Field>
        <Field label="Type-check command">
          <input className={inputCls} value={form.typeCheckCmd} onChange={(e) => set("typeCheckCmd", e.target.value)} placeholder="pnpm type-check (optional)" />
        </Field>
      </div>
    </div>
  );
}

function Step4({ form, set }: { form: FormState; set: (k: keyof FormState, v: string) => void }) {
  return (
    <div className="space-y-5">
      <div className="p-3 rounded-lg bg-teal-500/10 border border-teal-500/20 text-sm text-teal-300">
        This is the most important section. The more domain knowledge you provide, the smarter your PM agent will be from day one — catching business logic errors before they ship and reasoning about regulatory urgency.
      </div>
      <Field
        label="Regulatory bodies / standards"
        hint="One per line — e.g. SRA, HMRC, FDA, ISO 27001. Skip if not applicable."
      >
        <textarea className={textareaCls} rows={3} value={form.regulatorsText} onChange={(e) => set("regulatorsText", e.target.value)} placeholder={"SRA\nOPG\nHMRC"} />
      </Field>
      <Field
        label="Key domain processes"
        hint="One per line — the core workflows your product supports e.g. 'will drafting → execution → registration'"
      >
        <textarea className={textareaCls} rows={4} value={form.keyProcessesText} onChange={(e) => set("keyProcessesText", e.target.value)} placeholder={"Onboarding\nPayment processing\nCompliance check"} />
      </Field>
      <Field
        label="Domain terminology"
        hint="Correct terms and common confusions. Format: term: definition. One per line."
      >
        <textarea className={textareaCls} rows={4} value={form.terminologyText} onChange={(e) => set("terminologyText", e.target.value)} placeholder={"testator: the person making a will\ngrant of probate: not 'probate certificate'"} />
      </Field>
      <Field
        label="Common domain pitfalls"
        hint="Top 5–10 mistakes a non-expert would make when building features. One per line."
      >
        <textarea className={textareaCls} rows={5} value={form.domainPitfallsText} onChange={(e) => set("domainPitfallsText", e.target.value)} placeholder={"Treating all executors as having equal permissions\nNot validating signing order before submission"} />
      </Field>
      <Field
        label="Product areas / modules"
        hint="Key modules that map to Jira epics. Format: Area Name: brief description. One per line."
      >
        <textarea className={textareaCls} rows={4} value={form.productAreasText} onChange={(e) => set("productAreasText", e.target.value)} placeholder={"Dashboard: overview and analytics\nClient Records: CRM-style client management\nCompliance: regulatory checks and audit trail"} />
      </Field>
    </div>
  );
}

function Step5({ form, toggle }: { form: FormState; toggle: (agent: string) => void }) {
  return (
    <div className="space-y-5">
      {AGENT_GROUPS.map((group) => (
        <div key={group.label} className={`p-4 rounded-xl border ${group.required ? "border-teal-500/30 bg-teal-500/5" : "border-zinc-800 bg-zinc-900"}`}>
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <h4 className="text-sm font-semibold text-white">{group.label}</h4>
              <p className="text-xs text-zinc-400 mt-0.5">{group.description}</p>
            </div>
            {group.required && (
              <span className="flex-shrink-0 text-xs px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-400 border border-teal-500/20">Required</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {group.agents.map((agent) => {
              const selected = group.required || form.selectedAgents.includes(agent);
              return (
                <button
                  key={agent}
                  type="button"
                  disabled={group.required}
                  onClick={() => !group.required && toggle(agent)}
                  className={`px-2.5 py-1 rounded-full text-xs font-mono transition-colors ${
                    selected
                      ? "bg-teal-500/20 text-teal-300 border border-teal-500/30"
                      : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600 hover:text-zinc-300"
                  } ${group.required ? "opacity-70 cursor-default" : "cursor-pointer"}`}
                >
                  {agent}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Step6Review({ form }: { form: FormState }) {
  const slug = slugify(form.name);
  const allAgents = [...CORE_AGENTS, ...form.selectedAgents];
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">Review your configuration before submitting. Claude will generate the full plugin scaffold based on this information.</p>
      <div className="space-y-3 text-sm">
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-2">
          <div className="font-semibold text-zinc-300 mb-2">Basic</div>
          <Row label="Product ID" value={slug} mono />
          <Row label="Name" value={form.name} />
          <Row label="Description" value={form.description} />
          <Row label="Working dir" value={form.workingDir} mono />
          {form.industry && <Row label="Industry" value={form.industry} />}
        </div>
        {(form.jiraProjectKey || form.sprintEnabled) && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-2">
            <div className="font-semibold text-zinc-300 mb-2">Project</div>
            {form.jiraProjectKey && <Row label="Jira key" value={form.jiraProjectKey} mono />}
            {form.jiraBoardId && <Row label="Board ID" value={form.jiraBoardId} />}
            {form.sprintEnabled && <Row label="Sprint execution" value="Enabled" />}
          </div>
        )}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-2">
          <div className="font-semibold text-zinc-300 mb-2">Tech stack</div>
          {form.frontend && <Row label="Frontend" value={form.frontend} />}
          {form.backend && <Row label="Backend" value={form.backend} />}
          {form.database && <Row label="Database" value={form.database} />}
          <Row label="Package manager" value={form.packageManager} />
          <Row label="Test command" value={form.testCmd} mono />
        </div>
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-2">
          <div className="font-semibold text-zinc-300 mb-2">Agents ({allAgents.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {allAgents.map((a) => (
              <span key={a} className="px-2 py-0.5 rounded-full text-xs font-mono bg-teal-500/10 text-teal-300 border border-teal-500/20">{a}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-zinc-500 w-32 flex-shrink-0">{label}</span>
      <span className={`text-zinc-200 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

// ─── Progress Panel ───────────────────────────────────────────────────────────

function ProgressPanel({ jobId, productId, baseUrl, onDone }: {
  jobId: string;
  productId: string;
  baseUrl: string;
  onDone: (success: boolean) => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"running" | "succeeded" | "failed">("running");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const streamUrl = `${baseUrl}/jobs/${encodeURIComponent(jobId)}/log/stream`;
    const es = new EventSource(streamUrl);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "log" && data.message) {
          setLines((prev) => [...prev, data.message]);
        }
        if (data.type === "status") {
          if (data.status === "succeeded") {
            setStatus("succeeded");
            es.close();
            setTimeout(() => onDone(true), 1500);
          } else if (data.status === "failed") {
            setStatus("failed");
            es.close();
            onDone(false);
          }
        }
      } catch {
        setLines((prev) => [...prev, e.data]);
      }
    };
    es.onerror = () => {
      es.close();
      // Poll job status as fallback
      pollStatus(jobId, baseUrl, setStatus, onDone);
    };
    return () => es.close();
  }, [jobId, baseUrl, onDone]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {status === "running" && (
          <>
            <div className="w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-white font-semibold">Generating product scaffold…</span>
          </>
        )}
        {status === "succeeded" && (
          <>
            <span className="text-2xl">✓</span>
            <span className="text-emerald-400 font-semibold">Product <span className="font-mono">{productId}</span> created successfully!</span>
          </>
        )}
        {status === "failed" && (
          <>
            <span className="text-2xl">✗</span>
            <span className="text-red-400 font-semibold">Generation failed. Check the output below.</span>
          </>
        )}
      </div>

      <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 h-72 overflow-y-auto font-mono text-xs text-zinc-300 space-y-0.5">
        {lines.length === 0 && status === "running" && (
          <span className="text-zinc-600">Waiting for output…</span>
        )}
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        <div ref={bottomRef} />
      </div>

      {status === "running" && (
        <p className="text-xs text-zinc-500">Job ID: <span className="font-mono">{jobId}</span> — you can also track this in <a href="/jobs" className="text-teal-400 underline">Jobs</a>.</p>
      )}
      {status === "succeeded" && (
        <div className="p-4 rounded-lg bg-zinc-900 border border-zinc-800 space-y-3 text-sm">
          <p className="font-semibold text-white">Next steps</p>
          <ol className="space-y-1.5 text-zinc-400 list-decimal list-inside">
            <li>Review generated agents in <code className="font-mono text-xs bg-zinc-800 px-1 rounded">{productId}-plugin/agents/</code></li>
            <li>Check <code className="font-mono text-xs bg-zinc-800 px-1 rounded">products/{productId}/product.json</code> and fill in any blank fields</li>
            <li>Run <code className="font-mono text-xs bg-zinc-800 px-1 rounded">source ~/.zprofile</code> in a new terminal to pick up the updated Claude launcher</li>
            <li>Test by dispatching a job to the runner with <code className="font-mono text-xs bg-zinc-800 px-1 rounded">{`"workingDir": "${""}"...`}</code></li>
          </ol>
        </div>
      )}
    </div>
  );
}

async function pollStatus(jobId: string, baseUrl: string, setStatus: (s: "running" | "succeeded" | "failed") => void, onDone: (ok: boolean) => void) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const res = await fetch(`${baseUrl}/jobs/${encodeURIComponent(jobId)}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const s = data.job?.status || data.status;
        if (s === "succeeded") { setStatus("succeeded"); onDone(true); return; }
        if (s === "failed") { setStatus("failed"); onDone(false); return; }
      }
    } catch { /* ignore */ }
  }
}

// ─── Wizard ───────────────────────────────────────────────────────────────────

const STEPS = ["Basic info", "Project", "Tech stack", "Domain expertise", "Agents", "Review"];

function OnboardWizard({ baseUrl }: { baseUrl: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);

  function set(k: keyof FormState, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function toggleBool(k: keyof FormState) {
    setForm((f) => ({ ...f, [k]: !f[k] }));
  }

  function toggleAgent(agent: string) {
    setForm((f) => {
      const selected = f.selectedAgents.includes(agent)
        ? f.selectedAgents.filter((a) => a !== agent)
        : [...f.selectedAgents, agent];
      return { ...f, selectedAgents: selected };
    });
  }

  function canAdvance(): boolean {
    if (step === 0) return !!form.name.trim() && !!form.description.trim() && !!form.workingDir.trim();
    return true;
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const payload = buildPayload(form);
      const result = await getAPI().onboardProduct(payload);
      setJobId(result.jobId);
      setProductId(result.productId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submission failed");
      setSubmitting(false);
    }
  }

  if (jobId && productId) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h2 className="text-xl font-bold text-white">Onboarding <span className="text-teal-400 font-mono">{productId}</span></h2>
          <p className="text-zinc-400 text-sm mt-0.5">Claude is generating your product scaffold. This takes 1–3 minutes.</p>
        </div>
        <ProgressPanel
          jobId={jobId}
          productId={productId}
          baseUrl={`${baseUrl}/api/runner`}
          onDone={(success) => {
            if (success) setTimeout(() => router.push("/products"), 3000);
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <button onClick={() => router.push("/products")} className="text-sm text-zinc-400 hover:text-white mb-4 flex items-center gap-1">
          ← Back to Products
        </button>
        <h2 className="text-xl font-bold text-white">Onboard a Product</h2>
        <p className="text-zinc-400 text-sm mt-0.5">Claude will generate a domain-aware plugin scaffold based on your answers.</p>
      </div>

      {/* Step indicator */}
      <div className="flex gap-1">
        {STEPS.map((label, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <div className={`h-1 w-full rounded-full transition-colors ${i <= step ? "bg-teal-500" : "bg-zinc-800"}`} />
            <span className={`text-xs hidden sm:block ${i === step ? "text-teal-400" : "text-zinc-600"}`}>{label}</span>
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
        <h3 className="text-base font-semibold text-white mb-5">Step {step + 1}: {STEPS[step]}</h3>

        {step === 0 && <Step1 form={form} set={set} />}
        {step === 1 && <Step2 form={form} set={set} toggle={toggleBool} />}
        {step === 2 && <Step3 form={form} set={set} />}
        {step === 3 && <Step4 form={form} set={set} />}
        {step === 4 && <Step5 form={form} toggle={toggleAgent} />}
        {step === 5 && <Step6Review form={form} />}

        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

        {/* Navigation */}
        <div className="flex items-center justify-between mt-8 pt-4 border-t border-zinc-800">
          <button
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 0}
            className="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Back
          </button>

          <div className="flex items-center gap-3">
            {step < STEPS.length - 1 && step !== 0 && (
              <button
                onClick={() => setStep((s) => s + 1)}
                className="px-4 py-2 text-sm rounded-lg text-zinc-400 hover:text-white transition-colors"
              >
                Skip
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canAdvance()}
                className="px-5 py-2 text-sm font-semibold rounded-lg bg-teal-600 hover:bg-teal-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-5 py-2 text-sm font-semibold rounded-lg bg-teal-600 hover:bg-teal-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Submitting…" : "Generate plugin scaffold"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  return (
    <AuthGate>
      {({ baseUrl }) => (
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col">
            <Header baseUrl={baseUrl} />
            <main className="flex-1 p-2 sm:p-4 md:p-6">
              <OnboardWizard baseUrl={baseUrl} />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
