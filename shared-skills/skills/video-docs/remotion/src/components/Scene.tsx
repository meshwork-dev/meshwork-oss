import { AbsoluteFill, Audio, Img, Sequence, interpolate, useCurrentFrame } from "remotion";
import { TextOverlay } from "./TextOverlay";
import type { Scene as SceneType } from "../lib/manifest";

interface SceneProps {
  scene: SceneType;
  durationInFrames: number;
  basePath: string;
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

export const Scene: React.FC<SceneProps> = ({
  scene,
  durationInFrames,
  basePath,
  fadeInFrames = 0,
  fadeOutFrames = 0,
}) => {
  const frame = useCurrentFrame();

  const screenshotPath = `${basePath}/${scene.screenshot}`;
  const audioPath = scene.audioFile ? `${basePath}/${scene.audioFile}` : undefined;

  // Crossfade opacity — dissolve between scenes
  const opacity = interpolate(
    frame,
    [0, fadeInFrames, durationInFrames - fadeOutFrames, durationInFrames],
    [fadeInFrames > 0 ? 0 : 1, 1, 1, fadeOutFrames > 0 ? 0 : 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ opacity }}>
      <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
        <Img
          src={screenshotPath}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            background: "#0f172a",
          }}
        />
      </div>
      {audioPath && (
        <Sequence from={0} durationInFrames={durationInFrames}>
          <Audio src={audioPath} volume={(f) => {
            const fadeInEnd = 9;
            const fadeOutStart = durationInFrames - 9;
            if (f < fadeInEnd) return f / fadeInEnd;
            if (f > fadeOutStart) return (durationInFrames - f) / 9;
            return 1;
          }} />
        </Sequence>
      )}
      {scene.textOverlay && (
        <TextOverlay config={scene.textOverlay} durationInFrames={durationInFrames} />
      )}
    </AbsoluteFill>
  );
};
