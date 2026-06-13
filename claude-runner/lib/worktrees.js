// worktrees.js — git worktree lifecycle and branch merge helpers
// Extracted from runner.js.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../db");
const issueTracker = require("../issue-tracker");
const { config } = require("./config");
const { resolveProduct } = require("./products");
const { jobEmitter, pipelines, worktrees } = require("./state");
const { nowIso } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  resolveWorktreeBaseDir,
  createWorktree,
  setupWorktree,
  removeWorktree,
  listWorktreesWithStats,
  pruneWorktrees,
  resolveMergeBranch,
  resolveRemoteName,
  ensureIntegrationBranch,
  mergeBranchIntoDev,
  mergeWorktree,
  stashDirtyWorkingDir,
  reconcileMergedWorktrees,
  withMergeLock,
  isBranchMergedToTrunk,
};


/**
 * ============================================================
 * WORKTREE ISOLATION
 * Creates isolated git worktrees for pipeline jobs so concurrent
 * pipelines don't contaminate each other's branches.
 * ============================================================
 */

function resolveWorktreeBaseDir() {
  const dir = config.worktrees?.baseDir || "~/meshwork-worktrees";
  return dir.replace(/^~/, os.homedir());
}

/**
 * Create a git worktree for an issue. Reuses if already exists.
 * Returns the worktree directory path.
 */
function createWorktree(baseRepo, issueKey, branchName) {
  const { execSync } = require("child_process");
  const baseDir = resolveWorktreeBaseDir();
  const worktreeDir = path.join(baseDir, issueKey);

  // Reuse existing worktree
  if (fs.existsSync(worktreeDir)) {
    const existing = Array.from(worktrees.values()).find(w => w.issueKey === issueKey && w.status === "active");
    if (existing) {
      console.log(`[${nowIso()}] Reusing existing worktree for ${issueKey}: ${worktreeDir}`);
      return { id: existing.id, path: worktreeDir };
    }
  }

  // Ensure base dir exists
  fs.mkdirSync(baseDir, { recursive: true });

  // Ensure base repo is on default branch
  try {
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: baseRepo, encoding: "utf8" }).trim();
    if (currentBranch !== "main") {
      execSync("git checkout main", { cwd: baseRepo, encoding: "utf8", timeout: 10000 });
    }
  } catch (e) {
    console.log(`[${nowIso()}] Worktree: could not reset base repo to main: ${e.message}`);
  }

  // Create worktree with new branch
  try {
    execSync(`git worktree add "${worktreeDir}" -b "${branchName}"`, { cwd: baseRepo, encoding: "utf8", timeout: 30000 });
  } catch (e) {
    // Branch may already exist — try adding worktree on existing branch
    if (e.message.includes("already exists")) {
      try {
        execSync(`git worktree add "${worktreeDir}" "${branchName}"`, { cwd: baseRepo, encoding: "utf8", timeout: 30000 });
      } catch (e2) {
        throw new Error(`Failed to create worktree: ${e2.message}`);
      }
    } else {
      throw new Error(`Failed to create worktree: ${e.message}`);
    }
  }

  // Symlink agent memory so all worktrees share memory files
  const memSrc = path.join(baseRepo, ".claude", "agent-memory");
  const memDst = path.join(worktreeDir, ".claude", "agent-memory");
  if (fs.existsSync(memSrc) && !fs.existsSync(memDst)) {
    fs.mkdirSync(path.join(worktreeDir, ".claude"), { recursive: true });
    try {
      fs.symlinkSync(memSrc, memDst);
    } catch (e) {
      console.log(`[${nowIso()}] Worktree: memory symlink warning: ${e.message}`);
    }
  }

  // Track worktree
  const id = `wt_${crypto.randomBytes(4).toString("hex")}`;
  const record = {
    id,
    issueKey,
    branch: branchName,
    path: worktreeDir,
    baseRepo,
    pipelineId: null,
    status: "active",
    createdAt: nowIso(),
    lastJobId: null,
    lastJobAgent: null,
    prUrl: null,
  };
  worktrees.set(id, record);
  db.worktrees.set(record).catch(e => console.error('[db] worktree persist failed: ' + e.message));


  jobEmitter.emit("worktree:created", { id, issueKey, branch: branchName, path: worktreeDir });
  console.log(`[${nowIso()}] Worktree created: ${id} issue=${issueKey} branch=${branchName} path=${worktreeDir}`);

  return { id, path: worktreeDir };
}

/**
 * Run product-specific post-create setup commands inside a fresh worktree.
 *
 * Drives off `product.worktreeSetup.commands` (array of strings); falls back to
 * detecting `package.json` (runs `<pm> install --frozen-lockfile`) and
 * `prisma/schema.prisma` (runs `<pm> exec prisma generate`).
 *
 * Failures are logged but do NOT throw — the implementer agent can still attempt
 * the work and surface a clearer error than a silent missing-types failure.
 */
function setupWorktree(worktreeDir, baseRepo) {
  const { execSync } = require("child_process");
  const product = resolveProduct(baseRepo);
  const pm = product?.techStack?.packageManager || "pnpm";

  let commands = product?.worktreeSetup?.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    commands = [];
    if (fs.existsSync(path.join(worktreeDir, "package.json"))) {
      const lockArg = pm === "pnpm" ? "--frozen-lockfile" : (pm === "yarn" ? "--frozen-lockfile" : "--ci");
      commands.push(`${pm} install ${lockArg}`);
    }
    // Detect Prisma anywhere in the worktree (monorepo packages/* common in EOS/CER)
    const hasPrisma = (() => {
      try {
        if (fs.existsSync(path.join(worktreeDir, "prisma", "schema.prisma"))) return true;
        const pkgs = path.join(worktreeDir, "packages");
        if (fs.existsSync(pkgs)) {
          for (const sub of fs.readdirSync(pkgs)) {
            if (fs.existsSync(path.join(pkgs, sub, "prisma", "schema.prisma"))) return true;
          }
        }
      } catch { /* ignore */ }
      return false;
    })();
    if (hasPrisma) commands.push(`${pm} exec prisma generate`);
  }

  if (commands.length === 0) {
    console.log(`[${nowIso()}] Worktree setup: nothing to do for ${worktreeDir}`);
    return { ok: true, ran: [] };
  }

  const ran = [];
  for (const cmd of commands) {
    console.log(`[${nowIso()}] Worktree setup: running '${cmd}' in ${worktreeDir}`);
    try {
      execSync(cmd, { cwd: worktreeDir, encoding: "utf8", timeout: 10 * 60 * 1000, stdio: "pipe" });
      ran.push({ cmd, ok: true });
    } catch (e) {
      console.error(`[${nowIso()}] Worktree setup: '${cmd}' failed: ${e.message?.slice(0, 500)}`);
      ran.push({ cmd, ok: false, error: e.message?.slice(0, 500) });
      // Continue — partial setup is still better than none.
    }
  }
  return { ok: ran.every(r => r.ok), ran };
}

/**
 * Remove a worktree by issue key.
 */
function removeWorktree(issueKey) {
  const { execSync } = require("child_process");
  const record = Array.from(worktrees.values()).find(w => w.issueKey === issueKey);
  if (!record) throw new Error(`No worktree found for ${issueKey}`);

  // Remove symlinks before removal
  const memLink = path.join(record.path, ".claude", "agent-memory");
  try {
    if (fs.lstatSync(memLink).isSymbolicLink()) fs.unlinkSync(memLink);
  } catch { /* ignore */ }

  // Remove worktree directory
  if (fs.existsSync(record.path)) {
    try {
      execSync(`git worktree remove "${record.path}" --force`, { cwd: record.baseRepo, encoding: "utf8", timeout: 15000, stdio: "pipe" });
    } catch (e) {
      console.log(`[${nowIso()}] Worktree remove warning: ${e.message}`);
      // Fallback: remove directory manually
      fs.rmSync(record.path, { recursive: true, force: true });
    }
  }
  // Prune stale worktree references from git
  try {
    execSync("git worktree prune", { cwd: record.baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" });
  } catch { /* ignore */ }
  // Clean up the branch
  if (record.branch) {
    try {
      execSync(`git branch -D ${record.branch}`, { cwd: record.baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" });
    } catch { /* branch may already be deleted or merged */ }
  }

  worktrees.delete(record.id);
  db.worktrees.delete(record.id).catch(e => console.error('[db] worktree delete failed: ' + e.message));


  jobEmitter.emit("worktree:deleted", { id: record.id, issueKey });
  console.log(`[${nowIso()}] Worktree removed: ${record.id} issue=${issueKey}`);
}

/**
 * List worktrees with live git stats.
 */
function listWorktreesWithStats() {
  const { execSync } = require("child_process");
  const results = [];
  for (const [, wt] of worktrees) {
    let commits = 0, filesChanged = 0;
    try {
      execSync(`git rev-parse --verify ${wt.branch}`, { cwd: wt.baseRepo, encoding: "utf8", stdio: "pipe", timeout: 5000 });
      commits = parseInt(execSync(`git rev-list main..${wt.branch} --count`, { cwd: wt.baseRepo, encoding: "utf8", stdio: "pipe" }).trim()) || 0;
      const diffOutput = execSync(`git diff main..${wt.branch} --name-only`, { cwd: wt.baseRepo, encoding: "utf8", stdio: "pipe" }).trim();
      filesChanged = diffOutput ? diffOutput.split("\n").filter(Boolean).length : 0;
    } catch { /* worktree may be stale or branch deleted */ }
    results.push({ ...wt, commits, filesChanged });
  }
  return results;
}

/**
 * Prune stale git worktrees and reconcile tracking Map.
 */
function pruneWorktrees(baseRepo) {
  const { execSync } = require("child_process");
  try {
    execSync("git worktree prune", { cwd: baseRepo, encoding: "utf8", timeout: 10000 });
  } catch (e) {
    console.log(`[${nowIso()}] Worktree prune warning: ${e.message}`);
  }

  // Reconcile: remove tracked worktrees whose directories no longer exist
  const staleIds = [];
  for (const [id, wt] of worktrees) {
    if (!fs.existsSync(wt.path)) {
      staleIds.push(id);
    }
  }
  for (const id of staleIds) {
    const wt = worktrees.get(id);
    console.log(`[${nowIso()}] Worktree pruned (dir gone): ${id} (${wt.issueKey})`);
    // Clean up branch reference if it exists
    try {
      execSync(`git branch -D ${wt.branch}`, { cwd: wt.baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" });
    } catch { /* branch may already be deleted or merged */ }
    worktrees.delete(id);
    db.worktrees.delete(id).catch(e => console.error('[db] worktree delete failed: ' + e.message));
  }
  // stale worktrees already removed from DB above
}

/**
 * Resolve the integration ("dev") branch for a base repo from product config.
 * Defaults to "dev". A product can override via `product.json -> mergeBranch`.
 */
function resolveMergeBranch(baseRepo) {
  const product = resolveProduct(baseRepo);
  return (product && typeof product.mergeBranch === "string" && product.mergeBranch.trim())
    ? product.mergeBranch.trim()
    : "dev";
}

/**
 * Resolve the git remote name for a base repo.
 * Order:
 *  1. `product.json -> remoteName` if set (e.g. estateos uses remote "estateos", not "origin")
 *  2. The repo's actual remotes — prefer "origin", else first listed
 *  3. Falls back to "origin" if detection fails
 * Cached per baseRepo for the process lifetime.
 */
const _remoteNameCache = new Map();
function resolveRemoteName(baseRepo) {
  if (!baseRepo) return "origin";
  if (_remoteNameCache.has(baseRepo)) return _remoteNameCache.get(baseRepo);

  const product = resolveProduct(baseRepo);
  if (product && typeof product.remoteName === "string" && product.remoteName.trim()) {
    const name = product.remoteName.trim();
    _remoteNameCache.set(baseRepo, name);
    return name;
  }

  const { execSync } = require("child_process");
  let name = "origin";
  try {
    const out = execSync("git remote", { cwd: baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
    const remotes = out.split("\n").map(s => s.trim()).filter(Boolean);
    if (remotes.length > 0) {
      name = remotes.includes("origin") ? "origin" : remotes[0];
    }
  } catch (e) {
    console.warn(`[${nowIso()}] resolveRemoteName: detection failed for ${baseRepo}, falling back to "origin": ${e.message}`);
  }
  _remoteNameCache.set(baseRepo, name);
  return name;
}

/**
 * Ensure the integration branch exists locally and on origin.
 * If origin/<mergeBranch> is missing, create it from origin/main and push.
 * Idempotent: safe to call on every merge.
 */
function ensureIntegrationBranch(baseRepo, mergeBranch) {
  const { execSync } = require("child_process");
  const remote = resolveRemoteName(baseRepo);
  try {
    execSync(`git fetch ${remote} --prune`, { cwd: baseRepo, encoding: "utf8", timeout: 60000, stdio: "pipe" });
  } catch (e) {
    console.warn(`[${nowIso()}] ensureIntegrationBranch: fetch failed for ${baseRepo}: ${e.message}`);
  }

  let remoteHasIt = false;
  try {
    const out = execSync(`git ls-remote --heads ${remote} ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 15000, stdio: "pipe" }).trim();
    remoteHasIt = !!out;
  } catch { /* assume not */ }

  if (!remoteHasIt) {
    console.log(`[${nowIso()}] Bootstrapping integration branch '${mergeBranch}' from ${remote}/main in ${baseRepo}`);
    try {
      // Create local branch from <remote>/main if missing
      try { execSync(`git rev-parse --verify ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" }); }
      catch {
        execSync(`git branch ${mergeBranch} ${remote}/main`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" });
      }
      execSync(`git push -u ${remote} ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 60000, stdio: "pipe" });
    } catch (e) {
      throw new Error(`ensureIntegrationBranch failed to bootstrap '${mergeBranch}': ${e.message}`);
    }
  } else {
    // Remote has it — ensure local tracking exists
    try {
      execSync(`git rev-parse --verify ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" });
    } catch {
      try {
        execSync(`git branch --track ${mergeBranch} ${remote}/${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" });
      } catch (e) {
        console.warn(`[${nowIso()}] ensureIntegrationBranch: local track create warned: ${e.message}`);
      }
    }
  }
}

/**
 * Merge a feature branch into the integration ("dev") branch via a temp worktree
 * checked out to dev (refs are shared across worktrees, so feature branches are
 * visible). Fast-forward by default, falls back to --no-ff if dev has diverged.
 * On success: pushes dev, deletes the feature branch locally + on origin.
 *
 * Returns { branch, mergeBranch, devSha, mode } where mode is "ff" or "no-ff".
 * Throws on conflict (with .conflictContext) or other failure.
 */
function mergeBranchIntoDev(baseRepo, featureBranch, issueKey) {
  const { execSync } = require("child_process");
  if (!baseRepo || !featureBranch) throw new Error("mergeBranchIntoDev: baseRepo and featureBranch required");

  const mergeBranch = resolveMergeBranch(baseRepo);
  const remote = resolveRemoteName(baseRepo);
  ensureIntegrationBranch(baseRepo, mergeBranch);

  // Push the feature branch first so the merge result has a remote audit trail
  // and so failure-path safety is preserved even if the merge itself fails.
  try {
    execSync(`git push -u ${remote} ${featureBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 60000, stdio: "pipe" });
  } catch (e) {
    console.warn(`[${nowIso()}] mergeBranchIntoDev: feature-branch push failed (continuing to merge): ${e.message}`);
  }

  // Verify there is something to merge (branch ahead of mergeBranch)
  let ahead = 0;
  try {
    ahead = parseInt(execSync(`git rev-list ${mergeBranch}..${featureBranch} --count`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim()) || 0;
  } catch {
    try {
      ahead = parseInt(execSync(`git rev-list ${remote}/${mergeBranch}..${featureBranch} --count`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim()) || 0;
    } catch {}
  }
  if (ahead === 0) {
    console.log(`[${nowIso()}] mergeBranchIntoDev: ${featureBranch} has 0 commits ahead of ${mergeBranch}, skipping`);
    return null;
  }

  // git refuses to check out a branch that's already checked out in another
  // worktree. Detect that case and merge in-place there instead of trying to
  // add a fresh worktree (which would fail with "fatal: '<branch>' is already
  // checked out at ..."). The base repo itself counts as a worktree.
  let existingWorktree = null;
  try {
    const wt = execSync("git worktree list --porcelain", { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" });
    let cur = {};
    for (const line of wt.split("\n")) {
      if (line.startsWith("worktree ")) cur = { path: line.slice(9).trim() };
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim();
      else if (line === "" && cur.path) {
        if (cur.branch === `refs/heads/${mergeBranch}`) { existingWorktree = cur.path; break; }
        cur = {};
      }
    }
  } catch (e) {
    console.warn(`[${nowIso()}] mergeBranchIntoDev: worktree list failed (continuing): ${e.message}`);
  }

  const os = require("os");
  const reuseWorktree = !!existingWorktree;
  const tmpWorktree = reuseWorktree ? existingWorktree : path.join(os.tmpdir(), `merge-${issueKey || featureBranch}-${Date.now()}`);
  console.log(`[${nowIso()}] mergeBranchIntoDev: ${reuseWorktree ? "reusing existing" : "temp"} worktree at ${tmpWorktree} for ${featureBranch} -> ${mergeBranch}`);

  try {
    if (!reuseWorktree) {
      execSync(`git worktree add "${tmpWorktree}" ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 30000, stdio: "pipe" });
    } else {
      // Existing worktree must have no tracked changes; merging would fail mid-merge.
      // Untracked files (??) are fine — git merge refuses on its own only if they'd be
      // overwritten, and pipeline artifacts (CTX-*.md, REPORT-*.md) routinely sit here.
      const status = execSync("git status --porcelain", { cwd: tmpWorktree, encoding: "utf8", timeout: 10000, stdio: "pipe" });
      const trackedDirty = status.split("\n").filter(l => l && !l.startsWith("??")).join("\n").trim();
      if (trackedDirty) {
        throw new Error(`mergeBranchIntoDev: ${tmpWorktree} (on ${mergeBranch}) has uncommitted tracked changes — refusing to merge into dirty tree:\n${trackedDirty}`);
      }
    }
    try {
      execSync(`git pull --ff-only ${remote} ${mergeBranch}`, { cwd: tmpWorktree, encoding: "utf8", timeout: 60000, stdio: "pipe" });
    } catch (e) {
      console.warn(`[${nowIso()}] mergeBranchIntoDev: ff-only pull of ${mergeBranch} failed: ${e.message}`);
    }

    let mode = "ff";
    try {
      execSync(`git merge --ff-only ${featureBranch}`, { cwd: tmpWorktree, encoding: "utf8", timeout: 30000, stdio: "pipe" });
    } catch (ffErr) {
      // Fallback to --no-ff so a merge commit captures the integration point
      mode = "no-ff";
      try {
        execSync(
          `git merge ${featureBranch} --no-ff -m "Merge ${featureBranch} into ${mergeBranch}${issueKey ? ` (${issueKey})` : ""}"`,
          {
            cwd: tmpWorktree, encoding: "utf8", timeout: 30000, stdio: "pipe",
            env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Meshwork Runner", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || "Meshwork Runner", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid" }
          }
        );
      } catch (mergeErr) {
        try { execSync("git merge --abort", { cwd: tmpWorktree, encoding: "utf8", timeout: 5000, stdio: "pipe" }); } catch {}

        let devLog = "", branchLog = "", diffStat = "";
        try {
          devLog = execSync(`git log ${featureBranch}..${mergeBranch} --oneline -20`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
          branchLog = execSync(`git log ${mergeBranch}..${featureBranch} --oneline -20`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
          diffStat = execSync(`git diff ${mergeBranch}...${featureBranch} --stat`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
        } catch {}

        const err = new Error(`MERGE_CONFLICT:${featureBranch}`);
        err.conflictContext = { branchName: featureBranch, mergeBranch, mainLog: devLog, branchLog, diffStat, issueKey };
        throw err;
      }
    }

    // Push the integration branch
    execSync(`git push ${remote} ${mergeBranch}`, { cwd: tmpWorktree, encoding: "utf8", timeout: 60000, stdio: "pipe" });
    const devSha = execSync(`git rev-parse HEAD`, { cwd: tmpWorktree, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
    console.log(`[${nowIso()}] mergeBranchIntoDev: pushed ${mergeBranch}@${devSha.slice(0,8)} (${mode})`);

    // Delete the feature branch on the remote (best-effort)
    try {
      execSync(`git push ${remote} --delete ${featureBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 30000, stdio: "pipe" });
    } catch (e) {
      console.warn(`[${nowIso()}] mergeBranchIntoDev: remote branch delete warning for ${featureBranch}: ${e.message}`);
    }

    jobEmitter.emit("pipeline:auto-merged", {
      pipelineId: null, issueKey, branch: featureBranch, mergeBranch, devSha, mode,
    });

    if (issueKey) {
      const comment = [
        `[AUTO-MERGED-TO-DEV] Branch \`${featureBranch}\` merged into \`${mergeBranch}\` (${mode}) at ${devSha.slice(0, 8)}.`,
        ``,
        `Open a PR \`${mergeBranch}\` -> \`main\` when ready to deploy. The feature branch has been deleted locally and on ${remote}.`,
      ].join("\n");
      Promise.resolve().then(() => issueTracker.addComment(issueKey, comment, "runner")).catch(e => {
        console.warn(`[${nowIso()}] mergeBranchIntoDev: Jira comment failed for ${issueKey}: ${e.message}`);
      });
    }
    return { branch: featureBranch, mergeBranch, devSha, mode };
  } finally {
    if (!reuseWorktree) {
      try {
        execSync(`git worktree remove "${tmpWorktree}" --force`, { cwd: baseRepo, encoding: "utf8", timeout: 15000, stdio: "pipe" });
      } catch (e) {
        console.warn(`[${nowIso()}] mergeBranchIntoDev: temp worktree cleanup warning: ${e.message}`);
        try { fs.rmSync(tmpWorktree, { recursive: true, force: true }); } catch {}
        try { execSync(`git worktree prune`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }); } catch {}
      }
    }
  }
}

/**
 * Merge a worktree branch into the integration ("dev") branch and reap the worktree.
 * Synchronous: by the time this returns, dev has been pushed and the local feature
 * branch + worktree have been removed.
 * Returns { branch, mergeBranch, devSha, mode }.
 */
function mergeWorktree(issueKey) {
  const record = Array.from(worktrees.values()).find(w => w.issueKey === issueKey);
  if (!record) throw new Error(`No worktree found for ${issueKey}`);
  if (!record.baseRepo || !record.branch) throw new Error(`Worktree ${record.id} has no baseRepo/branch`);

  const result = mergeBranchIntoDev(record.baseRepo, record.branch, issueKey);
  if (!result) throw new Error(`No commits to merge for ${issueKey}`);

  record.status = "merged";
  record.mergedTo = result.mergeBranch;
  record.mergedSha = result.devSha;
  db.worktrees.set(record).catch(e => console.error('[db] worktree update failed: ' + e.message));

  jobEmitter.emit("worktree:merged", {
    id: record.id, issueKey, branch: record.branch, mergeBranch: result.mergeBranch, devSha: result.devSha,
  });

  // Reap the worktree synchronously now that the branch is on dev
  try {
    removeWorktree(issueKey);
  } catch (e) {
    console.warn(`[${nowIso()}] mergeWorktree: post-merge worktree removal warning for ${issueKey}: ${e.message}`);
  }

  return result;
}

/**
 * Preserve dirty workingDir state by stashing onto a safety branch and pushing.
 * Called at pipeline creation so the user's in-progress work is never overwritten.
 * Returns { stashedBranch, fileCount } when work was preserved, or null when clean.
 */
function stashDirtyWorkingDir(workingDir, issueKey) {
  const { execSync } = require("child_process");
  if (!workingDir) return null;
  let status = "";
  try {
    status = execSync("git status --porcelain", { cwd: workingDir, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
  } catch (e) {
    console.warn(`[${nowIso()}] stashDirtyWorkingDir: status check failed for ${workingDir}: ${e.message}`);
    return null;
  }
  if (!status) return null;

  const fileCount = status.split("\n").filter(Boolean).length;
  const ts = new Date().toISOString().replace(/[-:]/g, "").split(".")[0]; // 20260426T091500
  const stashedBranch = `safety/main-wip-${ts}`;
  console.log(`[${nowIso()}] Stashing ${fileCount} dirty file(s) in ${workingDir} to ${stashedBranch} before pipeline ${issueKey || ''}`);

  try {
    // Determine current branch (typically main); we'll come back to it
    const currentBranch = execSync("git branch --show-current", { cwd: workingDir, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim() || "main";
    execSync(`git checkout -b ${stashedBranch}`, { cwd: workingDir, encoding: "utf8", timeout: 10000, stdio: "pipe" });
    execSync("git add -A", { cwd: workingDir, encoding: "utf8", timeout: 30000, stdio: "pipe" });
    execSync(
      `git commit -m "safety: in-progress WIP stashed before pipeline${issueKey ? ` ${issueKey}` : ''}\n\nAuto-stashed by Meshwork Runner. Review and merge or discard."`,
      {
        cwd: workingDir, encoding: "utf8", timeout: 30000, stdio: "pipe",
        env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Meshwork Runner", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || "Meshwork Runner", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid" }
      }
    );
    try {
      const remote = resolveRemoteName(workingDir);
      execSync(`git push -u ${remote} ${stashedBranch}`, { cwd: workingDir, encoding: "utf8", timeout: 60000, stdio: "pipe" });
      console.log(`[${nowIso()}] Pushed safety branch ${stashedBranch}`);
    } catch (pushErr) {
      console.warn(`[${nowIso()}] Safety branch push failed (kept locally): ${pushErr.message}`);
    }
    execSync(`git checkout ${currentBranch}`, { cwd: workingDir, encoding: "utf8", timeout: 10000, stdio: "pipe" });
    jobEmitter.emit("workingdir:safety-stashed", { workingDir, stashedBranch, fileCount, issueKey });
    return { stashedBranch, fileCount };
  } catch (e) {
    console.error(`[${nowIso()}] stashDirtyWorkingDir failed for ${workingDir}: ${e.message}`);
    return null;
  }
}

/**
 * Periodic reconciler: reap stale worktree records.
 * Two-condition reaping: (a) the local worktree directory is missing, OR
 * (b) the feature branch's LOCAL ref is gone (someone deleted the branch).
 *
 * NOTE: We deliberately do NOT check the remote ref here. Fresh pipelines run
 * for many minutes on a local-only branch before any push happens (some
 * pipelines never push at all). Treating remote-absence as "gone" reaped
 * active worktrees mid-pipeline, which then broke the final merge step with
 * "No worktree found".
 */
function reconcileMergedWorktrees() {
  const { execSync } = require("child_process");
  for (const [, wt] of Array.from(worktrees.entries())) {
    if (!wt || !wt.path || !wt.branch || !wt.baseRepo) continue;
    if (wt.status === "merged" || wt.status === "deleted") {
      // Already-merged record: directory was reaped synchronously, drop the row
      try {
        worktrees.delete(wt.id);
        db.worktrees.delete(wt.id).catch(e => console.error('[db] worktree delete failed: ' + e.message));
      } catch {}
      continue;
    }

    const dirGone = !fs.existsSync(wt.path);
    let branchGone = false;
    try {
      execSync(`git show-ref --verify --quiet refs/heads/${wt.branch}`, { cwd: wt.baseRepo, timeout: 15000, stdio: "pipe" });
      // exit 0 → local branch ref exists → branch is alive
    } catch (e) {
      // Non-zero exit means the local branch ref is missing.
      // Distinguish "missing" (exit 1) from "I/O or timeout error" — only treat the former as gone.
      if (e && (e.status === 1 || e.code === 1)) branchGone = true;
    }

    if (!dirGone && !branchGone) continue;

    try {
      console.log(`[${nowIso()}] Reconciler: reaping worktree for ${wt.issueKey} (dirGone=${dirGone}, branchGone=${branchGone})`);
      removeWorktree(wt.issueKey);
    } catch (e) {
      console.warn(`[${nowIso()}] Reconciler: removeWorktree failed for ${wt.issueKey}: ${e.message}`);
      // Drop the record anyway so it doesn't pile up
      try {
        worktrees.delete(wt.id);
        db.worktrees.delete(wt.id).catch(err => console.error('[db] worktree delete failed: ' + err.message));
      } catch {}
    }
  }
}

// Per-repo merge lock to prevent concurrent checkout/merge conflicts
const repoMergeLocks = new Map();
async function withMergeLock(cwd, fn) {
  const key = cwd;
  while (repoMergeLocks.get(key)) {
    await new Promise(r => setTimeout(r, 500));
  }
  repoMergeLocks.set(key, true);
  try { return await fn(); } finally { repoMergeLocks.delete(key); }
}

/**
 * Check if a branch for a given issue key has been merged into a trunk branch (dev or main).
 * Platform pattern is dev-only auto-merges (runner → dev, human-owned dev → main),
 * so a branch landed on dev is "shipped" from the dependency-gate's perspective.
 * Looks for branch patterns: {issueKey}-auto, {issueKey}
 * Also checks pipeline records for completed+merged state.
 * Fails open (returns true) if git check errors — avoids blocking everything.
 */
function isBranchMergedToTrunk(baseRepo, issueKey) {
  const { execSync } = require("child_process");
  const branchPatterns = [`${issueKey}-auto`, issueKey.toLowerCase()];
  const trunks = config.dependencyGating?.trunkBranches || ["dev", "main"];

  try {
    for (const trunk of trunks) {
      let mergedBranches;
      try {
        const merged = execSync(`git branch --merged ${trunk}`, {
          cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"]
        });
        mergedBranches = merged.split("\n").map(b => b.trim().replace(/^\*\s*/, ""));
      } catch (_) {
        // Trunk doesn't exist locally (e.g. only `main` in some repos) — skip it
        continue;
      }

      for (const pattern of branchPatterns) {
        if (mergedBranches.some(b => b === pattern)) return true;
      }

      // Issue key in merge commits on this trunk (branch may have been deleted after merge)
      try {
        const mergeLog = execSync(`git log --oneline --grep="${issueKey}" ${trunk} -5`, {
          cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"]
        });
        if (mergeLog.trim().length > 0) return true;
      } catch (_) { /* ignore */ }
    }

    // Pipeline records — if a pipeline completed + merged, treat as merged
    for (const p of pipelines.values()) {
      if (p.issueKey === issueKey && p.status === "completed" && p.merged) return true;
    }

    return false;
  } catch (e) {
    console.log(`[${nowIso()}] Dependency check: trunk merge probe failed for ${baseRepo}: ${e.message}`);
    return true; // Fail open
  }
}
