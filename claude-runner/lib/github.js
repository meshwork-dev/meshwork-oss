// github.js — GitHub integration for hosted deployments
// Handles repo cloning (on demand), branch push, and PR creation.
// Products with a `github` config block use this module instead of relying
// on a pre-existing local working directory.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { resolveApiKey } = require("./provider-store");
const { nowIso } = require("./util");
const db = require("../db");

const CLONE_BASE_DIR = process.env.MESHWORK_REPOS_DIR || path.join(os.homedir(), "meshwork-repos");

// ---------------------------------------------------------------------------
// Resolve GitHub token for a product
// ---------------------------------------------------------------------------

async function resolveGitHubToken(product) {
  const tokenProviderId = product?.github?.tokenProviderId || "github";
  try {
    const key = await resolveApiKey({ id: tokenProviderId, authTokenEnvVar: "GITHUB_TOKEN" });
    return key || process.env.GITHUB_TOKEN || null;
  } catch {
    return process.env.GITHUB_TOKEN || null;
  }
}

// ---------------------------------------------------------------------------
// Repo clone management
// ---------------------------------------------------------------------------

/**
 * Ensure a GitHub-backed product's repo is cloned locally.
 * On first call: git clone. On subsequent calls: git fetch origin.
 * Returns the local path to the repo.
 */
async function ensureRepoClone(product) {
  const { owner, repo, defaultBranch = "main" } = product.github;
  const repoDir = path.join(CLONE_BASE_DIR, owner, repo);

  const token = await resolveGitHubToken(product);
  const authUrl = token
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;

  fs.mkdirSync(path.dirname(repoDir), { recursive: true });

  if (!fs.existsSync(repoDir)) {
    console.log(`[${nowIso()}] Cloning ${owner}/${repo} to ${repoDir}`);
    execSync(`git clone "${authUrl}" "${repoDir}"`, {
      timeout: 120_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`[${nowIso()}] Clone complete: ${repoDir}`);
  } else {
    // Repo exists — fetch latest
    try {
      // Update remote URL in case token changed
      execSync(`git remote set-url origin "${authUrl}"`, { cwd: repoDir, timeout: 5000, encoding: "utf8" });
      execSync(`git fetch origin ${defaultBranch} --prune`, {
        cwd: repoDir,
        timeout: 60_000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      console.warn(`[${nowIso()}] git fetch warning for ${owner}/${repo}: ${e.message}`);
    }
  }

  return repoDir;
}

// ---------------------------------------------------------------------------
// Push branch + open PR
// ---------------------------------------------------------------------------

/**
 * Push the job's worktree branch to GitHub origin and create a PR.
 * Called from worker.js after a successful delivery job.
 */
async function createGitHubPR(job, product) {
  if (!product?.github) return null;

  const { owner, repo, defaultBranch = "main" } = product.github;
  const branchName = job.branchName || `meshwork/${job.issueKey || job.jobId}`;
  const worktreeDir = job.worktreeDir || job.workingDir;

  if (!worktreeDir || !fs.existsSync(worktreeDir)) {
    console.warn(`[${nowIso()}] createGitHubPR: no worktree dir for job ${job.jobId}`);
    return null;
  }

  const token = await resolveGitHubToken(product);
  if (!token) {
    console.warn(`[${nowIso()}] createGitHubPR: no GitHub token — skipping PR creation`);
    return null;
  }

  console.log(`[${nowIso()}] Pushing branch ${branchName} to ${owner}/${repo}`);

  try {
    // Stage any uncommitted changes
    execSync("git add -A", { cwd: worktreeDir, timeout: 10_000, encoding: "utf8" });
    try {
      execSync(`git commit -m "meshwork: ${job.issueKey || job.jobId} automated changes"`, {
        cwd: worktreeDir,
        timeout: 10_000,
        encoding: "utf8",
      });
    } catch {
      // Nothing to commit is fine — the branch may already have commits
    }

    // Push to origin (with token embedded in URL)
    const baseRepo = worktreeDir;
    const pushUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    execSync(`git push "${pushUrl}" HEAD:"${branchName}" --force-with-lease`, {
      cwd: baseRepo,
      timeout: 60_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`[${nowIso()}] Pushed branch ${branchName}`);
  } catch (e) {
    console.error(`[${nowIso()}] Failed to push branch: ${e.message}`);
    return null;
  }

  // Create PR via GitHub REST API
  const prTitle = job.issueKey
    ? `${job.issueKey}: ${job.summary || "Automated changes"}`
    : job.summary || `Meshwork job ${job.jobId}`;

  const prBody = buildPrBody(job);

  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: prTitle,
        head: branchName,
        base: defaultBranch,
        body: prBody,
        draft: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      // 422 "A pull request already exists" is not an error
      if (resp.status === 422 && text.includes("pull request already exists")) {
        const existingPr = await findExistingPR(owner, repo, branchName, defaultBranch, token);
        if (existingPr) {
          console.log(`[${nowIso()}] PR already exists: ${existingPr}`);
          await persistPrUrl(job.jobId, existingPr);
          return existingPr;
        }
      }
      console.error(`[${nowIso()}] GitHub PR creation failed ${resp.status}: ${text.slice(0, 300)}`);
      return null;
    }

    const pr = await resp.json();
    const prUrl = pr.html_url;
    console.log(`[${nowIso()}] PR created: ${prUrl}`);
    await persistPrUrl(job.jobId, prUrl);
    return prUrl;
  } catch (e) {
    console.error(`[${nowIso()}] Failed to create PR: ${e.message}`);
    return null;
  }
}

async function findExistingPR(owner, repo, head, base, token) {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&base=${base}&state=open`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!resp.ok) return null;
    const prs = await resp.json();
    return prs[0]?.html_url || null;
  } catch {
    return null;
  }
}

async function persistPrUrl(jobId, prUrl) {
  try {
    await db.jobs.update(jobId, { prUrl });
  } catch (e) {
    console.warn(`[${nowIso()}] Could not persist PR URL: ${e.message}`);
  }
}

function buildPrBody(job) {
  const lines = [];
  if (job.issueKey) lines.push(`**Issue:** ${job.issueKey}`);
  if (job.summary) lines.push(`**Summary:** ${job.summary}`);
  lines.push(`**Job ID:** ${job.jobId}`);
  lines.push(`**Agent:** ${job.agent || "default"}`);
  lines.push("");
  lines.push("---");
  lines.push("*Automated by [Meshwork](https://github.com/your-org/meshwork-oss)*");
  return lines.join("\n");
}

module.exports = {
  ensureRepoClone,
  createGitHubPR,
  resolveGitHubToken,
};
