import type React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import credits from "../../data/credits.json";
import { body, c, head, Logo, Scene, useIn } from "../brand";

// The end credits from media/data/credits.json: the crew rolls up the screen, then the night shift and the AI
// credits hold, centred, under the music's fade-out.
export const CREDITS = 20 * 30;
const ROLL_END = 13 * 30;
const HOLD = 12 * 30;
const ROW = 92;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const Credits: React.FC = () => {
  const frame = useCurrentFrame();
  const height = credits.crew.length * ROW;
  const y = interpolate(frame, [0, ROLL_END], [1080, -height - 120], clamp);
  const hold = useIn(HOLD, 30);
  const notes = useIn(HOLD + 40, 30);
  return (
    <Scene center>
      <div style={{ position: "absolute", left: 0, right: 0, top: y }}>
        {credits.crew.map(([role, name]) => (
          <div key={role} style={{ display: "flex", justifyContent: "center", gap: 40, height: ROW, alignItems: "baseline" }}>
            <div style={{ ...body, fontSize: 40, color: c.muted, width: 620, textAlign: "right" }}>{role}</div>
            <div style={{ ...head, fontSize: 48, width: 620, textAlign: "left" }}>{name}</div>
          </div>
        ))}
      </div>
      <div style={{ opacity: hold, transform: `translateY(${(1 - hold) * 30}px)` }}>
        <Logo width={360} />
        <div style={{ ...body, fontSize: 40, color: c.muted, marginTop: 60 }}>{credits.nightShift[0]}</div>
        <div style={{ ...head, fontSize: 76, color: c.orange, marginTop: 10 }}>{credits.nightShift[1]}</div>
      </div>
      <div style={{ marginTop: 50, opacity: notes }}>
        {credits.notes.map((line) => (
          <div key={line} style={{ ...body, fontSize: 30, color: c.muted, marginTop: 10 }}>
            {line}
          </div>
        ))}
      </div>
    </Scene>
  );
};
