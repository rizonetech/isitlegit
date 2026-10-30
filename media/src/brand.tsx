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

// The living ground under every scene: the darkest brand surface, falling to near-black at the edges (operator,
// 2026-10-31), faint topographic lines flowing sideways with every fifth line in orange, a soft orange glow, film grain
// and a vignette (chosen from five mockups, 2026-10-31). A composition draws it once behind its whole Series, so it
// flows on across scene changes instead of restarting with each scene.
const GROUND = DARK ? c.surface : c.light;
const EDGE = DARK ? "#060507" : c.light;
const alpha = (a: number) => Math.round(a * 255).toString(16).padStart(2, "0");

export const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const lines = Array.from({ length: 22 }, (_, i) => {
    const base = 80 + i * 46;
    const d = Array.from({ length: 49 }, (_, k) => {
      const x = k * 40;
      const y = base + 26 * Math.sin(x / 260 + t / 6 + i * 0.45) + 14 * Math.sin(x / 120 - t / 9 + i * 0.8);
      return `${k ? "L" : "M"}${x} ${y.toFixed(1)}`;
    }).join(" ");
    const accent = i % 5 === 0;
    return <path key={i} d={d} fill="none" stroke={accent ? c.orange : c["line-strong"]} strokeWidth={accent ? 1.6 : 1} opacity={accent ? 0.35 : 0.5} />;
  });
  const seed = Math.floor(frame / 2) % 50;
  return (
    <AbsoluteFill style={{ background: GROUND }}>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 50% 60% at 78% 70%, ${c.orange}${alpha(0.14)}, transparent 70%)` }} />
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }} aria-hidden>
        {lines}
      </svg>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 75% 70% at 50% 45%, transparent 40%, ${EDGE}${alpha(0.8)} 100%)` }} />
      <AbsoluteFill style={{ opacity: 0.05, mixBlendMode: "overlay" }}>
        <svg width="100%" height="100%" aria-hidden>
          <filter id={`grain-${seed}`}>
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={3} seed={seed} stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter={`url(#grain-${seed})`} />
        </svg>
      </AbsoluteFill>
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

/**
 * The marker on scenes where one of Meta's models does the work (operator, 2026-10-31), so a judge skimming any frame
 * sees where Meta's tooling sits: top right, an orange dot and the model's name.
 */
export const MetaBadge: React.FC<{ text: string }> = ({ text }) => {
  const p = useIn(18, 20);
  return (
    <div
      style={{
        ...body,
        position: "absolute",
        right: 60,
        top: 48,
        display: "flex",
        alignItems: "center",
        gap: 14,
        fontSize: 24,
        fontWeight: 600,
        color: c.ink,
        background: `${CARD}cc`,
        border: `2px solid ${c.orange}`,
        borderRadius: 999,
        padding: "8px 22px",
        opacity: p,
        transform: `translateY(${(1 - p) * -10}px)`,
      }}
    >
      <div style={{ width: 12, height: 12, borderRadius: 6, background: c.orange }} />
      Meta AI: {text}
    </div>
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
