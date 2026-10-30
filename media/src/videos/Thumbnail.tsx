import type React from "react";
import { AbsoluteFill } from "remotion";
import { Backdrop, body, c, head, Logo, MetaBadge } from "../brand";
import { LoupeMark } from "./LoupeMark";

// YouTube thumbnails (operator, 2026-10-31): the videos' own ground, a few words large enough to read at thumbnail
// size, one orange accent and the maker. Rendered as stills (pnpm thumbs).
type Thumb = { kicker: string; line: string[]; accent: number; mark?: "loupe"; meta?: string };

export const THUMBS: Record<string, Thumb> = {
  "01": { kicker: "How IsItLegit is built", line: ["One developer.", "An AI team that", "never sleeps."], accent: 2 },
  "02": { kicker: "Technical deep dive", line: ["Is this email", "legit?"], accent: 1, meta: "Muse Spark, Muse Wonder, SAM 3.1" },
  "03": { kicker: "Training a page screener", line: ["Loupe 1.0"], accent: 0, mark: "loupe", meta: "Muse Glimmer 30B" },
};

export const Thumbnail: React.FC<{ video: string }> = ({ video }) => {
  const t = THUMBS[video];
  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill style={{ padding: "110px 130px", justifyContent: "center" }}>
        <div style={{ ...body, fontSize: 52, fontWeight: 700, color: c.orange, letterSpacing: 1 }}>{t.kicker.toUpperCase()}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 50, marginTop: 30 }}>
          {t.mark ? <LoupeMark size={300} /> : null}
          <div>
            {t.line.map((l, i) => (
              <div key={l} style={{ ...head, fontSize: t.mark ? 210 : 150, lineHeight: 1.04, color: i === t.accent && !t.mark ? c.orange : c.ink }}>
                {l}
              </div>
            ))}
          </div>
        </div>
        <div style={{ position: "absolute", left: 130, bottom: 90 }}>
          <Logo width={380} />
        </div>
      </AbsoluteFill>
      {t.meta ? <MetaBadge text={t.meta} /> : null}
    </AbsoluteFill>
  );
};
