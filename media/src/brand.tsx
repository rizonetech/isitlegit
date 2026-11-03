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
 * The Meta logo mark (permitted per the 2026-11-03 07:08 ruling in docs/hackathon-criteria.md): the official infinity
 * outline (Simple Icons "meta", CC0), in Meta blue unless a colour is given. Never redrawn by hand.
 */
const META_PATH =
  "M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z";
export const META_BLUE = "#0082FB";

export const MetaInfinity: React.FC<{ size?: number; color?: string }> = ({ size = 28, color = META_BLUE }) => (
  <svg width={size} height={Math.round(size * 0.66)} viewBox="0 3.4 24 16" aria-hidden>
    <path d={META_PATH} fill={color} />
  </svg>
);

/**
 * The marker on scenes where one of Meta's models does the work (operator, 2026-10-31), so a judge skimming any frame
 * sees where Meta's tooling sits: above the window's top right corner, the Meta logo and the model's name, never on
 * top of the product.
 */
export const MetaBadge: React.FC<{ text: string; style?: React.CSSProperties }> = ({ text, style }) => {
  const p = useIn(18, 20);
  return (
    <div
      style={{
        ...body,
        position: "absolute",
        right: 60,
        top: 22,
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 22,
        fontWeight: 600,
        color: c.ink,
        background: `${CARD}e6`,
        border: `1px solid ${c["line-strong"]}`,
        borderRadius: 999,
        padding: "6px 18px 6px 14px",
        opacity: p,
        transform: `translateY(${(1 - p) * -10}px)`,
        ...style,
      }}
    >
      <MetaInfinity size={28} />
      {text}
    </div>
  );
};

/** The attribution: what runs in the product on Meta's models, and how it was built. One line each, centred. */
export const MetaAttributionStrip: React.FC<{ style?: React.CSSProperties }> = ({ style }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, ...style }}>
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <MetaInfinity size={32} />
      <span style={{ ...body, fontSize: 24, fontWeight: 600, color: c.ink }}>Runs on Muse Spark, Muse Wonder, SAM 3.1, Muse Voice and Loupe on Muse Glimmer</span>
    </div>
    <div style={{ ...body, fontSize: 19, color: c.muted }}>Built with Meta Muse Code · Cloudflare Workers · Fireworks AI</div>
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
