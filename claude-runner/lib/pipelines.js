// pipelines.js — pipeline engine: phases, gates, context bridge, merge conflict handling, timeline
// Extracted from runner.js.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const issueTracker = require("../issue-tracker");
const { GATE_NEGATIVE_VERDICTS, GATE_POSITIVE_VERDICTS, extractGateVerdict } = require("./protocol");
const { evaluateObservationPolicy, renderObservationsComment } = require("./observations");
const {
  DEFAULT_WORKING_DIR,
  LOG_DIR,
  MAX_RETRIES,
  N8N_CALLBACK_URL,
  RUNNER_ROOT,
  config,
} = require("./config");
const { moveSubtaskToParentSprint, transitionIssueToInProgress } = require("./jira");
const { appendLesson } = require("./lessons");
const { shouldRunLocal } = require("./models");
const { resolveProduct } = require("./products");
const { jobEmitter, jobs, pipelines, worktrees } = require("./state");
const { getJson, makeJobId, nowIso, postJson, truncateForLesson } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  loadPipelineDefinitions,
  evaluatePhaseCondition,
  parsePlannerPhases,
  applyDynamicPhaseGating,
  mergePipelineBranchIntoDev,
  detectInheritedRedBase,
  preserveBranchOnFailure,
  createPipeline,
  buildPipelinePrompt,
  executePipelinePhase,
  evaluateGate,
  handlePipelineNeedsClarification,
  extractStructuredSummary,
  formatContextSection,
  updateContextBridge,
  autoMergePipelineBranch,
  dispatchMergeConflictAgent,
  finalizeMergeConflictResolution,
  advancePipeline,
  autoTransitionIssueToDone,
  checkAndTransitionParent,
  moveParentToInProgress,
  createPipelineFailureSubtask,
  onPipelinePhaseComplete,
  extractTeammateLog,
  buildTimelineForIssue,
};

const { sendCallbackWithRetry } = require("./callbacks");
const { getUnmergedBlockers } = require("./sprint");
const { maybeScheduleVerification } = require("./verification");
const { enqueue } = require("./worker");
const {
  createWorktree,
  mergeBranchIntoDev,
  mergeWorktree,
  resolveMergeBranch,
  resolveRemoteName,
  setupWorktree,
  stashDirtyWorkingDir,
  withMergeLock,
} = require("./worktrees");


/**
 * Load pipeline definitions from config
 */
function loadPipelineDefinitions() {
  const configPath = path.join(RUNNER_ROOT, "config.json");
  try {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return fileConfig.pipelines || {};
  } catch {
    return {};
  }
}

/**
 * Evaluate a phase condition string against runtime context.
 * The condition is a simple expression evaluated with the pipeline's labels array.
 * e.g. "labels.includes('needs-ui') || labels.includes('needs-ux-design')"
 */
function evaluatePhaseCondition(condition, labels) {
  if (!condition) return true;
  try {
    // Safe eval: only allow access to `labels`
    const fn = new Function("labels", `return !!(${condition});`);
    return fn(Array.isArray(labels) ? labels : []);
  } catch {
    return true; // If condition can't be evaluated, don't skip phase
  }
}

/**
 * Parse [PIPELINE-PHASES] block from planner output.
 * Expected format:
 *   [PIPELINE-PHASES]
 *   - requirements: local
 *   - implementation: sonnet
 *   - qa: local
 *   [/PIPELINE-PHASES]
 * Returns Map of phaseName → modelTier (or null if no model override).
 */
function parsePlannerPhases(output) {
  if (!output) return null;
  const match = output.match(/\[PIPELINE-PHASES\]([\s\S]*?)\[\/PIPELINE-PHASES\]/);
  if (!match) return null;

  const phases = new Map();
  const lines = match[1].trim().split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*-\s*(\S+)(?:\s*:\s*(\S+))?/);
    if (m) {
      phases.set(m[1].toLowerCase(), m[2]?.toLowerCase() || null);
    }
  }
  return phases.size > 0 ? phases : null;
}

/**
 * Apply dynamic phase gating after a planner/triage phase completes.
 * Reads the planner's output for [PIPELINE-PHASES] and skips phases not listed.
 * Always keeps 'triage', 'implementation', 'code-review', and 'verify' as mandatory (planner can't skip those).
 */
function applyDynamicPhaseGating(pipeline, phase, job) {
  const output = (typeof job.parsedOutput === "string" ? job.parsedOutput : job.parsedOutput?.result) || "";
  const selectedPhases = parsePlannerPhases(output);

  if (!selectedPhases) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} dynamic gating: no [PIPELINE-PHASES] block found — running all phases`);
    return;
  }

  // Mandatory phases that can never be skipped
  const mandatory = new Set(["triage", "implementation", "code-review", "verify"]);

  let skipped = 0;
  let retained = 0;
  for (const p of pipeline.phases) {
    if (p.status !== "pending") continue; // Already completed/skipped/running
    if (mandatory.has(p.name)) { retained++; continue; }

    if (selectedPhases.has(p.name)) {
      // Planner wants this phase — optionally override model tier
      const modelOverride = selectedPhases.get(p.name);
      if (modelOverride && ["opus", "sonnet", "haiku"].includes(modelOverride)) {
        p.model = modelOverride;
      }
      retained++;
    } else {
      // Planner didn't select this phase — skip it
      p.status = "skipped";
      p.completedAt = nowIso();
      skipped++;
    }
  }


  console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} dynamic gating applied: ${retained} phases retained, ${skipped} skipped. Selected: [${[...selectedPhases.keys()].join(", ")}]`);

  jobEmitter.emit("pipeline:dynamic-gating", {
    pipelineId: pipeline.pipelineId,
    issueKey: pipeline.issueKey,
    selectedPhases: [...selectedPhases.entries()],
    skipped,
    retained,
  });
}

/**
 * Locate the pipeline's feature branch in the base repo and merge it into the
 * integration ("dev") branch via mergeBranchIntoDev. Used by the non-worktree path.
 * Returns { branch, mergeBranch, devSha, mode } or null when nothing to merge.
 */
function mergePipelineBranchIntoDev(pipeline) {
  const { execSync } = require("child_process");
  const baseRepo = pipeline.workingDir; // non-worktree: agents committed in workingDir
  if (!baseRepo) return null;
  const issueKey = pipeline.issueKey;
  if (!issueKey) return null;

  const candidateBranches = [
    pipeline.worktreeBranch,
    `${issueKey}-auto`,
    `${issueKey.toLowerCase()}-auto`,
    `feature/${issueKey}`,
    `fix/${issueKey}`,
    issueKey.toLowerCase(),
  ].filter(Boolean);

  let branchName = null;
  for (const candidate of candidateBranches) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, { cwd: baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" });
      branchName = candidate;
      break;
    } catch { /* try next */ }
  }
  if (!branchName) {
    console.log(`[${nowIso()}] mergePipelineBranchIntoDev: no matching branch found for ${issueKey} in ${baseRepo}`);
    return null;
  }

  return mergeBranchIntoDev(baseRepo, branchName, issueKey);
}

/**
 * On pipeline failure, preserve work by pushing the branch (no PR — just keep it on remote).
 * Posts an [AUTO-IMPLEMENT-FAILED] Jira comment with the branch name so a human can pick it up.
 */
/**
 * d3a: Detect "blocked on red base" — quality-gate failures whose failing
 * test files have zero overlap with the pipeline's diff. Heuristic:
 * if the implementer hasn't touched these files, they were red on dev
 * before the pipeline started. Halts fix-loop retry burn.
 *
 * Conservative: only consults `test` failures; needs ≥1 parsed failing
 * file path; needs a non-empty diff to compare against.
 */
function detectInheritedRedBase(pipeline, phase, job) {
  const { execSync } = require("child_process");
  const cwd = pipeline.worktreePath || pipeline.workingDir || job.workingDir;
  if (!cwd || !fs.existsSync(cwd)) return { inherited: false, reason: "no worktree" };

  const qgFailure = job.qualityGateFailure || {};
  if (qgFailure.failedCheck !== "test") return { inherited: false, reason: "not a test failure" };
  const output = qgFailure.failureOutput || job.error || "";
  if (!output) return { inherited: false, reason: "no output" };

  const failingFiles = new Set();
  const failRegex = /(?:^|\s)(?:FAIL|❯|×)\s+([\w./@-]+\.(?:test|spec)\.[tj]sx?)/g;
  let m;
  while ((m = failRegex.exec(output)) !== null) failingFiles.add(m[1]);
  if (failingFiles.size === 0) return { inherited: false, reason: "no failing files parsed" };

  let changedFiles = new Set();
  let basis = null;
  for (const ref of ["origin/dev", "origin/main"]) {
    try {
      const out = execSync(`git diff --name-only $(git merge-base HEAD ${ref})..HEAD`, {
        cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash"
      });
      out.split("\n").map(s => s.trim()).filter(Boolean).forEach(f => changedFiles.add(f));
      basis = ref;
      if (changedFiles.size > 0) break;
    } catch {}
  }
  if (changedFiles.size === 0) return { inherited: false, reason: "no diff resolvable" };

  for (const f of failingFiles) {
    if (changedFiles.has(f)) return { inherited: false, reason: `overlap: ${f}` };
  }
  return {
    inherited: true,
    failingFiles: Array.from(failingFiles),
    changedFiles: Array.from(changedFiles),
    basis,
  };
}

function preserveBranchOnFailure(pipeline, phase) {
  const { execSync } = require("child_process");
  const cwd = pipeline.worktreePath || pipeline.workingDir;
  if (!cwd || !pipeline.issueKey) return null;

  let branchName = pipeline.worktreeBranch || `${pipeline.issueKey}-auto`;
  try {
    execSync(`git rev-parse --verify ${branchName}`, { cwd, encoding: "utf8", timeout: 5000, stdio: "pipe" });
  } catch {
    // Fall back to current branch if the canonical one isn't there
    try {
      branchName = execSync("git branch --show-current", { cwd, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
    } catch { return null; }
    if (!branchName || branchName === "main") return null;
  }

  // Skip if no commits ahead of main
  let ahead = 0;
  try {
    ahead = parseInt(execSync(`git rev-list main..${branchName} --count`, { cwd, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim()) || 0;
  } catch {}
  if (ahead === 0) {
    console.log(`[${nowIso()}] No commits to preserve for failed pipeline ${pipeline.pipelineId}`);
    return null;
  }

  let pushedRemote = false;
  const remote = resolveRemoteName(cwd);
  try {
    execSync(`git push -u ${remote} ${branchName}`, { cwd, encoding: "utf8", timeout: 60000, stdio: "pipe" });
    pushedRemote = true;
    console.log(`[${nowIso()}] Preserved failed-pipeline branch ${branchName} to ${remote}`);
  } catch (e) {
    console.warn(`[${nowIso()}] Failed to push preservation branch ${branchName}: ${e.message}`);
  }

  // Best-effort Jira note (non-blocking)
  const jiraComment = [
    `[AUTO-IMPLEMENT-FAILED] Pipeline ${pipeline.pipelineId} failed at phase "${phase?.name || 'unknown'}".`,
    ``,
    `Branch ${pushedRemote ? `pushed to ${remote}` : 'kept locally'}: \`${branchName}\` (${ahead} commit${ahead === 1 ? '' : 's'} ahead of main).`,
    `Worktree retained for inspection: ${pipeline.worktreePath || '(no worktree)'}.`,
    `Error: ${pipeline.error || phase?.error || 'unknown'}`,
    ``,
    `No PR was opened. A human can review the branch and either complete it or discard it.`,
  ].join("\n");
  Promise.resolve().then(() => issueTracker.addComment(pipeline.issueKey, jiraComment, "runner")).catch(e => {
    console.warn(`[${nowIso()}] preserveBranchOnFailure: Jira comment failed: ${e.message}`);
  });

  jobEmitter.emit("pipeline:branch-preserved", {
    pipelineId: pipeline.pipelineId, issueKey: pipeline.issueKey, branch: branchName, pushedRemote, ahead,
  });
  return { branch: branchName, pushedRemote, ahead };
}

/**
 * Create and start a pipeline for an issue.
 * Returns the pipeline record immediately; execution happens asynchronously.
 */
async function createPipeline(issueKey, pipelineType, options = {}) {
  const definitions = loadPipelineDefinitions();
  const def = definitions[pipelineType];
  if (!def) {
    throw new Error(`Unknown pipeline type: ${pipelineType}`);
  }

  // Reject duplicate: if an active pipeline already exists for this issue, don't create another
  for (const existing of pipelines.values()) {
    if (existing.issueKey === String(issueKey) && !["completed", "failed"].includes(existing.status)) {
      throw new Error(`Pipeline ${existing.pipelineId} already active for ${issueKey} (status: ${existing.status})`);
    }
  }

  // Pre-flight: if the workingDir has uncommitted changes, push them to a safety branch
  // so the user's in-progress work is preserved before the pipeline (or worktree creation)
  // potentially disturbs it. Skipping this check on subtask pipelines whose parent already
  // has a worktree, since they'll share that worktree and never touch the base repo.
  const targetWorkingDir = options.workingDir || DEFAULT_WORKING_DIR;
  const parentHasActiveWorktree = options.parentKey && Array.from(worktrees.values())
    .some(w => w.issueKey === options.parentKey && w.status === "active");
  if (!parentHasActiveWorktree) {
    try {
      const stashResult = stashDirtyWorkingDir(targetWorkingDir, issueKey);
      if (stashResult) {
        console.log(`[${nowIso()}] Pre-flight stash: ${stashResult.fileCount} file(s) preserved on ${stashResult.stashedBranch} for ${issueKey}`);
      }
    } catch (e) {
      console.warn(`[${nowIso()}] Pre-flight stash failed for ${issueKey}: ${e.message} — proceeding anyway`);
    }
  }

  const pipelineId = `pipe_${crypto.randomBytes(4).toString("hex")}`;
  const labels = options.labels || [];

  // Check for agent:* label to override the implementation phase agent
  const agentLabelMap = config.agentLabels || {};
  const agentOverrideLabel = labels.find(l => agentLabelMap[l]);
  const agentOverride = agentOverrideLabel ? agentLabelMap[agentOverrideLabel] : null;

  // Build phases, marking optional ones that fail their condition as skipped
  const phases = def.phases.map((phaseDef, index) => {
    // Override implementation phase agent if subtask has an agent:* label
    let phaseAgent = phaseDef.agent;
    if (agentOverride && phaseDef.name === "implementation") {
      phaseAgent = agentOverride;
      console.log(`[${nowIso()}] Pipeline ${pipelineId}: overriding implementation agent ${phaseDef.agent} → ${agentOverride} (label: ${agentOverrideLabel})`);
    }
    const skip = phaseDef.optional && !evaluatePhaseCondition(phaseDef.condition, labels);
    return {
      index,
      name: phaseDef.name,
      agent: phaseAgent,
      model: phaseDef.model || null,
      team: phaseDef.team || false,
      worktree: phaseDef.worktree || false,
      dynamicGating: phaseDef.dynamicGating || false,
      optional: phaseDef.optional || false,
      condition: phaseDef.condition || null,
      gate: phaseDef.gate || null,
      contextExtract: phaseDef.contextExtract || null,
      status: skip ? "skipped" : "pending",
      jobId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      gateResult: null,
      retryCount: 0,
      fixLoopAttempts: 0,
      fixLoopContext: null,
    };
  });

  const parentKey = options.parentKey || null;

  const pipeline = {
    pipelineId,
    issueKey: String(issueKey),
    parentKey,
    pipelineType,
    description: def.description || "",
    workingDir: options.workingDir || DEFAULT_WORKING_DIR,
    labels,
    callbackUrl: options.callbackUrl || N8N_CALLBACK_URL || null,
    slack: options.slack || null,
    telegram: options.telegram || null,
    requestedProvider: options.provider || null, // Optional provider override for all phases
    status: "running",
    currentPhase: 0,
    phases,
    contextBridgeFile: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeId: null,
    createdAt: nowIso(),
    startedAt: nowIso(),
    completedAt: null,
    error: null,
  };

  pipelines.set(pipelineId, pipeline);
  db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline persist failed: ' + e.message));


  jobEmitter.emit("pipeline:created", {
    pipelineId,
    issueKey,
    pipelineType,
    phases: phases.length,
    createdAt: pipeline.createdAt,
  });

  console.log(`[${nowIso()}] Pipeline ${pipelineId} created: type=${pipelineType} issueKey=${issueKey} phases=${phases.length}`);

  // Defer context bridge seeding until the worktree exists — writing to
  // pipeline.workingDir (base repo on dev) leaks CTX-*.md as untracked files
  // on the dev branch's working tree.
  if (options.initialContext) {
    pipeline.pendingInitialContext = {
      text: options.initialContext.substring(0, 2000),
      agent: options.initialContextAgent || "unknown",
    };
  }

  // Start the first non-skipped phase
  const firstActiveIndex = phases.findIndex(p => p.status === "pending");
  if (firstActiveIndex >= 0) {
    setImmediate(() => executePipelinePhase(pipeline, firstActiveIndex));
  } else {
    // All phases skipped (shouldn't happen but handle gracefully)
    pipeline.status = "completed";
    pipeline.completedAt = nowIso();
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
  
    jobEmitter.emit("pipeline:completed", { pipelineId, issueKey, reason: "all phases skipped" });
  }

  return pipeline;
}

/**
 * Build the full prompt for a pipeline phase, prepending any existing
 * context bridge content so each agent knows what prior phases did.
 */
function buildPipelinePrompt(pipeline, phase, basePrompt) {
  const parts = [];

  // Prepend context bridge if it exists
  // For local models (smaller context windows), compress to compact word limit
  const isLocalAgent = shouldRunLocal({ agent: phase.agent });
  if (pipeline.contextBridgeFile && fs.existsSync(pipeline.contextBridgeFile)) {
    try {
      let bridgeContent = fs.readFileSync(pipeline.contextBridgeFile, "utf8");
      if (bridgeContent.trim()) {
        if (isLocalAgent) {
          // Compress for local models: strip raw excerpts and <details> blocks, enforce word limit
          const compactMax = config.contextBridge?.compactMaxWords || 120;
          bridgeContent = bridgeContent
            .replace(/<details>[\s\S]*?<\/details>/g, "")  // strip collapsed raw blocks
            .replace(/- \*\*Job\*\*:.*$/gm, "")            // strip job IDs (noise for local)
            .replace(/\n{3,}/g, "\n\n");                     // collapse whitespace
          const words = bridgeContent.split(/\s+/).filter(Boolean);
          if (words.length > compactMax) {
            bridgeContent = words.slice(0, compactMax).join(" ") + "\n\n(context truncated for local model)";
          }
          parts.push("## Prior Phase Context (compact)");
        } else {
          parts.push("## Prior Phase Context");
        }
        parts.push(bridgeContent.trim());
        parts.push("");
      }
    } catch {
      // Ignore read errors; agent proceeds without prior context
    }
  }

  // For local models, inject the extraction instruction so the agent focuses on what matters
  if (isLocalAgent) {
    const extractorConfig = config.contextBridge?.phaseExtractors?.[phase.name];
    if (extractorConfig?.instruction) {
      parts.push(`**Context output requirement**: ${extractorConfig.instruction}`);
      parts.push("");
    }
  }

  // Phase-specific instruction header
  parts.push(`## Pipeline Phase: ${phase.name}`);
  parts.push(`You are the ${phase.agent} agent running as phase "${phase.name}" in a ${pipeline.pipelineType} pipeline.`);
  parts.push(`Issue: ${pipeline.issueKey}`);
  parts.push(`Working directory: ${pipeline.workingDir}`);

  // Branch context: tell agents which branch they're reviewing/working on
  // After implementation, the branch stays checked out — QA and reviewers run on it
  if (pipeline.mergedBranch) {
    parts.push(`Branch: ${pipeline.mergedBranch} (already merged to main)`);
  } else {
    // Detect current branch from the working directory
    try {
      const branch = execSync("git branch --show-current", { cwd: pipeline.worktreePath || pipeline.workingDir, encoding: "utf8" }).trim();
      if (branch && branch !== "main" && branch !== "master") {
        parts.push(`Branch: ${branch} (NOT yet merged to main — merge happens only after QA passes)`);
        if (phase.name === "verify") {
          parts.push("You are reviewing code ON THE IMPLEMENTATION BRANCH. If you find issues, they will be fixed on this same branch and you will re-verify.");
        }
      }
    } catch { /* ignore — agent proceeds without branch info */ }
  }
  parts.push("");

  if (phase.gate) {
    if (phase.gate.type === "comment-prefix" && phase.gate.structured && config.gates?.structuredObservations?.enabled !== false) {
      parts.push(
        `## Structured Observations (how this gate is decided)`,
        `Do NOT issue a verdict — the pipeline engine computes the gate verdict from your structured observations and posts the ${phase.gate.prefix} audit comment itself. Your job is to report findings honestly; policy decides.`,
        ``,
        `End your FINAL output with exactly one observations block:`,
        ``,
        `[OBSERVATIONS]`,
        `{ "gate": "${phase.name}", "findings": [{ "severity": "critical|major|minor|info", "title": "<short>", "file": "<path>", "line": <n>, "detail": "<what and why>", "evidence": "<how you know>" }], "acChecks": [{ "id": "AC1", "status": "met|gap|partial", "evidence": "<test or file:line>" }], "summary": "<2-3 sentence prose summary>" }`,
        `[/OBSERVATIONS]`,
        ``,
        `Rules: valid JSON only inside the block; every finding needs a severity you would defend and file:line evidence; every AC check needs evidence; an empty findings array is a legitimate result if you genuinely found nothing. Zero findings on a substantial diff triggers an independent second review — report what you actually found, not what passes.`,
        `Do not also post a "${phase.gate.prefix} VERDICT:" comment — the engine posts the audit comment from your observations. Only if you CANNOT produce the block should you fall back to the legacy "${phase.gate.prefix} VERDICT: <PASS|FAIL|CHANGES-REQUESTED|BLOCKED|NEEDS-CLARIFICATION>" line in your output (the gate fails closed without one of the two).`
      );
    } else if (phase.gate.type === "comment-prefix") {
      parts.push(
        `When done, post a Jira comment starting with: ${phase.gate.prefix}`,
        `CRITICAL: the comment (and your final output) MUST include an explicit verdict line in the form "${phase.gate.prefix} VERDICT: <verdict>".`,
        `Allowed verdicts: PASS / APPROVED (work is acceptable), FAIL / CHANGES-REQUESTED (issues must be fixed), BLOCKED (cannot proceed for an external reason), NEEDS-CLARIFICATION (requirements are ambiguous — a human must decide).`,
        `The pipeline gate parses this verdict and fails closed if it is missing. Never omit it.`
      );
    } else if (phase.gate.type === "quality-gate") {
      parts.push("Your implementation must pass the quality gate (type-check, lint, test).");
    } else if (phase.gate.type === "file-exists") {
      parts.push(`When done, ensure file exists: ${phase.gate.file}`);
    }
    parts.push("");
  }

  // Structured blackboard: prior phases' observations flow forward as facts
  // alongside the prose context bridge (records for engine-checkable facts,
  // prose for nuance — neither replaces the other).
  const priorObs = (pipeline.phases || [])
    .filter(p => p.status === "completed" && p.observations?.findings?.length >= 0 && (p.observations.findings.length > 0 || (p.observations.acChecks || []).length > 0))
    .map(p => ({
      phase: p.name,
      findings: p.observations.findings.slice(0, 15),
      acChecks: (p.observations.acChecks || []).slice(0, 20),
    }));
  if (priorObs.length > 0) {
    let obsJson = JSON.stringify(priorObs, null, 1);
    if (obsJson.length > 4000) obsJson = obsJson.slice(0, 4000) + "\n…(truncated)";
    parts.push("## Prior Phase Observations (structured)");
    parts.push("Findings and AC checks recorded by earlier phases of this pipeline:");
    parts.push("```json", obsJson, "```", "");
  }

  // Fix-loop: inject error context from previous failed attempt
  if (phase.fixLoopContext) {
    const ctx = phase.fixLoopContext;
    parts.push("## ⚠️ Fix-Loop: Previous Attempt Failed");
    const reviewPhaseNames = { "verify": "QA verification", "code-review": "Code review", "security-review": "Security review" };
    const source = ctx.sourcePhase && reviewPhaseNames[ctx.sourcePhase]
      ? `${reviewPhaseNames[ctx.sourcePhase]} found issues. This is fix-loop attempt ${ctx.attempt}. Fix the findings on this branch — do NOT create a new branch.`
      : `This is fix-loop attempt ${ctx.attempt}. Your previous implementation failed the quality gate.`;
    parts.push(source);
    parts.push("");
    if (ctx.failedCheck) parts.push(`**Failed check:** ${ctx.failedCheck}`);
    if (ctx.failedCommand) parts.push(`**Command:** ${ctx.failedCommand}`);
    if (ctx.failureOutput) {
      parts.push("");
      parts.push("**Error output:**");
      parts.push("```");
      parts.push(ctx.failureOutput);
      parts.push("```");
    }
    parts.push("");
    parts.push("You MUST fix these errors before proceeding. Read the error output carefully, identify the root cause, and apply a targeted fix. Do not rewrite from scratch — fix the specific issues.");
    parts.push("");
  }

  parts.push("## Your Task");
  parts.push(basePrompt);

  return parts.join("\n");
}

/**
 * Execute a single pipeline phase by creating a standard job.
 * The job is tagged with pipelineId and pipelinePhase for tracking.
 */
async function executePipelinePhase(pipeline, phaseIndex) {
  const phase = pipeline.phases[phaseIndex];
  if (!phase) return;

  // Skip phases marked as skipped
  if (phase.status === "skipped") {
    return advancePipeline(pipeline);
  }

  pipeline.currentPhase = phaseIndex;
  phase.status = "running";
  phase.startedAt = nowIso();

  // Dependency gating: before creating a worktree, verify all blockers' branches are merged to main
  if (phase.worktree && config.dependencyGating?.enabled && !pipeline.worktreePath) {
    const blockers = await getUnmergedBlockers(pipeline.issueKey, pipeline.workingDir);
    if (blockers.length > 0) {
      const blockerStr = blockers.map(b => `${b.key} (${b.detail})`).join(", ");
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} BLOCKED: waiting on ${blockerStr}`);

      phase.status = "blocked";
      phase.blockedBy = blockers;
      phase.blockedAt = nowIso();
      pipeline.status = "blocked";
    

      jobEmitter.emit("pipeline:blocked", {
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        phase: phase.name,
        blockedBy: blockers,
      });
      return; // tickDependencyChecker will resume when blockers resolve
    }
  }

  // Worktree isolation: create worktree when first code-modifying phase runs
  // Subtasks share a worktree with their parent story so all changes land on one branch
  if (phase.worktree && config.worktrees?.enabled && !pipeline.worktreePath) {
    try {
      const worktreeKey = pipeline.parentKey || pipeline.issueKey;
      const branchName = `${worktreeKey}-auto`;
      const wt = createWorktree(pipeline.workingDir, worktreeKey, branchName);
      pipeline.worktreePath = wt.path;
      pipeline.worktreeBranch = branchName;
      pipeline.worktreeId = wt.id;
      // Link worktree to pipeline
      const wtRecord = worktrees.get(wt.id);
      if (wtRecord) wtRecord.pipelineId = pipeline.pipelineId;
      // Run product-specific install/generate so the implementer doesn't fail
      // on missing node_modules or ungenerated Prisma client (was #1 cause of
      // EOS pipelines stuck in fix-loop-forever on type-check).
      try {
        const setup = setupWorktree(wt.path, pipeline.workingDir);
        pipeline.worktreeSetup = setup;
      } catch (e) {
        console.error(`[${nowIso()}] Worktree setup error (non-fatal): ${e.message}`);
      }

      // Flush any deferred initial-context seed into the worktree.
      if (pipeline.pendingInitialContext) {
        try {
          const seedDir = path.join(pipeline.worktreePath, "docs", "sdlc", "context");
          fs.mkdirSync(seedDir, { recursive: true });
          const seedFile = path.join(seedDir, `CTX-${pipeline.issueKey}.md`);
          const header = `# Context Bridge: ${pipeline.issueKey}\n> Pipeline: ${pipeline.pipelineType}\n> Created: ${nowIso()}\n\n`;
          const { text, agent } = pipeline.pendingInitialContext;
          const section = `## Phase: triage (pre-pipeline)\n- **Agent**: ${agent}\n- **Completed**: ${nowIso()}\n\n### Triage Output\n${text}\n\n`;
          fs.writeFileSync(seedFile, header + section, "utf8");
          pipeline.contextBridgeFile = seedFile;
          console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} context bridge seeded with ${agent} output (worktree)`);
        } catch (e) {
          console.error(`[${nowIso()}] Failed to seed context bridge for pipeline ${pipeline.pipelineId}: ${e.message}`);
        }
        delete pipeline.pendingInitialContext;
      }

    } catch (e) {
      console.error(`[${nowIso()}] Worktree creation failed for ${pipeline.issueKey}: ${e.message}`);
      // Fall through — pipeline will use base workingDir
    }
  }

  // If pipeline has a worktree, use it as workingDir for code-touching phases
  const phaseWorkingDir = pipeline.worktreePath || pipeline.workingDir;

  const basePrompt = `You are running as part of the ${pipeline.pipelineType} pipeline for Jira issue ${pipeline.issueKey}.\n` +
    `Phase: ${phase.name}\nAgent: ${phase.agent}\n\n` +
    `Fetch the full Jira issue ${pipeline.issueKey} via MCP tools for complete context. ` +
    `ALSO fetch every subtask of ${pipeline.issueKey} and read each one in full — subtasks are usually more prescriptive than the parent and define the actual work that needs doing.\n\n` +
    `If open subtasks exist that prescribe the work for this phase, do NOT do the work yourself. Instead, dispatch those subtasks to the appropriate agents (via [CREATE-SUBTASKS] routing labels if they need rerouting, or by ensuring the existing agent labels will pick them up) and let them execute. Your job in that case is to coordinate, not to implement.\n\n` +
    `Only do the work directly if there are no relevant subtasks, or the subtasks are already done/closed and the parent still requires action.`;

  const prompt = buildPipelinePrompt(pipeline, phase, basePrompt);

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);
  const metaFile = path.join(LOG_DIR, `${jobId}.json`);

  const job = {
    jobId,
    mode: "delivery",
    issueKey: pipeline.issueKey,
    summary: `[Pipeline:${pipeline.pipelineType}] Phase: ${phase.name}`,
    description: prompt,
    workingDir: phaseWorkingDir,
    agent: phase.agent,
    model: phase.model || null,
    requestedProvider: phase.provider || pipeline.requestedProvider || null, // Provider override (claude/zai)
    selectedModel: null,

    status: "queued",
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,

    logFile,
    metaFile,
    processPid: null,

    error: null,
    lastError: null,
    parsedOutput: null,

    retryCount: 0,
    maxRetries: MAX_RETRIES,
    retryAt: null,

    qualityGateRetryCount: 0,
    qualityGateFailure: null,
    qualityGate: null,

    usage: null,
    callbackUrl: null, // Pipeline manages callbacks; phase jobs don't call back independently
    slack: null,
    telegram: null,
    batchId: null,
    source: { workflow: "pipeline", pipeline: pipeline.pipelineType, phase: phase.name },

    // Pipeline metadata
    pipelineId: pipeline.pipelineId,
    pipelinePhase: phase.name,
    pipelinePhaseIndex: phaseIndex,
    pipelineGateType: phase.gate?.type || null,
    worktreeId: pipeline.worktreeId || null,

    parentKey: null,
    subtaskFiles: [],
    subtaskDepth: 0,
    isSubtask: false,
    teamSessionId: null,
    teamRole: null,
    teammates: [],
  };

  // Set up Agent Teams if phase has team:true
  if (phase.team && config.teams?.enabled && config.teams.teamLeads?.[job.agent]) {
    job.teamSessionId = `team-${jobId}`;
    job.teamRole = "lead";
    job.teammates = config.teams.teamLeads[job.agent].teammates || [];
  }

  jobs.set(jobId, job);
  db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
  fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");

  phase.jobId = jobId;


  jobEmitter.emit("pipeline:phase-started", {
    pipelineId: pipeline.pipelineId,
    issueKey: pipeline.issueKey,
    phase: phase.name,
    phaseIndex,
    agent: phase.agent,
    jobId,
    startedAt: phase.startedAt,
  });

  console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} starting: jobId=${jobId} agent=${phase.agent}`);

  enqueue(jobId);
}

/**
 * Evaluate the gate condition for a completed phase.
 * Returns { passed: boolean, reason: string, verdict?: string|null }
 */
function evaluateGate(pipeline, phase, job) {
  const gate = phase.gate;
  if (!gate) {
    return { passed: true, reason: "no gate defined" };
  }

  if (gate.type === "comment-prefix") {
    const gatesCfg = config.gates || {};

    // Structured observations path: when the gate opts in (gate.structured)
    // and the agent submitted observations, the ENGINE computes the verdict
    // via the thin policy layer — the agent does not get a vote. Dual-run:
    // with no observations submitted, fall through to legacy prefix parsing
    // unless structuredObservations.require is set (fail closed).
    const structCfg = gatesCfg.structuredObservations || {};
    if (gate.structured && structCfg.enabled !== false) {
      if (job.observations) {
        const product = resolveProduct(pipeline.workingDir);
        const policy = product?.observationPolicy || structCfg.policy || {};
        const policyResult = evaluateObservationPolicy(job.observations, policy);
        return {
          passed: policyResult.passed,
          verdict: policyResult.verdict,
          structured: true,
          policyResult,
          reason: policyResult.passed
            ? `Engine-computed PASS from ${job.observations.findings.length} finding(s) within policy floors`
            : `Engine-computed ${policyResult.verdict}: ${policyResult.reasons.join("; ")}`,
        };
      }
      if (structCfg.require) {
        return {
          passed: false,
          verdict: null,
          reason: `Gate requires structured observations but none were submitted (POST /jobs/:id/observations or .meshwork/observations.json). Gates fail closed.`,
        };
      }
      // fall through to legacy prefix parsing (dual-run)
    }

    // Check job output for the required prefix + an explicit verdict
    const result = job.parsedOutput?.result || "";
    const stdout = job.stdout || "";
    const searchText = result + stdout;
    const { found, verdict } = extractGateVerdict(searchText, gate.prefix);

    if (found) {
      if (verdict && GATE_NEGATIVE_VERDICTS.includes(verdict)) {
        return { passed: false, verdict, reason: `Found prefix "${gate.prefix}" but verdict is ${verdict}` };
      }
      if (verdict && GATE_POSITIVE_VERDICTS.includes(verdict)) {
        return { passed: true, verdict, reason: `Found prefix "${gate.prefix}" with verdict ${verdict}` };
      }
      // Prefix present but no recognizable verdict — fail closed unless disabled
      if (gatesCfg.requireVerdict === false) {
        return { passed: true, verdict: null, reason: `Found prefix "${gate.prefix}" in output (verdict enforcement disabled)` };
      }
      return {
        passed: false,
        verdict: null,
        reason: `Found prefix "${gate.prefix}" but no recognizable verdict — expected e.g. "${gate.prefix} VERDICT: PASS". Gates fail closed.`,
      };
    }

    // Prefix missing entirely — fail closed. The old behaviour (trust any
    // succeeded job) made gates decorative; it survives only as an explicit
    // legacy opt-in.
    if (gatesCfg.legacyTrustSucceededJob && job.status === "succeeded") {
      return { passed: true, verdict: null, reason: `Job succeeded; assuming "${gate.prefix}" posted to Jira (gates.legacyTrustSucceededJob)` };
    }
    return { passed: false, verdict: null, reason: `Required prefix "${gate.prefix}" not found in output` };
  }

  if (gate.type === "quality-gate") {
    if (job.qualityGate?.skipped) {
      return { passed: true, reason: "Quality gate skipped for this agent" };
    }
    if (job.qualityGate?.passed) {
      return { passed: true, reason: "Quality gate passed" };
    }
    if (job.status === "quality-gate-failed") {
      return { passed: false, reason: `Quality gate failed: ${job.error}` };
    }
    // Succeeded without gate data = pass
    if (job.status === "succeeded") {
      return { passed: true, reason: "Job succeeded (no quality gate configured for this agent)" };
    }
    return { passed: false, reason: "Quality gate did not pass" };
  }

  if (gate.type === "file-exists") {
    const filePath = path.join(pipeline.workingDir, gate.file);
    if (fs.existsSync(filePath)) {
      return { passed: true, reason: `File exists: ${gate.file}` };
    }
    return { passed: false, reason: `Required file not found: ${gate.file}` };
  }

  return { passed: true, reason: `Unknown gate type "${gate.type}" - defaulting to pass` };
}

/**
 * A phase agent flagged ambiguous requirements (verdict NEEDS-CLARIFICATION).
 * Retrying or fix-looping cannot resolve ambiguity — halt the pipeline,
 * preserve work, and emit a dedicated event + callback so N8N routes the
 * question to a human (PM / approval channel) instead of it shipping on a
 * best-guess interpretation.
 */
function handlePipelineNeedsClarification(pipeline, phase, phaseIndex, job, gateResult) {
  phase.status = "failed";
  phase.completedAt = nowIso();
  phase.error = `NEEDS-CLARIFICATION: ${gateResult.reason}`;

  pipeline.status = "failed";
  pipeline.needsClarification = true;
  pipeline.completedAt = nowIso();
  pipeline.error = `Phase "${phase.name}" needs clarification: ${gateResult.reason}`;
  db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));

  // Surface the agent's actual question: take the text following the verdict
  const outputText = (job.parsedOutput?.result || "") + "\n" + (job.stdout || "");
  const qIdx = outputText.indexOf("NEEDS-CLARIFICATION");
  const clarificationQuestion = qIdx >= 0
    ? outputText.substring(qIdx, Math.min(qIdx + 1200, outputText.length)).trim()
    : gateResult.reason;

  console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} NEEDS-CLARIFICATION at phase ${phase.name} — routing to human review`);

  // Preserve any partial work on the worktree branch
  try {
    const preserved = preserveBranchOnFailure(pipeline, phase);
    if (preserved) {
      pipeline.preservedBranch = preserved.branch;
      pipeline.preservedRemote = preserved.pushedRemote;
    }
  } catch (e) {
    console.warn(`[${nowIso()}] preserveBranchOnFailure (needs-clarification) error: ${e.message}`);
  }

  jobEmitter.emit("pipeline:needs-clarification", {
    pipelineId: pipeline.pipelineId,
    issueKey: pipeline.issueKey,
    pipelineType: pipeline.pipelineType,
    phase: phase.name,
    phaseIndex,
    agent: phase.agent,
    question: clarificationQuestion,
    completedAt: pipeline.completedAt,
  });

  if (pipeline.callbackUrl) {
    const payload = {
      event: "pipeline:needs-clarification",
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      pipelineType: pipeline.pipelineType,
      phase: phase.name,
      agent: phase.agent,
      question: clarificationQuestion,
      completedAt: pipeline.completedAt,
      slack: pipeline.slack || null,
      telegram: pipeline.telegram || null,
      message: `Pipeline ${pipeline.issueKey} paused at phase "${phase.name}": the ${phase.agent} agent needs clarification before work can continue.\n\n${clarificationQuestion}`,
    };
    const mockJob = { jobId: pipeline.pipelineId, logFile: path.join(LOG_DIR, `${pipeline.pipelineId}.log`) };
    if (!fs.existsSync(mockJob.logFile)) {
      fs.writeFileSync(mockJob.logFile, `[${nowIso()}] Pipeline needs clarification\n`, "utf8");
    }
    sendCallbackWithRetry(pipeline.callbackUrl, payload, mockJob).catch(e => {
      console.error(`[${nowIso()}] needs-clarification callback failed: ${e.message}`);
    });
  }
}

/**
 * Extract a structured summary from phase output using phase-specific extractors.
 * Each phase type defines which sections to extract (decisions, artifacts, risks, etc).
 * Falls back to a truncated raw summary if no extractor matches.
 */
function extractStructuredSummary(phaseName, rawOutput, maxWords) {
  const extractorConfig = config.contextBridge?.phaseExtractors?.[phaseName];
  const words = rawOutput.split(/\s+/).filter(Boolean);

  if (!extractorConfig || !extractorConfig.sections) {
    // Fallback: truncated raw output
    const truncated = words.slice(0, maxWords).join(" ") + (words.length > maxWords ? "..." : "");
    return { type: "raw", sections: {}, raw: truncated };
  }

  const sections = {};
  const sectionDefs = extractorConfig.sections;

  // Extract file paths mentioned (common across phases)
  if (sectionDefs.includes("filesChanged")) {
    const filePaths = [];
    const filePatterns = [
      /(?:created?|modified?|updated?|wrote|changed)\s+[`"]?([a-zA-Z0-9_/.-]+\.[a-z]{1,5})[`"]?/gi,
      /###\s+([a-zA-Z0-9_/.-]+\.[a-z]{1,5})/g,
      /(?:^|\n)\s*[-*]\s+[`"]?([a-zA-Z0-9_/.-]+\.[a-z]{1,5})[`"]?/g,
    ];
    for (const pat of filePatterns) {
      let m;
      while ((m = pat.exec(rawOutput))) {
        const fp = m[1].trim();
        if (fp && !filePaths.includes(fp) && !fp.startsWith("http")) filePaths.push(fp);
      }
    }
    if (filePaths.length) sections.filesChanged = filePaths.slice(0, 30);
  }

  // Extract acceptance criteria (numbered lists)
  if (sectionDefs.includes("acceptanceCriteria")) {
    const acMatch = rawOutput.match(/(?:acceptance criteria|ACs?)[\s:]*\n((?:\s*\d+[.)]\s+.+\n?)+)/i);
    if (acMatch) sections.acceptanceCriteria = acMatch[1].trim();
  }

  // Extract verdict/decision blocks
  if (sectionDefs.includes("verdict")) {
    const verdictMatch = rawOutput.match(/(?:verdict|decision|recommendation|conclusion)[\s:]*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
    if (verdictMatch) sections.verdict = verdictMatch[1].trim().substring(0, 500);
  }

  // Extract decisions (look for decision markers, ADR format, or "decided" language)
  if (sectionDefs.includes("decisions")) {
    const decisionLines = [];
    const lines = rawOutput.split("\n");
    for (const line of lines) {
      if (/(?:decided|decision|chose|selected|approach|strategy)[:]/i.test(line) ||
          /^[-*]\s*\*?\*?(?:Decision|Approach|Strategy|Choice)/i.test(line)) {
        decisionLines.push(line.trim());
      }
    }
    if (decisionLines.length) sections.decisions = decisionLines.slice(0, 10).join("\n");
  }

  // Extract selected phases (from triage output)
  if (sectionDefs.includes("selectedPhases")) {
    const phaseMatch = rawOutput.match(/(?:selected phases|pipeline phases|phases to run|skipping)[\s:]*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
    if (phaseMatch) sections.selectedPhases = phaseMatch[1].trim().substring(0, 300);
  }

  // Extract risks/blockers
  if (sectionDefs.includes("risks")) {
    const riskLines = [];
    const lines = rawOutput.split("\n");
    let inRiskSection = false;
    for (const line of lines) {
      if (/(?:risks?|blockers?|concerns?|warnings?)[\s:]/i.test(line) && /^#+\s|^\*\*/.test(line)) {
        inRiskSection = true;
        continue;
      }
      if (inRiskSection) {
        if (/^#+\s/.test(line) || line.trim() === "") { inRiskSection = false; continue; }
        riskLines.push(line.trim());
      }
    }
    if (riskLines.length) sections.risks = riskLines.slice(0, 8).join("\n");
  }

  // Extract test results
  if (sectionDefs.includes("testResults")) {
    const testMatch = rawOutput.match(/(\d+)\s*(?:tests?\s+)?pass(?:ed|ing)?/i);
    const failMatch = rawOutput.match(/(\d+)\s*(?:tests?\s+)?fail(?:ed|ing)?/i);
    if (testMatch || failMatch) {
      sections.testResults = `Passed: ${testMatch?.[1] || "?"}, Failed: ${failMatch?.[1] || "0"}`;
    }
  }

  // Extract vulnerabilities
  if (sectionDefs.includes("vulnerabilities")) {
    const vulnLines = [];
    const lines = rawOutput.split("\n");
    for (const line of lines) {
      if (/(?:vulnerabilit|CVE-|CWE-|CVSS|injection|XSS|CSRF|exposure)/i.test(line)) {
        vulnLines.push(line.trim());
      }
    }
    if (vulnLines.length) sections.vulnerabilities = vulnLines.slice(0, 10).join("\n");
  }

  // Handoff notes: look for explicit handoff or "next phase" language
  if (sectionDefs.includes("handoff")) {
    const handoffMatch = rawOutput.match(/(?:handoff|hand-off|next phase|for (?:the )?(?:implementer|reviewer|architect|qa|uat)|notes? for)[\s:]*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
    if (handoffMatch) sections.handoff = handoffMatch[1].trim().substring(0, 400);
  }

  // Build a compact text representation
  const hasSections = Object.keys(sections).length > 0;
  // Also include a truncated raw as fallback context
  const rawFallback = words.slice(0, Math.floor(maxWords / 2)).join(" ") + (words.length > maxWords / 2 ? "..." : "");

  return { type: hasSections ? "structured" : "raw", sections, raw: hasSections ? rawFallback : words.slice(0, maxWords).join(" ") + (words.length > maxWords ? "..." : "") };
}

/**
 * Format a structured summary into markdown for the context bridge file.
 */
function formatContextSection(phaseName, agent, status, jobId, extracted) {
  const lines = [
    `\n## Phase: ${phaseName}`,
    `- **Agent**: ${agent}`,
    `- **Status**: ${status}`,
    `- **Completed**: ${nowIso()}`,
    `- **Job**: ${jobId}`,
    "",
  ];

  if (extracted.type === "structured") {
    const s = extracted.sections;

    if (s.decisions) {
      lines.push("### Decisions");
      lines.push(s.decisions);
      lines.push("");
    }
    if (s.selectedPhases) {
      lines.push("### Selected Phases");
      lines.push(s.selectedPhases);
      lines.push("");
    }
    if (s.acceptanceCriteria) {
      lines.push("### Acceptance Criteria");
      lines.push(s.acceptanceCriteria);
      lines.push("");
    }
    if (s.verdict) {
      lines.push("### Verdict");
      lines.push(s.verdict);
      lines.push("");
    }
    if (s.filesChanged && s.filesChanged.length) {
      lines.push("### Files Changed");
      for (const f of s.filesChanged) lines.push(`- \`${f}\``);
      lines.push("");
    }
    if (s.testResults) {
      lines.push("### Test Results");
      lines.push(s.testResults);
      lines.push("");
    }
    if (s.vulnerabilities) {
      lines.push("### Vulnerabilities");
      lines.push(s.vulnerabilities);
      lines.push("");
    }
    if (s.risks) {
      lines.push("### Risks / Blockers");
      lines.push(s.risks);
      lines.push("");
    }
    if (s.handoff) {
      lines.push("### Handoff → Next Phase");
      lines.push(s.handoff);
      lines.push("");
    }

    // Compact raw context for additional signal
    if (extracted.raw) {
      lines.push("<details><summary>Raw excerpt</summary>");
      lines.push("");
      lines.push(extracted.raw);
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  } else {
    lines.push("### Summary");
    lines.push(extracted.raw || "(no output summary available)");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Update the context bridge file with a structured summary of the completed phase.
 * Creates docs/sdlc/context/CTX-{issueKey}.md in the working directory.
 * Uses phase-specific extractors to pull out decisions, artifacts, risks, and
 * handoff notes — giving downstream agents (especially local models) a compressed,
 * relevant prompt instead of a raw output dump.
 */
function updateContextBridge(pipeline, phase, job) {
  try {
    // Write into the worktree so CTX-*.md doesn't leak as untracked file on
    // dev. Falls back to the base repo only when no worktree was created
    // (e.g. non-code phases before the first worktree-bearing phase).
    const ctxRoot = pipeline.worktreePath || pipeline.workingDir;
    const ctxDir = path.join(ctxRoot, "docs", "sdlc", "context");
    fs.mkdirSync(ctxDir, { recursive: true });

    const ctxFile = path.join(ctxDir, `CTX-${pipeline.issueKey}.md`);
    pipeline.contextBridgeFile = ctxFile;

    const maxWords = config.contextBridge?.maxSummaryWords || 300;
    const result = job.parsedOutput?.result || "";

    // Extract structured summary based on phase type
    const extracted = extractStructuredSummary(phase.name, result, maxWords);
    const section = formatContextSection(phase.name, phase.agent, job.status, job.jobId, extracted);

    // Create or append. If a deferred initial-context seed survived (worktree
    // creation failed or was disabled), include it as the first section so
    // the seed isn't lost.
    if (!fs.existsSync(ctxFile)) {
      const header = [
        `# Context Bridge: ${pipeline.issueKey}`,
        `> Pipeline: ${pipeline.pipelineType}`,
        `> Created: ${nowIso()}`,
        "",
      ].join("\n");
      let seedSection = "";
      if (pipeline.pendingInitialContext) {
        const { text, agent } = pipeline.pendingInitialContext;
        seedSection = `## Phase: triage (pre-pipeline)\n- **Agent**: ${agent}\n- **Completed**: ${nowIso()}\n\n### Triage Output\n${text}\n\n`;
        delete pipeline.pendingInitialContext;
      }
      fs.writeFileSync(ctxFile, header + seedSection + section, "utf8");
    } else {
      fs.appendFileSync(ctxFile, section, "utf8");
    }

    const sectionCount = Object.keys(extracted.sections).length;
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} context bridge updated: ${ctxFile} (${extracted.type}, ${sectionCount} sections)`);
  } catch (e) {
    console.error(`[${nowIso()}] Failed to update context bridge for pipeline ${pipeline.pipelineId}: ${e.message}`);
  }
}

/**
 * Merge a non-worktree pipeline's feature branch into the integration branch (dev).
 * Returns { branch, mergeBranch, devSha, mode } or null when no branch is found.
 * Throws on conflict (with .conflictContext) or push failure.
 */
function autoMergePipelineBranch(pipeline) {
  return mergePipelineBranchIntoDev(pipeline);
}

/**
 * Dispatch an agent job to resolve a merge conflict.
 * The agent checks out the integration branch (dev), merges the feature branch,
 * resolves conflicts with full context, commits the merge, and pushes dev.
 */
function dispatchMergeConflictAgent(pipeline, conflictContext) {
  const { branchName, mainLog, branchLog, diffStat, issueKey } = conflictContext;
  const mergeBranch = conflictContext.mergeBranch || resolveMergeBranch(pipeline.workingDir) || "dev";
  const remote = resolveRemoteName(pipeline.workingDir);

  const prompt = [
    `You are resolving a merge conflict for pipeline ${pipeline.pipelineId} (${issueKey}).`,
    ``,
    `Branch \`${branchName}\` needs to be merged into \`${mergeBranch}\` but has conflicts.`,
    ``,
    `## Recent commits on ${mergeBranch} (since branch diverged):`,
    mainLog || "(none)",
    ``,
    `## Commits on ${branchName}:`,
    branchLog || "(none)",
    ``,
    `## Files changed on the feature branch:`,
    diffStat || "(none)",
    ``,
    `## Your task:`,
    `1. Run \`git fetch ${remote} && git checkout ${mergeBranch} && git pull --ff-only ${remote} ${mergeBranch}\` to ensure ${mergeBranch} is up to date.`,
    `2. Run \`git merge ${branchName} --no-ff\` — this will produce conflicts.`,
    `3. For each conflicted file, read both versions carefully. Understand what ${mergeBranch} changed and what the feature branch changed. Preserve ALL meaningful work from both sides.`,
    `4. If both sides changed the same code, integrate both changes. If they're truly incompatible, prefer the feature branch change but preserve any ${mergeBranch}-side additions.`,
    `5. After resolving all conflicts, run the build/typecheck to verify nothing is broken.`,
    `6. Commit with message: \`Merge ${branchName} into ${mergeBranch} (agent-resolved conflicts)\``,
    `7. Push to remote: \`git push ${remote} ${mergeBranch}\``,
    `8. Delete the merged branch locally and on the remote: \`git branch -d ${branchName} && git push ${remote} --delete ${branchName}\``,
    ``,
    `IMPORTANT: Do NOT use \`-X theirs\` or \`-X ours\`. Resolve each conflict manually by reading the code and understanding both changes. Do NOT push to main — main is reserved for human-driven PRs from ${mergeBranch}.`,
  ].join("\n");

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);
  const metaFile = path.join(LOG_DIR, `${jobId}.json`);
  const job = {
    jobId,
    status: "queued",
    mode: "agent",
    agent: "engineer-implementer",
    prompt,
    context: "",
    workingDir: pipeline.workingDir,
    issueKey: issueKey,
    model: config.routing?.agentToModel?.["engineer-implementer"] || "sonnet",
    selectedModel: null,
    requestedProvider: null,
    callbackUrl: config.callbackUrl || null,
    logFile,
    metaFile,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    pid: null,
    output: null,
    error: null,
    retryCount: 0,
    maxRetries: config.maxRetries || 3,
    source: `pipeline:${pipeline.pipelineId}:merge-conflict`,
    pipelineId: pipeline.pipelineId,
    telegram: pipeline.telegram || null,
  };

  jobs.set(jobId, job);
  db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));

  // Stash the conflict branch + target so finalizeMergeConflictResolution can verify
  // the resolver actually pushed dev when its job completes. Without this metadata,
  // the post-resolution hook has no way to know which branch the resolver was assigned to.
  pipeline.conflictBranch = branchName;
  pipeline.conflictMergeBranch = mergeBranch;
  pipeline.conflictResolverJobId = jobId;
  db.pipelines.set(pipeline).catch(e => console.error(`[db] pipeline conflict stash failed: ${e.message}`));

  console.log(`[${nowIso()}] Dispatched merge-conflict agent job ${jobId} for ${branchName} → main (pipeline ${pipeline.pipelineId})`);

  // Notify via Telegram
  const telegramChatId = pipeline.telegram?.chatId || config.telegramChatEngineering;
  if (telegramChatId) {
    sendTelegramMessage(telegramChatId,
      `⚠️ *Merge Conflict* — ${issueKey}\n\nBranch \`${branchName}\` conflicts with \`${mergeBranch}\`.\nDispatched agent job \`${jobId}\` to resolve.\n\nConflicting files:\n\`\`\`\n${diffStat.substring(0, 500)}\n\`\`\``
    ).catch(() => {});
  }

  enqueue(jobId);
  return jobId;
}

/**
 * Called when a merge-conflict resolver job succeeds. Verifies the resolver
 * actually pushed dev (by checking the merge commit + branch deletion), then
 * flips pipeline.merged so the upstream pipeline's Jira issue auto-transitions
 * to Done. The dependency checker (tickDependencyChecker) re-checks blockers
 * against pipeline records, so this is what unblocks downstream pipelines.
 *
 * Returns true if the resolution was verified and the pipeline was finalised.
 */
async function finalizeMergeConflictResolution(pipeline, job) {
  const { execSync } = require("child_process");
  const branchName = pipeline.conflictBranch;
  const mergeBranch = pipeline.conflictMergeBranch || resolveMergeBranch(pipeline.workingDir) || "dev";
  const remote = resolveRemoteName(pipeline.workingDir);
  const issueKey = pipeline.issueKey;

  if (!branchName) {
    console.warn(`[${nowIso()}] finalizeMergeConflictResolution: no conflictBranch on pipeline ${pipeline.pipelineId}, skipping`);
    return false;
  }

  // Refresh local refs so we see what the resolver pushed
  try {
    execSync(`git fetch ${remote} --prune`, { cwd: pipeline.workingDir, encoding: "utf8", timeout: 30000, stdio: "pipe" });
  } catch (e) {
    console.warn(`[${nowIso()}] finalizeMergeConflictResolution: fetch failed for ${pipeline.workingDir}: ${e.message}`);
  }

  // 1. Branch should be gone from remote (resolver deletes it after merging)
  let branchGone = true;
  try {
    const out = execSync(`git ls-remote --heads ${remote} ${branchName}`, { cwd: pipeline.workingDir, encoding: "utf8", timeout: 15000, stdio: "pipe" }).trim();
    branchGone = !out;
  } catch (_) { /* assume gone */ }

  // 2. Dev should contain a commit referencing the issue key
  let devHasMerge = false;
  let devSha = null;
  try {
    const log = execSync(`git log --oneline -10 ${remote}/${mergeBranch}`, { cwd: pipeline.workingDir, encoding: "utf8", timeout: 15000, stdio: "pipe" });
    if (issueKey && log.includes(issueKey)) devHasMerge = true;
    if (!devHasMerge && log.toLowerCase().includes(branchName.toLowerCase())) devHasMerge = true;
    devSha = execSync(`git rev-parse ${remote}/${mergeBranch}`, { cwd: pipeline.workingDir, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
  } catch (e) {
    console.warn(`[${nowIso()}] finalizeMergeConflictResolution: dev log check failed for ${pipeline.workingDir}: ${e.message}`);
  }

  if (!devHasMerge && !branchGone) {
    console.warn(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merge-conflict resolver job ${job.jobId} reported success but dev shows no merge AND branch ${branchName} still on remote — leaving mergeError in place`);
    return false;
  }

  if (!devHasMerge && branchGone) {
    // Branch deleted but no commit referencing the issue — likely a no-op merge.
    // Still treat as merged (the resolver may have rebased or fast-forwarded).
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merge-conflict resolver: branch ${branchName} deleted, dev log doesn't reference ${issueKey} — accepting as merged anyway`);
  }

  pipeline.merged = true;
  pipeline.mergedBranch = branchName;
  pipeline.mergedTo = mergeBranch;
  pipeline.mergedSha = devSha;
  pipeline.mergeError = null;
  pipeline.conflictResolvedAt = nowIso();
  pipeline.conflictResolverJobId = job.jobId;
  db.pipelines.set(pipeline).catch(e => console.error(`[db] pipeline post-resolution update failed: ${e.message}`));

  console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merge-conflict resolved (${branchName} → ${mergeBranch}@${(devSha||"").slice(0,8)}) by job ${job.jobId} — flipping to merged`);

  jobEmitter.emit("pipeline:merge-conflict-resolved", {
    pipelineId: pipeline.pipelineId,
    issueKey: pipeline.issueKey,
    branch: branchName,
    mergeBranch,
    devSha,
    resolverJobId: job.jobId,
  });

  // Telegram ping so Mark sees the unblock without checking the dashboard
  const telegramChatId = pipeline.telegram?.chatId || config.telegramChatEngineering;
  if (telegramChatId) {
    sendTelegramMessage(telegramChatId,
      `✅ *Merge resolved* — ${pipeline.issueKey}\n\nBranch \`${branchName}\` merged into \`${mergeBranch}\` by resolver job \`${job.jobId}\`.\nPipeline ${pipeline.pipelineId} now flagged merged — Jira auto-transition pending.`
    ).catch(() => {});
  }

  // Auto-transition Jira (same guards as advancePipeline: subtasks block, FAIL phases block)
  const anyPhaseFailed = pipeline.phases?.some(ph => ph.gateResult && ph.gateResult.passed === false);
  if (anyPhaseFailed) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} skipping post-resolution auto-transition: phase FAIL verdict present`);
  } else {
    autoTransitionIssueToDone(pipeline).catch(e => {
      console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} post-resolution auto-transition failed: ${e.message}`);
    });
    if (pipeline.parentKey) {
      setTimeout(() => {
        checkAndTransitionParent(pipeline.parentKey).catch(e => {
          console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} post-resolution parent transition failed: ${e.message}`);
        });
      }, 5000);
    }
  }

  return true;
}

/**
 * Advance the pipeline to the next non-skipped phase.
 * If no more phases, mark pipeline as completed.
 */
async function advancePipeline(pipeline) {
  // Defensive: if any phase is still running, do NOT advance or mark the
  // pipeline complete. The phase that's still running will call advancePipeline
  // again when it finishes. This prevents a stale callback from declaring the
  // pipeline done while real work is in flight.
  const stillRunning = pipeline.phases.find(p => p.status === "running");
  if (stillRunning) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} advancePipeline deferred: phase ${stillRunning.name} still running`);
    return;
  }

  const nextIndex = pipeline.phases.findIndex(
    (p, i) => i > pipeline.currentPhase && (p.status === "pending")
  );

  if (nextIndex >= 0) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} advancing to phase ${pipeline.phases[nextIndex].name} (index ${nextIndex})`);
    await executePipelinePhase(pipeline, nextIndex);
  } else {
    // No more pending phases
    pipeline.status = "completed";
    pipeline.completedAt = nowIso();
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
  

    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} completed all phases for ${pipeline.issueKey}`);

    jobEmitter.emit("pipeline:completed", {
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      pipelineType: pipeline.pipelineType,
      completedAt: pipeline.completedAt,
      phases: pipeline.phases.length,
    });

    // Auto-merge feature branch into the integration branch (dev) on successful
    // pipeline completion. The local main branch is never touched by the runner —
    // a human reviews `dev` and opens a PR `dev -> main` for deployment.
    // Synchronous: by the time this returns, dev has been pushed and the local
    // feature branch + worktree have been cleaned up.
    if (pipeline.merged) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} already merged (${pipeline.mergedBranch}) — skipping completion merge`);
    } else if (pipeline.worktreeId && config.worktrees?.enabled) {
      await withMergeLock(pipeline.workingDir, async () => {
        try {
          const mergeResult = mergeWorktree(pipeline.issueKey);
          console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merged ${mergeResult.branch} -> ${mergeResult.mergeBranch}@${(mergeResult.devSha || "").slice(0,8)} (${mergeResult.mode})`);
          pipeline.merged = true;
          pipeline.mergedBranch = mergeResult.branch;
          pipeline.mergedTo = mergeResult.mergeBranch;
          pipeline.mergedSha = mergeResult.devSha;
        } catch (e) {
          if (e.conflictContext) {
            console.warn(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merge conflict — dispatching agent`);
            dispatchMergeConflictAgent(pipeline, e.conflictContext);
            pipeline.mergeError = `Conflict on ${e.conflictContext.branchName} — agent dispatched`;
          } else {
            console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} worktree merge failed: ${e.message}`);
            pipeline.mergeError = e.message;
          }
        }
      });
    } else if (!pipeline.merged) {
      // Non-worktree: detect agent-created branch in workingDir and merge it
      await withMergeLock(pipeline.workingDir, async () => {
        try {
          const result = autoMergePipelineBranch(pipeline);
          if (result) {
            console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merged ${result.branch} -> ${result.mergeBranch}@${(result.devSha || "").slice(0,8)} (${result.mode})`);
            pipeline.merged = true;
            pipeline.mergedBranch = result.branch;
            pipeline.mergedTo = result.mergeBranch;
            pipeline.mergedSha = result.devSha;
          } else {
            console.warn(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-merge skipped: no mergeable branch found for ${pipeline.issueKey}`);
          }
        } catch (e) {
          if (e.conflictContext) {
            console.warn(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-merge conflict — dispatching agent`);
            dispatchMergeConflictAgent(pipeline, e.conflictContext);
            pipeline.mergeError = `Conflict on ${e.conflictContext.branchName} — agent dispatched`;
          } else {
            console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-merge failed: ${e.message}`);
            pipeline.mergeError = e.message;
          }
        }
      });
    }

    // Auto-transition Jira issue to Done only after the merge into dev has succeeded.
    // Guard 1: any phase with a FAIL verdict blocks the transition.
    // Guard 2: if the merge didn't succeed, leave Jira un-Done — preserves the
    // No silent Done when the code never reaches the integration branch.
    // A human still needs to act on `pipeline.mergeError`.
    const anyPhaseFailed = pipeline.phases.some(ph =>
      ph.gateResult && ph.gateResult.passed === false
    );
    if (anyPhaseFailed) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} skipping auto-transition: one or more phases had FAIL verdict`);
    } else if (!pipeline.merged) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} skipping auto-transition: merge did not succeed (${pipeline.mergeError || 'no branch found'})`);
    } else {
      autoTransitionIssueToDone(pipeline).catch(e => {
        console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition failed: ${e.message}`);
      });

      // If this pipeline's issue is a subtask, check if all siblings are done → transition parent
      if (pipeline.parentKey) {
        // Small delay to let the subtask transition complete first
        setTimeout(() => {
          checkAndTransitionParent(pipeline.parentKey).catch(e => {
            console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} parent transition check failed: ${e.message}`);
          });
        }, 5000);
      }
    }

    // Send pipeline completion callback if configured
    if (pipeline.callbackUrl) {
      const payload = {
        event: "pipeline:completed",
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        pipelineType: pipeline.pipelineType,
        completedAt: pipeline.completedAt,
        merged: pipeline.merged || false,
        mergedBranch: pipeline.mergedBranch || null,
        mergeError: pipeline.mergeError || null,
        slack: pipeline.slack || null,
      };
      const mockJob = { jobId: pipeline.pipelineId, logFile: path.join(LOG_DIR, `${pipeline.pipelineId}.log`) };
      // Ensure log file exists for callback helper
      if (!fs.existsSync(mockJob.logFile)) {
        fs.writeFileSync(mockJob.logFile, `[${nowIso()}] Pipeline completed\n`, "utf8");
      }
      sendCallbackWithRetry(pipeline.callbackUrl, payload, mockJob).catch(e => {
        console.error(`[${nowIso()}] Pipeline completion callback failed: ${e.message}`);
      });
    }
  }
}

/**
 * Auto-transition a Jira issue to Done after a pipeline completes successfully.
 * Uses direct Jira REST API calls — no Claude CLI overhead.
 * This is a safety net — the PM agent should also transition, but sometimes doesn't.
 */
async function autoTransitionIssueToDone(pipeline) {
  const issueKey = pipeline.issueKey;
  if (!issueKey) return;

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition skipped: JIRA_DOMAIN/JIRA_EMAIL/JIRA_API_TOKEN not configured`);
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  try {
    // 1. Check current status AND subtasks
    const issueRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}?fields=status,subtasks`, headers);
    if (issueRes.statusCode !== 200) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: failed to fetch issue (${issueRes.statusCode})`);
      return;
    }
    const currentStatus = issueRes.json?.fields?.status?.name || "";
    if (currentStatus.toLowerCase() === "done") {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: Already Done`);
      return;
    }

    // Guard: if issue has subtasks, do NOT auto-transition — let checkAndTransitionParent handle it
    const subtasks = issueRes.json?.fields?.subtasks || [];
    if (subtasks.length > 0) {
      const doneCount = subtasks.filter(st => (st.fields?.status?.name || "").toLowerCase() === "done").length;
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: BLOCKED — has ${subtasks.length} subtasks (${doneCount} done). Parent transitions are handled by checkAndTransitionParent only.`);
      return;
    }

    // 2. Get available transitions
    const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, headers);
    if (transRes.statusCode !== 200) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: failed to get transitions (${transRes.statusCode})`);
      return;
    }
    const transitions = transRes.json?.transitions || [];
    const doneTrans = transitions.find(t => t.name?.toLowerCase() === "done");
    if (!doneTrans) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: no "Done" transition available from "${currentStatus}" (available: ${transitions.map(t => t.name).join(", ")})`);
      return;
    }

    // 3. Transition to Done
    const result = await postJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: doneTrans.id } }, headers);
    if (result.statusCode === 204 || result.statusCode === 200) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: Transitioned to Done (from "${currentStatus}")`);
    } else {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: transition failed (${result.statusCode}) ${result.body?.substring(0, 200)}`);
    }
  } catch (e) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: error - ${e.message}`);
  }
}

/**
 * Check if all subtasks of a parent are done (via Jira API, not in-memory tracking).
 * If all subtasks are Done, transition the parent story to Done.
 */
async function checkAndTransitionParent(parentKey) {
  if (!parentKey) return;

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return;

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  // 1. Fetch parent with subtasks and their statuses
  const parentRes = await getJson(`${baseUrl}/rest/api/3/issue/${parentKey}?fields=subtasks,status`, headers);
  if (parentRes.statusCode !== 200) {
    console.log(`[parent-transition] ${parentKey}: failed to fetch (${parentRes.statusCode})`);
    return;
  }

  const subtasks = parentRes.json?.fields?.subtasks || [];
  if (subtasks.length === 0) {
    console.log(`[parent-transition] ${parentKey}: no subtasks, skipping`);
    return;
  }

  // 2. Check each subtask's status — need to fetch individually since subtasks field only has key/summary/status
  let allDone = true;
  for (const st of subtasks) {
    const stStatus = st.fields?.status?.name?.toLowerCase() || "";
    if (stStatus !== "done") {
      allDone = false;
      break;
    }
  }

  if (!allDone) {
    const doneCount = subtasks.filter(st => (st.fields?.status?.name || "").toLowerCase() === "done").length;
    console.log(`[parent-transition] ${parentKey}: ${doneCount}/${subtasks.length} subtasks done, waiting`);
    return;
  }

  // 3. Check parent isn't already done
  const parentStatus = parentRes.json?.fields?.status?.name || "";
  if (parentStatus.toLowerCase() === "done") {
    console.log(`[parent-transition] ${parentKey}: already Done`);
    return;
  }

  // 4. Get transitions and transition to Done
  const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${parentKey}/transitions`, headers);
  if (transRes.statusCode !== 200) {
    console.log(`[parent-transition] ${parentKey}: failed to get transitions (${transRes.statusCode})`);
    return;
  }
  const transitions = transRes.json?.transitions || [];
  const doneTrans = transitions.find(t => t.name?.toLowerCase() === "done");
  if (!doneTrans) {
    console.log(`[parent-transition] ${parentKey}: no "Done" transition from "${parentStatus}" (available: ${transitions.map(t => t.name).join(", ")})`);
    return;
  }

  const result = await postJson(`${baseUrl}/rest/api/3/issue/${parentKey}/transitions`, { transition: { id: doneTrans.id } }, headers);
  if (result.statusCode === 204 || result.statusCode === 200) {
    console.log(`[parent-transition] ${parentKey}: ALL ${subtasks.length} subtasks done → transitioned parent to Done`);
  } else {
    console.log(`[parent-transition] ${parentKey}: transition failed (${result.statusCode})`);
  }
}

/**
 * Move parent story to "In Progress" when first subtask starts working.
 * Skips if parent is already In Progress or Done (idempotent).
 */
async function moveParentToInProgress(parentKey) {
  if (!parentKey) return;
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return;

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  // Check current status — only transition if still in a pre-progress state (e.g. "To Do", "Backlog")
  const parentRes = await getJson(`${baseUrl}/rest/api/3/issue/${parentKey}?fields=status`, headers);
  if (parentRes.statusCode !== 200) {
    console.log(`[parent-in-progress] ${parentKey}: failed to fetch (${parentRes.statusCode})`);
    return;
  }

  const currentStatus = parentRes.json?.fields?.status?.name || "";
  const statusLower = currentStatus.toLowerCase();
  if (statusLower === "in progress" || statusLower === "done" || statusLower === "in review") {
    console.log(`[parent-in-progress] ${parentKey}: already "${currentStatus}", skipping`);
    return;
  }

  // Get transitions and move to In Progress
  const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${parentKey}/transitions`, headers);
  if (transRes.statusCode !== 200) return;

  const transitions = transRes.json?.transitions || [];
  const ipTrans = transitions.find(t => t.name?.toLowerCase() === "in progress");
  if (!ipTrans) {
    console.log(`[parent-in-progress] ${parentKey}: no "In Progress" transition from "${currentStatus}" (available: ${transitions.map(t => t.name).join(", ")})`);
    return;
  }

  const result = await postJson(`${baseUrl}/rest/api/3/issue/${parentKey}/transitions`, { transition: { id: ipTrans.id } }, headers);
  if (result.statusCode === 204 || result.statusCode === 200) {
    console.log(`[parent-in-progress] ${parentKey}: transitioned from "${currentStatus}" → In Progress (subtask started)`);
  } else {
    console.log(`[parent-in-progress] ${parentKey}: transition failed (${result.statusCode})`);
  }
}

/**
 * Create a Jira subtask under the parent issue when a pipeline phase fails.
 * The subtask is auto-transitioned to In Progress so it enters the sprint and gets worked on.
 */
async function createPipelineFailureSubtask(pipeline, phase) {
  if (!pipeline.issueKey) return;

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask skipped: JIRA_DOMAIN/JIRA_EMAIL/JIRA_API_TOKEN not configured`);
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  try {
    // Get parent issue project key
    const issueRes = await getJson(`${baseUrl}/rest/api/3/issue/${pipeline.issueKey}?fields=project`, headers);
    if (issueRes.statusCode !== 200) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask: failed to fetch parent issue (${issueRes.statusCode})`);
      return;
    }
    const projectKey = issueRes.json?.fields?.project?.key;
    const projectId = issueRes.json?.fields?.project?.id;
    if (!projectKey || !projectId) return;

    // Truncate error for summary (max 255 chars)
    const errorSummary = (phase.error || "Phase failed").substring(0, 140);
    const summary = `[RCA] ${pipeline.issueKey} — ${phase.name} exhausted: ${errorSummary}`.substring(0, 255);

    // Route exhausted-pipeline failures to ask-dave for root-cause analysis instead of
    // re-spawning the same agent. ask-dave investigates, attaches findings, and only then
    // delegates to an implementer (or recommends scope reduction / deferral) with a
    // narrow, evidenced plan.
    const agentLabel = "agent:ask-dave-agent";
    const failedAgent = phase.agent || "unknown";
    const fixLoopAttempts = phase.fixLoopAttempts || 0;
    const verifyLoopAttempts = pipeline.verifyFixLoopAttempts || 0;

    const rcaBrief = [
      `Pipeline ${pipeline.pipelineId} (${pipeline.pipelineType}) exhausted all retries at phase "${phase.name}".`,
      ``,
      `Failed agent: ${failedAgent}`,
      `Fix-loop attempts: ${fixLoopAttempts}`,
      `Verify-fix-loop attempts: ${verifyLoopAttempts}`,
      `Last error: ${phase.error || "Unknown"}`,
      ``,
      `## Your job (ask-dave-agent)`,
      `Do NOT just re-run the failed agent. Treat this as a root-cause problem.`,
      `1. Read the parent issue ${pipeline.issueKey} and the prior pipeline jobs/comments to understand what was attempted and why each attempt failed.`,
      `2. Identify the actual root cause — distinguish between (a) a narrow bug in the change, (b) scope creep that broke unrelated code, (c) a pre-existing flaky/broken test, (d) the spec being unimplementable as stated.`,
      `3. Post your findings as a Jira comment on this subtask before doing any code work.`,
      `4. Decide the path: narrow the scope and delegate to engineer-implementer with a constrained plan; recommend a meeting (planner + qa + product-manager) for scope/defer decisions; or escalate to a human if the spec needs revision.`,
      `5. Only dispatch an implementer once you have an evidenced, scoped plan that addresses the root cause.`,
    ].join("\n");

    const subtaskPayload = {
      fields: {
        project: { key: projectKey },
        parent: { key: pipeline.issueKey },
        summary,
        description: {
          type: "doc",
          version: 1,
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: rcaBrief }]
          }]
        },
        issuetype: { name: "Subtask" },
        labels: ["pipeline-fix", "needs-rca", agentLabel],
        priority: { name: "High" },
      }
    };

    const createRes = await postJson(`${baseUrl}/rest/api/3/issue`, subtaskPayload, headers);
    let createdKey = null;
    if (createRes.statusCode === 201) {
      try { createdKey = JSON.parse(createRes.body)?.key; } catch (_) {}
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask created: ${createdKey || "unknown"} under ${pipeline.issueKey}`);
    } else {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask creation failed (${createRes.statusCode}): ${(createRes.body || "").substring(0, 300)}`);
      return;
    }

    // Move subtask to parent's sprint + transition to In Progress
    if (createdKey) {
      await moveSubtaskToParentSprint(createdKey, pipeline.issueKey);
      await transitionIssueToInProgress(createdKey);
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask ${createdKey} moved to sprint + transitioned to In Progress`);
    }
  } catch (e) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask error: ${e.message}`);
  }
}

/**
 * Called when a pipeline phase job finishes (success or failure).
 * Evaluates the gate, updates context bridge, and advances or fails the pipeline.
 */
async function onPipelinePhaseComplete(pipeline, phaseIndex, job) {
  const phase = pipeline.phases[phaseIndex];
  if (!phase) return;

  // Guard: ignore stale callbacks for phases that have already terminated.
  // This happens when a duplicate job for the same phase finishes late — e.g.
  // job 1 of phase X is interrupted by a runner restart and re-queued via
  // `retry-pending` (loadStateFromDB), while the pipeline's own resume logic
  // ALSO restarts phase X with a fresh job 2. When job 1 eventually finishes,
  // it would re-fire phase completion and (incorrectly) advance the pipeline
  // past phases that are already running. Without this guard, the pipeline
  // can leap from a completed phase straight to a later one, leaving the
  // current phase running and the pipeline marked completed prematurely.
  if (phase.status === "completed" || phase.status === "failed" || phase.status === "skipped") {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} ignoring stale completion for phase ${phase.name} (status=${phase.status}, jobId=${job.jobId})`);
    return;
  }
  // Defensive: if the phase's tracked jobId no longer matches this job, the
  // phase has already moved on (e.g. fix-loop reset). Drop the stale callback.
  if (phase.jobId && phase.jobId !== job.jobId) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} ignoring duplicate job completion for phase ${phase.name} (current jobId=${phase.jobId}, completing jobId=${job.jobId})`);
    return;
  }

  phase.completedAt = nowIso();

  if (job.status === "failed" || job.status === "quality-gate-failed" || job.status === "cancelled") {
    // Fix-loop: for quality-gate failures on eligible phases, re-dispatch with error context
    const fixLoopCfg = config.fixLoop || {};
    const isFixLoopEligible = fixLoopCfg.enabled &&
      job.status === "quality-gate-failed" &&
      phase.gate && (fixLoopCfg.gateTypes || ["quality-gate"]).includes(phase.gate.type);

    if (isFixLoopEligible && phase.fixLoopAttempts < (fixLoopCfg.maxAttempts || 3)) {
      // d3a: short-circuit fix-loop when the failing tests live entirely
      // outside the pipeline's diff (i.e. base branch was already red).
      // Only check after at least one fix-loop attempt to avoid false
      // positives on a fresh implementer-introduced issue.
      if (phase.fixLoopAttempts >= 1) {
        try {
          const baseRed = detectInheritedRedBase(pipeline, phase, job);
          if (baseRed.inherited) {
            phase.baseRedDetection = baseRed;
            console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} BLOCKED_ON_BASE_RED (basis=${baseRed.basis}, failing=${baseRed.failingFiles.length} file(s)) — halting fix-loop`);
            // Fall through to terminal-fail block below.
          }
        } catch (e) {
          console.warn(`[${nowIso()}] detectInheritedRedBase error: ${e.message}`);
        }
      }

      if (!phase.baseRedDetection) {
      phase.fixLoopAttempts++;
      phase.status = "pending";
      phase.jobId = null;
      phase.startedAt = null;
      phase.completedAt = null;

      // Capture error context from the failed job for the next attempt
      const qgFailure = job.qualityGateFailure || {};
      phase.fixLoopContext = {
        attempt: phase.fixLoopAttempts,
        failedCheck: qgFailure.failedCheck || job.error || "unknown",
        failedCommand: qgFailure.failedCommand || "",
        failureOutput: qgFailure.failureOutput || job.error || "",
        previousJobId: job.jobId,
      };
    

      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} quality-gate failed — fix-loop attempt ${phase.fixLoopAttempts}/${fixLoopCfg.maxAttempts || 3}`);

      jobEmitter.emit("pipeline:fix-loop", {
        pipelineId: pipeline.pipelineId,
        phase: phase.name,
        phaseIndex,
        jobId: job.jobId,
        attempt: phase.fixLoopAttempts,
        maxAttempts: fixLoopCfg.maxAttempts || 3,
        failedCheck: phase.fixLoopContext.failedCheck,
      });

      setTimeout(() => executePipelinePhase(pipeline, phaseIndex), 5000);
      return;
      }
      // baseRedDetection set: fall through to terminal-fail block.
    }

    // Standard retry (non-quality-gate failures)
    const maxPhaseRetries = 1;
    if (phase.retryCount < maxPhaseRetries && job.status !== "cancelled" && !isFixLoopEligible) {
      phase.retryCount++;
      phase.status = "pending";
      phase.jobId = null;
      phase.startedAt = null;
    

      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} failed, retrying (${phase.retryCount}/${maxPhaseRetries})`);

      jobEmitter.emit("pipeline:phase-complete", {
        pipelineId: pipeline.pipelineId,
        phase: phase.name,
        phaseIndex,
        jobId: job.jobId,
        status: "retrying",
      });

      setTimeout(() => executePipelinePhase(pipeline, phaseIndex), 5000);
      return;
    }

    // All retries/fix-loops exhausted, cancelled, or base-red detected
    phase.status = "failed";
    const baseRed = phase.baseRedDetection;
    if (baseRed && baseRed.inherited) {
      const head = baseRed.failingFiles.slice(0, 3).join(", ");
      const more = baseRed.failingFiles.length > 3 ? ` (+${baseRed.failingFiles.length - 3} more)` : "";
      phase.error = `BLOCKED_ON_BASE_RED: ${baseRed.failingFiles.length} failing test file(s) live outside pipeline diff (basis=${baseRed.basis}). Failing: ${head}${more}.`;
    } else {
      phase.error = job.error || "Phase job failed";
      if (phase.fixLoopAttempts > 0) {
        phase.error += ` (after ${phase.fixLoopAttempts} fix-loop attempts)`;
      }
    }

    pipeline.status = "failed";
    pipeline.completedAt = nowIso();
    pipeline.blockedOnBaseRed = !!(baseRed && baseRed.inherited);
    pipeline.error = `Phase "${phase.name}" failed: ${phase.error}`;
    const baseRedActive = baseRed && baseRed.inherited;
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
  

    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} FAILED at phase ${phase.name}: ${pipeline.error}`);

    // Preserve any partial work on the worktree branch by pushing it to the remote.
    // This guarantees we never lose progress even when the pipeline didn't reach a green state.
    try {
      const preserved = preserveBranchOnFailure(pipeline, phase);
      if (preserved) {
        pipeline.preservedBranch = preserved.branch;
        pipeline.preservedRemote = preserved.pushedRemote;
      }
    } catch (e) {
      console.warn(`[${nowIso()}] preserveBranchOnFailure (job-fail) error: ${e.message}`);
    }

    // Create a Jira subtask for the failure so it gets resolved
    createPipelineFailureSubtask(pipeline, phase).catch(e => {
      console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask error: ${e.message}`);
    });

    jobEmitter.emit("pipeline:phase-complete", {
      pipelineId: pipeline.pipelineId,
      phase: phase.name,
      phaseIndex,
      jobId: job.jobId,
      status: "failed",
      error: phase.error,
    });

    jobEmitter.emit("pipeline:failed", {
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      pipelineType: pipeline.pipelineType,
      failedPhase: phase.name,
      error: pipeline.error,
      completedAt: pipeline.completedAt,
    });

    // Send pipeline failure callback so N8N/Slack is notified
    if (pipeline.callbackUrl) {
      const failPayload = {
        event: "pipeline:failed",
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        pipelineType: pipeline.pipelineType,
        failedPhase: phase.name,
        error: pipeline.error,
        completedAt: pipeline.completedAt,
        slack: pipeline.slack || null,
        telegram: pipeline.telegram || null,
        blockedOnBaseRed: !!baseRedActive,
        failingTestFiles: baseRedActive ? baseRed.failingFiles : undefined,
        baseRef: baseRedActive ? baseRed.basis : undefined,
        message: baseRedActive
          ? `Pipeline ${pipeline.issueKey} BLOCKED_ON_BASE_RED — ${baseRed.failingFiles.length} test file(s) failing on ${baseRed.basis} that this pipeline never touched. Fix the base before retrying.`
          : `Pipeline FAILED for ${pipeline.issueKey} at phase "${phase.name}": ${phase.error}`,
      };
      const mockJob = { jobId: pipeline.pipelineId, logFile: path.join(LOG_DIR, `${pipeline.pipelineId}.log`) };
      if (!fs.existsSync(mockJob.logFile)) {
        fs.writeFileSync(mockJob.logFile, `[${nowIso()}] Pipeline failed\n`, "utf8");
      }
      sendCallbackWithRetry(pipeline.callbackUrl, failPayload, mockJob).catch(e => {
        console.error(`[${nowIso()}] Pipeline failure callback failed: ${e.message}`);
      });
    }

    return;
  }

  // Job succeeded — evaluate gate
  const gateResult = evaluateGate(pipeline, phase, job);
  phase.gateResult = gateResult;

  // Structured gate: keep the observations on the phase (jobs are evicted
  // from memory once terminal — the phase record is what downstream phases
  // and the context bridge read), and post the audit projection to Jira so
  // humans and N8N consumers keep the [AUTO-*] trail they already know.
  if (gateResult.structured && job.observations) {
    phase.observations = job.observations;
    if (pipeline.issueKey && phase.gate?.prefix) {
      const projection = renderObservationsComment(phase.gate.prefix, gateResult.policyResult, job.observations);
      issueTracker.addComment(pipeline.issueKey, projection, "runner").catch(e =>
        console.error(`[${nowIso()}] Audit projection comment failed for ${pipeline.issueKey}: ${e.message}`));
    }
  }

  if (!gateResult.passed) {
    const verdict = gateResult.verdict || null;

    // NEEDS-CLARIFICATION: the agent flagged ambiguous requirements. Retrying
    // or fix-looping is pointless — a human must decide. Halt the pipeline
    // with a dedicated event/callback so N8N can route it to the PM/approval
    // channel, and surface it as a clearly-labelled failure.
    if (verdict === "NEEDS-CLARIFICATION") {
      handlePipelineNeedsClarification(pipeline, phase, phaseIndex, job, gateResult);
      return;
    }

    // Gate failed — retry the phase if retries remain.
    // Exception: when the agent posted a definitive negative verdict
    // (FAIL / CHANGES-REQUESTED / BLOCKED / REJECTED), re-running the same
    // phase on the same code is pointless — go straight to the fix-loop so
    // the implementer can address the findings.
    const isDefinitiveNegativeVerdict = !!verdict && GATE_NEGATIVE_VERDICTS.includes(verdict);
    const maxPhaseRetries = 1;
    if (!isDefinitiveNegativeVerdict && phase.retryCount < maxPhaseRetries) {
      phase.retryCount++;
      phase.status = "pending";
      phase.jobId = null;
      phase.startedAt = null;


      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} gate failed (${gateResult.reason}), retrying`);

      jobEmitter.emit("pipeline:gate-failed", {
        pipelineId: pipeline.pipelineId,
        phase: phase.name,
        phaseIndex,
        reason: gateResult.reason,
        verdict,
        retrying: true,
      });

      setTimeout(() => executePipelinePhase(pipeline, phaseIndex), 5000);
      return;
    }

    // Block-recovery fix-loop: when a review-style gate fails (verify,
    // code-review, security-review — configurable via fixLoop.fixablePhases),
    // loop back to the implementer to fix the findings on the same branch,
    // then re-run the failed phase. The branch stays checked out — merge only
    // happens when the gates finally pass.
    const verifyFixCfg = config.fixLoop || {};
    const maxVerifyLoops = verifyFixCfg.maxVerifyAttempts || 3;
    const fixablePhases = verifyFixCfg.fixablePhases || ["verify", "code-review", "security-review"];
    if (fixablePhases.includes(phase.name) && verifyFixCfg.enabled) {
      pipeline.verifyFixLoopAttempts = (pipeline.verifyFixLoopAttempts || 0) + 1;
      if (pipeline.verifyFixLoopAttempts <= maxVerifyLoops) {
        const implIndex = pipeline.phases.findIndex(p => p.name === "implementation");
        if (implIndex >= 0) {
          const implPhase = pipeline.phases[implIndex];

          // Record the findings as a shared lesson so future implementer runs
          // (any issue, any pipeline) learn from this failure class.
          appendLesson("gate-failure", pipeline.issueKey,
            `Phase "${phase.name}" ${verdict || "failed"}: ${truncateForLesson(job.parsedOutput?.result)}`);

          // Reset implementation phase with the reviewer/QA findings as fix context
          implPhase.status = "pending";
          implPhase.jobId = null;
          implPhase.startedAt = null;
          implPhase.fixLoopContext = {
            attempt: pipeline.verifyFixLoopAttempts,
            failedCheck: `${phase.name} gate failed (verdict: ${verdict || "none"}): ${gateResult.reason}`,
            failedCommand: "",
            failureOutput: ((job.parsedOutput?.result || "") + "\n" + (job.stdout || "")).substring(0, 4000),
            sourcePhase: phase.name,
          };

          // Reset verify phase so it re-runs after implementation
          phase.status = "pending";
          phase.jobId = null;
          phase.startedAt = null;
          phase.retryCount = 0;
          phase.gateResult = null;

          // Also reset code-review if present so reviewer sees the fixes
          const crIndex = pipeline.phases.findIndex(p => p.name === "code-review");
          if (crIndex >= 0 && crIndex > implIndex) {
            const crPhase = pipeline.phases[crIndex];
            crPhase.status = "pending";
            crPhase.jobId = null;
            crPhase.startedAt = null;
            crPhase.retryCount = 0;
            crPhase.gateResult = null;
          }

          pipeline.status = "running";
          db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));

          console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} fix-loop ${pipeline.verifyFixLoopAttempts}/${maxVerifyLoops}: ${phase.name} gate failed (verdict: ${verdict || "none"}) → re-dispatching implementer on same branch`);

          jobEmitter.emit("pipeline:verify-fix-loop", {
            pipelineId: pipeline.pipelineId,
            issueKey: pipeline.issueKey,
            phase: phase.name,
            attempt: pipeline.verifyFixLoopAttempts,
            maxAttempts: maxVerifyLoops,
            reason: gateResult.reason,
            verdict,
          });

          setTimeout(() => executePipelinePhase(pipeline, implIndex), 5000);
          return;
        }
      }
    }

    // Gate failed and no more retries (or verify-fix-loop exhausted)
    phase.status = "failed";
    phase.error = `Gate failed: ${gateResult.reason}`;
    if (pipeline.verifyFixLoopAttempts > 0) {
      phase.error += ` (after ${pipeline.verifyFixLoopAttempts} verify-fix-loop attempts)`;
    }

    pipeline.status = "failed";
    pipeline.completedAt = nowIso();
    pipeline.error = `Phase "${phase.name}" gate failed: ${gateResult.reason}`;
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));

    // Preserve any partial work on the worktree branch by pushing it to the remote.
    try {
      const preserved = preserveBranchOnFailure(pipeline, phase);
      if (preserved) {
        pipeline.preservedBranch = preserved.branch;
        pipeline.preservedRemote = preserved.pushedRemote;
      }
    } catch (e) {
      console.warn(`[${nowIso()}] preserveBranchOnFailure (gate-fail) error: ${e.message}`);
    }

    // Create a Jira subtask for the gate failure so it gets resolved
    createPipelineFailureSubtask(pipeline, phase).catch(e => {
      console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} gate failure subtask error: ${e.message}`);
    });

    jobEmitter.emit("pipeline:gate-failed", {
      pipelineId: pipeline.pipelineId,
      phase: phase.name,
      phaseIndex,
      reason: gateResult.reason,
      retrying: false,
    });

    jobEmitter.emit("pipeline:failed", {
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      pipelineType: pipeline.pipelineType,
      failedPhase: phase.name,
      error: pipeline.error,
      completedAt: pipeline.completedAt,
    });

    // Send pipeline failure callback so N8N/Slack is notified
    if (pipeline.callbackUrl) {
      const failPayload = {
        event: "pipeline:failed",
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        pipelineType: pipeline.pipelineType,
        failedPhase: phase.name,
        error: pipeline.error,
        completedAt: pipeline.completedAt,
        slack: pipeline.slack || null,
        telegram: pipeline.telegram || null,
        message: `Pipeline FAILED for ${pipeline.issueKey} at phase "${phase.name}": ${phase.error}`,
      };
      const mockJob = { jobId: pipeline.pipelineId, logFile: path.join(LOG_DIR, `${pipeline.pipelineId}.log`) };
      if (!fs.existsSync(mockJob.logFile)) {
        fs.writeFileSync(mockJob.logFile, `[${nowIso()}] Pipeline failed\n`, "utf8");
      }
      sendCallbackWithRetry(pipeline.callbackUrl, failPayload, mockJob).catch(e => {
        console.error(`[${nowIso()}] Pipeline failure callback failed: ${e.message}`);
      });
    }

    return;
  }

  // Gate passed — auto-commit any uncommitted changes in the worktree
  if (pipeline.worktreePath && phase.worktree) {
    try {
      const { execSync } = require("child_process");
      const phaseDir = pipeline.worktreePath;
      const statusOut = execSync("git status --porcelain", { cwd: phaseDir, encoding: "utf8", timeout: 10000 }).trim();
      if (statusOut) {
        execSync("git add -A", { cwd: phaseDir, encoding: "utf8", timeout: 15000 });
        execSync(`git commit -m "feat: ${phase.name} phase complete (${pipeline.issueKey})\n\nPipeline: ${pipeline.pipelineId}\nAgent: ${phase.agent}"`, {
          cwd: phaseDir, encoding: "utf8", timeout: 30000,
          env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Meshwork Runner", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || "Meshwork Runner", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid" }
        });
        console.log(`[${nowIso()}] Auto-committed uncommitted changes in worktree for ${pipeline.issueKey} phase ${phase.name}`);
      }
    } catch (e) {
      console.warn(`[${nowIso()}] Auto-commit warning for ${pipeline.issueKey} phase ${phase.name}: ${e.message}`);
    }
  }

  // Gate passed
  phase.status = "completed";


  jobEmitter.emit("pipeline:gate-passed", {
    pipelineId: pipeline.pipelineId,
    phase: phase.name,
    phaseIndex,
    reason: gateResult.reason,
  });

  jobEmitter.emit("pipeline:phase-complete", {
    pipelineId: pipeline.pipelineId,
    phase: phase.name,
    phaseIndex,
    jobId: job.jobId,
    status: "completed",
  });

  console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} completed and gate passed`);

  // Verification sampling: best-effort, never blocks or advances the pipeline
  try {
    maybeScheduleVerification(pipeline, phase, phaseIndex, job, gateResult);
  } catch (e) {
    console.warn(`[${nowIso()}] Verification scheduling error: ${e.message}`);
  }

  // Dynamic gating: planner phase selects which subsequent phases to run
  if (phase.dynamicGating) {
    applyDynamicPhaseGating(pipeline, phase, job);
  }

  // Merge is deferred to pipeline completion (advancePipeline) so that
  // code-review and QA (verify) phases run on the implementation branch.
  // If QA fails, the verify-fix-loop sends the implementer back to fix on
  // the same branch before QA re-runs.  Only when QA passes does the branch
  // get merged into main.

  // Send pipeline phase progress callback for Slack notifications
  if (pipeline.callbackUrl) {
    const completedCount = pipeline.phases.filter(p => p.status === "completed" || p.status === "skipped").length;
    const totalPhases = pipeline.phases.length;
    const nextPhase = pipeline.phases.find(p => p.status === "pending") || null;
    const nextPhaseName = nextPhase ? nextPhase.name : null;
    const progress = totalPhases > 0 ? Math.round((completedCount / totalPhases) * 100) : 0;

    const phaseProgressPayload = {
      event: "pipeline:phase-complete",
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      pipelineType: pipeline.pipelineType,
      completedPhase: phase.name,
      completedPhaseIndex: phaseIndex,
      totalPhases,
      completedCount,
      nextPhase: nextPhaseName,
      progress,
      slack: pipeline.slack || null,
      telegram: pipeline.telegram || null,
      message: `${pipeline.issueKey}: Phase ${completedCount}/${totalPhases} complete (${phase.name}). Next: ${nextPhaseName || "done"}.`,
    };
    const mockPhaseJob = { jobId: pipeline.pipelineId, logFile: path.join(LOG_DIR, `${pipeline.pipelineId}.log`) };
    if (!fs.existsSync(mockPhaseJob.logFile)) {
      fs.writeFileSync(mockPhaseJob.logFile, `[${nowIso()}] Pipeline phase complete\n`, "utf8");
    }
    sendCallbackWithRetry(pipeline.callbackUrl, phaseProgressPayload, mockPhaseJob).catch(e => {
      console.error(`[${nowIso()}] Pipeline phase progress callback failed: ${e.message}`);
    });
  }

  // Update context bridge with phase summary
  updateContextBridge(pipeline, phase, job);

  // Advance to next phase
  await advancePipeline(pipeline);
}

/**
 * Parse [TEAMMATE-LOG]...[/TEAMMATE-LOG] blocks from Claude output.
 * Returns array of { agent, started, completed, summary }
 */
function extractTeammateLog(output) {
  if (!output) return [];
  const results = [];
  const blockPattern = /\[TEAMMATE-LOG\]([\s\S]*?)\[\/TEAMMATE-LOG\]/g;
  let match;
  while ((match = blockPattern.exec(output)) !== null) {
    const block = match[1].trim();
    const entry = { agent: null, started: null, completed: null, summary: "" };

    const agentMatch = block.match(/agent:\s*(.+)/i);
    if (agentMatch) entry.agent = agentMatch[1].trim();

    const startedMatch = block.match(/started:\s*(.+)/i);
    if (startedMatch) entry.started = startedMatch[1].trim();

    const completedMatch = block.match(/completed:\s*(.+)/i);
    if (completedMatch) entry.completed = completedMatch[1].trim();

    // Summary is everything after the key-value lines
    const summaryMatch = block.match(/summary:\s*([\s\S]+)/i);
    if (summaryMatch) entry.summary = summaryMatch[1].trim();

    results.push(entry);
  }
  return results;
}

/**
 * Build a chronological timeline for a Jira issue by scanning all jobs.
 * Includes pipeline phase metadata and teammate activity.
 */
async function buildTimelineForIssue(issueKey) {
  const timeline = [];

  // Scan in-memory jobs
  for (const job of jobs.values()) {
    if (job.issueKey !== issueKey) continue;

    const entry = {
      jobId: job.jobId,
      agent: job.agent || null,
      mode: job.mode,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      pipelineId: job.pipelineId || null,
      pipelinePhase: job.pipelinePhase || null,
      model: job.selectedModel || job.model || null,
      estimatedCostUsd: job.usage?.estimatedCostUsd || null,
      error: job.error || null,
      teammateActivity: [],
    };

    // Extract teammate logs from output if available
    if (job.stdout || job.parsedOutput?.result) {
      const rawText = (job.parsedOutput?.result || "") + (job.stdout || "");
      entry.teammateActivity = extractTeammateLog(rawText);
    }

    timeline.push(entry);
  }

  // Also scan DB for historical jobs not in memory
  try {
    const dbJobs = await db.jobs.findByIssueKey(issueKey);
    for (const entry of dbJobs) {
      if (jobs.has(entry.jobId)) continue; // Already included above
      timeline.push({
        jobId: entry.jobId,
        agent: entry.agent || null,
        mode: entry.mode,
        status: entry.status,
        createdAt: entry.createdAt,
        startedAt: entry.startedAt || null,
        finishedAt: entry.finishedAt || null,
        pipelineId: null,
        pipelinePhase: null,
        model: entry.selectedModel || entry.model || null,
        estimatedCostUsd: entry.estimatedCostUsd || null,
        error: entry.error || null,
        teammateActivity: [],
      });
    }
  } catch {}

  // Sort chronologically
  timeline.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
  });

  return timeline;
}
