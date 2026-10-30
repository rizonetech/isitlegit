import type React from "react";
import { interpolate, Sequence, Series, useCurrentFrame } from "remotion";
import data from "../../data/loupe-facts.json";
import { Backdrop, body, c, CARD, Card, CloseScene, Headline, head, mono, Scene, Tick, TitleScene, useIn } from "../brand";
import { CREDITS as END_CREDITS, Credits as EndCredits } from "../kit/credits";
import { MusicBed, Sfx } from "../kit/sound";
import { Voice, voicedFrames, voiceFor } from "../kit/voice";
import { DURATION as INTRO, LogoReveal } from "./LogoReveal";

// Script: media/scripts/03-loupe-1-0.md. Every figure: media/data/loupe-facts.json, proven by media/tools/check-facts.py.
const F = data.facts;
const v = (k: keyof typeof F) => F[k].value;
const LABEL = `Loupe 1.0, in preparation: figures as of ${data.asOf}, glimmer ${data.commit.slice(0, 8)}`;
export const SCENES = [5, 10, 10, 14, 10, 14, 16, 10, 10, 12, 8, 8, 5];
// Each scene's frames, stretched to its narration clip when media/data/narration/03.json has been voiced.
const timing = () => {
  const clips = voiceFor("03", SCENES.length);
  return { frames: voicedFrames(SCENES, clips), clips };
};
// The dark logo animation opens the video and the credits close it, around the voiced scenes.
export const loupeFrames = () => INTRO + timing().frames.reduce((a, f) => a + f, 0) + END_CREDITS;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const n = (s: string) => Number(s.replace(/,/g, ""));

const Planned: React.FC = () => (
  <span style={{ ...body, fontSize: 22, fontWeight: 700, color: c.muted, border: `2px dashed ${c["line-strong"]}`, borderRadius: 999, padding: "2px 14px", marginLeft: 16, verticalAlign: "middle" }}>
    planned
  </span>
);

const Box: React.FC<{ title: string; sub?: string; on?: boolean; dashed?: boolean; style?: React.CSSProperties }> = ({ title, sub, on, dashed, style }) => (
  <div style={{ background: CARD, border: `3px ${dashed ? "dashed" : "solid"} ${on ? c.orange : c["line-strong"]}`, borderRadius: 18, padding: "22px 30px", ...style }}>
    <div style={{ ...head, fontSize: 36 }}>{title}</div>
    {sub ? <div style={{ ...body, fontSize: 26, marginTop: 6 }}>{sub}</div> : null}
  </div>
);

const Arrow: React.FC<{ dashed?: boolean; p: number }> = ({ dashed, p }) => (
  <svg width={140} height={30} style={{ opacity: p }} aria-hidden>
    <line x1={0} y1={15} x2={120 * p} y2={15} stroke={c.ink} strokeWidth={5} strokeDasharray={dashed ? "12 10" : undefined} />
    <path d="M118 4L136 15L118 26" fill="none" stroke={c.ink} strokeWidth={5} />
  </svg>
);

const Job: React.FC = () => {
  const frame = useCurrentFrame();
  const a = interpolate(frame, [40, 70], [0, 1], clamp);
  const b = interpolate(frame, [150, 180], [0, 1], clamp);
  return (
    <Scene label={LABEL}>
      <Headline text="One job: is this page a brand lure?" sub="A login or payment form wearing someone else's brand. Loupe answers first; Muse Spark takes over when it cannot." />
      <div style={{ ...mono, fontSize: 34, marginTop: 40 }}>
        {v("screenPage")}(screenshot, text) <Planned />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 40 }}>
        <Box title="Screenshot + page text" sub="a rendered candidate page" />
        <Arrow p={a} />
        <Box title="Loupe" sub={`${v("baseModel")} + LoRA`} on />
        <div style={{ opacity: b, display: "flex", alignItems: "center", gap: 20 }}>
          <Arrow dashed p={b} />
          <Box title="Muse Spark" sub="failover" dashed />
        </div>
      </div>
    </Scene>
  );
};

const SPECS: [string, string][] = [
  ["Base model", `${v("baseModel")} on Fireworks AI`],
  ["Input", "image and text"],
  ["Tuning", "LoRA; vision encoder frozen"],
  ["Training context", `${v("context")} tokens`],
  ["Trained through", v("serverless")],
];

const BaseModel: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene label={LABEL}>
      <Headline text="The base model." sub="Read from the provider's model record before any data was built." />
      <Card style={{ marginTop: 40, width: 1300, padding: "20px 44px" }}>
        {SPECS.map(([k, val], i) => (
          <div key={k} style={{ display: "flex", padding: "16px 0", borderBottom: i < SPECS.length - 1 ? `2px solid ${c.line}` : "none", opacity: interpolate(frame, [20 + i * 14, 34 + i * 14], [0, 1], clamp) }}>
            <div style={{ ...body, fontSize: 32, color: c.muted, width: 380 }}>{k}</div>
            <div style={{ ...head, fontSize: 34 }}>{val}</div>
          </div>
        ))}
      </Card>
    </Scene>
  );
};

const SOURCES: [string, string, string][] = [
  ["PhreshPhish", "CC BY 4.0", `${v("phreshphish")} pages`],
  ["CompPhish", "CC BY 4.0", `${v("compphish")} pages`],
  ["Ariyadasa 2021", "CC BY 4.0", `${v("ariyadasaSample")} sampled of 83,275`],
  ["Look for Mallory", "Apache 2.0", "15,000 sampled of 15,902"],
  ["Kempf HTML", "CC BY-SA 3.0", `${v("kempf")} pages`],
  ["ScamFerret", "GPL-3.0", `${v("scamferret")} captures, 240 screenshots`],
  ["7 Days Later", "CC BY 4.0", "public sample"],
  ["Majestic Million", "CC BY 3.0", "our own renders of the top 20,000 (benign)"],
];

const Data: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene label={LABEL}>
      <Headline text={`${v("accepted")} public sets, plus our own renders.`} />
      <div style={{ marginTop: 36, width: 1550 }}>
        {SOURCES.map(([name, licence, size], i) => (
          <div key={name} style={{ display: "flex", alignItems: "baseline", padding: "11px 0", borderBottom: `2px solid ${c.line}`, opacity: interpolate(frame, [20 + i * 18, 34 + i * 18], [0, 1], clamp) }}>
            <div style={{ ...head, fontSize: 32, width: 420 }}>{name}</div>
            <div style={{ ...mono, fontSize: 26, color: c.muted, width: 300 }}>{licence}</div>
            <div style={{ ...body, fontSize: 30, color: c.ink }}>{size}</div>
          </div>
        ))}
      </div>
      <div style={{ ...body, fontSize: 26, color: c.muted, marginTop: 20, opacity: interpolate(frame, [190, 210], [0, 1], clamp) }}>
        {v("rejected")} other candidates rejected, mostly for non-commercial or by-request terms. Each file is admitted against its publisher's digest.
      </div>
    </Scene>
  );
};

const TYPES: [string, keyof typeof F][] = [
  ["Impersonation", "impersonation"],
  ["Credential", "credential"],
  ["Fake shop", "fakeShop"],
  ["Payment", "payment"],
];

const Collection: React.FC = () => {
  const frame = useCurrentFrame();
  const read = Math.round(interpolate(frame, [15, 75], [0, n(v("collection"))], clamp));
  const adm = Math.round(interpolate(frame, [35, 95], [0, n(v("admitted"))], clamp));
  const max = n(v("impersonation"));
  return (
    <Scene label={LABEL}>
      <div style={{ display: "flex", gap: 120 }}>
        <div>
          <div style={{ ...head, fontSize: 110, color: c.orange }}>{read.toLocaleString("en-US")}</div>
          <div style={{ ...body, fontSize: 32 }}>pages read for build 1.0</div>
        </div>
        <div>
          <div style={{ ...head, fontSize: 110 }}>{adm.toLocaleString("en-US")}</div>
          <div style={{ ...body, fontSize: 32 }}>admitted</div>
        </div>
      </div>
      <div style={{ ...head, fontSize: 40, marginTop: 50 }}>Trusted lures, by type</div>
      <div style={{ marginTop: 18 }}>
        {TYPES.map(([name, key], i) => {
          const p = interpolate(frame, [110 + i * 15, 150 + i * 15], [0, 1], clamp);
          return (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 24, height: 56 }}>
              <div style={{ ...body, fontSize: 30, width: 260, color: c.ink }}>{name}</div>
              <div style={{ height: 34, width: Math.max(6, (1100 * n(v(key)) * p) / max), background: c.orange, borderRadius: 6 }} />
              <div style={{ ...mono, fontSize: 30 }}>{v(key)}</div>
            </div>
          );
        })}
      </div>
    </Scene>
  );
};

const Teacher: React.FC = () => {
  const frame = useCurrentFrame();
  const total = n(v("teacherChecked"));
  const parts: [string, number, string][] = [
    ["agreed", n(v("teacherAgreed")), c.ink],
    ["disputed", n(v("teacherDisputed")), c.orange],
    ["quarantined", n(v("teacherQuarantined")), c["line-strong"]],
  ];
  const p = interpolate(frame, [40, 100], [0, 1], clamp);
  const bar = useIn(220);
  return (
    <Scene label={LABEL}>
      <Headline text="A teacher labels the hardest pages first." sub={`Muse Spark checked ${v("teacherChecked")} South African pages: 346 benign renders, 137 redacted sample lures, 92 public pages hosted in South Africa.`} />
      <div style={{ display: "flex", width: 1500, height: 64, marginTop: 44, borderRadius: 10, overflow: "hidden", background: CARD }}>
        {parts.map(([name, count, colour]) => (
          <div key={name} style={{ width: `${(100 * count * p) / total}%`, background: colour }} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 50, marginTop: 18 }}>
        {parts.map(([name, count]) => (
          <div key={name} style={{ ...body, fontSize: 30, color: c.ink }}>
            <b style={{ ...head, fontSize: 34 }}>{count}</b> {name}
          </div>
        ))}
        <div style={{ ...body, fontSize: 30, color: c.ink }}>
          <b style={{ ...head, fontSize: 34 }}>0</b> failed
        </div>
      </div>
      <div style={{ ...body, fontSize: 30, color: c.muted, marginTop: 16 }}>Disputed pages stay out of training and evaluation.</div>
      <Card style={{ marginTop: 34, width: 1500, borderLeft: `10px solid ${c.orange}`, opacity: bar }}>
        <div style={{ ...head, fontSize: 40 }}>
          The bar: base Muse Spark found <span style={{ color: c["orange-text"] }}>{v("sparkRecall")}</span> of confirmed South African lures.
        </div>
        <div style={{ ...body, fontSize: 28, marginTop: 8 }}>Loupe 1.0 has to beat it.</div>
      </Card>
    </Scene>
  );
};

const BRANDS = ["Bank A", "Courier B", "Retailer C", "Telco D", "Insurer E"];

const Splits: React.FC = () => {
  const frame = useCurrentFrame();
  const chain = interpolate(frame, [200, 260], [0, 1], clamp);
  const fix = interpolate(frame, [340, 380], [0, 1], clamp);
  return (
    <Scene label={LABEL}>
      <Headline text="Nothing crosses the split." sub="No shared page, near-duplicate or brand group between training and evaluation." />
      <div style={{ display: "flex", gap: 30, marginTop: 36 }}>
        <Box title="Training" sub="everything else" style={{ flex: 1 }} />
        <Box title="Evaluation" sub={`target: ${v("evalPages")} pages, at most ${v("evalLureCap")} lures, teacher-agreed only`} on style={{ flex: 1.4 }} />
      </div>
      <div style={{ ...head, fontSize: 36, marginTop: 44, opacity: chain }}>
        The catch: grouping by registrable domain chained 57 brands on weebly.com into one group of {v("chainGroup")} pages.
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 20, opacity: chain }}>
        {BRANDS.map((b, i) => (
          <div key={b} style={{ ...body, fontSize: 26, color: c.ink, background: CARD, border: `2px solid ${fix > 0.5 ? c["line-strong"] : c.orange}`, borderRadius: 999, padding: "8px 20px", whiteSpace: "nowrap", transform: `translateX(${fix * (i - 2) * 16}px)` }}>
            weebly.com / {b}
          </div>
        ))}
      </div>
      <div style={{ ...body, fontSize: 30, color: c.ink, marginTop: 20, opacity: fix }}>
        Fixed: a domain carrying more than two brands now names a site by its full host. Brand names here are placeholders.
      </div>
    </Scene>
  );
};

const Builds: React.FC = () => {
  const one = useIn(20);
  const two = useIn(110);
  const card = (title: string, line: string, why: string, fixText: string, p: number) => (
    <Card style={{ flex: 1, opacity: p, transform: `translateY(${(1 - p) * 30}px)` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ ...head, fontSize: 40 }}>{title}</div>
        <div style={{ ...head, fontSize: 30, color: c["orange-text"], border: `4px solid ${c.orange}`, borderRadius: 10, padding: "2px 14px", transform: "rotate(-4deg)" }}>refused</div>
      </div>
      <div style={{ ...mono, fontSize: 28, marginTop: 14 }}>{line}</div>
      <div style={{ ...body, fontSize: 28, color: c.ink, marginTop: 14, lineHeight: 1.35 }}>{why}</div>
      <div style={{ ...body, fontSize: 26, marginTop: 14, lineHeight: 1.35 }}>
        <b>Fix:</b> {fixText}
      </div>
    </Card>
  );
  return (
    <Scene label={LABEL}>
      <Headline text="Two builds, both refused by their own checks." />
      <div style={{ display: "flex", gap: 30, marginTop: 40 }}>
        {card("Build 1", v("build1"), "Training kept 29 of 100 sample-derived lures: shared hosts chained brands into giant groups.", "site keys by full host; oversized groups train, never held out.", one)}
        {card("Build 2", "1 h 16 min, 2.4 GB", "Evaluation balanced to 997 of 1,000 pages: deduplication dropped teacher-agreed twins.", "keep the teacher-verified twin first (dedupe, capBrands).", two)}
      </div>
    </Scene>
  );
};

const RECIPE: [string, keyof typeof F][] = [
  ["LoRA rank", "loraRank"],
  ["Learning rate", "learningRate"],
  ["Batch size", "batchSize"],
  ["Epochs", "epochs"],
  ["Max sequence", "maxSeqLen"],
  ["Checkpoint every", "checkpoint"],
];

const Recipe: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene label={LABEL}>
      <div style={{ ...head, fontSize: 76 }}>
        The recipe. <Planned />
      </div>
      <div style={{ ...body, fontSize: 36, marginTop: 20 }}>Supervised fine-tuning with a LoRA adapter, streamed through the serverless API.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24, marginTop: 44 }}>
        {RECIPE.map(([name, key], i) => (
          <Card key={name} style={{ opacity: interpolate(frame, [20 + i * 12, 34 + i * 12], [0, 1], clamp) }}>
            <div style={{ ...body, fontSize: 28, color: c.muted }}>{name}</div>
            <div style={{ ...mono, fontSize: 56, fontWeight: 700, marginTop: 6 }}>
              {v(key)}
              {key === "maxSeqLen" ? <span style={{ fontSize: 28 }}> tokens</span> : key === "checkpoint" ? <span style={{ fontSize: 28 }}> steps</span> : null}
            </div>
          </Card>
        ))}
      </div>
    </Scene>
  );
};

const GATES = [
  "Trained on more lines than the version before",
  "Measured on the same held-out file",
  "Lure recall no lower, overall and on the South African slice",
  "False-alarm rate no higher, overall and on the South African slice",
];

const Gate: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene label={LABEL}>
      <div style={{ ...head, fontSize: 76 }}>
        A version ships only if it is better. <Planned />
      </div>
      <div style={{ ...body, fontSize: 36, marginTop: 20 }}>
        <span style={mono}>version-gate.py</span> prints promote, or keep the previous version and the first rule broken.
      </div>
      <div style={{ marginTop: 44 }}>
        {GATES.map((g, i) => {
          const on = frame > 60 + i * 50;
          return (
            <div key={g} style={{ display: "flex", alignItems: "center", gap: 26, height: 86 }}>
              <div style={{ width: 52, height: 52, border: `3px solid ${on ? c.orange : c["control-border"]}`, borderRadius: 6, display: "grid", placeItems: "center" }}>{on ? <Tick size={36} /> : null}</div>
              <div style={{ ...body, fontSize: 38, color: on ? c.ink : c.muted }}>{g}</div>
            </div>
          );
        })}
      </div>
    </Scene>
  );
};

const Serving: React.FC = () => {
  const a = useIn(20);
  return (
    <Scene label={LABEL}>
      <div style={{ ...head, fontSize: 76 }}>
        Serving. <Planned />
      </div>
      <Card style={{ marginTop: 44, width: 1300, opacity: a }}>
        <div style={{ ...head, fontSize: 44 }}>{v("gpu")}</div>
        <div style={{ ...body, fontSize: 34, color: c.ink, marginTop: 14 }}>0 to 1 replicas; scales to zero after {v("scaleToZero")} idle.</div>
        <div style={{ ...body, fontSize: 30, marginTop: 14 }}>
          Versions are never reused: <span style={mono}>{v("versioning")}</span>, then 1-1, 1-2. The model card is built only from run records.
        </div>
      </Card>
    </Scene>
  );
};

const CREDITS = [
  "PhreshPhish, CC BY 4.0",
  "CompPhish, Richa Goenka (MANIT), CC BY 4.0",
  "Ariyadasa, Fernando and Fernando (2021), CC BY 4.0",
  "7 Days Later, CC BY 4.0",
  "Kempf phishing website HTML, CC BY-SA 3.0",
  "Look for Mallory, Apache 2.0",
  "ScamFerret, GPL-3.0",
  "Majestic Million, Majestic, CC BY 3.0",
];

const Credits: React.FC = () => (
  <Scene label={LABEL}>
    <div style={{ ...head, fontSize: 60 }}>Data credits</div>
    <div style={{ columns: 2, columnGap: 80, marginTop: 36 }}>
      {CREDITS.map((line) => (
        <div key={line} style={{ ...body, fontSize: 30, color: c.ink, padding: "10px 0", breakInside: "avoid" }}>
          {line}
        </div>
      ))}
    </div>
    <div style={{ ...body, fontSize: 26, color: c.muted, marginTop: 24 }}>Full sources, versions and licence links: docs/glimmer/sources.md.</div>
  </Scene>
);

export const LoupeV1: React.FC = () => {
  const parts = [
    <TitleScene key="t" line="Loupe 1.0" sub={`Training a page screener on ${v("baseModel")}.`} />,
    <Job key="j" />,
    <BaseModel key="b" />,
    <Data key="d" />,
    <Collection key="c" />,
    <Teacher key="te" />,
    <Splits key="s" />,
    <Builds key="bu" />,
    <Recipe key="r" />,
    <Gate key="g" />,
    <Serving key="se" />,
    <Credits key="cr" />,
    <CloseScene key="x" lines={["github.com/rizonetech/isitlegit", "Loupe 1.0 results follow in its model card"]} />,
  ];
  const { frames, clips } = timing();
  const last = parts.length - 1;
  const voiced = frames.reduce((a, f) => a + f, 0);
  return (
    <>
      <Backdrop />
      <Series>
        <Series.Sequence durationInFrames={INTRO}>
          <LogoReveal theme="dark" />
        </Series.Sequence>
        {parts.map((part, i) => (
          <Series.Sequence key={part.key} durationInFrames={frames[i]}>
            {part}
            {i === 0 ? <Sfx name="swell" /> : i < last ? <Sfx name="whoosh" /> : null}
            <Voice clip={clips?.[i]} />
          </Series.Sequence>
        ))}
        <Series.Sequence durationInFrames={END_CREDITS}>
          <EndCredits />
        </Series.Sequence>
      </Series>
      <Sequence from={INTRO} layout="none">
        <MusicBed name="bed" frames={voiced + END_CREDITS} />
      </Sequence>
    </>
  );
};
