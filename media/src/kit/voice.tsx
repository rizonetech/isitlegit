import type React from "react";
import { Audio, Sequence } from "remotion";
import { VOICE } from "../data/voice";

// Narration in the operator's ElevenLabs voice (media/voiceover/README.md). tools/voice-index.py writes VOICE from the
// clips voiceover.py made, one per sequence (title, every scene, close). A video without clips renders silent at its
// reading pace; with clips, each sequence stays up until its clip has ended.
// Each clip's gain brings it to the shared reference level (tools/voice-index.py), so narration plays at that level.
export type Clip = { src: string; seconds: number; gain: number };

const FPS = 30;
const LEAD = 0.5; // the scene's content fades in before the voice starts
const TAIL = 0.8; // a breath after the last word before the next scene

export const voiceFor = (video: string, sequences: number): Clip[] | null => {
  const clips = VOICE[video];
  if (!clips) return null;
  if (clips.length !== sequences) throw new Error(`video ${video} has ${clips.length} narration clips for ${sequences} sequences`);
  return clips;
};

// Frames for each sequence: its own length in seconds, stretched to fit its clip.
export const voicedFrames = (seconds: number[], clips: Clip[] | null): number[] =>
  seconds.map((s, i) => Math.max(s * FPS, clips ? Math.ceil((LEAD + clips[i].seconds + TAIL) * FPS) : 0));

// Where the narration speaks, as [start, end] frames from `offset`, for sequences laid end to end: the music
// rises in the gaps (src/kit/sound.tsx).
export const voiceSpans = (frames: number[], clips: Clip[] | null, offset = 0): [number, number][] => {
  if (!clips) return [];
  let t = offset;
  return frames.map((f, i) => {
    const start = t + Math.round(LEAD * FPS);
    t += f;
    return [start, start + Math.ceil(clips[i].seconds * FPS)];
  });
};

// `at` places the clip at a frame of its sequence instead of half a second in (the reveals, src/kit/reveal.tsx).
export const Voice: React.FC<{ clip?: Clip; at?: number }> = ({ clip, at = Math.round(LEAD * FPS) }) =>
  clip ? (
    <Sequence from={at} layout="none">
      <Audio src={clip.src} volume={clip.gain} />
    </Sequence>
  ) : null;
