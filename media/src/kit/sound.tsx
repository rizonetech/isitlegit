import type React from "react";
import { Audio, Sequence } from "remotion";
import { SOUND } from "../data/voice";

// Music and sound effects from media/data/sound.json, made by tools/sound.py and indexed by tools/voice-index.py.
// Before they are made, every video renders without them. Every file arrives at the narration's reference level (its
// gain, from tools/voice-index.py), so these are the balance against the voice: the bed 21 dB under it, crossfading
// with itself so a long video never hears it restart, the swell 10 dB under and the whoosh 14 dB under.
const FPS = 30;
const db = (x: number) => 10 ** (x / 20);
const MUSIC = db(-21);
const SFX = { swell: db(-10), whoosh: db(-14), hit: db(-12), tick: db(-20) } as const;
const CROSSFADE = 3 * FPS;
const FADE_IN = 1 * FPS;

const sound = (name: string) => {
  if (Object.keys(SOUND).length === 0) return null;
  const s = SOUND[name];
  if (!s) throw new Error(`no sound named ${name} in media/data/sound.json`);
  return s;
};

const ramp = (x: number, over: number) => Math.min(1, Math.max(0, x / over));

// The bed rises 6 dB where the narration has been silent for over a second (a held scene, the credits) and settles
// back under the voice before it speaks again; the short breaths between scenes stay level, so it never pumps.
const SWELL = db(6) - 1;
const QUIET = 1 * FPS;
const swell = (f: number, voice: [number, number][]) => {
  let gap = Number.POSITIVE_INFINITY;
  for (const [a, b] of voice) gap = Math.min(gap, f < a ? a - f : f > b ? f - b : 0);
  return 1 + SWELL * ramp(gap - QUIET, QUIET);
};

export const MusicBed: React.FC<{ name: string; frames: number; voice?: [number, number][] }> = ({ name, frames, voice = [] }) => {
  const bed = sound(name);
  if (!bed) return null;
  const length = Math.floor(bed.seconds * FPS);
  const step = length - CROSSFADE;
  const copies = Math.ceil((frames - CROSSFADE) / step);
  return (
    <>
      {Array.from({ length: copies }, (_, k) => {
        const start = k * step;
        const duration = Math.min(length, frames - start);
        return (
          <Sequence key={k} from={start} durationInFrames={duration} layout="none">
            <Audio
              src={bed.src}
              volume={(f) =>
                MUSIC *
                bed.gain *
                swell(start + f, voice) *
                Math.min(
                  k === 0 ? ramp(f, FADE_IN) : ramp(f, CROSSFADE),
                  start + duration < frames ? ramp(duration - f, CROSSFADE) : 1,
                  ramp(frames - (start + f), CROSSFADE),
                )
              }
            />
          </Sequence>
        );
      })}
    </>
  );
};

export const Sfx: React.FC<{ name: keyof typeof SFX }> = ({ name }) => {
  const s = sound(name);
  return s ? <Audio src={s.src} volume={SFX[name] * s.gain} /> : null;
};
