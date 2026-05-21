import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { Branding } from "../lib/manifest";

interface TitleCardProps {
  title: string;
  subtitle?: string;
  branding: Branding;
  durationInFrames: number;
}

export const TitleCard: React.FC<TitleCardProps> = ({
  title,
  subtitle,
  branding,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [0, 15, durationInFrames - 15, durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const titleY = interpolate(frame, [0, 20], [30, 0], {
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
          fontSize: 72,
          fontFamily: "Inter, sans-serif",
          fontWeight: 700,
          transform: `translateY(${titleY}px)`,
          textAlign: "center",
          padding: "0 80px",
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div
          style={{
            color: branding.accentColor,
            fontSize: 36,
            fontFamily: "Inter, sans-serif",
            fontWeight: 400,
            marginTop: 24,
            transform: `translateY(${titleY}px)`,
            textAlign: "center",
          }}
        >
          {subtitle}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          bottom: 60,
          color: "rgba(255,255,255,0.6)",
          fontSize: 24,
          fontFamily: "Inter, sans-serif",
        }}
      >
        {branding.productName}
      </div>
    </AbsoluteFill>
  );
};
