#!/usr/bin/env node
"use strict";

/**
 * One-time migration: runner-state.json + historical job files → PostgreSQL
 *
 * Uses db.js repository methods directly to ensure schema compatibility.
 *
 * Usage:
 *   RUNNER_DB_HOST=localhost RUNNER_DB_PORT=5432 RUNNER_DB_NAME=runner \
 *   RUNNER_DB_USER=runner RUNNER_DB_PASSWORD=runner_secure_password \
 *   node migrate-state-to-postgres.js [state-file] [log-dir]
 */

const fs = require("fs");
const path = require("path");
const db = require("./db");

const HOME = process.env.HOME || "/data/logs";
const STATE_FILE = process.argv[2] || path.join(HOME, "claude-runner-logs/runner-state.json");
const LOG_DIR = process.argv[3] || path.join(HOME, "claude-runner-logs");

/** State file serialises Maps as [[key, value], ...] arrays */
function iterEntries(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  return Object.entries(collection);
}

async function main() {
  console.log("=== Meshwork Runner State Migration to PostgreSQL ===\n");

  // Step 1: Init DB (creates tables via db.js schema)
  console.log("Step 1: Initialising database schema...");
  await db.init({});
  console.log("  Schema ready.\n");

  // Step 2: Read state file
  console.log(`Step 2: Reading state file: ${STATE_FILE}`);
  if (!fs.existsSync(STATE_FILE)) {
    console.error(`  ERROR: State file not found: ${STATE_FILE}`);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

  const jobEntries = iterEntries(state.jobs);
  const pipelineEntries = iterEntries(state.pipelines);
  const meetingEntries = iterEntries(state.meetings);
  const worktreeEntries = iterEntries(state.worktrees);
  const scheduledEntries = iterEntries(state.scheduledItems);

  console.log(
    `  Found: ${jobEntries.length} jobs, ${pipelineEntries.length} pipelines, ` +
    `${meetingEntries.length} meetings, ${worktreeEntries.length} worktrees, ` +
    `${scheduledEntries.length} scheduled items\n`
  );

  let totalErrors = 0;

  // Step 3: Jobs from state
  console.log("Step 3: Migrating jobs from state...");
  let jobCount = 0, jobErrors = 0;
  for (const [id, job] of jobEntries) {
    try {
      if (!job.jobId) job.jobId = id;
      await db.jobs.set(job);
      jobCount++;
    } catch (e) {
      console.error(`  Failed job ${id}: ${e.message}`);
      jobErrors++;
    }
  }
  console.log(`  Migrated ${jobCount} jobs (${jobErrors} errors).\n`);
  totalErrors += jobErrors;

  // Step 4: Historical job files
  console.log("Step 4: Scanning historical job files...");
  let histCount = 0, skipCount = 0, histErrors = 0;
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith("job_") && f.endsWith(".json"));
    console.log(`  Found ${files.length} job files on disk.`);

    for (const file of files) {
      try {
        const jobData = JSON.parse(fs.readFileSync(path.join(LOG_DIR, file), "utf8"));
        if (!jobData.jobId) continue;

        const existing = await db.jobs.get(jobData.jobId);
        if (existing) { skipCount++; continue; }

        await db.jobs.set(jobData);
        histCount++;
      } catch {
        histErrors++;
      }
    }
  } catch (e) {
    console.log(`  Warning: Could not scan log dir: ${e.message}`);
  }
  console.log(`  Migrated ${histCount} historical jobs (${skipCount} skipped, ${histErrors} errors).\n`);
  totalErrors += histErrors;

  // Step 5: Pipelines
  console.log("Step 5: Migrating pipelines...");
  let pipelineCount = 0, pipelineErrors = 0;
  for (const [id, pipeline] of pipelineEntries) {
    try {
      if (!pipeline.pipelineId) pipeline.pipelineId = id;
      await db.pipelines.set(pipeline);
      pipelineCount++;
    } catch (e) {
      console.error(`  Failed pipeline ${id}: ${e.message}`);
      pipelineErrors++;
    }
  }
  console.log(`  Migrated ${pipelineCount} pipelines (${pipelineErrors} errors).\n`);
  totalErrors += pipelineErrors;

  // Step 6: Meetings
  console.log("Step 6: Migrating meetings...");
  let meetingCount = 0, meetingErrors = 0;
  for (const [id, meeting] of meetingEntries) {
    try {
      if (!meeting.meetingId) meeting.meetingId = id;
      await db.meetings.set(meeting);
      meetingCount++;
    } catch (e) {
      console.error(`  Failed meeting ${id}: ${e.message}`);
      meetingErrors++;
    }
  }
  console.log(`  Migrated ${meetingCount} meetings (${meetingErrors} errors).\n`);
  totalErrors += meetingErrors;

  // Step 7: Worktrees
  console.log("Step 7: Migrating worktrees...");
  let wtCount = 0, wtErrors = 0;
  for (const [id, wt] of worktreeEntries) {
    try {
      if (!wt.id) wt.id = id;
      await db.worktrees.set(wt);
      wtCount++;
    } catch (e) {
      console.error(`  Failed worktree ${id}: ${e.message}`);
      wtErrors++;
    }
  }
  console.log(`  Migrated ${wtCount} worktrees (${wtErrors} errors).\n`);
  totalErrors += wtErrors;

  // Step 8: Scheduled items
  console.log("Step 8: Migrating scheduled items...");
  let schedCount = 0, schedErrors = 0;
  for (const [id, item] of scheduledEntries) {
    try {
      if (!item.id) item.id = id;
      await db.scheduled.set(item);
      schedCount++;
    } catch (e) {
      console.error(`  Failed scheduled item ${id}: ${e.message}`);
      schedErrors++;
    }
  }
  console.log(`  Migrated ${schedCount} scheduled items (${schedErrors} errors).\n`);
  totalErrors += schedErrors;

  // Step 9: Skill usage
  console.log("Step 9: Migrating skill usage...");
  let skillCount = 0, skillErrors = 0;
  if (state.skillUsage && typeof state.skillUsage === "object") {
    const entries = Array.isArray(state.skillUsage) ? state.skillUsage : Object.entries(state.skillUsage);
    for (const [name, data] of entries) {
      try {
        // Use raw increment to seed initial values
        if (data.reads) {
          for (let i = 0; i < data.reads; i++) {
            await db.skillUsage.increment(name, "read", "migration");
          }
        }
        if (data.scriptRuns) {
          for (let i = 0; i < data.scriptRuns; i++) {
            await db.skillUsage.increment(name, "script", "migration");
          }
        }
        // If no reads or scriptRuns, still create the entry
        if (!data.reads && !data.scriptRuns) {
          await db.skillUsage.increment(name, "read", "migration");
        }
        skillCount++;
      } catch (e) {
        console.error(`  Failed skill '${name}': ${e.message}`);
        skillErrors++;
      }
    }
  }
  console.log(`  Migrated ${skillCount} skill entries (${skillErrors} errors).\n`);
  totalErrors += skillErrors;

  // Step 10: Verification
  console.log("Step 10: Verification...");
  const counts = {
    jobs: await db.jobs.count(),
    pipelines: await db.pipelines.count(),
    meetings: await db.meetings.count(),
    worktrees: await db.worktrees.count(),
    scheduled: await db.scheduled.count(),
  };

  console.log("  Database row counts:");
  for (const [table, count] of Object.entries(counts)) {
    console.log(`    ${table.padEnd(16)} ${count}`);
  }

  if (totalErrors > 0) {
    console.log(`\nWARNING: ${totalErrors} total errors — review output above.`);
  } else {
    console.log("\nAll records migrated without errors.");
  }

  console.log("\n=== Migration complete ===");
  await db.close();
}

main().catch(e => {
  console.error(`Migration failed: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
