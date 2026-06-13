// jira.js — Jira REST/Agile API helpers and issue transitions
// Extracted from runner.js.

const http = require("http");
const https = require("https");
const { config } = require("./config");
const { getJson, nowIso, postJson } = require("./util");


async function jiraAgileGet(apiPath) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return null;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/agile/1.0${apiPath}`;
  try {
    return await getJson(url, { authorization: auth });
  } catch (e) {
    console.error(`[sprint-runner] Agile API error ${apiPath}: ${e.message}`);
    return null;
  }
}

async function jiraAgilePost(apiPath, body) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return null;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/agile/1.0${apiPath}`;
  try {
    return await postJson(url, body, { authorization: auth });
  } catch (e) {
    console.error(`[sprint-runner] Agile POST error ${apiPath}: ${e.message}`);
    return null;
  }
}

/**
 * Move a subtask into the same sprint as its parent issue.
 * Looks up the parent's sprint via Agile API and moves the subtask into it.
 * This ensures subtasks are dispatchable by the sprint-runner.
 */
async function moveSubtaskToParentSprint(subtaskKey, parentKey) {
  if (!subtaskKey || !parentKey) return;
  try {
    // Get the parent issue's sprint via Agile API
    const parentRes = await jiraAgileGet(`/issue/${parentKey}?fields=sprint`);
    if (!parentRes || parentRes.statusCode !== 200) {
      console.log(`[sprint-inherit] ${subtaskKey}: failed to get parent ${parentKey} sprint info (${parentRes?.statusCode || "no response"})`);
      return;
    }
    const sprint = parentRes.json?.fields?.sprint;
    if (!sprint || !sprint.id) {
      console.log(`[sprint-inherit] ${subtaskKey}: parent ${parentKey} is not in any sprint, skipping`);
      return;
    }
    if (sprint.state === "closed") {
      console.log(`[sprint-inherit] ${subtaskKey}: parent ${parentKey} sprint ${sprint.id} (${sprint.name}) is closed, skipping`);
      return;
    }

    // Move subtask into parent's sprint
    const moveRes = await jiraAgilePost(`/sprint/${sprint.id}/issue`, { issues: [subtaskKey] });
    if (moveRes && (moveRes.statusCode === 204 || moveRes.statusCode === 200)) {
      console.log(`[sprint-inherit] ${subtaskKey}: moved to sprint ${sprint.id} (${sprint.name}) — inherited from parent ${parentKey}`);
    } else {
      console.log(`[sprint-inherit] ${subtaskKey}: failed to move to sprint ${sprint.id} (${moveRes?.statusCode || "no response"}) ${(moveRes?.body || "").substring(0, 200)}`);
    }
  } catch (e) {
    console.error(`[sprint-inherit] ${subtaskKey}: error inheriting sprint from ${parentKey}: ${e.message}`);
  }
}

async function jiraRestGet(apiPath) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return null;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/api/3${apiPath}`;
  try {
    return await getJson(url, { authorization: auth });
  } catch (e) {
    console.error(`[sprint-runner] REST API error ${apiPath}: ${e.message}`);
    return null;
  }
}

async function jiraRestPut(apiPath, payload) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return null;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/api/3${apiPath}`;
  try {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    return await new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request({
        method: "PUT",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        headers: { "content-type": "application/json", "content-length": body.length, authorization: auth },
      }, (res) => {
        let data = "";
        res.on("data", (d) => (data += d.toString()));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.error(`[sprint-runner] REST PUT error ${apiPath}: ${e.message}`);
    return null;
  }
}

/**
 * After a standalone implementer's branch is merged into dev, the issue's
 * downstream agent labels (engineer-reviewer/qa-agent/product-manager) are
 * obsolete — there's nothing to review on the dead feature branch. Strip them
 * so the reconciler doesn't keep firing read-only agents that have nothing to do.
 * Leaves any non-engineering agent labels (security-agent etc.) intact.
 */
async function stripDownstreamLabelsAfterMerge(issueKey) {
  if (!issueKey) return;
  const stripLabels = new Set([
    "agent:engineer-reviewer",
    "agent:reviewer",
    "agent:engineer-implementer",
    "agent:implementer",
  ]);
  const issueRes = await jiraRestGet(`/issue/${issueKey}?fields=labels`);
  if (!issueRes || issueRes.statusCode !== 200) return;
  const currentLabels = issueRes.json?.fields?.labels || [];
  const updatedLabels = currentLabels.filter(l => !stripLabels.has(l));
  if (updatedLabels.length === currentLabels.length) return;
  const removed = currentLabels.filter(l => !updatedLabels.includes(l));
  await jiraRestPut(`/issue/${issueKey}`, { fields: { labels: updatedLabels } });
  console.log(`[${nowIso()}] standalone-merge: stripped labels [${removed.join(", ")}] from ${issueKey}`);
}

async function transitionIssueToInProgress(issueKey) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: auth };
  try {
    const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, headers);
    if (transRes.statusCode !== 200) return;
    const transitions = transRes.json?.transitions || [];
    const ipTrans = transitions.find(t => t.name?.toLowerCase() === "in progress");
    if (!ipTrans) return;
    await postJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: ipTrans.id } }, headers);
    console.log(`[sprint-runner] Transitioned ${issueKey} to In Progress`);
  } catch (e) {
    console.log(`[sprint-runner] Failed to transition ${issueKey}: ${e.message}`);
  }
}

/**
 * Transition a Jira issue to Done. Looks up transitions first (transition ID
 * differs per project workflow) and prefers a transition named "Done", falling
 * back to any transition whose target status is in the "done" category.
 * Returns true on success.
 */
async function transitionIssueToDone(issueKey, reason = "") {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return false;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: auth };
  try {
    const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, headers);
    if (transRes.statusCode !== 200) return false;
    const transitions = transRes.json?.transitions || [];
    let target = transitions.find(t => (t.name || "").toLowerCase() === "done");
    if (!target) target = transitions.find(t => (t.to?.statusCategory?.key || "").toLowerCase() === "done");
    if (!target) {
      console.log(`[verified-close] ${issueKey}: no Done transition available`);
      return false;
    }
    await postJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: target.id } }, headers);
    console.log(`[verified-close] Transitioned ${issueKey} to ${target.name}${reason ? ` (${reason})` : ""}`);
    return true;
  } catch (e) {
    console.log(`[verified-close] Failed to transition ${issueKey}: ${e.message}`);
    return false;
  }
}

/**
 * After a job succeeds, strip every agent:* label that aliases to the just-
 * completed agent. Without this, the periodic agent-label reconciler re-fires
 * the same agent every tick, producing the "no-op verdict" loops that spam
 * Telegram. Pipelines drive their phases via state, not labels, so stripping
 * here is safe mid-pipeline.
 *
 * If the agent's output contains a [VERIFIED-CLOSE] marker, also transition
 * the issue to Done — this lets agents close issues they've verified in a
 * single hop instead of looping forever on "Recommend close as Done".
 */
async function stripOwnAgentLabelsOnSuccess(job) {
  if (!job?.issueKey || !job?.agent) return;
  const agentLabelMap = config.agentLabels || {};
  const ownLabels = new Set();
  for (const [label, agent] of Object.entries(agentLabelMap)) {
    if (agent === job.agent) ownLabels.add(label);
  }
  if (ownLabels.size === 0) return;

  try {
    const issueRes = await jiraRestGet(`/issue/${job.issueKey}?fields=labels,status`);
    if (!issueRes || issueRes.statusCode !== 200) return;
    const statusName = (issueRes.json?.fields?.status?.name || "").toLowerCase();
    if (statusName === "done" || statusName === "closed") return; // already terminal
    const currentLabels = issueRes.json?.fields?.labels || [];
    const updatedLabels = currentLabels.filter(l => !ownLabels.has(l));

    if (updatedLabels.length !== currentLabels.length) {
      const removed = currentLabels.filter(l => !updatedLabels.includes(l));
      await jiraRestPut(`/issue/${job.issueKey}`, { fields: { labels: updatedLabels } });
      console.log(`[strip-own-label] ${job.issueKey}: stripped [${removed.join(", ")}] (agent=${job.agent}, jobId=${job.jobId})`);
    }

    // Scan for [VERIFIED-CLOSE] marker and transition to Done.
    const output = (job.parsedOutput?.result || "") + "\n" + (typeof job.stdout === "string" ? job.stdout : "");
    if (/\[VERIFIED-CLOSE\]/i.test(output)) {
      await transitionIssueToDone(job.issueKey, `agent=${job.agent} jobId=${job.jobId}`);
    }
  } catch (e) {
    console.error(`[strip-own-label] ${job.issueKey} failed: ${e.message}`);
  }
}

module.exports = {
  jiraAgileGet,
  jiraAgilePost,
  moveSubtaskToParentSprint,
  jiraRestGet,
  jiraRestPut,
  stripDownstreamLabelsAfterMerge,
  transitionIssueToInProgress,
  transitionIssueToDone,
  stripOwnAgentLabelsOnSuccess,
};
