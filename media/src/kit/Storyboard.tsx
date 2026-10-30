import type React from "react";
import { Series } from "remotion";
import { CloseScene, TitleScene } from "../brand";
import { RenderScene, type SceneSpec } from "./scenes";
import { fill, words } from "./text";
import { Voice, voicedFrames, voiceFor } from "./voice";

export type StoryboardSpec = {
  id: string;
  title: string;
  sub: string;
  label: string;
  close: string[];
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

export const storyboardFrames = (b: StoryboardSpec, video: string) => sequenceFrames(b, video).frames.reduce((a, f) => a + f, 0);

export const Storyboard: React.FC<{ board: StoryboardSpec; video: string }> = ({ board, video }) => {
  const chapters = board.scenes.filter((s) => s.type === "chapter").length;
  const { frames, clips } = sequenceFrames(board, video);
  const last = frames.length - 1;
  return (
    <Series>
      <Series.Sequence durationInFrames={frames[0]}>
        <TitleScene line={fill(board.title)} sub={fill(board.sub)} />
        <Voice clip={clips?.[0]} />
      </Series.Sequence>
      {board.scenes.map((s, i) => (
        <Series.Sequence key={`${i}-${s.title}`} durationInFrames={frames[i + 1]}>
          <RenderScene s={s} chapters={chapters} label={fill(board.label)} />
          <Voice clip={clips?.[i + 1]} />
        </Series.Sequence>
      ))}
      <Series.Sequence durationInFrames={frames[last]}>
        <CloseScene lines={board.close.map(fill)} />
        <Voice clip={clips?.[last]} />
      </Series.Sequence>
    </Series>
  );
};
