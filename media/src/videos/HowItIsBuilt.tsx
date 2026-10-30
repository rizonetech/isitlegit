import type React from "react";
import { interpolate, Series, useCurrentFrame } from "remotion";
import { body, c, Card, CloseScene, Headline, head, mono, Scene, Tick, TitleScene, useIn } from "../brand";
import stats from "../data/stats.json";

// Script: media/scripts/01-how-isitlegit-is-built.md. Numbers: media/tools/collect-stats.py.
const LABEL = "Our development process, not a product feature";
export const SCENES = [5, 8, 8, 12, 12, 8, 8, 4];

const Plan: React.FC = () => {
  const frame = useCurrentFrame();
  const lit = Math.round(interpolate(frame, [40, 170], [0, stats.stamped], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const g = useIn(20);
  return (
    <Scene label={LABEL}>
      <Headline text={`One plan, ${stats.sections} small sections.`} sub="Each one testable on its own, built in dependency order." />
      <div style={{ display: "flex", alignItems: "flex-end", gap: 60, marginTop: 60, opacity: g }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(34, 26px)", gap: 7 }}>
          {Array.from({ length: stats.sections }, (_, i) => (
            <div key={i} style={{ width: 26, height: 26, borderRadius: 4, background: i < lit ? c.orange : c.surface, border: `2px solid ${i < lit ? c.orange : c.line}` }} />
          ))}
        </div>
        <div>
          <div style={{ ...head, fontSize: 110, color: c.ink }}>{lit}</div>
          <div style={{ ...body, fontSize: 32 }}>shipped</div>
        </div>
      </div>
    </Scene>
  );
};

const STEPS = ["Write the code", "Write a test that can fail", "Run the gates", "Commit"];

const Writer: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene label={LABEL}>
      <Headline text="Claude Code builds one section at a time." sub="Small, single-purpose sections, each with its own test checkpoint." />
      <Card style={{ marginTop: 56, width: 1200, padding: "40px 52px" }}>
        <div style={{ ...mono, fontSize: 32, color: c.muted, marginBottom: 18 }}>D02 T02 §4</div>
        {STEPS.map((step, i) => {
          const done = frame > 45 + i * 40;
          return (
            <div key={step} style={{ display: "flex", alignItems: "center", gap: 24, height: 84 }}>
              <div style={{ width: 52, height: 52, border: `3px solid ${done ? c.orange : c["control-border"]}`, borderRadius: 6, display: "grid", placeItems: "center" }}>
                {done ? <Tick size={36} /> : null}
              </div>
              <div style={{ ...body, fontSize: 44, color: done ? c.ink : c.muted }}>{step}</div>
            </div>
          );
        })}
      </Card>
    </Scene>
  );
};

// The schedule in .conclave/reviewers.toml: plan and completion reviews, then rounds at falling effort that stop at
// the first round with no P1 or P2. The results shown are the rule, not one section's record.
const ROUNDS: [string, string, string][] = [
  ["Plan review", "high", "before the build"],
  ["Completion review", "high", "after the build"],
  ["Round 1, adversarial", "high", "findings fixed"],
  ["Round 2, adversarial", "medium", "findings fixed"],
  ["Round 3, adversarial", "low", "no P1 or P2: stop"],
];

const Reviewer: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene label={LABEL}>
      <Headline text="A different model family reviews every section." sub="GPT-6 Astra, through the Codex CLI, at falling effort until a round finds nothing serious." />
      <div style={{ marginTop: 50, display: "flex", flexDirection: "column", gap: 16 }}>
        {ROUNDS.map(([name, effort, result], i) => {
          const from = 50 + i * 45;
          const p = interpolate(frame, [from, from + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const last = i === ROUNDS.length - 1;
          const width = { high: 760, medium: 560, low: 360 }[effort] ?? 360;
          return (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 28, opacity: p }}>
              <div style={{ ...body, fontSize: 30, width: 400, color: c.ink }}>{name}</div>
              <div style={{ height: 44, width: width * p, background: last ? c.orange : c["line-strong"], borderRadius: 8 }} />
              <div style={{ ...body, fontSize: 28, color: last ? c["orange-text"] : c.muted, fontWeight: last ? 700 : 500 }}>
                {effort} effort, {result}
              </div>
            </div>
          );
        })}
      </div>
    </Scene>
  );
};

const FINDING =
  "Top finding: the expired-object restore path can desynchronise R2, D1 and the returned media type, breaking the invariant this section was closed on.";

const FinalReview: React.FC = () => {
  const frame = useCurrentFrame();
  const chars = Math.round(interpolate(frame, [60, 230], [0, FINDING.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const card = useIn(30);
  const foot = useIn(260);
  return (
    <Scene label={LABEL}>
      <Headline text="Then one final review, by Muse Wonder." sub="Through Muse Code: a third model family reads the finished section once." />
      <Card style={{ marginTop: 50, borderLeft: `10px solid ${c.orange}`, opacity: card, maxWidth: 1500 }}>
        <div style={{ ...mono, fontSize: 30, fontWeight: 700 }}>## Final review: wonder</div>
        <div style={{ ...mono, fontSize: 24, color: c.muted, marginTop: 8 }}>docs/reviews/01-intake/D01-T01-s2.md</div>
        <div style={{ ...body, fontSize: 34, lineHeight: 1.4, color: c.ink, marginTop: 26, minHeight: 150 }}>{FINDING.slice(0, chars)}</div>
      </Card>
      <div style={{ ...body, fontSize: 34, marginTop: 36, opacity: foot }}>A P1 or P2 it finds is fixed, and proven by one more round.</div>
    </Scene>
  );
};

const Receipt: React.FC = () => {
  const cmd = useIn(30);
  const file = useIn(90);
  const stamp = useIn(150, 14);
  return (
    <Scene label={LABEL}>
      <Headline text="Nothing ships without a receipt." sub="The section is ticked only by the stamp command, backed by the review record." />
      <div style={{ display: "flex", gap: 50, alignItems: "center", marginTop: 60 }}>
        <div>
          <Card style={{ background: c.dark, border: "none", opacity: cmd }}>
            <div style={{ ...mono, fontSize: 32, color: c["on-dark"] }}>$ python3 scripts/todo-graph.py stamp</div>
          </Card>
          <Card style={{ marginTop: 24, opacity: file, transform: `translateX(${(1 - file) * -40}px)` }}>
            <div style={{ ...mono, fontSize: 30 }}>docs/reviews/01-intake/D01-T01-s2.md</div>
          </Card>
        </div>
        <div
          style={{
            ...head,
            fontSize: 56,
            color: c["orange-text"],
            border: `6px solid ${c.orange}`,
            borderRadius: 18,
            padding: "18px 36px",
            display: "flex",
            alignItems: "center",
            gap: 20,
            opacity: stamp,
            transform: `rotate(-6deg) scale(${1.4 - 0.4 * stamp})`,
          }}
        >
          <Tick size={56} /> Verified
        </div>
      </div>
    </Scene>
  );
};

const Counter: React.FC<{ value: number; label: string; from: number }> = ({ value, label, from }) => {
  const frame = useCurrentFrame();
  const n = Math.round(interpolate(frame, [from, from + 60], [0, value], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return (
    <div style={{ flex: 1 }}>
      <div style={{ ...head, fontSize: 150, color: c.orange }}>{n}</div>
      <div style={{ ...body, fontSize: 36, color: c.ink }}>{label}</div>
    </div>
  );
};

const SoFar: React.FC = () => {
  const foot = useIn(120);
  return (
    <Scene label={LABEL}>
      <Headline text="So far." />
      <div style={{ display: "flex", marginTop: 60 }}>
        <Counter value={stats.stamped} label="sections shipped" from={20} />
        <Counter value={stats.rounds} label="review rounds" from={40} />
        <Counter value={stats.finals} label="Muse final reviews" from={60} />
      </div>
      <div style={{ ...body, fontSize: 30, color: c.muted, marginTop: 50, opacity: foot }}>
        Read from the repository on {stats.date}, commit {stats.commit}.
      </div>
    </Scene>
  );
};

export const HowItIsBuilt: React.FC = () => {
  const parts = [
    <TitleScene key="t" line="How IsItLegit is built" sub="Our development process. Not a product feature." />,
    <Plan key="p" />,
    <Writer key="w" />,
    <Reviewer key="r" />,
    <FinalReview key="f" />,
    <Receipt key="s" />,
    <SoFar key="n" />,
    <CloseScene key="c" lines={["github.com/rizonetech/isitlegit", "Development tooling is declared in CONTRIBUTIONS.md"]} />,
  ];
  return (
    <Series>
      {parts.map((part, i) => (
        <Series.Sequence key={part.key} durationInFrames={SCENES[i] * 30}>
          {part}
        </Series.Sequence>
      ))}
    </Series>
  );
};
