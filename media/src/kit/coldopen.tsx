import type React from "react";
import { AbsoluteFill, Sequence, Series, useCurrentFrame } from "remotion";
import { type Clip, Voice, voiceFor } from "./voice";

// The cold open (operator, 2026-10-31): before the logo, the video's hook line (media/data/narration/<video>-hook.json)
// over hard cuts of its strongest scenes, each joined partway in so its content is already on screen, with a slow
// push-in. Without a voiced hook the video starts at the logo as before.
const FPS = 30;
const LEAD = 0.5;
const TAIL = 0.6;
// How far into a scene each cut joins it: its headline and most of its content have animated in by then.
const JOIN = 4 * FPS;

export const hookFor = (video: string): Clip | null => voiceFor(`${video}-hook`, 1)?.[0] ?? null;

export const coldOpenFrames = (clip: Clip | null) => (clip ? Math.ceil((LEAD + clip.seconds + TAIL) * FPS) : 0);

const Cut: React.FC<{ frames: number; children: React.ReactNode }> = ({ frames, children }) => {
  const push = 1.07 - (0.07 * useCurrentFrame()) / frames;
  return (
    <AbsoluteFill style={{ transform: `scale(${push})` }}>
      <Sequence from={-JOIN} durationInFrames={JOIN + frames} layout="none">
        {children}
      </Sequence>
    </AbsoluteFill>
  );
};

export const ColdOpen: React.FC<{ clip: Clip; cuts: React.ReactNode[] }> = ({ clip, cuts }) => {
  const total = coldOpenFrames(clip);
  const each = Math.floor(total / cuts.length);
  return (
    <>
      <Series>
        {cuts.map((cut, i) => {
          const frames = i === cuts.length - 1 ? total - each * (cuts.length - 1) : each;
          return (
            <Series.Sequence key={i} durationInFrames={frames}>
              <Cut frames={frames}>{cut}</Cut>
            </Series.Sequence>
          );
        })}
      </Series>
      <Voice clip={clip} />
    </>
  );
};
