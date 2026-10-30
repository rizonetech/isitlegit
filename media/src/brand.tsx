import type React from "react";
import { AbsoluteFill, continueRender, delayRender, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import tokens from "../../design/tokens/colors.json";

// Light theme tokens from design/tokens/colors.json, unchanged; the videos match the logo animation's light ground.
// The theme comes from design/tokens/colors.json unchanged: dark by default (operator, 2026-10-30), light when
// REMOTION_THEME=light. On dark, the ground is the brand's Ink, cards are raised a step, code sits on the darkest
// surface, and the logo is the approved on-dark variant.
export const DARK = process.env.REMOTION_THEME !== "light";
export const c = DARK ? tokens.themes.dark : tokens.themes.light;
export const BG = DARK ? tokens.themes.light.ink : c.light;
export const CARD = DARK ? c["dark-raised"] : c.surface;
export const CODE_BG = DARK ? c.surface : c.dark;

// Exo for headings, Exo 2 for body (design/brand/README.md "Type"), from design/fonts via --public-dir ../design.
const fontsReady = delayRender("fonts");
Promise.all(
  [
    ["Exo", "fonts/Exo[wght].ttf"],
    ["Exo 2", "fonts/Exo2[wght].ttf"],
  ].map(([family, file]) =>
    new FontFace(family, `url("${staticFile(file)}")`, { weight: "100 900" }).load().then((f) => document.fonts.add(f)),
  ),
).then(() => continueRender(fontsReady));

export const head: React.CSSProperties = { fontFamily: '"Exo", sans-serif', fontWeight: 700, color: c.ink, letterSpacing: -0.5 };
export const body: React.CSSProperties = { fontFamily: '"Exo 2", sans-serif', fontWeight: 500, color: c["ink-2"] };
export const mono: React.CSSProperties = { fontFamily: "ui-monospace, Menlo, Consolas, monospace", color: c.ink };

/** 0 to 1 over `frames` from `from`, eased by a spring. */
export const useIn = (from = 0, frames = 20) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - from, fps, durationInFrames: frames, config: { damping: 200 } });
};

/**
 * The living ground under every scene (operator, 2026-10-31): the theme's ground, two slow orange glows on long
 * drifting paths and a faint grid easing diagonally, faded towards the edges. A composition draws it once behind its
 * whole Series, so it flows on across scene changes instead of restarting with each scene.
 */
export const Backdrop: React.FC = () => {
  const t = useCurrentFrame() / 30;
  const shift = (t * 6) % 80;
  const a = { x: 50 + 30 * Math.sin(t / 23), y: 40 + 25 * Math.cos(t / 31) };
  const b = { x: 72 + 22 * Math.cos(t / 27), y: 72 + 18 * Math.sin(t / 19) };
  const grid = DARK ? `${c.line}` : `${c["line-strong"]}66`;
  return (
    <AbsoluteFill style={{ background: BG }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${a.x}% ${a.y}%, ${c.orange}26, transparent 42%), radial-gradient(circle at ${b.x}% ${b.y}%, ${c.orange}17, transparent 38%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${grid} 1px, transparent 1px), linear-gradient(90deg, ${grid} 1px, transparent 1px)`,
          backgroundSize: "80px 80px",
          backgroundPosition: `${shift}px ${shift}px`,
          WebkitMaskImage: "radial-gradient(ellipse at center, black 25%, transparent 80%)",
          maskImage: "radial-gradient(ellipse at center, black 25%, transparent 80%)",
        }}
      />
    </AbsoluteFill>
  );
};

/** A scene: fade in and out, content padded to the title-safe area, over the composition's Backdrop. */
export const Scene: React.FC<{ children: React.ReactNode; label?: string; center?: boolean }> = ({ children, label, center }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(frame, [0, 10, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    // Only the content fades; the Backdrop and the corner label stay put, so scene changes never dip to black.
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          opacity,
          padding: "110px 150px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: center ? "center" : "stretch",
          textAlign: center ? "center" : "left",
        }}
      >
        {children}
      </AbsoluteFill>
      {label ? <Label text={label} /> : null}
    </AbsoluteFill>
  );
};

/** The corner label that says what kind of video this is, on every scene but the title. */
export const Label: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      ...body,
      position: "absolute",
      right: 60,
      bottom: 48,
      fontSize: 24,
      fontWeight: 600,
      color: c.muted,
      border: `2px solid ${c["line-strong"]}`,
      borderRadius: 999,
      padding: "8px 22px",
    }}
  >
    {text}
  </div>
);

export const Headline: React.FC<{ text: string; sub?: string; from?: number }> = ({ text, sub, from = 0 }) => {
  const t = useIn(from);
  const s = useIn(from + 12);
  return (
    <div>
      <div style={{ ...head, fontSize: 76, lineHeight: 1.1, opacity: t, transform: `translateY(${(1 - t) * 24}px)` }}>{text}</div>
      {sub ? (
        <div style={{ ...body, fontSize: 40, lineHeight: 1.35, marginTop: 24, maxWidth: 1500, opacity: s, transform: `translateY(${(1 - s) * 16}px)` }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
};

export const Logo: React.FC<{ width: number }> = ({ width }) => (
  <Img src={staticFile(`brand/logo-svg/isitlegit-logo${DARK ? "-on-dark" : ""}.svg`)} style={{ width }} />
);

export const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{ background: CARD, border: `2px solid ${c.line}`, borderRadius: 20, padding: "32px 40px", ...style }}>{children}</div>
);

/** The brand tick, drawn with the mark's geometry so it matches every tick in the family. */
export const Tick: React.FC<{ size: number; color?: string }> = ({ size, color = c.orange }) => (
  <svg width={size} height={size} viewBox="70 120 80 64" aria-hidden>
    <path d="M82 152L100 170L138 132" fill="none" stroke={color} strokeWidth={24} strokeLinecap="butt" strokeLinejoin="miter" />
  </svg>
);

export const TitleScene: React.FC<{ line: string; sub: string }> = ({ line, sub }) => {
  const l = useIn(0, 30);
  const t = useIn(18);
  const s = useIn(30);
  return (
    <Scene center>
      <div style={{ opacity: l, transform: `scale(${0.92 + 0.08 * l})` }}>
        <Logo width={620} />
      </div>
      <div style={{ ...head, fontSize: 84, marginTop: 70, opacity: t }}>{line}</div>
      <div style={{ ...body, fontSize: 40, marginTop: 22, opacity: s }}>{sub}</div>
    </Scene>
  );
};

export const CloseScene: React.FC<{ lines: string[] }> = ({ lines }) => {
  const l = useIn(0, 24);
  const t = useIn(14);
  return (
    <Scene center>
      <div style={{ opacity: l }}>
        <Logo width={560} />
      </div>
      {lines.map((line, i) => (
        <div key={line} style={{ ...body, fontSize: i === 0 ? 44 : 30, fontWeight: i === 0 ? 600 : 500, color: i === 0 ? c.ink : c.muted, marginTop: i === 0 ? 60 : 18, opacity: t }}>
          {line}
        </div>
      ))}
    </Scene>
  );
};
