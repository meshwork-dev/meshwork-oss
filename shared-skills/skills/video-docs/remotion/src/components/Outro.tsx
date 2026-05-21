import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { Branding } from "../lib/manifest";

interface OutroProps {
  branding: Branding;
  durationInFrames: number;
}

export const Outro: React.FC<OutroProps> = ({ branding, durationInFrames }) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [0, 15, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: branding.primaryColor,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity,
      }}
    >
      <div
        style={{
          color: "white",
          fontSize: 48,
          fontFamily: "Inter, sans-serif",
          fontWeight: 600,
        }}
      >
        {branding.productName}
      </div>
      <div
        style={{
          color: branding.accentColor,
          fontSize: 28,
          fontFamily: "Inter, sans-serif",
          fontWeight: 400,
          marginTop: 16,
        }}
      >
        Learn more at {branding.productName.toLowerCase().replace(/\s+/g, "")}.co.uk
      </div>
    </AbsoluteFill>
  );
};
