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

// The living ground under every scene (operator, 2026-10-31, after a contour-line version proved too busy): a
// near-black ground and one soft orange glow drifting on a long, slow path, with a fainter second glow so it never
// reads as a stage spotlight, and a vignette. No lines and no grain: nothing competes with the text. A composition
// draws it once behind its whole Series, so the light moves on across scene changes instead of restarting.
const GROUND = DARK ? "#0B0A0D" : c.light;
const EDGE = DARK ? "#040305" : c.light;
const alpha = (a: number) => Math.round(a * 255).toString(16).padStart(2, "0");

export const Backdrop: React.FC = () => {
  const t = useCurrentFrame() / 30;
  const a = { x: 62 + 26 * Math.sin(t / 29), y: 58 + 20 * Math.sin(t / 37 + 1.3) };
  const b = { x: 30 + 18 * Math.cos(t / 41), y: 30 + 14 * Math.sin(t / 33) };
  const breathe = 0.22 + 0.04 * Math.sin(t / 11);
  return (
    <AbsoluteFill style={{ background: GROUND }}>
      <AbsoluteFill style={{ background: `radial-gradient(circle 760px at ${a.x}% ${a.y}%, ${c.orange}${alpha(breathe)}, transparent 70%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(circle 560px at ${b.x}% ${b.y}%, ${c.orange}${alpha(0.08)}, transparent 70%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 80% 75% at 50% 50%, transparent 45%, ${EDGE}${alpha(0.85)} 100%)` }} />
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
 * Meta infinity SVG mark (permitted per 2026-11-03 07:08 ruling in docs/hackathon-criteria.md).
 */
export const MetaInfinity: React.FC<{ size?: number; color?: string }> = ({ size = 28, color = c.orange }) => (
  <svg width={size} height={Math.round(size * 0.68)} viewBox="0 0 64 44" fill="none" aria-hidden>
    <path
      d="M17.2 6C9.6 6 4 12.6 4 21.6C4 30.2 9.2 38 16.8 38C22.4 38 26.8 33.8 32 25.4C37.2 33.8 41.6 38 47.2 38C54.8 38 60 30.2 60 21.6C60 12.6 54.4 6 46.8 6C41 6 36.4 10.4 32 18.2C27.6 10.4 23 6 17.2 6Z"
      stroke={color}
      strokeWidth={6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The marker on scenes where one of Meta's models does the work (operator, 2026-10-31), so a judge skimming any frame
 * sees where Meta's tooling sits: top right, the Meta infinity SVG mark and the model's name.
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
      <MetaInfinity size={26} />
      Meta AI: {text}
    </div>
  );
};

/**
 * Two-row attribution strip naming the 5 Runtime Meta AI models and the Meta Muse Code + full-stack engineering toolchain.
 */
export const MetaAttributionStrip: React.FC<{ style?: React.CSSProperties }> = ({ style }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: 10,
      background: `${CARD}ee`,
      border: `2px solid ${c.orange}`,
      borderRadius: 16,
      padding: "14px 24px",
      ...style,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span style={{ ...mono, fontSize: 16, fontWeight: 700, color: c.orange, letterSpacing: 1 }}>RUNTIME META AI:</span>
      <MetaInfinity size={22} />
      <span style={{ ...body, fontSize: 18, fontWeight: 600, color: c.ink }}>
        Muse Spark 1.3 · Muse Wonder 1.0 · SAM 3.1 · Loupe 1.1 (Muse Glimmer 30B LoRA) · Muse Voice Transcribe 1.0
      </span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span style={{ ...mono, fontSize: 15, fontWeight: 700, color: c.muted, letterSpacing: 1 }}>DEVELOPMENT, TRAINING & INFRASTRUCTURE:</span>
      <MetaInfinity size={20} />
      <span style={{ ...body, fontSize: 16, color: c["ink-2"] }}>
        Built with Meta Muse Code (Wonder 1.0) · Reviewed with GPT-6 Astra, Claude Opus 5.5 & Gemini 4 Argon · Cloudflare Workers & Workflows · Fireworks AI · Hugging Face
      </span>
    </div>
  </div>
);

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
