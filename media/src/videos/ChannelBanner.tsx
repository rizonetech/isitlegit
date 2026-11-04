import type React from "react";
import { AbsoluteFill } from "remotion";

export const BANNER = { fps: 30, width: 2560, height: 1440 } as const;
export const SAFE_ZONE = { width: 1546, height: 423 } as const;

/**
 * Personal developer YouTube channel banner for @DerickPayneDev (D10 T01 §10), its own identity, unrelated to IsItLegit:
 * a graphite ground with a field of flowing lines in cyan and violet that fills the whole 2560 x 1440 canvas (what a TV
 * shows), and every word inside the centred 1546 x 423 safe zone (what a phone shows). No box is drawn around the safe
 * zone and no monogram stands in for a photo: the channel avatar already carries the face.
 */
const INK = "#E9EEF5";
const MUTED = "#8A96A8";
const CYAN = "#3EE6D4";
const VIOLET = "#8B7CFF";
const GROUND = "#0B0E13";

// The line field: 46 curves, each a sum of two slow sines, drifting from left to right and gathering on the right,
// drawn once as SVG so the PNG is sharp at any size. Deterministic, so every render is the same banner.
const FIELD = Array.from({ length: 46 }, (_, i) => {
  const t = i / 45;
  const base = 120 + t * 1200;
  const pts: string[] = [];
  for (let x = -40; x <= 2600; x += 40) {
    const u = Math.max(0, x / 2560);
    const pull = Math.pow(u, 1.6) * (720 - base) * 0.55;
    const y = base + pull + 46 * Math.sin(u * 5.2 + i * 0.37) + 22 * Math.sin(u * 13 + i * 1.1);
    pts.push(`${x},${y.toFixed(1)}`);
  }
  return { d: `M${pts.join(" L")}`, t };
});

const font = (family: "Exo" | "Exo 2", weight: number): React.CSSProperties => ({ fontFamily: `"${family}", sans-serif`, fontWeight: weight });
const mono: React.CSSProperties = { fontFamily: "ui-monospace, Menlo, Consolas, monospace" };

export const ChannelBanner: React.FC = () => (
  <AbsoluteFill style={{ background: GROUND, overflow: "hidden" }}>
    <svg width={2560} height={1440} viewBox="0 0 2560 1440" style={{ position: "absolute", inset: 0 }} aria-hidden>
      <defs>
        <linearGradient id="field" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={VIOLET} stopOpacity="0.05" />
          <stop offset="0.55" stopColor={VIOLET} stopOpacity="0.32" />
          <stop offset="1" stopColor={CYAN} stopOpacity="0.75" />
        </linearGradient>
        <radialGradient id="glow" cx="0.78" cy="0.5" r="0.45">
          <stop offset="0" stopColor={CYAN} stopOpacity="0.16" />
          <stop offset="1" stopColor={CYAN} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
          <stop offset="0.55" stopColor={GROUND} stopOpacity="0" />
          <stop offset="1" stopColor={GROUND} stopOpacity="0.95" />
        </radialGradient>
      </defs>
      <rect width="2560" height="1440" fill="url(#glow)" />
      {FIELD.map((l) => (
        <path key={l.d.slice(0, 24)} d={l.d} fill="none" stroke="url(#field)" strokeWidth={l.t > 0.48 && l.t < 0.56 ? 2.6 : 1.3} />
      ))}
      <rect width="2560" height="1440" fill="url(#vignette)" />
    </svg>
    {/* Left side of the safe zone sits on darker ground, so the type always reads over the lines. */}
    <AbsoluteFill style={{ background: `linear-gradient(90deg, ${GROUND} 0%, ${GROUND}f2 30%, ${GROUND}00 62%)` }} />

    <div
      style={{
        position: "absolute",
        left: (2560 - SAFE_ZONE.width) / 2,
        top: (1440 - SAFE_ZONE.height) / 2,
        width: SAFE_ZONE.width,
        height: SAFE_ZONE.height,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        boxSizing: "border-box",
        padding: "0 24px",
      }}
    >
      <div style={{ ...mono, fontSize: 26, letterSpacing: 6, color: CYAN }}>@DERICKPAYNEDEV</div>
      <div style={{ ...font("Exo", 800), fontSize: 132, lineHeight: 1, color: INK, letterSpacing: -3, marginTop: 18 }}>Derick Payne</div>
      <div style={{ ...font("Exo 2", 500), fontSize: 40, lineHeight: 1.25, color: INK, marginTop: 26 }}>
        I build production AI systems, <span style={{ color: CYAN }}>and show exactly how.</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 30, ...mono, fontSize: 24, color: MUTED }}>
        {["agents", "evals", "fine-tuning", "systems design", "shipping"].map((w, i) => (
          <span key={w} style={{ display: "flex", alignItems: "center", gap: 18 }}>
            {i ? <span style={{ width: 6, height: 6, borderRadius: 3, background: VIOLET }} /> : null}
            {w}
          </span>
        ))}
      </div>
    </div>
  </AbsoluteFill>
);
