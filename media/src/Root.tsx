import type React from "react";
import { Composition } from "remotion";
import { HowItIsBuilt, SCENES as BUILT } from "./videos/HowItIsBuilt";
import { InSixtySeconds, SCENES as SIXTY } from "./videos/InSixtySeconds";

const FPS = 30;
const frames = (scenes: number[]) => scenes.reduce((a, b) => a + b, 0) * FPS;

export const Root: React.FC = () => (
  <>
    <Composition id="HowItIsBuilt" component={HowItIsBuilt} durationInFrames={frames(BUILT)} fps={FPS} width={1920} height={1080} />
    <Composition id="InSixtySeconds" component={InSixtySeconds} durationInFrames={frames(SIXTY)} fps={FPS} width={1920} height={1080} />
  </>
);
