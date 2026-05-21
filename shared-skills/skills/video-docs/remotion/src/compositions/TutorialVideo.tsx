import { AbsoluteFill, Sequence } from "remotion";
import { TitleCard } from "../components/TitleCard";
import { Scene } from "../components/Scene";
import { Outro } from "../components/Outro";
import type { VideoManifest } from "../lib/manifest";

interface TutorialVideoProps {
  manifestPath: string;
}

export const TutorialVideo: React.FC<TutorialVideoProps> = ({ manifestPath }) => {
  const manifest: VideoManifest = require(manifestPath);
  const fps = 30;
  const crossfadeFrames = Math.round(0.4 * fps); // 12 frames = 0.4s dissolve

  const basePath = manifestPath.substring(0, manifestPath.lastIndexOf("/"));

  let currentFrame = 0;
  const sequences: React.ReactNode[] = [];

  // Intro
  if (manifest.intro?.enabled) {
    const introFrames = Math.round(manifest.intro.durationSeconds * fps);
    sequences.push(
      <Sequence key="intro" from={currentFrame} durationInFrames={introFrames}>
        <TitleCard
          title={manifest.intro.title}
          subtitle={manifest.intro.subtitle}
          branding={manifest.branding}
          durationInFrames={introFrames}
        />
      </Sequence>
    );
    currentFrame += introFrames;
  }

  // Scenes — overlapping by crossfadeFrames for true dissolve transitions
  for (let i = 0; i < manifest.scenes.length; i++) {
    const scene = manifest.scenes[i];
    const duration = scene.actualDurationSeconds ?? scene.durationSeconds;
    const durationFrames = Math.round(duration * fps);

    const isFirst = i === 0 && !manifest.intro?.enabled;
    const isLast = i === manifest.scenes.length - 1 && !manifest.outro?.enabled;

    sequences.push(
      <Sequence key={scene.id} from={currentFrame} durationInFrames={durationFrames}>
        <Scene
          scene={scene}
          durationInFrames={durationFrames}
          basePath={basePath}
          fadeInFrames={isFirst ? 0 : crossfadeFrames}
          fadeOutFrames={isLast ? 0 : crossfadeFrames}
        />
      </Sequence>
    );

    // Overlap next scene by crossfadeFrames (true dissolve, not black gap)
    currentFrame += durationFrames;
    if (i < manifest.scenes.length - 1) {
      currentFrame -= crossfadeFrames;
    }
  }

  // Outro
  if (manifest.outro?.enabled) {
    const outroFrames = Math.round((manifest.outro.durationSeconds ?? 3) * fps);
    sequences.push(
      <Sequence key="outro" from={currentFrame} durationInFrames={outroFrames}>
        <Outro branding={manifest.branding} durationInFrames={outroFrames} />
      </Sequence>
    );
  }

  return <AbsoluteFill style={{ backgroundColor: "#000" }}>{sequences}</AbsoluteFill>;
};
