---
name: video-docs
description: "Video documentation rendering infrastructure. Defines the video manifest JSON schema, Remotion composition architecture, TTS generation, and Ken Burns animation system. Use when generating video manifests from user guides or rendering tutorial videos from manifests."
last_updated: 2026-04-12
---

# Video Documentation Pipeline

Infrastructure for converting screenshot-based user guides into polished tutorial videos. Two-phase architecture: manifest generation (by user-guide-agent) and video rendering (by video-renderer agent).

## When to Apply

- **Manifest generation**: After writing a Markdown user guide with screenshots, generate a video manifest JSON
- **Video rendering**: When a manifest exists and needs to be rendered into MP4

## Video Manifest Schema

Each manifest lives at `docs/user-guides/video-manifests/{guide-name}.json` relative to the product repo.

### Root Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `guideFile` | string | Yes | Relative path to the source Markdown guide |
| `title` | string | Yes | Human-readable title for the video |
| `locale` | string | Yes | BCP 47 locale (e.g., `en-GB`) |
| `outputFile` | string | Yes | Relative path for rendered MP4 output |
| `branding` | object | Yes | Product branding configuration |
| `tts` | object | Yes | Text-to-speech configuration |
| `scenes` | array | Yes | Ordered array of scene objects |
| `intro` | object | No | Intro card configuration |
| `outro` | object | No | Outro card configuration |

### Branding Object

| Field | Type | Description |
|-------|------|-------------|
| `productName` | string | Product display name |
| `primaryColor` | string | Hex colour for backgrounds/headers |
| `accentColor` | string | Hex colour for highlights/buttons |

### TTS Object

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `"edge"` or `"elevenlabs"` | TTS engine selection |
| `voice` | string | Voice ID (e.g., `en-GB-RyanNeural` for Edge) |

### Scene Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique scene identifier (e.g., `scene-01`) |
| `screenshot` | string | Yes | Relative path to screenshot PNG |
| `narration` | string | Yes | Voiceover text for this scene |
| `durationSeconds` | number | Yes | Estimated duration (overridden by actual TTS audio length) |
| `kenBurns` | object | No | **DEPRECATED — do not include.** Zoom/pan disabled; screenshots are shown static at full size |
| `textOverlay` | object | No | On-screen text overlay |

### Ken Burns Object (DEPRECATED — DO NOT USE)

Ken Burns zoom/pan is disabled. It causes judder on screenshot-based content. Do not include `kenBurns` in scene objects. The renderer ignores it — all scenes display static at full resolution.

### Text Overlay Object

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | string | - | Text to display |
| `position` | string | `bottom-left` | Position: `bottom-left`, `bottom-center`, `top-left` |

### Intro/Outro Object

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | true | Whether to include this card |
| `durationSeconds` | number | 4 (intro) / 3 (outro) | Card duration |
| `title` | string | - | Main title text |
| `subtitle` | string | - | Subtitle text (intro only) |

## Manifest Generation Guidelines (for user-guide-agent)

1. **One manifest per guide**: Each Markdown guide gets one manifest JSON
2. **Scene mapping**: Each `### N. {Step}` section with a screenshot becomes one scene
3. **Narration style**: Rewrite step text for voiceover — shorter, conversational, professional UK English
4. **Duration estimation**: ~1 second per 15 words of narration, minimum 5 seconds per scene
5. **No Ken Burns**: Do NOT include `kenBurns` in any scene. Screenshots are displayed static at full resolution with `object-fit: contain` so the entire application UI is always visible. No zoom, no pan.
6. **Branding**: Read `primaryColor` and `accentColor` from the product's `product.json`

## Video Rendering Pipeline (for video-renderer agent)

```
1. Validate manifest (scripts/validate-manifest.js)
2. Generate TTS audio (scripts/generate-tts.js)
   → Writes .wav per scene + _rendered-manifest.json with actual durations
3. Render video (scripts/render-video.sh)
   → Remotion reads _rendered-manifest.json → outputs MP4
```

### Composition Structure

```
[TitleCard 4s] → [Scene 1 + audio + overlay] ←0.4s dissolve→ [Scene 2] → ... → [Outro 3s]
```

- Resolution: 1920x1080 @ 30fps
- Codec: h264
- Ken Burns: DISABLED — screenshots shown static with `object-fit: contain` (full app visible, no judder)
- Transitions: true dissolve crossfade (overlapping scenes with opacity), not black gaps
- Audio: `<Audio>` component per scene with 0.3s fade in/out
- Text overlays: semi-transparent bar, Inter font

## Example Manifest

```json
{
  "guideFile": "01-dashboard.md",
  "title": "Dashboard Overview",
  "locale": "en-GB",
  "outputFile": "docs/user-guides/videos/01-dashboard.mp4",
  "branding": {
    "productName": "EstateOS",
    "primaryColor": "#1E3A8A",
    "accentColor": "#F59E0B"
  },
  "tts": { "provider": "edge", "voice": "en-GB-RyanNeural" },
  "scenes": [
    {
      "id": "scene-01",
      "screenshot": "images/dashboard-01-overview.png",
      "narration": "When you sign in to EstateOS, you arrive at the Dashboard. This gives you an at-a-glance view of your active matters, upcoming deadlines, and recent activity.",
      "durationSeconds": 8,
      "textOverlay": { "title": "Dashboard Overview", "position": "bottom-left" }
    }
  ],
  "intro": { "enabled": true, "durationSeconds": 4, "title": "EstateOS Tutorial", "subtitle": "Dashboard Overview" },
  "outro": { "enabled": true, "durationSeconds": 3 }
}
```
