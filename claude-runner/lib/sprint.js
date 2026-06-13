// sprint.js — sprint runner, agent-label dispatch/reconciliation, dependency gating
// Extracted from runner.js.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const {
  IDEMPOTENCY_TTL_HOURS,
  LOG_DIR,
  MAX_RETRIES,
  N8N_CALLBACK_URL,
  config,
} = require("./config");
const { idempotencyStore, pruneIdempotency, saveIdempotency } = require("./idempotency");
const { jiraAgileGet, jiraAgilePost, jiraRestGet, transitionIssueToInProgress } = require("./jira");
const { products, resolveProductForIssueKey, resolveProductWorkingDir } = require("./products");
const { jobEmitter, jobs, pipelines } = require("./state");
const { getJson, makeJobId, nowIso } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  getBlockingDependencies,
  getUnmergedBlockers,
  tickDependencyChecker,
  tickSprintRunner,
  dispatchAgentLabelsForIssue,
  tickAgentLabelReconciler,
};

const { createPipeline, executePipelinePhase } = require("./pipelines");
const { enqueue } = require("./worker");
const { isBranchMergedToTrunk } = require("./worktrees");
const { listPipelineRoutingRules } = require("./pipeline-definitions");

/**
 * Resolve the pipeline type for an issue using configured routing rules.
 * Rules are evaluated in order; the first match wins.
 * Falls back to null if no rule matches or the config is unreadable.
 *
 * @param {string} issueType  — e.g. "bug", "story", "sub-task"
 * @param {string[]} labels   — issue label array
 * @returns {string|null}
 */
function resolvePipelineType(issueType, labels) {
  try {
    const rules = listPipelineRoutingRules();
    for (const rule of rules) {
      const m = rule.match || {};
      const typeMatch = !m.issueType || m.issueType === issueType;
      const labelMatch = !m.labels?.length || m.labels.every(l => labels.includes(l));
      if (typeMatch && labelMatch) return rule.pipelineType;
    }
  } catch { /* config unreadable — fall through */ }
  return null;
}


// ─── Sprint Runner ──────────────────────────────────────────────────────────
// Periodically scans active sprints across all products and dispatches
// "To Do" issues as pipelines or direct agent jobs.
// ─────────────────────────────────────────────────────────────────────────────

const SPRINT_RUNNER_PRIORITY_ORDER = ["Highest", "High", "Medium", "Low", "Lowest"];

function getBlockingDependencies(issue) {
  const blockers = [];
  const links = issue.fields?.issuelinks || [];
  for (const link of links) {
    // inwardIssue with "Blocks" type means "this issue is blocked by inwardIssue"
    // (inwardIssue is the prerequisite that must finish first)
    if (link.type?.name === "Blocks" && link.inwardIssue) {
      const depStatus = link.inwardIssue.fields?.status?.name || "";
      if (depStatus.toLowerCase() !== "done") {
        blockers.push({ key: link.inwardIssue.key, status: depStatus, type: "blocked-by" });
      }
    }
    // outwardIssue with "Blocks" type means "this issue blocks outwardIssue"
    // — that is NOT a blocker of this issue, so we skip it
  }
  return blockers;
}


/**
 * Get unmerged blocking dependencies for an issue.
 * Fetches Jira issue links and checks both Jira status AND git merge status.
 * Returns array of { key, status, reason, detail } for each unresolved blocker.
 */
async function getUnmergedBlockers(issueKey, baseRepo) {
  if (!config.dependencyGating?.enabled) return [];

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return [];

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  try {
    const issueRes = await getJson(
      `${baseUrl}/rest/api/3/issue/${issueKey}?fields=issuelinks`,
      headers
    );
    if (issueRes.statusCode !== 200) return [];

    const links = issueRes.json?.fields?.issuelinks || [];
    const blockers = [];

    for (const link of links) {
      // "is blocked by" = inwardIssue with "Blocks" type
      if (link.type?.name === "Blocks" && link.inwardIssue) {
        const blockerKey = link.inwardIssue.key;
        const blockerStatus = link.inwardIssue.fields?.status?.name || "";

        if (blockerStatus.toLowerCase() === "done") {
          // Blocker is Done in Jira — verify branch is actually merged to a trunk (dev or main)
          if (config.dependencyGating?.checkGitMerge !== false) {
            const merged = isBranchMergedToTrunk(baseRepo, blockerKey);
            if (!merged) {
              blockers.push({
                key: blockerKey,
                status: blockerStatus,
                reason: "done-but-not-merged",
                detail: `${blockerKey} is Done but branch not merged to dev or main`
              });
            }
          }
          // If merged, blocker is cleared
        } else {
          blockers.push({
            key: blockerKey,
            status: blockerStatus,
            reason: "not-done",
            detail: `${blockerKey} status: ${blockerStatus}`
          });
        }
      }
    }

    return blockers;
  } catch (e) {
    console.log(`[${nowIso()}] Dependency check failed for ${issueKey}: ${e.message}`);
    return []; // Fail open
  }
}

/**
 * Periodic checker: unblock pipelines whose dependencies have resolved.
 * Runs every N seconds when dependency gating is enabled.
 */
async function tickDependencyChecker() {
  if (!config.dependencyGating?.enabled) return;

  const maxBlockedMs = (config.dependencyGating.maxBlockedMinutes || 120) * 60 * 1000;

  for (const pipeline of pipelines.values()) {
    if (pipeline.status !== "blocked") continue;

    const blockedPhase = pipeline.phases.find(p => p.status === "blocked");
    if (!blockedPhase) {
      // Stale blocked status — fix it
      pipeline.status = "running";
    
      continue;
    }

    // Check if blocked too long — fail the pipeline
    const blockedSince = blockedPhase.blockedAt ? new Date(blockedPhase.blockedAt).getTime() : 0;
    if (blockedSince && (Date.now() - blockedSince) > maxBlockedMs) {
      const blockerStr = (blockedPhase.blockedBy || []).map(b => `${b.key} (${b.detail})`).join(", ");
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} TIMED OUT waiting on: ${blockerStr}`);
      blockedPhase.status = "failed";
      blockedPhase.error = `Dependency timeout: waited ${config.dependencyGating.maxBlockedMinutes}m for ${blockerStr}`;
      pipeline.status = "failed";
      pipeline.error = blockedPhase.error;
      pipeline.completedAt = nowIso();
    

      jobEmitter.emit("pipeline:failed", {
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        reason: "dependency-timeout",
        blockedBy: blockedPhase.blockedBy,
      });
      continue;
    }

    // Re-check blockers
    const blockers = await getUnmergedBlockers(pipeline.issueKey, pipeline.workingDir);
    if (blockers.length === 0) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} UNBLOCKED: all dependencies merged for ${pipeline.issueKey}`);

      blockedPhase.status = "pending";
      blockedPhase.blockedBy = null;
      blockedPhase.blockedAt = null;
      pipeline.status = "running";
    

      jobEmitter.emit("pipeline:unblocked", {
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        phase: blockedPhase.name,
      });

      // Resume pipeline from the unblocked phase
      executePipelinePhase(pipeline, blockedPhase.index);
    } else {
      const blockerStr = blockers.map(b => b.key).join(", ");
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} still blocked: waiting on ${blockerStr}`);
    }
  }
}

async function tickSprintRunner() {
  const srConfig = config.sprintRunner || {};
  if (!srConfig.enabled) return;

  const { email, apiToken } = config.jira || {};
  if (!email || !apiToken) {
    console.log(`[sprint-runner] Skipped: JIRA credentials not configured`);
    return;
  }

  const dispatchStatuses = (srConfig.dispatchStatuses || ["To Do"]).map(s => s.toLowerCase());
  const skipLabels = srConfig.skipLabels || ["on-hold", "blocked"];
  const maxPerCycle = srConfig.maxDispatchPerCycle || 5;
  const dryRun = srConfig.dryRun || false;
  const agentLabels = config.agentLabels || {};

  for (const [productId, product] of products) {
    const sprintCfg = product.sprint;
    if (!sprintCfg?.enabled) continue;

    const boardId = sprintCfg.boardId || product.jira?.boardId;
    if (!boardId) {
      console.log(`[sprint-runner] Product ${productId}: no boardId configured, skipping`);
      continue;
    }

    try {
      // 1. Get active sprint
      const sprintRes = await jiraAgileGet(`/board/${boardId}/sprint?state=active`);
      if (!sprintRes || sprintRes.statusCode !== 200) {
        console.log(`[sprint-runner] Product ${productId}: failed to get active sprint (${sprintRes?.statusCode || "no response"})`);
        continue;
      }
      const activeSprints = sprintRes.json?.values || [];
      if (activeSprints.length === 0) {
        console.log(`[sprint-runner] Product ${productId}: no active sprint`);
        continue;
      }
      const sprint = activeSprints[0];

      // 2. Get sprint issues (Agile API returns top-level only, so we also fetch subtasks)
      const issueRes = await jiraAgileGet(`/sprint/${sprint.id}/issue?fields=summary,status,issuetype,labels,priority,issuelinks,parent&maxResults=50`);
      if (!issueRes || issueRes.statusCode !== 200) {
        console.log(`[sprint-runner] Product ${productId}: failed to get sprint issues (${issueRes?.statusCode || "no response"})`);
        continue;
      }
      const topLevelIssues = issueRes.json?.issues || [];
      // Fetch subtasks for each parent to include them (Agile API omits sub-tasks)
      const allIssues = [...topLevelIssues];
      const seenKeys = new Set(topLevelIssues.map(i => i.key));
      for (const issue of topLevelIssues) {
        try {
          const detail = await jiraRestGet(`/issue/${issue.key}?fields=subtasks`);
          if (detail?.statusCode === 200 && detail.json?.fields?.subtasks?.length) {
            for (const st of detail.json.fields.subtasks) {
              if (!seenKeys.has(st.key)) {
                // Fetch full subtask details for dispatch
                const stDetail = await jiraRestGet(`/issue/${st.key}?fields=summary,status,issuetype,labels,priority,issuelinks,parent`);
                if (stDetail?.statusCode === 200 && stDetail.json) {
                  allIssues.push(stDetail.json);
                  seenKeys.add(st.key);
                }
              }
            }
          }
        } catch (e) { /* skip on error, orphan detection below will catch it */ }
      }

      // 3. Filter to dispatchable issues
      // Build set of parent keys that have subtasks in the sprint — skip these parents
      const parentKeysWithSubtasks = new Set();
      const subtaskKeysInSprint = new Set();
      for (const issue of allIssues) {
        const parentKey = issue.fields?.parent?.key;
        if (parentKey) {
          parentKeysWithSubtasks.add(parentKey);
          subtaskKeysInSprint.add(issue.key);
        }
      }

      // Pull orphan subtasks into parent's sprint.
      // For each parent story IN the sprint, check if it has subtasks NOT in the sprint and move them in.
      let movedSubtasks = false;
      for (const issue of allIssues) {
        const issueType = (issue.fields?.issuetype?.name || "").toLowerCase();
        if (issueType === "sub-task" || issueType === "subtask") continue; // skip subtasks themselves
        // Check if this parent story has subtasks at all (via REST API subtasks field)
        try {
          const parentDetail = await jiraRestGet(`/issue/${issue.key}?fields=subtasks`);
          if (parentDetail?.statusCode === 200 && parentDetail.json?.fields?.subtasks?.length) {
            const allSubtasks = parentDetail.json.fields.subtasks;
            const orphans = allSubtasks.filter(st => !subtaskKeysInSprint.has(st.key));
            if (orphans.length > 0) {
              const orphanKeys = orphans.map(st => st.key);
              console.log(`[sprint-runner] Parent ${issue.key} has ${orphans.length} subtask(s) not in sprint: ${orphanKeys.join(", ")}`);
              // Move orphan subtasks into this sprint
              const moveRes = await jiraAgilePost(`/sprint/${sprint.id}/issue`, { issues: orphanKeys });
              if (moveRes && (moveRes.statusCode === 204 || moveRes.statusCode === 200)) {
                console.log(`[sprint-runner] Moved ${orphanKeys.join(", ")} into sprint ${sprint.id} (${sprint.name})`);
                movedSubtasks = true;
                for (const key of orphanKeys) {
                  parentKeysWithSubtasks.add(issue.key);
                  subtaskKeysInSprint.add(key);
                }
              } else {
                console.log(`[sprint-runner] Failed to move subtasks for ${issue.key}: ${moveRes?.statusCode || "no response"}`);
              }
            }
          }
        } catch (e) {
          console.log(`[sprint-runner] Error checking subtasks for ${issue.key}: ${e.message}`);
        }
      }

      // After moving orphans, fetch their details and add to the issue list
      let sprintIssues = allIssues;
      if (movedSubtasks) {
        // Re-scan all parents for newly moved subtasks
        for (const issue of topLevelIssues) {
          try {
            const detail = await jiraRestGet(`/issue/${issue.key}?fields=subtasks`);
            if (detail?.statusCode === 200 && detail.json?.fields?.subtasks?.length) {
              for (const st of detail.json.fields.subtasks) {
                if (!seenKeys.has(st.key)) {
                  const stDetail = await jiraRestGet(`/issue/${st.key}?fields=summary,status,issuetype,labels,priority,issuelinks,parent`);
                  if (stDetail?.statusCode === 200 && stDetail.json) {
                    sprintIssues.push(stDetail.json);
                    seenKeys.add(st.key);
                  }
                }
              }
            }
          } catch (e) { /* skip */ }
        }
      }

      const candidates = sprintIssues.filter(issue => {
        const statusName = (issue.fields?.status?.name || "").toLowerCase();
        if (!dispatchStatuses.includes(statusName)) return false;

        const labels = (issue.fields?.labels || []).map(l => l.toLowerCase());
        if (skipLabels.some(sl => labels.includes(sl.toLowerCase()))) return false;

        // Skip parent stories that have subtasks — only dispatch the subtasks
        const issueType = (issue.fields?.issuetype?.name || "").toLowerCase();
        if (issueType !== "sub-task" && issueType !== "subtask" && parentKeysWithSubtasks.has(issue.key)) {
          console.log(`[sprint-runner] Skipping parent ${issue.key}: has subtasks in sprint — dispatch subtasks instead`);
          return false;
        }

        return true;
      });

      // 4. Check dependencies and sort by priority
      const workingDir = resolveProductWorkingDir(product);
      const dispatchable = [];
      const blocked = [];
      for (const issue of candidates) {
        const blockers = getBlockingDependencies(issue);
        if (blockers.length > 0) {
          blocked.push({ key: issue.key, blockers });
        } else if (config.dependencyGating?.enabled && config.dependencyGating?.checkGitMerge !== false && workingDir) {
          // Additional check: verify "Done" blockers' branches are actually merged to a trunk (dev or main)
          const links = issue.fields?.issuelinks || [];
          const unmergedDone = [];
          for (const link of links) {
            if (link.type?.name === "Blocks" && link.inwardIssue) {
              const depStatus = (link.inwardIssue.fields?.status?.name || "").toLowerCase();
              if (depStatus === "done") {
                const depKey = link.inwardIssue.key;
                if (!isBranchMergedToTrunk(workingDir, depKey)) {
                  unmergedDone.push({ key: depKey, status: "Done (not merged)", type: "done-but-not-merged" });
                }
              }
            }
          }
          if (unmergedDone.length > 0) {
            blocked.push({ key: issue.key, blockers: unmergedDone });
          } else {
            dispatchable.push(issue);
          }
        } else {
          dispatchable.push(issue);
        }
      }

      // Log blocked issues
      for (const b of blocked) {
        const blockerStr = b.blockers.map(bl => `${bl.key} (${bl.status})`).join(", ");
        console.log(`[sprint-runner] Skipping ${b.key}: blocked by ${blockerStr}`);
      }

      // Sort by priority (Highest first)
      dispatchable.sort((a, b) => {
        const pa = SPRINT_RUNNER_PRIORITY_ORDER.indexOf(a.fields?.priority?.name || "Medium");
        const pb = SPRINT_RUNNER_PRIORITY_ORDER.indexOf(b.fields?.priority?.name || "Medium");
        return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
      });

      // 5. Dispatch (up to maxPerCycle)
      if (!workingDir) {
        console.log(`[sprint-runner] Product ${productId}: no workingDir configured, skipping dispatch`);
        continue;
      }

      let dispatched = 0;
      for (const issue of dispatchable) {
        if (dispatched >= maxPerCycle) break;

        const issueKey = issue.key;
        const idempotencyKey = `sprint-run:${issueKey}`;

        // Check idempotency
        pruneIdempotency(idempotencyStore);
        db.idempotency.prune(IDEMPOTENCY_TTL_HOURS).catch(e => console.error('[db] idempotency prune failed: ' + e.message));
        if (idempotencyStore[idempotencyKey]) {
          console.log(`[sprint-runner] SKIP ${issueKey}: idempotency hit (key: ${idempotencyKey})`);
          continue; // Already dispatched recently
        }

        // Check if job already queued/running for this issue
        let alreadyActive = false;
        let activeReason = "";
        for (const j of jobs.values()) {
          if (j.issueKey === issueKey && (j.status === "queued" || j.status === "running")) {
            alreadyActive = true;
            activeReason = `job ${j.id} status=${j.status} agent=${j.agent}`;
            break;
          }
        }
        // Check active pipelines too
        if (!alreadyActive) {
          for (const p of pipelines.values()) {
            if (p.issueKey === issueKey && !["completed", "failed"].includes(p.status)) {
              alreadyActive = true;
              activeReason = `pipeline ${p.pipelineId} status=${p.status}`;
              break;
            }
          }
        }
        if (alreadyActive) {
          console.log(`[sprint-runner] SKIP ${issueKey}: already active — ${activeReason}`);
          continue;
        }

        const issueType = (issue.fields?.issuetype?.name || "").toLowerCase();
        const labels = issue.fields?.labels || [];
        const telegram = product.telegram?.chatId ? { chatId: String(product.telegram.chatId) } : null;

        // --- Gate label enforcement ---
        // Gate labels (needs-requirements, needs-architecture, needs-ux-design) are applied
        // per-subtask at creation time by the planner/PM agent. No propagation from parent.
        // Route to the appropriate gate agent for the specific issue that needs it.
        const GATE_LABEL_TO_AGENT = {
          "needs-requirements": "ba-agent",
          "needs-ux-design": "ux-agent",
          "needs-architecture": "architect",
        };
        const isSubtask = issueType === "sub-task" || issueType === "subtask";
        const gateLabels = labels.filter(l => GATE_LABEL_TO_AGENT[l]);

        if (gateLabels.length > 0) {
          // Route to the first gate agent (priority: requirements > architecture > ux)
          const gateOrder = ["needs-requirements", "needs-architecture", "needs-ux-design"];
          const firstGate = gateOrder.find(g => gateLabels.includes(g)) || gateLabels[0];
          const gateAgent = GATE_LABEL_TO_AGENT[firstGate];

          if (dryRun) {
            console.log(`[sprint-runner] DRY RUN: Would dispatch ${issueKey} → gate agent:${gateAgent} (label: ${firstGate}, product: ${productId})`);
          } else {
            // Dispatch gate agent against this specific issue (subtask or story)
            const jobId = makeJobId();
            const logFile = path.join(LOG_DIR, `${jobId}.log`);
            const metaFile = path.join(LOG_DIR, `${jobId}.json`);
            const job = {
              jobId,
              mode: "delivery",
              issueKey: String(issueKey),
              summary: issue.fields?.summary || "",
              description: "",
              workingDir,
              agent: gateAgent,
              model: config.routing?.agentToModel?.[gateAgent] || null,
              requestedProvider: null,
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
              callbackUrl: N8N_CALLBACK_URL || null,
              slack: null,
              telegram,
              batchId: null,
              parentKey: isSubtask ? (issue.fields?.parent?.key || null) : null,
              subtaskFiles: null,
              subtaskDepth: 0,
              isSubtask,
              source: "sprint-runner",
              gateLabel: firstGate,
              allGateLabels: gateLabels,
              teamSessionId: null,
              teamRole: null,
              teammates: [],
            };
            jobs.set(jobId, job);
            db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
            fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");
            enqueue(jobId);
            console.log(`[sprint-runner] Dispatched ${issueKey} → gate agent:${gateAgent} (label: ${firstGate}, job: ${jobId}, product: ${productId})`);
          }

          idempotencyStore[idempotencyKey] = { jobId: `sprint-${issueKey}`, createdAt: Date.now() };
          db.idempotency.set(idempotencyKey, `sprint-${issueKey}`).catch(e => console.error('[db] idempotency persist failed: ' + e.message));
          saveIdempotency(idempotencyStore);
          dispatched++;
          continue; // Skip normal dispatch — gate agent handles this issue first
        }

        // Check for direct agent label (agent:*)
        const agentLabel = labels.find(l => agentLabels[l]);
        const agentName = agentLabel ? agentLabels[agentLabel] : null;

        // Implementation agents route through pipeline (implement → code-review → verify)
        // Non-implementation agents (architect, PM, etc.) stay as direct dispatch
        const pipelineAgents = new Set(["engineer-implementer", "ui-engineer", "e2e-builder", "qa-agent", "security-agent"]);
        const routeToPipeline = agentName && pipelineAgents.has(agentName);

        try {
          // Safety net: before creating a pipeline for a non-subtask issue,
          // check if it already has subtasks. If so, skip pipeline and pull subtasks into sprint.
          if (!dryRun && issueType !== "sub-task" && issueType !== "subtask" && !agentName) {
            try {
              const parentCheck = await jiraRestGet(`/issue/${issueKey}?fields=subtasks`);
              const existingSubs = parentCheck?.statusCode === 200 ? (parentCheck.json?.fields?.subtasks || []) : [];
              if (existingSubs.length > 0) {
                console.log(`[sprint-runner] ${issueKey} has ${existingSubs.length} existing subtask(s) — skipping pipeline, ensuring subtasks are in sprint`);
                const toMove = existingSubs.map(st => st.key).filter(k => !subtaskKeysInSprint.has(k));
                if (toMove.length > 0) {
                  const moveRes = await jiraAgilePost(`/sprint/${sprint.id}/issue`, { issues: toMove });
                  if (moveRes && (moveRes.statusCode === 204 || moveRes.statusCode === 200)) {
                    console.log(`[sprint-runner] Moved ${toMove.join(", ")} into sprint ${sprint.id} (${sprint.name})`);
                  } else {
                    console.log(`[sprint-runner] Warning: failed to move subtasks for ${issueKey}: ${moveRes?.statusCode}`);
                  }
                }
                // Transition parent to In Progress so it's not re-picked up
                await transitionIssueToInProgress(issueKey);
                idempotencyStore[idempotencyKey] = { jobId: `sprint-${issueKey}`, createdAt: Date.now() };
                db.idempotency.set(idempotencyKey, `sprint-${issueKey}`).catch(e => console.error('[db] idempotency persist failed: ' + e.message));
                saveIdempotency(idempotencyStore);
                dispatched++;
                continue; // Skip pipeline — subtasks will dispatch on next tick
              }
            } catch (e) {
              console.log(`[sprint-runner] Warning: subtask check failed for ${issueKey}: ${e.message} — falling through to normal dispatch`);
            }
          }

          if (dryRun) {
            const dispatchType = routeToPipeline ? `pipeline (agent:${agentName})` : agentName ? `agent:${agentName}` : issueType === "bug" ? "bug-fix pipeline" : "new-feature pipeline";
            console.log(`[sprint-runner] DRY RUN: Would dispatch ${issueKey} as ${dispatchType} (product: ${productId})`);
          } else if (agentName && !routeToPipeline) {
            // Direct agent dispatch (non-implementation agents only)
            const jobId = makeJobId();
            const logFile = path.join(LOG_DIR, `${jobId}.log`);
            const metaFile = path.join(LOG_DIR, `${jobId}.json`);
            const job = {
              jobId,
              mode: "delivery",
              issueKey: String(issueKey),
              summary: issue.fields?.summary || "",
              description: "",
              workingDir,
              agent: agentName,
              model: config.routing?.agentToModel?.[agentName] || null,
              requestedProvider: null,
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
              callbackUrl: N8N_CALLBACK_URL || null,
              slack: null,
              telegram,
              batchId: null,
              parentKey: issue.fields?.parent?.key || null,
              subtaskFiles: null,
              subtaskDepth: 0,
              isSubtask: issueType === "sub-task" || issueType === "subtask",
              source: "sprint-runner",
              teamSessionId: null,
              teamRole: null,
              teammates: [],
            };
            // Populate team metadata if this agent is a team lead
            if (config.teams?.enabled && config.teams.teamLeads?.[job.agent]) {
              job.teamSessionId = `team-${jobId}`;
              job.teamRole = "lead";
              job.teammates = config.teams.teamLeads[job.agent].teammates || [];
            }
            jobs.set(jobId, job);
            db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
            fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");
            enqueue(jobId);
            console.log(`[sprint-runner] Dispatched ${issueKey} → agent:${agentName} (job: ${jobId}, product: ${productId})`);
          } else if (routeToPipeline) {
            // Implementation agents route through lean pipeline with agent override
            const pipelineType = resolvePipelineType(issueType, labels) || (issueType === "bug" ? "bug-fix" : "new-feature");
            const parentKey = issue.fields?.parent?.key || null;
            const pipeline = await createPipeline(issueKey, pipelineType, {
              workingDir,
              labels,
              telegram,
              parentKey,
            });
            console.log(`[sprint-runner] Dispatched ${issueKey} → ${pipelineType} pipeline ${pipeline.pipelineId} with agent override ${agentName}${parentKey ? ` (parent: ${parentKey})` : ""} (product: ${productId})`);
          } else if (issueType === "bug" && isSubtask) {
            const parentKey = issue.fields?.parent?.key || null;
            const bugPipelineType = resolvePipelineType(issueType, labels) || "bug-fix";
            const pipeline = await createPipeline(issueKey, bugPipelineType, {
              workingDir,
              labels,
              telegram,
              parentKey,
            });
            console.log(`[sprint-runner] Dispatched ${issueKey} → ${bugPipelineType} pipeline ${pipeline.pipelineId}${parentKey ? ` (parent: ${parentKey})` : ""} (product: ${productId})`);
          } else if (issueType === "bug" && !isSubtask) {
            // Parent bug → send to bug-triage agent for analysis first
            const jobId = makeJobId();
            const logFile = path.join(LOG_DIR, `${jobId}.log`);
            const metaFile = path.join(LOG_DIR, `${jobId}.json`);
            const job = {
              jobId,
              mode: "delivery",
              issueKey: String(issueKey),
              summary: issue.fields?.summary || "",
              description: "",
              workingDir,
              agent: "bug-triage",
              model: config.routing?.agentToModel?.["bug-triage"] || null,
              requestedProvider: null,
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
              callbackUrl: N8N_CALLBACK_URL || null,
              slack: null,
              telegram,
              batchId: null,
              parentKey: null,
              subtaskFiles: null,
              subtaskDepth: 0,
              isSubtask: false,
              source: "sprint-runner",
              teamSessionId: null,
              teamRole: null,
              teammates: [],
            };
            jobs.set(jobId, job);
            db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
            fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");
            enqueue(jobId);
            console.log(`[sprint-runner] Dispatched ${issueKey} → bug-triage for analysis (job: ${jobId}, product: ${productId})`);
          } else if (labels.includes("needs-design-system")) {
            // Design system bootstrap pipeline
            const pipeline = await createPipeline(issueKey, "design-bootstrap", {
              workingDir,
              labels,
              telegram,
            });
            console.log(`[sprint-runner] Dispatched ${issueKey} → design-bootstrap pipeline ${pipeline.pipelineId} (product: ${productId})`);
          } else if (isSubtask) {
            // Subtask without agent label → new-feature pipeline (or routing-rule override)
            const parentKey = issue.fields?.parent?.key || null;
            const subtaskPipelineType = resolvePipelineType(issueType, labels) || "new-feature";
            const pipeline = await createPipeline(issueKey, subtaskPipelineType, {
              workingDir,
              labels,
              telegram,
              parentKey,
            });
            console.log(`[sprint-runner] Dispatched ${issueKey} → ${subtaskPipelineType} pipeline ${pipeline.pipelineId}${parentKey ? ` (parent: ${parentKey})` : ""} (product: ${productId})`);
          } else {
            // Parent Story/Task with no subtasks → send to engineer-planner for decomposition
            const jobId = makeJobId();
            const logFile = path.join(LOG_DIR, `${jobId}.log`);
            const metaFile = path.join(LOG_DIR, `${jobId}.json`);
            const job = {
              jobId,
              mode: "delivery",
              issueKey: String(issueKey),
              summary: issue.fields?.summary || "",
              description: "",
              workingDir,
              agent: "engineer-planner",
              model: config.routing?.agentToModel?.["engineer-planner"] || null,
              requestedProvider: null,
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
              callbackUrl: N8N_CALLBACK_URL || null,
              slack: null,
              telegram,
              batchId: null,
              parentKey: null,
              subtaskFiles: null,
              subtaskDepth: 0,
              isSubtask: false,
              source: "sprint-runner",
              teamSessionId: null,
              teamRole: null,
              teammates: [],
            };
            // Planner is a team lead — activate team session
            if (config.teams?.enabled && config.teams.teamLeads?.["engineer-planner"]) {
              job.teamSessionId = `team-${jobId}`;
              job.teamRole = "lead";
              job.teammates = config.teams.teamLeads["engineer-planner"].teammates || [];
            }
            jobs.set(jobId, job);
            db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
            fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");
            enqueue(jobId);
            console.log(`[sprint-runner] Dispatched ${issueKey} → engineer-planner for decomposition (job: ${jobId}, product: ${productId})`);
          }

          // Set idempotency key
          idempotencyStore[idempotencyKey] = { jobId: `sprint-${issueKey}`, createdAt: Date.now() };
          db.idempotency.set(idempotencyKey, `sprint-${issueKey}`).catch(e => console.error('[db] idempotency persist failed: ' + e.message));
          saveIdempotency(idempotencyStore);

          // Transition to In Progress to prevent re-dispatch
          await transitionIssueToInProgress(issueKey);

          // Emit SSE event
          jobEmitter.emit("sprint-runner:dispatched", {
            issueKey,
            productId,
            issueType,
            agent: agentName || null,
            pipelineType: agentName ? null : (labels.includes("needs-design-system") ? "design-bootstrap" : (issueType === "bug" ? "bug-fix" : "new-feature")),
            dryRun,
          });

          dispatched++;
        } catch (e) {
          console.error(`[sprint-runner] Error dispatching ${issueKey}: ${e.message}`);
        }
      }

      console.log(`[sprint-runner] Product ${productId}: ${dispatched} dispatched, ${blocked.length} blocked by dependencies, ${candidates.length - dispatched - blocked.length} skipped (idempotency/active)`);
    } catch (e) {
      console.error(`[sprint-runner] Product ${productId} error: ${e.message}`);
    }
  }
}

/**
 * Dispatch any agent:* labels currently on a Jira issue that aren't already
 * being worked. This is the core of the agent-label reconciler — used both
 * by the periodic sweep (B) and the post-job-completion hot path (A).
 *
 * @param {string} issueKey - Jira issue key (e.g., "PROJ-123")
 * @param {object} opts
 * @param {string} [opts.excludeAgent] - Skip this agent (avoid self-redispatch when called from job completion)
 * @param {string} [opts.reason] - Logged with dispatch (e.g., "post-job-completion", "reconciler-sweep")
 * @param {object} [opts.preloadedIssue] - Issue JSON if already fetched, avoids extra REST call
 * @returns {Promise<{dispatched: string[], skipped: string[]}>}
 */
async function dispatchAgentLabelsForIssue(issueKey, opts = {}) {
  const { excludeAgent, reason = "agent-label-reconciler", preloadedIssue } = opts;
  const result = { dispatched: [], skipped: [] };

  const resolved = resolveProductForIssueKey(issueKey);
  if (!resolved) {
    result.skipped.push(`${issueKey}: no product matches project key`);
    return result;
  }
  const { productId, product } = resolved;
  const workingDir = resolveProductWorkingDir(product);
  if (!workingDir) {
    result.skipped.push(`${issueKey}: product ${productId} has no workingDir`);
    return result;
  }

  let issue = preloadedIssue;
  if (!issue) {
    const res = await jiraRestGet(`/issue/${issueKey}?fields=summary,status,issuetype,labels,priority,parent`);
    if (!res || res.statusCode !== 200) {
      result.skipped.push(`${issueKey}: failed to fetch (${res?.statusCode || "no response"})`);
      return result;
    }
    issue = res.json;
  }

  const statusName = (issue.fields?.status?.name || "").toLowerCase();
  const statusCategory = (issue.fields?.status?.statusCategory?.key || "").toLowerCase();
  if (statusName === "done" || statusName === "closed" || statusCategory === "done") {
    result.skipped.push(`${issueKey}: status is ${statusName}`);
    return result;
  }

  const issueLabels = issue.fields?.labels || [];
  const skipLabels = config.agentLabelReconciler?.skipLabels || [];
  const lowerIssueLabels = issueLabels.map(l => l.toLowerCase());
  const matchedSkipLabel = skipLabels.find(sl => {
    const pattern = sl.toLowerCase();
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return lowerIssueLabels.some(l => l.startsWith(prefix));
    }
    return lowerIssueLabels.includes(pattern);
  });
  if (matchedSkipLabel) {
    result.skipped.push(`${issueKey}: has skip-label (${matchedSkipLabel})`);
    return result;
  }

  const agentLabelMap = config.agentLabels || {};
  const matchedLabels = issueLabels.filter(l => agentLabelMap[l]);
  if (matchedLabels.length === 0) {
    result.skipped.push(`${issueKey}: no agent:* labels`);
    return result;
  }

  for (const label of matchedLabels) {
    const agentName = agentLabelMap[label];
    if (excludeAgent && agentName === excludeAgent) {
      result.skipped.push(`${issueKey}/${agentName}: excludeAgent`);
      continue;
    }

    // Check for an active (non-terminal) job on this issue+agent
    let activeJob = null;
    for (const j of jobs.values()) {
      if (j.issueKey === issueKey && j.agent === agentName &&
          ["queued", "running", "retry-pending"].includes(j.status)) {
        activeJob = j;
        break;
      }
    }
    if (activeJob) {
      result.skipped.push(`${issueKey}/${agentName}: active job ${activeJob.jobId} (${activeJob.status})`);
      continue;
    }

    // Check for an active pipeline phase running this agent for this issue
    let activePipelinePhase = null;
    for (const p of pipelines.values()) {
      if (p.issueKey === issueKey && ["running", "blocked"].includes(p.status)) {
        const ph = p.phases?.find(ph => ph.agent === agentName && ["running", "pending"].includes(ph.status));
        if (ph) { activePipelinePhase = { pipelineId: p.pipelineId, phase: ph.name }; break; }
      }
    }
    if (activePipelinePhase) {
      result.skipped.push(`${issueKey}/${agentName}: active pipeline ${activePipelinePhase.pipelineId} phase ${activePipelinePhase.phase}`);
      continue;
    }

    // Idempotency — separate namespace from sprint-runner
    const idempotencyKey = `agent-label:${issueKey}:${agentName}`;
    const ttlMs = (config.agentLabelReconciler?.idempotencyMinutes || 30) * 60 * 1000;
    const existing = idempotencyStore[idempotencyKey];
    if (existing && (Date.now() - new Date(existing.createdAt).getTime()) < ttlMs) {
      result.skipped.push(`${issueKey}/${agentName}: idempotency hit (${idempotencyKey})`);
      continue;
    }

    const issueType = (issue.fields?.issuetype?.name || "").toLowerCase();
    const isSubtask = issueType === "sub-task" || issueType === "subtask";
    const telegram = product.telegram?.chatId ? { chatId: String(product.telegram.chatId) } : null;

    const jobId = makeJobId();
    const logFile = path.join(LOG_DIR, `${jobId}.log`);
    const metaFile = path.join(LOG_DIR, `${jobId}.json`);
    const job = {
      jobId,
      mode: "delivery",
      issueKey: String(issueKey),
      summary: issue.fields?.summary || "",
      description: "",
      workingDir,
      agent: agentName,
      model: config.routing?.agentToModel?.[agentName] || null,
      requestedProvider: null,
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
      callbackUrl: N8N_CALLBACK_URL || null,
      slack: null,
      telegram,
      batchId: null,
      parentKey: isSubtask ? (issue.fields?.parent?.key || null) : null,
      subtaskFiles: null,
      subtaskDepth: 0,
      isSubtask,
      source: `agent-label-reconciler:${reason}`,
      teamSessionId: null,
      teamRole: null,
      teammates: [],
    };
    jobs.set(jobId, job);
    db.jobs.set(job).catch(e => console.error(`[db] Failed to persist reconciler job ${jobId}: ${e.message}`));
    fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");

    idempotencyStore[idempotencyKey] = { jobId, createdAt: nowIso() };
    db.idempotency.set(idempotencyKey, jobId).catch(e => console.error('[db] idempotency persist failed: ' + e.message));
    saveIdempotency(idempotencyStore);

    enqueue(jobId);
    console.log(`[agent-label-reconciler] Dispatched ${issueKey} → ${agentName} (job: ${jobId}, label: ${label}, reason: ${reason}, product: ${productId})`);
    result.dispatched.push(`${issueKey}/${agentName}`);
  }
  return result;
}

/**
 * Periodic sweep: scan every product's Jira project for issues with agent:*
 * labels that are not Done. Dispatches anything the sprint-runner missed
 * (in-flight issues, webhook drops, manual labels).
 */
async function tickAgentLabelReconciler() {
  const cfg = config.agentLabelReconciler || {};
  if (!cfg.enabled) return;

  const { email, apiToken } = config.jira || {};
  if (!email || !apiToken) {
    console.log(`[agent-label-reconciler] Skipped: JIRA credentials not configured`);
    return;
  }

  const agentLabelMap = config.agentLabels || {};
  const labelKeys = Object.keys(agentLabelMap);
  if (labelKeys.length === 0) return;

  const lookbackDays = cfg.lookbackDays || 14;
  const maxPerProduct = cfg.maxPerProductCycle || 10;

  for (const [productId, product] of products) {
    const projectKey = product.jira?.projectKey;
    if (!projectKey) continue;
    try {
      const labelClause = labelKeys.map(l => `"${l}"`).join(", ");
      const jql = encodeURIComponent(
        `project = ${projectKey} AND statusCategory != Done AND labels in (${labelClause}) AND updated > -${lookbackDays}d ORDER BY updated DESC`
      );
      const res = await jiraRestGet(`/search/jql?jql=${jql}&fields=summary,status,issuetype,labels,priority,parent&maxResults=${maxPerProduct}`);
      if (!res || res.statusCode !== 200) {
        console.log(`[agent-label-reconciler] Product ${productId}: search failed (${res?.statusCode || "no response"})`);
        continue;
      }
      const issues = res.json?.issues || [];
      let dispatchedCount = 0, skippedCount = 0;
      for (const issue of issues) {
        const r = await dispatchAgentLabelsForIssue(issue.key, {
          reason: "reconciler-sweep",
          preloadedIssue: issue,
        });
        dispatchedCount += r.dispatched.length;
        skippedCount += r.skipped.length;
      }
      if (dispatchedCount > 0 || issues.length > 0) {
        console.log(`[agent-label-reconciler] Product ${productId}: scanned ${issues.length} issue(s), dispatched ${dispatchedCount}, skipped ${skippedCount}`);
      }
    } catch (e) {
      console.error(`[agent-label-reconciler] Product ${productId} error: ${e.message}`);
    }
  }
}
