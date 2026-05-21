import { Composition } from "remotion";
import { TutorialVideo } from "./compositions/TutorialVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TutorialVideo"
        component={TutorialVideo}
        durationInFrames={900}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          manifestPath: "",
        }}
      />
    </>
  );
};
