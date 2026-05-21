export interface KenBurnsConfig {
  startScale: number;
  endScale: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface TextOverlayConfig {
  title: string;
  position: "bottom-left" | "bottom-center" | "top-left";
}

export interface Scene {
  id: string;
  screenshot: string;
  narration: string;
  durationSeconds: number;
  kenBurns?: KenBurnsConfig;
  textOverlay?: TextOverlayConfig;
  audioFile?: string;
  actualDurationSeconds?: number;
}

export interface Branding {
  productName: string;
  primaryColor: string;
  accentColor: string;
}

export interface TtsConfig {
  provider: "edge" | "elevenlabs";
  voice: string;
}

export interface IntroConfig {
  enabled: boolean;
  durationSeconds: number;
  title: string;
  subtitle?: string;
}

export interface OutroConfig {
  enabled: boolean;
  durationSeconds: number;
}

export interface VideoManifest {
  guideFile: string;
  title: string;
  locale: string;
  outputFile: string;
  branding: Branding;
  tts: TtsConfig;
  scenes: Scene[];
  intro?: IntroConfig;
  outro?: OutroConfig;
}

export function calculateTotalDuration(manifest: VideoManifest, fps: number): number {
  let totalFrames = 0;
  const crossfadeFrames = Math.round(0.4 * fps);

  if (manifest.intro?.enabled) {
    totalFrames += Math.round(manifest.intro.durationSeconds * fps);
  }

  for (let i = 0; i < manifest.scenes.length; i++) {
    const scene = manifest.scenes[i];
    const duration = scene.actualDurationSeconds ?? scene.durationSeconds;
    totalFrames += Math.round(duration * fps);
    // Scenes overlap (not gap) — subtract crossfade duration
    if (i < manifest.scenes.length - 1) {
      totalFrames -= crossfadeFrames;
    }
  }

  if (manifest.outro?.enabled) {
    totalFrames += Math.round(manifest.outro.durationSeconds * fps);
  }

  return totalFrames;
}
