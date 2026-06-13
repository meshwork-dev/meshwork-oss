// verification.js — structured observations ingest and independent verification of phase results
// Extracted from runner.js.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const issueTracker = require("../issue-tracker");
const { compareFindings, extractObservationsBlock, sampledForVerification, validateObservations } = require("./observations");
const { LOG_DIR, config } = require("./config");
const { appendLesson } = require("./lessons");
const { jobEmitter, jobs, pipelines, queue, verificationStats } = require("./state");
const { appendLog, makeJobId, nowIso, truncateForLesson } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  ingestObservationsFile,
  ingestObservationsFromOutput,
  maybeScheduleVerification,
  handleVerificationJobComplete,
  recordVerificationOnPipeline,
  maybeDispatchIndependentReview,
};

const { createJob, enqueue, tickWorker } = require("./worker");


/* ============================================================
 * STRUCTURED OBSERVATIONS + VERIFICATION SAMPLING
 *
 * Agents emit structured observations (findings with severity + evidence,
 * AC checks) instead of self-issuing gate verdicts; the engine computes the
 * verdict via a thin policy layer (evaluateGate) and posts the legacy
 * [AUTO-*] comment to Jira as an audit PROJECTION — humans and N8N keep the
 * trail they know, but it is no longer the control signal.
 *
 * Verification sampling dispatches an adversarial second review on a sample
 * of passed gates and records the overturn rate + root causes. This is
 * MEASUREMENT (the platform's escaped-defect instrumentation), not deterrence
 * — agents are ephemeral; the metric is the product.
 * ============================================================ */

const OBSERVATIONS_RELPATH = path.join(".meshwork", "observations.json");

/**
 * Ingest a worktree observations file (the zero-infrastructure transport for
 * phases that run in a worktree, and the only transport local models need).
 * HTTP-submitted observations win — the file is only read when nothing was
 * submitted via POST /jobs/:id/observations.
 */
function ingestObservationsFile(job) {
  if (job.observations || !job.workingDir) return;
  const filePath = path.join(job.workingDir, OBSERVATIONS_RELPATH);
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const { ok, errors, observations } = validateObservations(raw);
    if (!ok) {
      appendLog(job.logFile, `\n[${nowIso()}] Observations file rejected: ${errors.join("; ")}\n`);
      return;
    }
    job.observations = observations;
    job.observationsSource = "file";
    appendLog(job.logFile, `\n[${nowIso()}] Ingested observations file (${observations.findings.length} finding(s), ${observations.acChecks.length} AC check(s))\n`);
    jobEmitter.emit("job:observations", { jobId: job.jobId, source: "file", findings: observations.findings.length });
  } catch (e) {
    appendLog(job.logFile, `\n[${nowIso()}] Observations file ingest error: ${e.message}\n`);
  }
}

/**
 * Ingest an [OBSERVATIONS] block from the agent's output — the universal
 * transport: works for read-only agents (the reviewer has Bash and Write
 * disallowed) and local models with MCP stripped. Lowest priority: HTTP
 * submission and the worktree file both win over the output block.
 */
function ingestObservationsFromOutput(job) {
  if (job.observations) return;
  const text = (job.parsedOutput?.result || "") + "\n" + (job.stdout || "");
  const { found, raw, error } = extractObservationsBlock(text);
  if (!found) return;
  if (error) {
    appendLog(job.logFile, `\n[${nowIso()}] [OBSERVATIONS] block rejected: ${error}\n`);
    return;
  }
  const { ok, errors, observations } = validateObservations(raw);
  if (!ok) {
    appendLog(job.logFile, `\n[${nowIso()}] [OBSERVATIONS] block rejected: ${errors.join("; ")}\n`);
    return;
  }
  job.observations = observations;
  job.observationsSource = "output";
  appendLog(job.logFile, `\n[${nowIso()}] Ingested [OBSERVATIONS] block from output (${observations.findings.length} finding(s), ${observations.acChecks.length} AC check(s))\n`);
  jobEmitter.emit("job:observations", { jobId: job.jobId, source: "output", findings: observations.findings.length });
}

/**
 * After a review-type gate passes, decide whether to dispatch an adversarial
 * second review. Two triggers: deterministic sampling by jobId (the unbiased
 * overturn-rate measurement) and zero-findings-on-structured-review (a
 * suspiciously clean result). Verification jobs are not pipeline phases —
 * they never advance or block the pipeline; they produce a metric.
 */
function maybeScheduleVerification(pipeline, phase, phaseIndex, job, gateResult) {
  const cfg = config.verification || {};
  if (!cfg.enabled) return;
  if (job.verificationOf) return; // never verify a verification job
  const phaseNames = cfg.phases || ["code-review"];
  if (!phaseNames.includes(phase.name)) return;
  if (!gateResult.passed) return; // failed gates already loop back to the implementer

  const sampled = sampledForVerification(job.jobId, cfg.sampleRate ?? 0.1);
  const zeroFindings = cfg.triggerOnZeroFindings !== false &&
    !!job.observations && job.observations.findings.length === 0;
  if (!sampled && !zeroFindings) return;
  const trigger = sampled ? "sampled" : "zero-findings";

  const firstFindings = job.observations?.findings || [];
  const firstSummary = firstFindings.length > 0
    ? JSON.stringify(firstFindings.slice(0, 30), null, 1)
    : (job.observations ? "(the first review reported zero findings)" : "(the first review used the legacy comment protocol — its findings are in the Jira [AUTO-*] comment thread)");

  const prompt = [
    `You are an independent verification reviewer. A code review for issue ${pipeline.issueKey} already PASSED its gate. Your single job is to find what the first reviewer MISSED — do not repeat or re-confirm their findings.`,
    ``,
    `Review the current branch's diff against the merge base from a deliberately different angle than a standard checklist review: trace data flows end-to-end, hunt edge cases and error paths, check the changed code against the issue's acceptance criteria, and look for security and concurrency problems.`,
    ``,
    `The first reviewer's findings (do NOT report these again):`,
    firstSummary,
    ``,
    `For EVERY new finding, include a "cause" field classifying why the first review missed it:`,
    `- "spec-ambiguity" — the requirement was vague; the miss traces to the spec`,
    `- "reviewer-omission" — clearly in scope and visible; the first reviewer should have caught it`,
    `- "implementer-error" — a defect introduced by the implementation that review alone could not see (e.g. only visible by running code)`,
    `- "context-starvation" — the first reviewer lacked context that exists elsewhere (other files, prior phases)`,
    `- "other"`,
    ``,
    `Report via an observations block at the END of your final output (this is your ONLY output channel — do NOT post Jira comments):`,
    ``,
    `[OBSERVATIONS]`,
    `{ "gate": "verification", "findings": [{ "severity": "critical|major|minor|info", "title": "...", "file": "...", "line": 1, "detail": "...", "evidence": "...", "cause": "..." }], "summary": "..." }`,
    `[/OBSERVATIONS]`,
    ``,
    `If you genuinely find nothing the first reviewer missed, submit an empty findings array with a summary explaining what you checked. An honest "nothing found" is a valid result.`,
  ].join("\n");

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);
  const metaFile = path.join(LOG_DIR, `${jobId}.json`);
  const vJob = {
    jobId,
    status: "queued",
    mode: "agent",
    agent: cfg.agent || "engineer-reviewer",
    prompt,
    context: "",
    workingDir: pipeline.worktreePath || pipeline.workingDir,
    issueKey: null, // no Jira side effects — observations are the only channel
    model: cfg.model || "sonnet",
    selectedModel: null,
    requestedProvider: null,
    callbackUrl: null,
    logFile,
    metaFile,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    pid: null,
    output: null,
    error: null,
    retryCount: 0,
    maxRetries: 0, // best-effort: a failed verification is recorded as inconclusive, never retried
    source: `verification:${pipeline.pipelineId}:${phase.name}`,
    verificationOf: {
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      phaseName: phase.name,
      phaseIndex,
      firstJobId: job.jobId,
      firstFindings,
      trigger,
    },
  };

  jobs.set(jobId, vJob);
  db.jobs.set(vJob).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
  queue.push({ jobId });

  verificationStats.scheduled++;
  verificationStats.byTrigger[trigger] = (verificationStats.byTrigger[trigger] || 0) + 1;
  phase.verification = { jobId, trigger, status: "scheduled" };
  db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));

  console.log(`[${nowIso()}] Verification review scheduled for ${pipeline.issueKey} phase ${phase.name} (trigger=${trigger}, job ${jobId})`);
  jobEmitter.emit("verification:scheduled", { pipelineId: pipeline.pipelineId, phase: phase.name, jobId, trigger });
  setImmediate(tickWorker);
}

/**
 * Record the outcome of a verification review: compare finding sets, compute
 * overturn, tally root causes, persist onto the pipeline phase, and flag the
 * issue when the second look found something material. Overturns also become
 * shared lessons so future reviewer runs learn the failure class.
 */
function handleVerificationJobComplete(job) {
  const v = job.verificationOf;
  if (!v) return;

  const phaseLabel = `${v.issueKey || "?"}/${v.phaseName}`;
  if (!job.observations) {
    verificationStats.inconclusive++;
    console.log(`[${nowIso()}] Verification review ${job.jobId} for ${phaseLabel} inconclusive (no observations submitted)`);
    recordVerificationOnPipeline(v, { status: "inconclusive", jobId: job.jobId, trigger: v.trigger });
    return;
  }

  const { newFindings, overturn, rootCauses } = compareFindings(v.firstFindings, job.observations.findings);
  verificationStats.completed++;
  verificationStats.newFindings += newFindings.length;
  if (overturn) verificationStats.overturned++;
  for (const [cause, n] of Object.entries(rootCauses)) {
    verificationStats.rootCauses[cause] = (verificationStats.rootCauses[cause] || 0) + n;
  }

  const result = {
    status: "completed",
    jobId: job.jobId,
    trigger: v.trigger,
    overturn,
    newFindings: newFindings.length,
    rootCauses,
    completedAt: nowIso(),
  };
  recordVerificationOnPipeline(v, result);

  console.log(`[${nowIso()}] Verification review ${job.jobId} for ${phaseLabel}: ${overturn ? "OVERTURNED" : "upheld"} (${newFindings.length} new finding(s))`);
  jobEmitter.emit("verification:completed", { ...result, pipelineId: v.pipelineId, issueKey: v.issueKey, phase: v.phaseName });

  if (overturn && v.issueKey) {
    const head = newFindings
      .filter(f => f.severity === "critical" || f.severity === "major")
      .slice(0, 5)
      .map(f => `- [${f.severity}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : ""} (cause: ${f.cause || "other"})`)
      .join("\n");
    issueTracker.addComment(
      v.issueKey,
      `[VERIFICATION] An independent second review (${v.trigger}) found ${newFindings.length} finding(s) the passed ${v.phaseName} gate missed:\n${head}\nFull detail: job ${job.jobId}. The gate result stands — this is measurement, not a re-gate — but these findings deserve a human look.`,
      "runner"
    ).catch(e => console.error(`[${nowIso()}] Verification comment failed for ${v.issueKey}: ${e.message}`));

    appendLesson("verification-overturn", v.issueKey,
      `Second review overturned a passed ${v.phaseName} gate: ${newFindings.slice(0, 3).map(f => f.title).join("; ")}`);
  }
}

function recordVerificationOnPipeline(v, result) {
  const pipeline = pipelines.get(v.pipelineId);
  if (!pipeline) return;
  const phase = pipeline.phases[v.phaseIndex];
  if (phase) {
    phase.verification = { ...(phase.verification || {}), ...result };
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
  }
}

/**
 * Independent post-team review (Agent Teams hallucination containment).
 * Teammate reviewers share the lead's conversation context, so a planner
 * hallucination survives "review" because the reviewer reasons inside the
 * same frame. After a successful team-lead delivery session, dispatch the
 * reviewer as a SEPARATE isolated job whose only shared artifact is the
 * code itself plus an explicitly-untrusted summary of the team's claims.
 */
function maybeDispatchIndependentReview(job) {
  try {
    if (!config.teams?.enabled || !config.teams.independentReview) return;
    if (job.teamRole !== "lead" || job.mode !== "delivery" || job.status !== "succeeded") return;
    if (job._independentReview) return;
    const reviewerAgent = config.teams.independentReviewAgent || "engineer-reviewer";
    if (job.agent === reviewerAgent) return;

    const teamSummary = truncateForLesson(job.parsedOutput?.result, 4000);
    const reviewJob = createJob({
      mode: "agent",
      jobIn: { maxRetries: 1 },
      callbackUrl: job.callbackUrl,
      fields: {
        agent: reviewerAgent,
        issueKey: job.issueKey || null,
        workingDir: job.workingDir,
        prompt:
          `A team session led by ${job.agent} just completed work on issue ${job.issueKey || "(none)"} in this repository. ` +
          `Perform an INDEPENDENT code review of their changes. Verify every claim in the team's summary against the actual code — ` +
          `do not assume their framing is correct; they shared one context and may share one blind spot.\n\n` +
          `When done, post a Jira comment starting with [AUTO-REVIEW] including an explicit verdict line ` +
          `"[AUTO-REVIEW] VERDICT: <APPROVED|CHANGES-REQUESTED|BLOCKED>", and end your output with the same verdict line.`,
        context: `Team session result summary (their claims, unverified):\n${teamSummary}`,
        _independentReview: true,
        parentJobId: job.jobId,
        slack: job.slack || null,
      },
    });
    // createJob auto-marks configured team leads; the reviewer must run solo
    reviewJob.teamSessionId = null;
    reviewJob.teamRole = null;
    reviewJob.teammates = [];

    appendLog(job.logFile, `[${nowIso()}] Independent review job ${reviewJob.jobId} dispatched (${reviewerAgent})\n`);
    jobEmitter.emit("job:independent-review-dispatched", {
      jobId: job.jobId,
      reviewJobId: reviewJob.jobId,
      agent: reviewerAgent,
      issueKey: job.issueKey || null,
    });
    enqueue(reviewJob.jobId);
  } catch (e) {
    console.warn(`[${nowIso()}] maybeDispatchIndependentReview failed: ${e.message}`);
  }
}
