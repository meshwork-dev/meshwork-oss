"use strict";

/**
 * Unified issue tracker abstraction layer.
 *
 * When Jira is enabled (config.jira.enabled && config.jira.email && config.jira.apiToken),
 * all operations proxy to the Jira REST API. Otherwise, they use the built-in
 * PostgreSQL-backed issue tracker (db.issues).
 *
 * Usage:
 *   const tracker = require("./issue-tracker");
 *   tracker.init(config, db);
 *   const issue = await tracker.createIssue("EOS", { type: "story", summary: "..." });
 */

const http = require("http");
const https = require("https");

let config = null;
let db = null;

function init(cfg, database) {
  config = cfg;
  db = database;
}

function isJiraEnabled() {
  const { domain, email, apiToken } = config?.jira || {};
  return !!(domain && email && apiToken);
}

// ---------------------------------------------------------------------------
// Jira REST helpers
// ---------------------------------------------------------------------------

function jiraAuth() {
  const { email, apiToken } = config.jira;
  return "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
}

function jiraBaseUrl() {
  const domain = (config.jira.domain || "").replace(/\/+$/, "");
  if (!domain) throw new Error("Jira domain not configured");
  return domain;
}

function jiraRequest(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const headers = {
      authorization: jiraAuth(),
      "content-type": "application/json",
      accept: "application/json",
    };
    if (payload) headers["content-length"] = payload.length;

    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d.toString()));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) { /* not json */ }
          resolve({ statusCode: res.statusCode, body: data, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function jiraGet(apiPath) {
  return jiraRequest("GET", `${jiraBaseUrl()}/rest/api/3${apiPath}`);
}

async function jiraPost(apiPath, body) {
  return jiraRequest("POST", `${jiraBaseUrl()}/rest/api/3${apiPath}`, body);
}

async function jiraPut(apiPath, body) {
  return jiraRequest("PUT", `${jiraBaseUrl()}/rest/api/3${apiPath}`, body);
}

// ---------------------------------------------------------------------------
// Jira field mappers
// ---------------------------------------------------------------------------

function mapJiraIssueToInternal(jiraIssue) {
  const f = jiraIssue.fields || {};
  return {
    key: jiraIssue.key,
    project: jiraIssue.key.split("-")[0],
    type: (f.issuetype?.name || "Task").toLowerCase(),
    status: (f.status?.name || "To Do").toLowerCase().replace(/ /g, "_"),
    summary: f.summary || "",
    description: typeof f.description === "string"
      ? f.description
      : f.description?.content?.map((b) => b.content?.map((c) => c.text).join("")).join("\n") || "",
    priority: (f.priority?.name || "Medium").toLowerCase(),
    labels: f.labels || [],
    assignee: f.assignee?.displayName || f.assignee?.emailAddress || null,
    parentKey: f.parent?.key || null,
    storyPoints: f.story_points || f.customfield_10016 || null,
    createdAt: f.created,
    updatedAt: f.updated,
    resolvedAt: f.resolutiondate || null,
  };
}

function mapJiraStatusToInternal(statusName) {
  const lower = (statusName || "").toLowerCase();
  if (lower === "to do" || lower === "open" || lower === "backlog") return "todo";
  if (lower === "in progress" || lower === "in review") return "in_progress";
  if (lower === "done" || lower === "closed" || lower === "resolved") return "done";
  if (lower === "cancelled" || lower === "won't do") return "cancelled";
  return lower.replace(/ /g, "_");
}

// ---------------------------------------------------------------------------
// Type mapping for Jira issue creation
// ---------------------------------------------------------------------------

const JIRA_TYPE_MAP = {
  epic: "Epic",
  story: "Story",
  task: "Task",
  bug: "Bug",
  subtask: "Sub-task",
};

// ---------------------------------------------------------------------------
// Unified API
// ---------------------------------------------------------------------------

const tracker = {
  init,
  isJiraEnabled,

  async createIssue(project, { type, summary, description, labels, priority, assignee, parentKey, storyPoints }) {
    if (isJiraEnabled()) {
      const fields = {
        project: { key: project.toUpperCase() },
        issuetype: { name: JIRA_TYPE_MAP[type] || "Task" },
        summary,
        labels: labels || [],
      };
      if (description) {
        fields.description = {
          type: "doc", version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
        };
      }
      if (priority) fields.priority = { name: priority.charAt(0).toUpperCase() + priority.slice(1) };
      if (parentKey) fields.parent = { key: parentKey };

      const res = await jiraPost("/issue", { fields });
      if (res.statusCode >= 200 && res.statusCode < 300 && res.json?.key) {
        return { key: res.json.key, project: project.toUpperCase(), type, summary, status: "todo" };
      }
      throw new Error(`Jira create failed (${res.statusCode}): ${res.body?.substring(0, 300)}`);
    }

    return db.issues.create({ project, type, summary, description, priority, labels, assignee, parentKey, storyPoints });
  },

  async getIssue(key) {
    if (isJiraEnabled()) {
      const res = await jiraGet(`/issue/${key}?fields=summary,status,issuetype,priority,labels,assignee,parent,description,created,updated,resolutiondate`);
      if (res.statusCode === 200 && res.json) return mapJiraIssueToInternal(res.json);
      if (res.statusCode === 404) return null;
      throw new Error(`Jira get failed (${res.statusCode})`);
    }
    return db.issues.get(key);
  },

  async searchIssues(query) {
    if (isJiraEnabled()) {
      // Build JQL from query params
      const jqlParts = [];
      if (query.project) jqlParts.push(`project = "${query.project}"`);
      if (query.status) {
        const jiraStatus = query.status === "todo" ? "To Do" : query.status === "in_progress" ? "In Progress" : query.status === "done" ? "Done" : query.status;
        jqlParts.push(`status = "${jiraStatus}"`);
      }
      if (query.type) jqlParts.push(`issuetype = "${JIRA_TYPE_MAP[query.type] || query.type}"`);
      if (query.assignee) jqlParts.push(`assignee = "${query.assignee}"`);
      if (query.label) jqlParts.push(`labels = "${query.label}"`);
      if (query.search) jqlParts.push(`summary ~ "${query.search}"`);
      if (query.parentKey) jqlParts.push(`parent = "${query.parentKey}"`);

      const jql = jqlParts.length > 0 ? jqlParts.join(" AND ") : `project IS NOT EMPTY`;
      const maxResults = query.limit || 50;
      const startAt = query.offset || 0;

      const res = await jiraGet(`/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&startAt=${startAt}&fields=summary,status,issuetype,priority,labels,assignee,parent,created,updated`);
      if (res.statusCode === 200 && res.json) {
        return {
          issues: (res.json.issues || []).map(mapJiraIssueToInternal),
          total: res.json.total || 0,
        };
      }
      throw new Error(`Jira search failed (${res.statusCode}): ${res.body?.substring(0, 200)}`);
    }

    return db.issues.search(query);
  },

  async addComment(key, body, author) {
    if (isJiraEnabled()) {
      const res = await jiraPost(`/issue/${key}/comment`, {
        body: {
          type: "doc", version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: `[${author || "system"}] ${body}` }] }],
        },
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { issueKey: key, author, body, createdAt: new Date().toISOString() };
      }
      throw new Error(`Jira comment failed (${res.statusCode})`);
    }

    return db.issueComments.create(key, author || "system", body);
  },

  async getComments(key) {
    if (isJiraEnabled()) {
      const res = await jiraGet(`/issue/${key}/comment`);
      if (res.statusCode === 200 && res.json) {
        return (res.json.comments || []).map((c) => ({
          id: c.id,
          issueKey: key,
          author: c.author?.displayName || c.author?.emailAddress || "unknown",
          body: c.body?.content?.map((b) => b.content?.map((t) => t.text).join("")).join("\n") || "",
          createdAt: c.created,
        }));
      }
      return [];
    }

    return db.issueComments.listByIssue(key);
  },

  async transitionIssue(key, toStatus, actor) {
    if (isJiraEnabled()) {
      // Get available transitions
      const transRes = await jiraGet(`/issue/${key}/transitions`);
      if (transRes.statusCode !== 200) throw new Error(`Failed to get transitions (${transRes.statusCode})`);
      const transitions = transRes.json?.transitions || [];
      const target = transitions.find(
        (t) => mapJiraStatusToInternal(t.to?.name) === toStatus || t.to?.name?.toLowerCase() === toStatus.replace(/_/g, " ")
      );
      if (!target) throw new Error(`No transition available to '${toStatus}'`);

      const res = await jiraPost(`/issue/${key}/transitions`, { transition: { id: target.id } });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { key, status: toStatus };
      }
      throw new Error(`Jira transition failed (${res.statusCode})`);
    }

    return db.issues.transition(key, toStatus, actor);
  },

  async getTransitions(key) {
    if (isJiraEnabled()) {
      const res = await jiraGet(`/issue/${key}/transitions`);
      if (res.statusCode === 200 && res.json) {
        return (res.json.transitions || []).map((t) => ({
          id: t.id,
          name: t.name,
          to: { name: mapJiraStatusToInternal(t.to?.name) },
        }));
      }
      return [];
    }

    const issue = await db.issues.get(key);
    if (!issue) return [];
    return db.issues.getTransitions(issue.status);
  },

  async createLink(sourceKey, targetKey, linkType) {
    if (isJiraEnabled()) {
      const jiraLinkType = linkType === "blocks" || linkType === "is_blocked_by" ? "Blocks" : "Relates";
      const body = {
        type: { name: jiraLinkType },
        inwardIssue: { key: linkType === "is_blocked_by" ? targetKey : sourceKey },
        outwardIssue: { key: linkType === "is_blocked_by" ? sourceKey : targetKey },
      };
      const res = await jiraPost("/issueLink", body);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { sourceKey, targetKey, linkType };
      }
      throw new Error(`Jira link failed (${res.statusCode})`);
    }

    return db.issueLinks.create(sourceKey, targetKey, linkType);
  },

  async getLinks(key) {
    if (isJiraEnabled()) {
      const res = await jiraGet(`/issue/${key}?fields=issuelinks`);
      if (res.statusCode === 200 && res.json) {
        const links = res.json.fields?.issuelinks || [];
        return links.map((l) => ({
          id: l.id,
          sourceKey: l.outwardIssue?.key || key,
          targetKey: l.inwardIssue?.key || key,
          linkType: l.type?.name?.toLowerCase() || "relates_to",
          createdAt: null,
        }));
      }
      return [];
    }

    return db.issueLinks.listByIssue(key);
  },

  async getSubtasks(parentKey) {
    if (isJiraEnabled()) {
      const res = await jiraGet(`/issue/${parentKey}?fields=subtasks`);
      if (res.statusCode === 200 && res.json) {
        return (res.json.fields?.subtasks || []).map((st) => ({
          key: st.key,
          summary: st.fields?.summary || "",
          status: mapJiraStatusToInternal(st.fields?.status?.name),
          type: "subtask",
        }));
      }
      return [];
    }

    return db.issues.getSubtasks(parentKey);
  },

  async deleteIssue(key) {
    if (isJiraEnabled()) {
      const res = await jiraRequest("DELETE", `${jiraBaseUrl()}/rest/api/3/issue/${key}`);
      return res.statusCode >= 200 && res.statusCode < 300;
    }
    return db.issues.delete(key);
  },

  async updateIssue(key, fields) {
    if (isJiraEnabled()) {
      const jiraFields = {};
      if (fields.summary) jiraFields.summary = fields.summary;
      if (fields.description) {
        jiraFields.description = {
          type: "doc", version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: fields.description }] }],
        };
      }
      if (fields.priority) jiraFields.priority = { name: fields.priority.charAt(0).toUpperCase() + fields.priority.slice(1) };
      if (fields.labels) jiraFields.labels = fields.labels;

      const res = await jiraPut(`/issue/${key}`, { fields: jiraFields });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return tracker.getIssue(key);
      }
      throw new Error(`Jira update failed (${res.statusCode})`);
    }

    return db.issues.update(key, fields);
  },
};

module.exports = tracker;
