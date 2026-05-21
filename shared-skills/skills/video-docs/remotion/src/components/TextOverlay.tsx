import { interpolate, useCurrentFrame } from "remotion";
import type { TextOverlayConfig } from "../lib/manifest";

interface TextOverlayProps {
  config: TextOverlayConfig;
  durationInFrames: number;
}

const positionStyles: Record<string, React.CSSProperties> = {
  "bottom-left": { bottom: 40, left: 40, right: "auto" },
  "bottom-center": { bottom: 40, left: "50%", transform: "translateX(-50%)" },
  "top-left": { top: 40, left: 40, right: "auto" },
};

export const TextOverlay: React.FC<TextOverlayProps> = ({ config, durationInFrames }) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [0, 10, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const pos = positionStyles[config.position] ?? positionStyles["bottom-left"];

  return (
    <div
      style={{
        position: "absolute",
        ...pos,
        backgroundColor: "rgba(0, 0, 0, 0.65)",
        color: "white",
        padding: "12px 24px",
        borderRadius: 8,
        fontSize: 28,
        fontFamily: "Inter, sans-serif",
        fontWeight: 500,
        opacity,
        maxWidth: "60%",
      }}
    >
      {config.title}
    </div>
  );
};
