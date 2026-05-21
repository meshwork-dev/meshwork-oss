#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("Usage: generate-tts.js <manifest.json>");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const baseDir = path.dirname(manifestPath);
const audioDir = path.join(baseDir, "audio");
fs.mkdirSync(audioDir, { recursive: true });

async function generateEdgeTts(text, outputPath, voice) {
  const { EdgeTTS } = require("edge-tts-universal");
  const tts = new EdgeTTS();
  await tts.synthesize(text, voice, { outputPath });

  // Read the wav file to determine actual duration
  const stats = fs.statSync(outputPath);
  // Rough estimate: WAV at 16kHz 16-bit mono = 32000 bytes/sec
  // Actual duration will be refined by Remotion
  const estimatedDuration = stats.size / 32000;
  return estimatedDuration;
}

async function generateElevenLabsTts(text, outputPath, voice) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY environment variable required");

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });

  if (!response.ok) throw new Error(`ElevenLabs API error: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  const estimatedDuration = buffer.length / 32000;
  return estimatedDuration;
}

async function main() {
  const provider = manifest.tts?.provider || "edge";
  const voice = manifest.tts?.voice || "en-GB-RyanNeural";

  console.log(`TTS provider: ${provider}, voice: ${voice}`);
  console.log(`Processing ${manifest.scenes.length} scenes...`);

  const renderedScenes = [];

  for (const scene of manifest.scenes) {
    const audioFile = `audio/${scene.id}.wav`;
    const audioPath = path.join(baseDir, audioFile);

    console.log(`  ${scene.id}: "${scene.narration.substring(0, 50)}..."`);

    let actualDuration;
    try {
      if (provider === "elevenlabs") {
        actualDuration = await generateElevenLabsTts(scene.narration, audioPath, voice);
      } else {
        actualDuration = await generateEdgeTts(scene.narration, audioPath, voice);
      }
    } catch (err) {
      console.error(`  ERROR generating TTS for ${scene.id}: ${err.message}`);
      actualDuration = scene.durationSeconds;
    }

    // Ensure minimum duration
    actualDuration = Math.max(actualDuration, 5);

    renderedScenes.push({
      ...scene,
      audioFile,
      actualDurationSeconds: Math.round(actualDuration * 10) / 10,
    });
  }

  // Write rendered manifest with actual durations
  const renderedManifest = { ...manifest, scenes: renderedScenes };
  const renderedPath = path.join(baseDir, "_rendered-manifest.json");
  fs.writeFileSync(renderedPath, JSON.stringify(renderedManifest, null, 2));

  console.log(`\nTTS complete. Rendered manifest: ${renderedPath}`);
  console.log(`Audio files: ${audioDir}/`);
}

main().catch((err) => {
  console.error(`TTS generation failed: ${err.message}`);
  process.exit(1);
});
