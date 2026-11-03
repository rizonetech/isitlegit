import type React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import hook01 from "../../data/narration/01-hook.json";
import hook02 from "../../data/narration/02-hook.json";
import hook03 from "../../data/narration/03-hook.json";
import { c, head } from "../brand";
import { type Clip, Voice, voiceFor } from "./voice";

// The cold open (operator, 2026-10-31): before the reveal, the video's hook line (media/data/narration/<video>-hook.json)
// as kinetic type. Each phrase between the pause tags rises in large and centred as it is spoken, its *starred* words
// in orange, and holds through the pause after it. Without a voiced hook the video starts at the reveal.
const FPS = 30;
export const HOOK_LEAD_MS = 500;
export const HOOK_TAIL_MS = 1000;
const LEAD = HOOK_LEAD_MS / 1000;
const TAIL = HOOK_TAIL_MS / 1000;
const HOOKS: Record<string, string> = { "01": hook01.segments[0].text, "02": hook02.segments[0].text, "03": hook03.segments[0].text };
const BREAK = /<break time="([0-9.]+)s"\s*\/>/;

export const hookFor = (video: string): Clip | null => voiceFor(`${video}-hook`, 1)?.[0] ?? null;

export const coldOpenFrames = (clip: Clip | null) => (clip ? Math.ceil((LEAD + clip.seconds + TAIL) * FPS) : 0);

type Phrase = { words: string; at: number };

// Where each phrase starts within the clip: the spoken time (the clip less its pauses) shared by characters, each pause
// inserted after its phrase. The read has no per-word timing, so this is an estimate, close enough for a phrase.
export const phrases = (text: string, seconds: number): Phrase[] => {
  const parts = text.split(BREAK);
  const said = parts.filter((_, i) => i % 2 === 0).map((p) => p.trim());
  const pauses = parts.filter((_, i) => i % 2 === 1).map(Number);
  const speaking = seconds - pauses.reduce((a, b) => a + b, 0);
  const chars = said.reduce((a, p) => a + p.replace(/\*/g, "").length, 0);
  let t = 0;
  return said.map((words, i) => {
    const at = t;
    t += (speaking * words.replace(/\*/g, "").length) / chars + (pauses[i] ?? 0);
    return { words, at };
  });
};

const Line: React.FC<{ words: string; from: number; until: number }> = ({ words, from, until }) => {
  const f = useCurrentFrame();
  const enter = interpolate(f, [from, from + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const leave = interpolate(f, [until - 8, until], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (f < from || f > until) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 160,
        right: 160,
        top: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        ...head,
        fontSize: 104,
        lineHeight: 1.12,
        opacity: enter * (1 - leave),
        transform: `translateY(${(1 - enter) * 40 - leave * 30}px)`,
        filter: `blur(${(1 - enter) * 8}px)`,
      }}
    >
      <div>
        {words.split(/(\*[^*]+\*)/).map((w, i) =>
          w.startsWith("*") ? (
            <span key={`${i}-${w}`} style={{ color: c.orange }}>
              {w.slice(1, -1)}
            </span>
          ) : (
            w
          ),
        )}
      </div>
    </div>
  );
};

export const ColdOpen: React.FC<{ video: string; clip: Clip }> = ({ video, clip }) => {
  const total = coldOpenFrames(clip);
  const lead = Math.round(LEAD * FPS);
  const list = phrases(HOOKS[video], clip.seconds);
  return (
    <AbsoluteFill>
      {list.map((p, i) => (
        <Line key={p.words} words={p.words} from={lead + Math.round(p.at * FPS)} until={i + 1 < list.length ? lead + Math.round(list[i + 1].at * FPS) : total} />
      ))}
      <Voice clip={clip} />
    </AbsoluteFill>
  );
};
