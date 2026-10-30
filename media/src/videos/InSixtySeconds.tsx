import type React from "react";
import { Img, interpolate, Series, staticFile, useCurrentFrame } from "remotion";
import { body, c, Card, CloseScene, Headline, head, mono, Scene, TitleScene, useIn } from "../brand";

// Script: media/scripts/02-isitlegit-in-60-seconds.md. Roles: README.md "How it uses Meta's models".
const LABEL = "Architecture diagram";
export const SCENES = [4, 7, 7, 8, 16, 6, 8, 4];

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const swap = frame > 110;
  const card = useIn(20);
  return (
    <Scene label="Example invoice">
      <Headline text="An invoice from a real supplier." sub="The bank details quietly changed." />
      <Card style={{ marginTop: 50, width: 1000, opacity: card }}>
        <div style={{ ...head, fontSize: 40 }}>Example Supplies (Pty) Ltd</div>
        <div style={{ ...body, fontSize: 30, marginTop: 10 }}>Invoice INV-2041, R 48 250,00 due</div>
        <div style={{ display: "flex", gap: 24, marginTop: 30, alignItems: "baseline" }}>
          <div style={{ ...body, fontSize: 30, color: c.muted }}>Pay into account</div>
          <div
            style={{
              ...mono,
              fontSize: 40,
              fontWeight: 700,
              padding: "4px 14px",
              borderRadius: 8,
              background: swap ? c["orange-wash"] : "transparent",
              color: swap ? c["orange-text"] : c.ink,
            }}
          >
            {swap ? "4071 552 803" : "6203 114 958"}
          </div>
        </div>
      </Card>
    </Scene>
  );
};

const Box: React.FC<{ title: string; sub?: string; on?: number; style?: React.CSSProperties }> = ({ title, sub, on = 1, style }) => (
  <div
    style={{
      background: c.surface,
      border: `3px solid ${on > 0.5 ? c.orange : c.line}`,
      borderRadius: 18,
      padding: "24px 32px",
      ...style,
    }}
  >
    <div style={{ ...head, fontSize: 36 }}>{title}</div>
    {sub ? <div style={{ ...body, fontSize: 26, marginTop: 6 }}>{sub}</div> : null}
  </div>
);

const Intake: React.FC = () => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [40, 140], [0, 860], clamp);
  const arrived = frame > 140 ? 1 : 0;
  return (
    <Scene label={LABEL}>
      <Headline text="Forward it to check@isitlegit.co.za." />
      <div style={{ position: "relative", height: 300, marginTop: 80 }}>
        <Card style={{ position: "absolute", left: x, top: 60, width: 520, opacity: 1 - arrived * 0.6 }}>
          <div style={{ ...mono, fontSize: 26, color: c.muted }}>To: check@isitlegit.co.za</div>
          <div style={{ ...body, fontSize: 32, color: c.ink, marginTop: 8 }}>Fwd: Invoice INV-2041</div>
        </Card>
        <Box title="Cloudflare Email Routing" sub="the forwarded mail arrives" on={arrived} style={{ position: "absolute", right: 0, top: 40, width: 520 }} />
      </div>
    </Scene>
  );
};

const STEPS = ["Headers", "Domains", "Links", "Attachments"];

const Investigation: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene label={LABEL}>
      <Headline text="One Cloudflare Worker runs the investigation." sub="Each check is a Workflows step, retried on its own." />
      <div style={{ display: "flex", gap: 28, marginTop: 70 }}>
        {STEPS.map((s, i) => (
          <Box key={s} title={s} on={frame > 40 + i * 35 ? 1 : 0} style={{ flex: 1, textAlign: "center" }} />
        ))}
      </div>
    </Scene>
  );
};

const MODELS: [string, string][] = [
  ["Muse Spark", "Reads the mail, the headers and the evidence, and writes the cited verdict."],
  ["Muse Wonder", "Walks the landing page in a contained browser, with canary values only."],
  ["SAM 3.1", "Finds and compares logos, stamps and signatures with the registered ones."],
  ["Muse Voice Transcribe", "Turns voice notes and voicemail lures into text for the same checks."],
];

const Models: React.FC = () => {
  const frame = useCurrentFrame();
  const foot = interpolate(frame, [400, 420], [0, 1], clamp);
  return (
    <Scene label={LABEL}>
      <Headline text="Each Meta model does one job." />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, marginTop: 50 }}>
        {MODELS.map(([name, job], i) => {
          const p = interpolate(frame, [30 + i * 90, 50 + i * 90], [0, 1], clamp);
          return (
            <Card key={name} style={{ opacity: p, transform: `translateY(${(1 - p) * 30}px)`, borderTop: `8px solid ${c.orange}` }}>
              <div style={{ ...head, fontSize: 42 }}>{name}</div>
              <div style={{ ...body, fontSize: 30, lineHeight: 1.35, marginTop: 10 }}>{job}</div>
            </Card>
          );
        })}
      </div>
      <div style={{ ...body, fontSize: 30, color: c.muted, marginTop: 32, opacity: foot }}>
        Every call goes through Cloudflare AI Gateway, with <span style={mono}>store: false</span>.
      </div>
    </Scene>
  );
};

const CHIPS = ["header", "domain", "screenshot", "logo crop", "invoice field"];

const Evidence: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene label={LABEL}>
      <Headline text="Every claim cites its evidence." sub="Kept in D1, R2 and KV. Pages render in Browser Run." />
      <div style={{ display: "flex", gap: 20, marginTop: 50 }}>
        {CHIPS.map((chip, i) => {
          const p = interpolate(frame, [20 + i * 14, 34 + i * 14], [0, 1], clamp);
          return (
            <div key={chip} style={{ ...body, fontSize: 30, color: c.ink, background: c.surface, border: `2px solid ${c["line-strong"]}`, borderRadius: 999, padding: "10px 26px", opacity: p, transform: `translateY(${(1 - p) * -30}px)` }}>
              {chip}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 28, marginTop: 50 }}>
        {["D1", "R2", "KV", "Browser Run"].map((s) => (
          <Box key={s} title={s} on={frame > 110 ? 1 : 0} style={{ flex: 1, textAlign: "center" }} />
        ))}
      </div>
    </Scene>
  );
};

const VERDICTS: [string, string, string][] = [
  ["safe", "Safe", c.safe],
  ["suspicious", "Suspicious", c.sus],
  ["malicious", "Malicious", c.mal],
];

const Verdict: React.FC = () => {
  const frame = useCurrentFrame();
  const stage = frame < 50 ? "question" : frame < 100 ? "checking" : frame < 130 ? "deciding" : "done";
  const foot = interpolate(frame, [150, 170], [0, 1], clamp);
  return (
    <Scene label={LABEL}>
      <Headline text="A plain-language verdict, in minutes." />
      <div style={{ display: "flex", gap: 80, marginTop: 40, justifyContent: "center", height: 360, alignItems: "center" }}>
        {stage === "done" ? (
          VERDICTS.map(([file, name, colour], i) => {
            const p = interpolate(frame, [130 + i * 8, 145 + i * 8], [0, 1], clamp);
            return (
              <div key={file} style={{ textAlign: "center", opacity: p }}>
                <Img src={staticFile(`brand/motion/${file}.svg`)} style={{ width: 260 }} />
                <div style={{ ...head, fontSize: 40, color: colour }}>{name}</div>
              </div>
            );
          })
        ) : (
          <Img src={staticFile(`brand/motion/${stage}.svg`)} style={{ width: 300 }} />
        )}
      </div>
      <div style={{ ...body, fontSize: 36, color: c.ink, textAlign: "center", marginTop: 20, opacity: foot }}>
        The verdict, the top three reasons, and what to do now.
      </div>
    </Scene>
  );
};

export const InSixtySeconds: React.FC = () => {
  const parts = [
    <TitleScene key="t" line="IsItLegit in 60 seconds" sub="Forward a suspicious email. Get a verdict with the evidence." />,
    <Problem key="p" />,
    <Intake key="i" />,
    <Investigation key="w" />,
    <Models key="m" />,
    <Evidence key="e" />,
    <Verdict key="v" />,
    <CloseScene key="c" lines={["github.com/rizonetech/isitlegit", "Built by Rizonetech at the Meta Global AI Developer Hackathon"]} />,
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
