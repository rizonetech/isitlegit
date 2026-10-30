import type React from "react";
import { Composition } from "remotion";
import { HowItIsBuilt, SCENES as BUILT } from "./videos/HowItIsBuilt";
import { InSixtySeconds, SCENES as SIXTY } from "./videos/InSixtySeconds";
import { LogoReveal, DURATION as LOGO } from "./videos/LogoReveal";
import { LoupeV1, SCENES as LOUPE } from "./videos/LoupeV1";

// Every video is 1920 x 1080 at 30 fps (operator, 2026-10-30); compositions take the size from here, never their own.
export const VIDEO = { fps: 30, width: 1920, height: 1080 } as const;
const frames = (scenes: number[]) => scenes.reduce((a, b) => a + b, 0) * VIDEO.fps;

export const Root: React.FC = () => (
  <>
    <Composition id="HowItIsBuilt" component={HowItIsBuilt} durationInFrames={frames(BUILT)} {...VIDEO} />
    <Composition id="InSixtySeconds" component={InSixtySeconds} durationInFrames={frames(SIXTY)} {...VIDEO} />
    <Composition id="LoupeV1" component={LoupeV1} durationInFrames={frames(LOUPE)} {...VIDEO} />
    <Composition id="LogoReveal" component={LogoReveal} durationInFrames={LOGO} {...VIDEO} />
  </>
);
