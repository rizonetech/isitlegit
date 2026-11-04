import type React from "react";
import { Composition } from "remotion";
import devProcess from "../data/storyboards/01-development-process.json";
import techDeepDive from "../data/storyboards/02-technical-deep-dive.json";
import { Storyboard, type StoryboardSpec, storyboardFrames } from "./kit/Storyboard";
import { BANNER, ChannelBanner } from "./videos/ChannelBanner";
import { Demo, DemoArchitecture, DemoTeaser, DemoTitleClose, DemoTitleOpen, demoFrames, introLength, standaloneFrames, teaserFrames } from "./videos/Demo";
import { JudgeGuide, judgeGuideFrames } from "./videos/JudgeGuide";
import { LogoReveal, DURATION as LOGO } from "./videos/LogoReveal";
import { LoupeV1, loupeFrames } from "./videos/LoupeV1";
import { THUMBS, Thumbnail } from "./videos/Thumbnail";

// Every video is 1920 x 1080 at 30 fps (operator, 2026-10-30); compositions take the size from here, never their own.
export const VIDEO = { fps: 30, width: 1920, height: 1080 } as const;
// Each storyboard with its video number, which names its narration (media/data/narration/<video>.json).
const boards: [StoryboardSpec, string][] = [
  [devProcess as StoryboardSpec, "01"],
  [techDeepDive as StoryboardSpec, "02"],
];

// Lengths are worked out per composition, when that composition is picked (calculateMetadata), so one video whose
// narration is stale (src/kit/voice.tsx refuses it) stops only its own render, not every other video's.
export const Root: React.FC = () => (
  <>
    {boards.map(([board, video]) => (
      <Composition key={board.id} id={board.id} component={Storyboard} defaultProps={{ board, video }} durationInFrames={1} calculateMetadata={() => ({ durationInFrames: storyboardFrames(board, video) })} {...VIDEO} />
    ))}
    <Composition id="Demo" component={Demo} durationInFrames={1} calculateMetadata={() => ({ durationInFrames: demoFrames() })} {...VIDEO} />
    <Composition id="DemoTitleOpen" component={DemoTitleOpen} durationInFrames={1} calculateMetadata={() => ({ durationInFrames: introLength() })} {...VIDEO} />
    <Composition id="DemoArchitecture" component={DemoArchitecture} durationInFrames={1} calculateMetadata={() => ({ durationInFrames: standaloneFrames(5) })} {...VIDEO} />
    <Composition id="DemoTitleClose" component={DemoTitleClose} durationInFrames={1} calculateMetadata={() => ({ durationInFrames: standaloneFrames(7) })} {...VIDEO} />
    <Composition id="JudgeGuide" component={JudgeGuide} durationInFrames={1} calculateMetadata={() => ({ durationInFrames: judgeGuideFrames() })} {...VIDEO} />
    <Composition id="XTeaser" component={DemoTeaser} durationInFrames={1} calculateMetadata={() => ({ durationInFrames: teaserFrames() })} {...VIDEO} />
    <Composition id="LoupeV1" component={LoupeV1} durationInFrames={1} calculateMetadata={() => ({ durationInFrames: loupeFrames() })} {...VIDEO} />
    {Object.keys(THUMBS).map((video) => (
      <Composition key={video} id={`Thumbnail${video}`} component={Thumbnail} defaultProps={{ video }} durationInFrames={60} {...VIDEO} />
    ))}
    <Composition id="ChannelBanner" component={ChannelBanner} durationInFrames={1} {...BANNER} />
    <Composition id="LogoReveal" component={LogoReveal} durationInFrames={LOGO} {...VIDEO} />
  </>
);
