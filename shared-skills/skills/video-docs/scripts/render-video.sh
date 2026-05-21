#!/usr/bin/env bash
set -euo pipefail

MANIFEST="${1:?Usage: render-video.sh <manifest.json>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTION_DIR="$SCRIPT_DIR/../remotion"
BASE_DIR="$(dirname "$MANIFEST")"

echo "=== Video Docs Pipeline ==="
echo "Manifest: $MANIFEST"

# Step 1: Validate manifest
echo ""
echo "--- Step 1: Validate manifest ---"
node "$SCRIPT_DIR/validate-manifest.js" "$MANIFEST"

# Step 2: Generate TTS audio
echo ""
echo "--- Step 2: Generate TTS audio ---"
node "$SCRIPT_DIR/generate-tts.js" "$MANIFEST"

RENDERED_MANIFEST="$BASE_DIR/_rendered-manifest.json"
if [ ! -f "$RENDERED_MANIFEST" ]; then
  echo "ERROR: _rendered-manifest.json not found after TTS generation"
  exit 1
fi

# Step 3: Install Remotion deps if needed
if [ ! -d "$REMOTION_DIR/node_modules" ]; then
  echo ""
  echo "--- Step 3: Installing Remotion dependencies ---"
  cd "$REMOTION_DIR" && npm install && cd -
fi

# Step 4: Render video with Remotion
echo ""
echo "--- Step 4: Render video ---"
OUTPUT_FILE=$(node -e "console.log(require('$RENDERED_MANIFEST').outputFile)")
OUTPUT_PATH="$(dirname "$MANIFEST")/../$OUTPUT_FILE"
OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"
mkdir -p "$OUTPUT_DIR"

cd "$REMOTION_DIR"
npx remotion render TutorialVideo "$OUTPUT_PATH" \
  --props="$(echo "{\"manifestPath\": \"$RENDERED_MANIFEST\"}" | node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))))")" \
  --codec=h264 \
  --crf=18

echo ""
echo "=== Video rendered successfully ==="
echo "Output: $OUTPUT_PATH"
