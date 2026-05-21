import { interpolate } from "remotion";
import type { KenBurnsConfig } from "./manifest";

const DEFAULT_KEN_BURNS: KenBurnsConfig = {
  startScale: 1.0,
  endScale: 1.0,
  startX: 0.5,
  startY: 0.5,
  endX: 0.5,
  endY: 0.5,
};

// Disable zoom/pan — static framing prevents judder on screenshot content
const MAX_SCALE = 1.0;
const MAX_TRANSLATE_PCT = 0;

export function getKenBurnsStyle(
  frame: number,
  durationInFrames: number,
  config?: KenBurnsConfig
): React.CSSProperties {
  const kb = config ?? DEFAULT_KEN_BURNS;

  // Clamp scales to prevent over-zoom on screenshot content
  const clampedStartScale = Math.min(kb.startScale, MAX_SCALE);
  const clampedEndScale = Math.min(kb.endScale, MAX_SCALE);

  const scale = interpolate(frame, [0, durationInFrames], [clampedStartScale, clampedEndScale], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const rawTranslateX = interpolate(frame, [0, durationInFrames], [kb.startX - 0.5, kb.endX - 0.5], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const rawTranslateY = interpolate(frame, [0, durationInFrames], [kb.startY - 0.5, kb.endY - 0.5], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Clamp translation to prevent wild panning
  const translateX = Math.max(-MAX_TRANSLATE_PCT, Math.min(MAX_TRANSLATE_PCT, rawTranslateX * -100));
  const translateY = Math.max(-MAX_TRANSLATE_PCT, Math.min(MAX_TRANSLATE_PCT, rawTranslateY * -100));

  return {
    transform: `scale(${scale}) translate(${translateX}%, ${translateY}%)`,
    transformOrigin: "center center",
  };
}
