import type React from "react";
import { Composition } from "remotion";
import devProcess from "../data/storyboards/01-development-process.json";
import techDeepDive from "../data/storyboards/02-technical-deep-dive.json";
import { Storyboard, type StoryboardSpec, storyboardFrames } from "./kit/Storyboard";
import { LogoReveal, DURATION as LOGO } from "./videos/LogoReveal";
import { LoupeV1, SCENES as LOUPE } from "./videos/LoupeV1";

// Every video is 1920 x 1080 at 30 fps (operator, 2026-10-30); compositions take the size from here, never their own.
export const VIDEO = { fps: 30, width: 1920, height: 1080 } as const;
const frames = (scenes: number[]) => scenes.reduce((a, b) => a + b, 0) * VIDEO.fps;
const boards = [devProcess as StoryboardSpec, techDeepDive as StoryboardSpec];

export const Root: React.FC = () => (
  <>
    {boards.map((board) => (
      <Composition key={board.id} id={board.id} component={Storyboard} defaultProps={{ board }} durationInFrames={storyboardFrames(board)} {...VIDEO} />
    ))}
    <Composition id="LoupeV1" component={LoupeV1} durationInFrames={frames(LOUPE)} {...VIDEO} />
    <Composition id="LogoReveal" component={LogoReveal} durationInFrames={LOGO} {...VIDEO} />
  </>
);
