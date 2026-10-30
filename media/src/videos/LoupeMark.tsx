import type React from "react";
import { body, c, head, Logo, Scene, useIn } from "../brand";

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

/** Video 03's title card: the Loupe lockup, the subtitle, and IsItLegit as the maker. */
export const LoupeTitle: React.FC<{ line: string; sub: string }> = ({ line, sub }) => {
  const l = useIn(0, 30);
  const s = useIn(24);
  const by = useIn(40);
  return (
    <Scene center>
      <div style={{ display: "flex", alignItems: "center", gap: 40, opacity: l, transform: `scale(${0.92 + 0.08 * l})` }}>
        <LoupeMark size={220} />
        <div style={{ ...head, fontSize: 190, lineHeight: 1 }}>{line}</div>
      </div>
      <div style={{ ...body, fontSize: 44, marginTop: 50, opacity: s }}>{sub}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 70, opacity: by }}>
        <div style={{ ...body, fontSize: 30, color: c.muted }}>by</div>
        <Logo width={260} />
      </div>
    </Scene>
  );
};
