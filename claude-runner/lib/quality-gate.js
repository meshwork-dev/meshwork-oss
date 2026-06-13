// quality-gate.js — post-job quality gate checks and automated repair
// Extracted from runner.js.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { parseTestSummary } = require("./protocol");
const { config } = require("./config");
const { pushFallbackModel } = require("./models");
const { applyProductPluginDir, products, resolveProduct } = require("./products");
const { appendLog, nowIso } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  runQualityCheck,
  runQualityGate,
  buildQualityGateRetryContext,
  repairQualityGateFailure,
};


/**
 * Run a single quality gate check
 */
function runQualityCheck(check, workingDir) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const child = spawn("sh", ["-c", check.cmd], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    // Timeout after 5 minutes per check
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({
        name: check.name,
        passed: false,
        output: "Timeout after 5 minutes",
        durationMs: Date.now() - startTime
      });
    }, 5 * 60 * 1000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        name: check.name,
        passed: code === 0,
        output: stdout + stderr,
        exitCode: code,
        durationMs: Date.now() - startTime
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        name: check.name,
        passed: false,
        output: `Error: ${err.message}`,
        durationMs: Date.now() - startTime
      });
    });
  });
}

/**
 * Run quality gate checks after implementation
 * Returns { passed, results, failedCheck, retryContext }
 */
async function runQualityGate(job) {
  const qg = config.qualityGate;
  if (!qg.enabled) {
    return { passed: true, skipped: true, results: [] };
  }

  // Only run for configured agents
  if (!qg.runAfterAgents.includes(job.agent)) {
    return { passed: true, skipped: true, reason: `agent ${job.agent} not in runAfterAgents`, results: [] };
  }

  // Skip code quality gate for phases whose gate type is not 'quality-gate'
  // (e.g. comment-prefix phases like triage/requirements/security-review don't produce testable code)
  if (job.pipelineGateType && job.pipelineGateType !== "quality-gate") {
    return { passed: true, skipped: true, reason: `phase gate type is '${job.pipelineGateType}', not 'quality-gate'`, results: [] };
  }

  // Product-level quality gate override: check product.json for custom checks,
  // falling back to the dev commands collected at onboarding (techStack.commands)
  // so a product never silently runs the global npm defaults against a repo
  // whose scripts have different names.
  let productChecks = null;
  for (const [, product] of products) {
    const mappedDir = config.pathMappings?.[product.workingDir] || product.workingDir;
    if (job.workingDir === product.workingDir || job.workingDir === mappedDir) {
      productChecks = product.qualityGate?.checks || null;
      if (productChecks) {
        appendLog(job.logFile, `\n[${nowIso()}] Using product-level quality gate checks for ${product.name}\n`);
      } else if (product.techStack?.commands) {
        const cmds = product.techStack.commands;
        const fallback = [
          cmds.typeCheck ? { name: "type-check", cmd: cmds.typeCheck, required: true } : null,
          cmds.lint ? { name: "lint", cmd: cmds.lint, required: true } : null,
          cmds.test ? { name: "test", cmd: cmds.test, required: true } : null,
        ].filter(Boolean);
        if (fallback.length > 0) {
          productChecks = fallback;
          appendLog(job.logFile, `\n[${nowIso()}] Using quality gate checks derived from techStack.commands for ${product.name} (${fallback.map(c => c.name).join(", ")})\n`);
        }
      }
      break;
    }
  }

  appendLog(job.logFile, `\n[${nowIso()}] Running quality gate checks...\n`);

  const gateChecks = productChecks || qg.checks;
  const results = [];
  let allPassed = true;
  let failedCheck = null;

  // Detect Turborepo monorepo once for all checks
  const isTurboRepo = (() => {
    try { return fs.existsSync(path.join(job.workingDir, "turbo.json")); } catch { return false; }
  })();

  // Auto-detect package manager (pnpm > yarn > npm)
  const detectedPkgMgr = (() => {
    try {
      if (fs.existsSync(path.join(job.workingDir, "pnpm-lock.yaml"))) return "pnpm";
      if (fs.existsSync(path.join(job.workingDir, "yarn.lock"))) return "yarn";
      // Also check packageManager field in package.json
      const pkgPath = path.join(job.workingDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.packageManager) {
          if (pkg.packageManager.startsWith("pnpm")) return "pnpm";
          if (pkg.packageManager.startsWith("yarn")) return "yarn";
        }
      }
    } catch {}
    return "npm";
  })();

  for (const check of gateChecks) {
    // For Turborepo monorepos, replace the typecheck command with `npx turbo type-check`
    // to avoid phantom errors from the root tsconfig (which has no jsx setting)
    let resolvedCheck = (check.name === "typecheck" && isTurboRepo)
      ? { ...check, cmd: "npx turbo type-check" }
      : check;

    // Replace npm with detected package manager (pnpm/yarn) in check commands
    if (detectedPkgMgr !== "npm" && resolvedCheck.cmd.startsWith("npm ")) {
      resolvedCheck = { ...resolvedCheck, cmd: resolvedCheck.cmd.replace(/^npm /, `${detectedPkgMgr} `) };
    }

    const pkgNote = detectedPkgMgr !== "npm" ? ` [${detectedPkgMgr} detected]` : "";
    appendLog(job.logFile, `[${nowIso()}] Running check: ${resolvedCheck.name} (${resolvedCheck.cmd}${isTurboRepo && check.name === "typecheck" ? " [turbo detected]" : ""}${pkgNote})\n`);

    const result = await runQualityCheck(resolvedCheck, job.workingDir);

    if (resolvedCheck.name === "test") {
      const stats = parseTestSummary(result.output);
      if (stats) {
        result.testStats = stats;
        appendLog(job.logFile, `[${nowIso()}] Test summary (${stats.runner}): ${stats.passed} passed, ${stats.failed} failed\n`);
        if (result.passed && stats.failed > 0) {
          result.passed = false;
          result.failedByTestStats = true;
          appendLog(job.logFile, `[${nowIso()}] Test command exited 0 but the runner reported ${stats.failed} failing test(s) — marking check FAILED\n`);
        }
      }
    }
    results.push(result);

    appendLog(job.logFile, `[${nowIso()}] Check ${check.name}: ${result.passed ? "PASSED" : "FAILED"} (${result.durationMs}ms)\n`);

    if (!result.passed) {
      allPassed = false;
      if (resolvedCheck.required) {
        failedCheck = { ...resolvedCheck, result };
        // Log failure output for context
        appendLog(job.logFile, `[${nowIso()}] Failure output:\n${result.output.slice(0, 5000)}\n`);
        break; // Stop on first required failure
      }
    }
  }

  const gateResult = {
    passed: allPassed,
    results,
    failedCheck,
    retryContext: null
  };

  // Build retry context if failed and retryWithContext is enabled
  if (!allPassed && failedCheck && qg.retryWithContext) {
    gateResult.retryContext = buildQualityGateRetryContext(job, failedCheck);
  }

  appendLog(job.logFile, `[${nowIso()}] Quality gate ${allPassed ? "PASSED" : "FAILED"}\n`);

  return gateResult;
}

/**
 * Build context for retry attempt after quality gate failure
 */
function buildQualityGateRetryContext(job, failedCheck) {
  const output = failedCheck.result?.output || "";
  // Truncate output to avoid overwhelming the prompt
  const truncatedOutput = output.length > 4000 ? output.slice(0, 4000) + "\n...[truncated]" : output;

  return {
    failedCheck: failedCheck.name,
    failedCommand: failedCheck.cmd,
    failureOutput: truncatedOutput,
    retryPrompt: `Previous implementation attempt failed quality gate check "${failedCheck.name}" (${failedCheck.cmd}).\n\nFailure output:\n${truncatedOutput}\n\nPlease fix the issues and complete the implementation.`
  };
}

/**
 * Targeted quality gate repair: spawn a lightweight Claude session to fix errors
 * instead of re-running the entire agent from scratch.
 *
 * Returns { repaired: boolean, checkResult: object }
 */
async function repairQualityGateFailure(job, failedCheck, attempt) {
  const output = failedCheck.result?.output || "";
  const truncatedOutput = output.length > 6000 ? output.slice(0, 6000) + "\n...[truncated]" : output;

  appendLog(job.logFile, `\n[${nowIso()}] Quality gate repair attempt ${attempt}: fixing "${failedCheck.name}" errors\n`);

  const prompt = [
    `You are a code repair agent. A quality gate check failed and you must fix the errors.`,
    ``,
    `Working directory: ${job.workingDir}`,
    job.issueKey ? `Jira issue: ${job.issueKey}` : "",
    ``,
    `The following quality gate check failed:`,
    `  Check: ${failedCheck.name}`,
    `  Command: ${failedCheck.cmd}`,
    ``,
    `Error output:`,
    "```",
    truncatedOutput,
    "```",
    ``,
    `Instructions:`,
    `- Read the error output carefully and identify every file and line with errors.`,
    `- Open each affected file, understand the surrounding code, and fix the errors.`,
    `- For type-check errors: fix type mismatches, missing imports, incorrect generics, missing properties.`,
    `- For lint errors: fix the specific lint violations shown.`,
    `- For test failures: fix the failing test or the code it tests.`,
    `- Make minimal, targeted fixes. Do NOT refactor or restructure unrelated code.`,
    `- After fixing, run \`${failedCheck.cmd}\` to verify your fixes resolved the errors.`,
    `- If new errors appear from your fixes, fix those too until the check passes.`,
  ].filter(Boolean).join("\n");

  const repairModel = config.claude.models.sonnet || "claude-sonnet-4-6";
  const args = [...(config.claude.baseArgs || ["--dangerously-skip-permissions"])];
  args.push("--model", repairModel);
  pushFallbackModel(args, "sonnet");
  args.push("-p");
  args.push("--output-format", "json");
  args.push("--no-session-persistence");

  // Apply product plugin directory
  const product = resolveProduct(job.workingDir);
  applyProductPluginDir(args, product);

  const cliCmd = config.claude?.command || "claude";

  // Run repair session
  const repairResult = await new Promise((resolve) => {
    const proc = spawn(cliCmd, args, {
      cwd: job.workingDir,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const timeout = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      resolve({ success: false, output: "Repair timed out after 5 minutes" });
    }, 5 * 60 * 1000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      let content = "";
      try {
        const parsed = JSON.parse(stdout);
        content = parsed.result || parsed.output || stdout;
      } catch {
        content = stdout.trim() || stderr.trim() || "(no output)";
      }
      appendLog(job.logFile, `[${nowIso()}] Repair session finished (exit ${code})\n`);
      resolve({ success: code === 0, output: content });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ success: false, output: `Repair spawn error: ${err.message}` });
    });
  });

  appendLog(job.logFile, `[${nowIso()}] Repair session ${repairResult.success ? "completed" : "failed"}, re-running check "${failedCheck.name}"...\n`);

  // Re-run only the failed check to see if repair worked
  const recheckResult = await runQualityCheck(failedCheck, job.workingDir);

  appendLog(job.logFile, `[${nowIso()}] Re-check "${failedCheck.name}": ${recheckResult.passed ? "PASSED" : "FAILED"} (${recheckResult.durationMs}ms)\n`);

  if (!recheckResult.passed) {
    appendLog(job.logFile, `[${nowIso()}] Repair attempt ${attempt} did not resolve errors:\n${(recheckResult.output || "").slice(0, 2000)}\n`);
  }

  return { repaired: recheckResult.passed, checkResult: recheckResult };
}
