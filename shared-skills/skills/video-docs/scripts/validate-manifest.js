#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("Usage: validate-manifest.js <manifest.json>");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const errors = [];

// Required root fields
for (const field of ["guideFile", "title", "locale", "outputFile", "branding", "tts", "scenes"]) {
  if (!manifest[field]) errors.push(`Missing required field: ${field}`);
}

// Branding
if (manifest.branding) {
  for (const field of ["productName", "primaryColor", "accentColor"]) {
    if (!manifest.branding[field]) errors.push(`Missing branding.${field}`);
  }
}

// TTS
if (manifest.tts) {
  if (!["edge", "elevenlabs"].includes(manifest.tts.provider)) {
    errors.push(`Invalid tts.provider: ${manifest.tts.provider} (must be "edge" or "elevenlabs")`);
  }
  if (!manifest.tts.voice) errors.push("Missing tts.voice");
}

// Scenes
if (Array.isArray(manifest.scenes)) {
  const baseDir = path.dirname(manifestPath);
  manifest.scenes.forEach((scene, i) => {
    if (!scene.id) errors.push(`Scene ${i}: missing id`);
    if (!scene.screenshot) errors.push(`Scene ${i}: missing screenshot`);
    if (!scene.narration) errors.push(`Scene ${i}: missing narration`);
    if (!scene.durationSeconds || scene.durationSeconds < 1) {
      errors.push(`Scene ${i}: invalid durationSeconds`);
    }

    // Check screenshot file exists (relative to manifest directory)
    if (scene.screenshot) {
      const screenshotPath = path.resolve(baseDir, "..", scene.screenshot);
      if (!fs.existsSync(screenshotPath)) {
        errors.push(`Scene ${i}: screenshot not found: ${screenshotPath}`);
      }
    }

    // Validate Ken Burns
    if (scene.kenBurns) {
      const kb = scene.kenBurns;
      for (const f of ["startScale", "endScale"]) {
        if (typeof kb[f] !== "number" || kb[f] < 0.5 || kb[f] > 2.0) {
          errors.push(`Scene ${i}: kenBurns.${f} must be 0.5-2.0`);
        }
      }
      for (const f of ["startX", "startY", "endX", "endY"]) {
        if (kb[f] !== undefined && (typeof kb[f] !== "number" || kb[f] < 0 || kb[f] > 1)) {
          errors.push(`Scene ${i}: kenBurns.${f} must be 0-1`);
        }
      }
    }
  });

  if (manifest.scenes.length === 0) errors.push("scenes array is empty");
} else {
  errors.push("scenes must be an array");
}

if (errors.length > 0) {
  console.error("Manifest validation FAILED:");
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
} else {
  console.log(`Manifest valid: ${manifest.scenes.length} scenes, title="${manifest.title}"`);
}
