import type React from "react";
import { Series } from "remotion";
import { CloseScene, TitleScene } from "../brand";
import { RenderScene, type SceneSpec } from "./scenes";
import { fill, words } from "./text";

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

// A scene stays up long enough to read: about 2.6 words a second plus time to take in the visual, unless the
// storyboard sets `seconds`.
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
  if (s.type === "chapter") return 6;
  const visual = s.type === "chart" || s.type === "flow" ? 6 : 3;
  return Math.max(8, Math.ceil(words(sceneText(s)) / 2.6 + visual));
};

export const storyboardFrames = (b: StoryboardSpec) => (TITLE + CLOSE + b.scenes.reduce((a, s) => a + sceneSeconds(s), 0)) * FPS;

export const Storyboard: React.FC<{ board: StoryboardSpec }> = ({ board }) => {
  const chapters = board.scenes.filter((s) => s.type === "chapter").length;
  return (
    <Series>
      <Series.Sequence durationInFrames={TITLE * FPS}>
        <TitleScene line={fill(board.title)} sub={fill(board.sub)} />
      </Series.Sequence>
      {board.scenes.map((s, i) => (
        <Series.Sequence key={`${i}-${s.title}`} durationInFrames={sceneSeconds(s) * FPS}>
          <RenderScene s={s} chapters={chapters} label={fill(board.label)} />
        </Series.Sequence>
      ))}
      <Series.Sequence durationInFrames={CLOSE * FPS}>
        <CloseScene lines={board.close.map(fill)} />
      </Series.Sequence>
    </Series>
  );
};
