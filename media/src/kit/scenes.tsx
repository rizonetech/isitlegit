import type React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import stats from "../data/stats.json";
import { body, c, CARD, CODE_BG, Card, Headline, head, mono, Scene, Tick, useIn } from "../brand";
import { fill } from "./text";

// The scene types a storyboard (media/data/storyboards/*.json) is written in. Every string passes through fill(), so
// a figure is named ({stats.x}, {fact.y}) rather than typed.
export type Step = { title: string; sub?: string };
export type SceneSpec = (
  | { type: "chapter"; number: number; title: string; sub?: string; seconds?: number }
  | { type: "bullets"; title: string; sub?: string; items: string[]; seconds?: number }
  | { type: "table"; title: string; sub?: string; columns: string[]; rows: string[][]; seconds?: number }
  | { type: "flow"; title: string; sub?: string; steps: Step[]; note?: string; seconds?: number }
  | { type: "code"; title: string; sub?: string; lines: string[]; caption?: string; seconds?: number }
  | { type: "stats"; title: string; sub?: string; items: { value: string; label: string }[]; note?: string; seconds?: number }
  | { type: "chart"; title: string; sub?: string; data: "domains" | "days" | "hours"; note?: string; seconds?: number }
  | { type: "lanes"; title: string; sub?: string; lanes: { name: string; branch: string; owns: string; role: string }[]; seconds?: number }
  | { type: "callout"; title: string; text: string; seconds?: number }
) & {
  // Names the Meta model that does this scene's work; shows the MetaBadge.
  meta?: string;
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const stagger = (frame: number, i: number, from = 24, gap = 14) => interpolate(frame, [from + i * gap, from + 14 + i * gap], [0, 1], clamp);

// A chapter card opens with an orange wipe in time with the whoosh (src/kit/sound.tsx), then the number lands with a
// scale and a glow and the title rises in behind it.
const Chapter: React.FC<{ s: Extract<SceneSpec, { type: "chapter" }>; total: number; label?: string }> = ({ s, total, label }) => {
  const frame = useCurrentFrame();
  const sweep = interpolate(frame, [0, 9, 20], [0, 1, 2], clamp);
  const n = useIn(10, 26);
  const t = useIn(16, 24);
  const u = useIn(26);
  return (
    <Scene label={label}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: c.orange,
          transformOrigin: sweep <= 1 ? "left" : "right",
          transform: `scaleX(${sweep <= 1 ? sweep : 2 - sweep})`,
        }}
      />
      <div
        style={{
          ...head,
          fontSize: 200,
          color: c.orange,
          lineHeight: 1,
          opacity: n,
          transform: `scale(${1.35 - 0.35 * n})`,
          transformOrigin: "left center",
          textShadow: `0 0 ${80 * n}px ${c.orange}88`,
        }}
      >
        {String(s.number).padStart(2, "0")}
      </div>
      <div style={{ ...head, fontSize: 92, marginTop: 20, opacity: t, transform: `translateY(${(1 - t) * 30}px)` }}>{fill(s.title)}</div>
      {s.sub ? <div style={{ ...body, fontSize: 40, marginTop: 24, maxWidth: 1500, opacity: u }}>{fill(s.sub)}</div> : null}
      <div style={{ display: "flex", gap: 10, marginTop: 70 }}>
        {Array.from({ length: total }, (_, i) => (
          <div key={i} style={{ width: 54, height: 8, borderRadius: 4, background: i < s.number ? c.orange : c["line-strong"] }} />
        ))}
      </div>
    </Scene>
  );
};

const Bullets: React.FC<{ s: Extract<SceneSpec, { type: "bullets" }>; label?: string }> = ({ s, label }) => {
  const frame = useCurrentFrame();
  const size = s.items.length > 6 ? 32 : 36;
  return (
    <Scene label={label}>
      <Headline text={fill(s.title)} sub={s.sub ? fill(s.sub) : undefined} />
      <div style={{ marginTop: 40, maxWidth: 1600 }}>
        {s.items.map((item, i) => {
          const p = stagger(frame, i, 30, 22);
          return (
            <div key={item} style={{ display: "flex", gap: 24, alignItems: "baseline", marginBottom: size * 0.62, opacity: p, transform: `translateX(${(1 - p) * 20}px)` }}>
              <div style={{ width: 16, height: 16, background: c.orange, flex: "none", transform: "translateY(-4px)" }} />
              <div style={{ ...body, fontSize: size, lineHeight: 1.35, color: c.ink }}>{fill(item)}</div>
            </div>
          );
        })}
      </div>
    </Scene>
  );
};

const Table: React.FC<{ s: Extract<SceneSpec, { type: "table" }>; label?: string }> = ({ s, label }) => {
  const frame = useCurrentFrame();
  const size = s.rows.length > 8 ? 26 : 30;
  return (
    <Scene label={label}>
      <Headline text={fill(s.title)} sub={s.sub ? fill(s.sub) : undefined} />
      <div style={{ marginTop: 34, display: "grid", gridTemplateColumns: s.columns.map((_, i) => (i === 0 ? "minmax(0, 0.9fr)" : "minmax(0, 1.6fr)")).join(" "), columnGap: 36, maxWidth: 1620 }}>
        {s.columns.map((col) => (
          <div key={col} style={{ ...body, fontSize: size - 4, fontWeight: 700, color: c.muted, paddingBottom: 10, borderBottom: `3px solid ${c.ink}` }}>
            {fill(col)}
          </div>
        ))}
        {s.rows.map((row, r) =>
          row.map((cell, i) => (
            <div
              key={`${r}-${i}`}
              style={{ ...(i === 0 ? head : body), fontSize: size, color: c.ink, padding: "10px 0", borderBottom: `2px solid ${c.line}`, opacity: stagger(frame, r, 24, 10), lineHeight: 1.3 }}
            >
              {fill(cell)}
            </div>
          )),
        )}
      </div>
    </Scene>
  );
};

const Flow: React.FC<{ s: Extract<SceneSpec, { type: "flow" }>; label?: string }> = ({ s, label }) => {
  const frame = useCurrentFrame();
  const perRow = s.steps.length > 5 ? Math.ceil(s.steps.length / 2) : s.steps.length;
  const lit = Math.floor(interpolate(frame, [30, 30 + s.steps.length * 30], [0, s.steps.length], clamp));
  return (
    <Scene label={label}>
      <Headline text={fill(s.title)} sub={s.sub ? fill(s.sub) : undefined} />
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${perRow}, 1fr)`, gap: "28px 46px", marginTop: 44 }}>
        {s.steps.map((step, i) => {
          const on = i < lit;
          return (
            <div key={step.title} style={{ position: "relative", opacity: interpolate(frame, [18 + i * 6, 30 + i * 6], [0, 1], clamp) }}>
              <div style={{ background: CARD, border: `3px solid ${on ? c.orange : c["line-strong"]}`, borderRadius: 16, padding: "18px 22px", minHeight: 120 }}>
                <div style={{ ...mono, fontSize: 20, color: c.muted }}>{String(i + 1).padStart(2, "0")}</div>
                <div style={{ ...head, fontSize: 30, marginTop: 4 }}>{fill(step.title)}</div>
                {step.sub ? <div style={{ ...body, fontSize: 23, marginTop: 6, lineHeight: 1.3 }}>{fill(step.sub)}</div> : null}
              </div>
              {(i + 1) % perRow !== 0 && i < s.steps.length - 1 ? (
                <div style={{ position: "absolute", right: -40, top: "50%", ...head, fontSize: 34, color: on ? c.orange : c["line-strong"], transform: "translateY(-50%)" }}>›</div>
              ) : null}
            </div>
          );
        })}
      </div>
      {s.note ? <div style={{ ...body, fontSize: 30, color: c.ink, marginTop: 34, opacity: interpolate(frame, [60 + s.steps.length * 30, 80 + s.steps.length * 30], [0, 1], clamp) }}>{fill(s.note)}</div> : null}
    </Scene>
  );
};

const Code: React.FC<{ s: Extract<SceneSpec, { type: "code" }>; label?: string }> = ({ s, label }) => {
  const frame = useCurrentFrame();
  return (
    <Scene label={label}>
      <Headline text={fill(s.title)} sub={s.sub ? fill(s.sub) : undefined} />
      <Card style={{ background: CODE_BG, border: `2px solid ${c.line}`, marginTop: 36, maxWidth: 1620, padding: "30px 40px" }}>
        {s.lines.map((line, i) => (
          <div key={`${i}-${line}`} style={{ ...mono, fontSize: s.lines.length > 9 ? 24 : 28, lineHeight: 1.5, color: line.trim().startsWith("#") ? c["on-dark-muted"] : c["on-dark"], whiteSpace: "pre-wrap", minHeight: "1.5em", opacity: stagger(frame, i, 24, 8) }}>
            {fill(line)}
          </div>
        ))}
      </Card>
      {s.caption ? <div style={{ ...body, fontSize: 30, color: c.ink, marginTop: 28 }}>{fill(s.caption)}</div> : null}
    </Scene>
  );
};

const Stats: React.FC<{ s: Extract<SceneSpec, { type: "stats" }>; label?: string }> = ({ s, label }) => {
  const frame = useCurrentFrame();
  return (
    <Scene label={label}>
      <Headline text={fill(s.title)} sub={s.sub ? fill(s.sub) : undefined} />
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(4, s.items.length)}, 1fr)`, gap: 40, marginTop: 56 }}>
        {s.items.map((item, i) => {
          const text = fill(item.value);
          const target = Number(text.replace(/,/g, ""));
          const p = interpolate(frame, [24 + i * 10, 84 + i * 10], [0, 1], clamp);
          const shown = Number.isFinite(target) && /^[\d,]+$/.test(text) ? Math.round(target * p).toLocaleString("en-US") : text;
          return (
            <div key={item.label} style={{ opacity: Math.min(1, p * 3) }}>
              <div style={{ ...head, fontSize: 110, color: c.orange, lineHeight: 1 }}>{shown}</div>
              <div style={{ ...body, fontSize: 32, color: c.ink, marginTop: 12 }}>{fill(item.label)}</div>
            </div>
          );
        })}
      </div>
      {s.note ? <div style={{ ...body, fontSize: 28, color: c.muted, marginTop: 50 }}>{fill(s.note)}</div> : null}
    </Scene>
  );
};

const Chart: React.FC<{ s: Extract<SceneSpec, { type: "chart" }>; label?: string }> = ({ s, label }) => {
  const frame = useCurrentFrame();
  const grow = interpolate(frame, [24, 90], [0, 1], clamp);
  let chart: React.ReactNode = null;
  if (s.data === "domains") {
    const max = Math.max(...stats.domains.map((d) => d.sections));
    chart = (
      <div style={{ marginTop: 30 }}>
        {stats.domains.map((d) => (
          <div key={d.domain} style={{ display: "flex", alignItems: "center", gap: 20, height: 52 }}>
            <div style={{ ...mono, fontSize: 24, width: 230 }}>{d.domain}</div>
            <div style={{ position: "relative", height: 30, width: (1100 * d.sections) / max, background: CARD, border: `2px solid ${c["line-strong"]}`, borderRadius: 6 }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(100 * d.stamped * grow) / d.sections}%`, background: c.orange, borderRadius: 4 }} />
            </div>
            <div style={{ ...body, fontSize: 24, color: c.ink }}>
              {Math.round(d.stamped * grow)} of {d.sections}
            </div>
          </div>
        ))}
      </div>
    );
  } else {
    const series = s.data === "days" ? stats.pace.days.map((d) => ({ k: d.date.slice(5), v: d.commits, w: d.stamps })) : stats.pace.hours.map((v, h) => ({ k: String(h).padStart(2, "0"), v, w: 0 }));
    const max = Math.max(...series.map((x) => x.v));
    const width = s.data === "days" ? 180 : 50;
    chart = (
      <div style={{ display: "flex", alignItems: "flex-end", gap: s.data === "days" ? 50 : 14, height: 520, marginTop: 30 }}>
        {series.map((x) => (
          <div key={x.k} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div style={{ ...mono, fontSize: s.data === "days" ? 30 : 18, color: c.ink }}>{Math.round(x.v * grow)}</div>
            <div style={{ position: "relative", width, height: (400 * x.v * grow) / max, background: c.orange, borderRadius: 6 }}>
              {x.w ? <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: (400 * x.w * grow) / max, background: c.ink, borderRadius: 6 }} /> : null}
            </div>
            <div style={{ ...mono, fontSize: s.data === "days" ? 26 : 18, color: c.muted }}>{x.k}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <Scene label={label}>
      <Headline text={fill(s.title)} sub={s.sub ? fill(s.sub) : undefined} />
      {chart}
      {s.note ? <div style={{ ...body, fontSize: 28, color: c.muted, marginTop: 20 }}>{fill(s.note)}</div> : null}
    </Scene>
  );
};

const Lanes: React.FC<{ s: Extract<SceneSpec, { type: "lanes" }>; label?: string }> = ({ s, label }) => {
  const frame = useCurrentFrame();
  // More than six lanes no longer fit one column at 1080p: two columns of compact cards, name and branch on one line.
  if (s.lanes.length > 6) {
    return (
      <Scene label={label}>
        <Headline text={fill(s.title)} sub={s.sub ? fill(s.sub) : undefined} />
        <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {s.lanes.map((lane, i) => {
            const p = stagger(frame, i, 24, 12);
            const pulse = 0.55 + 0.45 * Math.abs(Math.sin((frame + i * 11) / 9));
            return (
              <div key={lane.name} style={{ display: "grid", gridTemplateColumns: "28px 1fr", alignItems: "start", gap: 14, background: CARD, border: `2px solid ${c.line}`, borderRadius: 14, padding: "12px 20px", opacity: p }}>
                <div style={{ width: 18, height: 18, borderRadius: 9, marginTop: 9, background: c.orange, opacity: pulse }} />
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
                    <span style={{ ...head, fontSize: 28 }}>{fill(lane.name)}</span>
                    <span style={{ ...mono, fontSize: 18, color: c.muted }}>{fill(lane.branch)}</span>
                  </div>
                  <div style={{ ...body, fontSize: 22, color: c.ink, marginTop: 2 }}>{fill(lane.role)}</div>
                  <div style={{ ...body, fontSize: 19, marginTop: 1 }}>{fill(lane.owns)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </Scene>
    );
  }
  return (
    <Scene label={label}>
      <Headline text={fill(s.title)} sub={s.sub ? fill(s.sub) : undefined} />
      <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 16 }}>
        {s.lanes.map((lane, i) => {
          const p = stagger(frame, i, 24, 18);
          const pulse = 0.55 + 0.45 * Math.abs(Math.sin((frame + i * 11) / 9));
          return (
            <div key={lane.name} style={{ display: "grid", gridTemplateColumns: "40px 300px 420px 1fr", alignItems: "center", gap: 20, background: CARD, border: `2px solid ${c.line}`, borderRadius: 16, padding: "16px 24px", opacity: p }}>
              <div style={{ width: 22, height: 22, borderRadius: 11, background: c.orange, opacity: pulse }} />
              <div style={{ ...head, fontSize: 34 }}>{fill(lane.name)}</div>
              <div style={{ ...mono, fontSize: 22, color: c.muted }}>{fill(lane.branch)}</div>
              <div>
                <div style={{ ...body, fontSize: 26, color: c.ink }}>{fill(lane.role)}</div>
                <div style={{ ...body, fontSize: 22, marginTop: 2 }}>{fill(lane.owns)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </Scene>
  );
};

const Callout: React.FC<{ s: Extract<SceneSpec, { type: "callout" }>; label?: string }> = ({ s, label }) => {
  const t = useIn(10, 24);
  return (
    <Scene label={label}>
      <div style={{ ...body, fontSize: 32, fontWeight: 700, color: c["orange-text"], opacity: t }}>{fill(s.title)}</div>
      <div style={{ ...head, fontSize: 70, lineHeight: 1.2, marginTop: 24, maxWidth: 1600, opacity: t, transform: `translateY(${(1 - t) * 20}px)` }}>{fill(s.text)}</div>
      <div style={{ marginTop: 40, opacity: t }}>
        <Tick size={64} />
      </div>
    </Scene>
  );
};

export const RenderScene: React.FC<{ s: SceneSpec; chapters: number; label?: string }> = ({ s, chapters, label }) => {
  switch (s.type) {
    case "chapter":
      return <Chapter s={s} total={chapters} label={label} />;
    case "bullets":
      return <Bullets s={s} label={label} />;
    case "table":
      return <Table s={s} label={label} />;
    case "flow":
      return <Flow s={s} label={label} />;
    case "code":
      return <Code s={s} label={label} />;
    case "stats":
      return <Stats s={s} label={label} />;
    case "chart":
      return <Chart s={s} label={label} />;
    case "lanes":
      return <Lanes s={s} label={label} />;
    case "callout":
      return <Callout s={s} label={label} />;
  }
};
