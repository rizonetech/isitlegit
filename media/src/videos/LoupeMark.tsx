import type React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { body, c, head, Logo } from "../brand";
import { type Clip, Voice } from "../kit/voice";

// The Loupe mark (operator's choice of three concepts, 2026-10-31): a magnifier with the brand's orange tick inside,
// "inspect, then the verdict", drawn on the IsItLegit mark's grid: a 200 x 200 box, 24-unit strokes, butt caps and
// mitred joins, ink plus one orange accent. To be added to design/brand by the coordinator (coordinator-request.md).
export const LoupeMark: React.FC<{ size: number; ink?: string }> = ({ size, ink = c.ink }) => (
  <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden>
    <circle cx={84} cy={84} r={58} fill="none" stroke={ink} strokeWidth={24} />
    <path d="M125 125L180 180" fill="none" stroke={ink} strokeWidth={30} strokeLinecap="butt" />
    <path d="M58 86L76 104L112 68" fill="none" stroke={c.orange} strokeWidth={24} strokeLinecap="butt" strokeLinejoin="miter" />
  </svg>
);

// The Loupe reveal, which is video 03's title (operator, 2026-10-31): the lens draws itself and its handle extends, the
// orange tick snaps in with a glint, then the mark slides left as "Loupe 1.0" is unmasked beside it, landing on the
// spoken "This is Loupe"; the subtitle and "by IsItLegit" settle in below.
export const LOUPE_VOICE_AT = 76;
export const LOUPE_REVEAL_MIN = 270;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const MARK = 220;
// Half the wordmark's width plus the gap: how far right the mark starts, so it sits centred until the lockup opens.
const SHIFT = 460;

export const LoupeReveal: React.FC<{ line: string; sub: string; clip?: Clip }> = ({ line, sub, clip }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ring = interpolate(frame, [4, 30], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const handle = interpolate(frame, [24, 38], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const tick = interpolate(frame, [42, 54], [0, 1], { ...clamp, easing: Easing.out(Easing.back(2)) });
  const glint = interpolate(frame, [54, 80], [0, 1], clamp);
  const move = spring({ frame: frame - 70, fps, durationInFrames: 30, config: { damping: 200 } });
  const s = spring({ frame: frame - 130, fps, durationInFrames: 30, config: { damping: 200 } });
  const by = spring({ frame: frame - 150, fps, durationInFrames: 30, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
        <div style={{ position: "relative", transform: `translateX(${SHIFT * (1 - move)}px) scale(${1.25 - 0.25 * move})` }}>
          <svg width={MARK} height={MARK} viewBox="0 0 200 200" aria-hidden>
            <circle cx={84} cy={84} r={58} fill="none" stroke={c.ink} strokeWidth={24} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - ring} transform="rotate(-90 84 84)" />
            <path d="M125 125L180 180" fill="none" stroke={c.ink} strokeWidth={30} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - handle} />
            <path d="M58 86L76 104L112 68" fill="none" stroke={c.orange} strokeWidth={24} strokeLinecap="butt" strokeLinejoin="miter" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - Math.min(1, tick)} />
            <circle cx={84} cy={84} r={58 + 70 * glint} fill="none" stroke={c.orange} strokeWidth={6 * (1 - glint)} opacity={glint > 0 ? 1 - glint : 0} />
          </svg>
        </div>
        <div style={{ ...head, fontSize: 190, lineHeight: 1, whiteSpace: "nowrap", opacity: move, clipPath: `inset(0 ${(1 - move) * 100}% 0 0)` }}>{line}</div>
      </div>
      <div style={{ ...body, fontSize: 44, marginTop: 50, opacity: s, transform: `translateY(${(1 - s) * 20}px)` }}>{sub}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 60, opacity: by }}>
        <div style={{ ...body, fontSize: 30, color: c.muted }}>by</div>
        <Logo width={260} />
      </div>
      <Voice clip={clip} at={LOUPE_VOICE_AT} />
    </AbsoluteFill>
  );
};
