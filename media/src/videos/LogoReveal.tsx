import type React from "react";
import { AbsoluteFill, Audio, Img, interpolate, interpolateColors, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import tokens from "../../../design/tokens/colors.json";
import { LOGO_GAIN } from "../data/voice";

// The standalone logo video is always light: it rebuilds the original light clip and draws the ink mark. The
// explainers open with the dark variant (operator, 2026-10-31): the explainers' near-black ground, the on-dark logo and the
// dark theme's light ink, the same ground as the explainers' Backdrop.
const THEMES = {
  light: { c: tokens.themes.light, bg: tokens.themes.light.light, logo: "brand/logo-svg/isitlegit-logo.svg" },
  dark: { c: tokens.themes.dark, bg: "#0B0A0D", logo: "brand/logo-svg/isitlegit-logo-on-dark.svg" },
} as const;

// The logo animation rebuilt from the brand geometry (design/brand/logo-svg/isitlegit-logo.svg, mark at
// translate(-27 0) scale(0.5) in a 338.32 x 100 box), replacing the 720p design/brand/videos/logo_animation.mp4.
// The question mark draws, its dot turns orange and becomes the tick, then the mark moves into the logo and the
// wordmark slides in; the last two seconds are the approved logo file itself. Sound: the original clip's track.
export const DURATION = 240;

const LOGO_W = 1100;
const UNIT = LOGO_W / 338.32;
const LOGO_H = 100 * UNIT;
const LOGO_X = (1920 - LOGO_W) / 2;
const LOGO_Y = (1080 - LOGO_H) / 2;
// Where the mark's 200 x 200 box sits in the final logo, and where it starts, large and centred.
const END = { x: LOGO_X - 27 * UNIT, y: LOGO_Y, size: 100 * UNIT };
const START = { x: 960 - 330, y: 540 - 330, size: 660 };
// The wordmark starts at x 66.3 in logo units and the mark ends at 46, so the reveal edge sits between them.
const WORDMARK_EDGE = 56 * UNIT;

const QUESTION = "M66 68A34 34 0 1 1 124.04 92.04L100 116.08V130";
const TICK = "M82 152L100 170L138 132";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// `ground={false}` leaves the ground to the composition's Backdrop, so the logo can move over it (src/kit/reveal.tsx).
export const LogoReveal: React.FC<{ theme?: keyof typeof THEMES; ground?: boolean }> = ({ theme = "light", ground = true }) => {
  const { c, bg, logo } = THEMES[theme];
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const draw = interpolate(frame, [4, 34], [0, 1], clamp);
  const dotIn = spring({ frame: frame - 34, fps, config: { damping: 12, stiffness: 180 } });
  const dotColour = interpolateColors(frame, [48, 58], [c.ink, c.orange]);
  const wobble = interpolate(frame, [60, 66, 72, 78, 84], [0, -12, 9, -5, 0], clamp);
  const dotOut = interpolate(frame, [88, 98], [1, 0], clamp);
  const tick = interpolate(frame, [90, 108], [0, 1], clamp);
  const move = spring({ frame: frame - 132, fps, durationInFrames: 30, config: { damping: 200 } });
  const words = spring({ frame: frame - 144, fps, durationInFrames: 28, config: { damping: 200 } });
  const final = frame >= 180;

  const box = {
    x: START.x + (END.x - START.x) * move,
    y: START.y + (END.y - START.y) * move,
    size: START.size + (END.size - START.size) * move,
  };

  return (
    <AbsoluteFill style={{ background: ground ? bg : undefined }}>
      <Audio src={staticFile("brand/videos/logo_animation.mp4")} volume={theme === "dark" ? LOGO_GAIN : 1} />
      {final ? (
        <Img src={staticFile(logo)} style={{ position: "absolute", left: LOGO_X, top: LOGO_Y, width: LOGO_W }} />
      ) : (
        <>
          <div style={{ position: "absolute", left: LOGO_X + WORDMARK_EDGE, top: LOGO_Y, width: LOGO_W - WORDMARK_EDGE, height: LOGO_H, overflow: "hidden" }}>
            <Img
              src={staticFile(logo)}
              style={{ position: "absolute", left: -WORDMARK_EDGE, top: 0, width: LOGO_W, opacity: words, transform: `translateX(${(1 - words) * -160}px)` }}
            />
          </div>
          <svg viewBox="0 0 200 200" style={{ position: "absolute", left: box.x, top: box.y, width: box.size, height: box.size }} aria-hidden>
            <path d={QUESTION} fill="none" stroke={c.ink} strokeWidth={24} strokeLinecap="butt" strokeLinejoin="miter" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
            <rect
              x={88}
              y={142}
              width={24}
              height={24}
              fill={dotColour}
              style={{ transformBox: "fill-box", transformOrigin: "center", transform: `scale(${dotIn * dotOut}) rotate(${wobble}deg)` }}
            />
            <path d={TICK} fill="none" stroke={c.orange} strokeWidth={24} strokeLinecap="butt" strokeLinejoin="miter" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - tick} />
          </svg>
        </>
      )}
    </AbsoluteFill>
  );
};
