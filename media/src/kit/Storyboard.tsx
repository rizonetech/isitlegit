import type React from "react";
import { Series } from "remotion";
import { Backdrop, CloseScene, MetaBadge, TitleScene } from "../brand";
import { DURATION as INTRO, LogoReveal } from "../videos/LogoReveal";
import { ColdOpen, coldOpenFrames, hookFor } from "./coldopen";
import { CREDITS, Credits } from "./credits";
import { RenderScene, type SceneSpec } from "./scenes";
import { fill, words } from "./text";
import { MusicBed, Sfx } from "./sound";
import { Voice, voicedFrames, voiceFor, voiceSpans } from "./voice";

export type StoryboardSpec = {
  id: string;
  title: string;
  sub: string;
  label: string;
  close: string[];
  // Indexes into `scenes` for the cold open's cuts, in order.
  coldOpen?: number[];
  scenes: SceneSpec[];
};

const FPS = 30;
const TITLE = 6;
const CLOSE = 6;

// A scene stays up long enough to read: about 3.6 words a second, the pace of a viewer who can pause, plus time to
// take in the visual, unless the storyboard sets `seconds`.
const sceneText = (s: SceneSpec): string => {
  const parts: string[] = [s.title];
  if ("sub" in s && s.sub) parts.push(s.sub);
  if (s.type === "bullets") parts.push(...s.items);
  if (s.type === "table") parts.push(...s.rows.flat());
  if (s.type === "flow") parts.push(...s.steps.flatMap((x) => [x.title, x.sub ?? ""]), s.note ?? "");
  if (s.type === "code") parts.push(...s.lines, s.caption ?? "");
  if (s.type === "stats") parts.push(...s.items.flatMap((x) => [x.value, x.label]), s.note ?? "");
  if (s.type === "chart") parts.push(s.note ?? "");
  if (s.type === "lanes") parts.push(...s.lanes.flatMap((x) => [x.name, x.role, x.owns]));
  if (s.type === "callout") parts.push(s.text);
  return fill(parts.join(" "));
};

export const sceneSeconds = (s: SceneSpec): number => {
  if (s.seconds) return s.seconds;
  if (s.type === "chapter") return 5;
  const visual = s.type === "chart" || s.type === "flow" ? 5 : 2;
  return Math.max(7, Math.ceil(words(sceneText(s)) / 3.6 + visual));
};

// One entry per sequence, matching the narration file's segments: the title, every scene, the close.
const sequenceFrames = (b: StoryboardSpec, video: string) => {
  const seconds = [TITLE, ...b.scenes.map(sceneSeconds), CLOSE];
  const clips = voiceFor(video, seconds.length);
  return { frames: voicedFrames(seconds, clips), clips };
};

// The cold open (when its hook is voiced) and the dark logo animation open the video and the credits close it, around
// the voiced sequences.
export const storyboardFrames = (b: StoryboardSpec, video: string) =>
  coldOpenFrames(hookFor(video)) + INTRO + sequenceFrames(b, video).frames.reduce((a, f) => a + f, 0) + CREDITS;

export const Storyboard: React.FC<{ board: StoryboardSpec; video: string }> = ({ board, video }) => {
  const chapters = board.scenes.filter((s) => s.type === "chapter").length;
  const { frames, clips } = sequenceFrames(board, video);
  const last = frames.length - 1;
  const voiced = frames.reduce((a, f) => a + f, 0);
  const label = fill(board.label);
  const hook = hookFor(video);
  const cold = coldOpenFrames(hook);
  // The music runs from the first frame and stays level through the logo, so it never fights the logo's own sound.
  const quiet: [number, number][] = [...(hook ? voiceSpans([cold], [hook]) : []), [cold, cold + INTRO], ...voiceSpans(frames, clips, cold + INTRO)];
  return (
    <>
      <Backdrop />
      <Series>
        {hook ? (
          <Series.Sequence durationInFrames={cold}>
            <ColdOpen clip={hook} cuts={(board.coldOpen ?? []).map((i) => <RenderScene key={i} s={board.scenes[i]} chapters={chapters} label={label} />)} />
          </Series.Sequence>
        ) : null}
        <Series.Sequence durationInFrames={INTRO}>
          <LogoReveal theme="dark" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={frames[0]}>
          <TitleScene line={fill(board.title)} sub={fill(board.sub)} />
          <Sfx name="swell" />
          <Voice clip={clips?.[0]} />
        </Series.Sequence>
        {board.scenes.map((s, i) => (
          <Series.Sequence key={`${i}-${s.title}`} durationInFrames={frames[i + 1]}>
            <RenderScene s={s} chapters={chapters} label={label} />
            {s.meta ? <MetaBadge text={s.meta} /> : null}
            {s.type === "chapter" ? <Sfx name="whoosh" /> : null}
            <Voice clip={clips?.[i + 1]} />
          </Series.Sequence>
        ))}
        <Series.Sequence durationInFrames={frames[last]}>
          <CloseScene lines={board.close.map(fill)} />
          <Voice clip={clips?.[last]} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={CREDITS}>
          <Credits />
        </Series.Sequence>
      </Series>
      <MusicBed name="bed" frames={cold + INTRO + voiced + CREDITS} voice={quiet} />
    </>
  );
};
