import type React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { body, c, head } from "../brand";
import { LogoReveal } from "../videos/LogoReveal";
import { type Clip, Voice } from "./voice";

// The reveal is the title (operator, 2026-10-31): after the cold open, the logo animation plays, the title line is spoken
// as the wordmark lands, and the logo lifts to settle the title beneath it, so no separate title card follows.
const FPS = 30;
// The frame the title line starts (the IsItLegit wordmark lands at 144 to 172 in LogoReveal), the shortest reveal,
// and the breath after the line.
export const REVEAL_VOICE_AT = 150;
export const REVEAL_MIN = 300;
export const REVEAL_TAIL = 24;

export const revealFrames = (clip: Clip | undefined, voiceAt = REVEAL_VOICE_AT, min = REVEAL_MIN) =>
  clip ? Math.max(min, voiceAt + Math.ceil(clip.seconds * FPS) + REVEAL_TAIL) : min;

export const BrandReveal: React.FC<{ line: string; sub: string; clip?: Clip }> = ({ line, sub, clip }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lift = spring({ frame: frame - 190, fps, durationInFrames: 34, config: { damping: 200 } });
  const t = spring({ frame: frame - 206, fps, durationInFrames: 30, config: { damping: 200 } });
  const s = spring({ frame: frame - 222, fps, durationInFrames: 30, config: { damping: 200 } });
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `translateY(${-170 * lift}px) scale(${1 - 0.42 * lift})` }}>
        <LogoReveal theme="dark" ground={false} />
      </AbsoluteFill>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center", paddingTop: 260 }}>
        <div style={{ ...head, fontSize: 88, opacity: t, transform: `translateY(${(1 - t) * 24}px)` }}>{line}</div>
        <div style={{ ...body, fontSize: 40, marginTop: 22, color: c["ink-2"], opacity: s, maxWidth: 1500 }}>{sub}</div>
      </AbsoluteFill>
      <Voice clip={clip} at={REVEAL_VOICE_AT} />
    </AbsoluteFill>
  );
};
