// The 3-minute demo video (D09 T02 §3 and §4; docs/specs/2026-10-31-demo-video-design.md), built from captures of the
// live service (media/capture/), the operator's generated shots and plates, and narration in Brian's voice
// (data/narration/demo.json). Every clip of the product is the live app as the rig recorded it; every time on screen is
// measured from the capture's own marks; every figure is a pinned fact or a sourced figure from the spec. A beat whose
// feature is not live yet (the invoice hero, the closed loop, the walkthrough) is left out, never mocked.
import type React from "react";
import { AbsoluteFill, Freeze, Img, interpolate, Loop, OffthreadVideo, Sequence, Series, useCurrentFrame } from "remotion";
import { CAPTURE, GENERATED } from "../data/demo-capture";
import loupe from "../../data/loupe-facts.json";
import { body, c, CloseScene, head, mono, MetaBadge } from "../brand";
import { Sfx, MusicBed } from "../kit/sound";
import { Voice, voicedFrames, voiceFor, voiceSpans } from "../kit/voice";

const FPS = 30;
const s = (seconds: number) => Math.max(1, Math.round(seconds * FPS));
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const fact = (key: string): string => (loupe.facts as Record<string, { value: string }>)[key].value;

type Box = { x: number; y: number; width: number; height: number };
type Beat = { src: string; caseId: string | null; marks: Record<string, number>; boxes: Record<string, Box | null> };
const beat = (name: string): Beat | null => ((CAPTURE?.beats as Record<string, Beat> | undefined)?.[name] ?? null);

// The browser window the footage sits in: the capture is 1920 x 1080, shown at FRAME_W wide under a title bar.
const FRAME_W = 1600;
const SCALE = FRAME_W / 1920;
const FRAME_H = Math.round(1080 * SCALE);
const BAR = 44;

const Window: React.FC<{ src: string; startAt: number }> = ({ src, startAt }) => (
  <div style={{ position: "absolute", left: (1920 - FRAME_W) / 2, top: (1080 - FRAME_H - BAR) / 2 + 20, width: FRAME_W, borderRadius: 18, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.55)", border: `2px solid ${c.line}` }}>
    <div style={{ height: BAR, background: c.surface, display: "flex", alignItems: "center", gap: 10, padding: "0 18px" }}>
      {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
        <div key={dot} style={{ width: 13, height: 13, borderRadius: 7, background: dot }} />
      ))}
      <div style={{ ...mono, fontSize: 18, color: c.muted, marginLeft: 18 }}>app.isitlegit.co.za</div>
    </div>
    <div style={{ width: FRAME_W, height: FRAME_H, overflow: "hidden", position: "relative", background: "#fff" }}>
      <div style={{ width: 1920, height: 1080, transformOrigin: "0 0", transform: `scale(${SCALE})` }}>
        <OffthreadVideo src={src} startFrom={s(startAt)} muted style={{ width: 1920, height: 1080 }} />
      </div>
    </div>
  </div>
);

/** The clip plays, then holds its last frame for as long as the scene runs on. */
const Held: React.FC<{ children: React.ReactNode; clipFrames: number }> = ({ children, clipFrames }) => (
  <Freeze frame={Math.min(useCurrentFrame(), clipFrames - 1)}>{children}</Freeze>
);

type Caption = { at: number; hold: number; text: string };

const Captions: React.FC<{ startAt: number; items: Caption[] }> = ({ startAt, items }) => {
  const t = startAt + useCurrentFrame() / FPS;
  return (
    <>
      {items.map((cap) => {
        const o = Math.min(interpolate(t, [cap.at, cap.at + 0.3], [0, 1], clamp), interpolate(t, [cap.at + cap.hold - 0.3, cap.at + cap.hold], [1, 0], clamp));
        return o > 0 ? (
          <div key={cap.text} style={{ position: "absolute", left: 0, right: 0, bottom: 34, display: "flex", justifyContent: "center", opacity: o }}>
            <div style={{ ...head, fontSize: 34, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>{cap.text}</div>
          </div>
        ) : null;
      })}
    </>
  );
};

const fade = (frame: number, total: number, edge = 18) => interpolate(frame, [0, edge, total - edge, total], [0, 1, 1, 0], clamp);

/** A generated plate behind a scene, dimmed so the text on top stays the brightest thing. */
const Plate: React.FC<{ src: string | null; dim?: number; side?: "left" | "right" }> = ({ src, dim = 0.35, side }) => {
  const frame = useCurrentFrame();
  if (!src) return null;
  return (
    <AbsoluteFill>
      <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${1 + frame / 6000})` }} />
      <AbsoluteFill style={{ background: `rgba(7,6,9,${dim})` }} />
      {side ? <AbsoluteFill style={{ background: `linear-gradient(${side === "left" ? 90 : 270}deg, rgba(7,6,9,0.85), transparent 60%)` }} /> : null}
    </AbsoluteFill>
  );
};

const Source: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ ...body, position: "absolute", left: 110, right: 110, bottom: 56, fontSize: 24, color: c.muted }}>{text}</div>
);

// Scene 1: the cold open, four generated shots and the line.
const SHOTS: (keyof typeof GENERATED)[] = ["road", "attacker", "inbox", "hover"];

const ColdOpen: React.FC<{ frames: number }> = ({ frames }) => {
  const per = Math.floor(frames / SHOTS.length);
  const frame = useCurrentFrame();
  const line = interpolate(frame, [frames - per + 20, frames - per + 40], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Series>
        {SHOTS.map((name, i) => (
          <Series.Sequence key={name} durationInFrames={i === SHOTS.length - 1 ? frames - per * (SHOTS.length - 1) : per}>
            <ShotClip src={GENERATED[name]} />
          </Series.Sequence>
        ))}
      </Series>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 80% 70% at 50% 50%, transparent 50%, rgba(0,0,0,0.6))" }} />
      <Sequence from={Math.max(0, frames - per + 20)} layout="none">
        <Sfx name="hit" />
      </Sequence>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 150, display: "flex", justifyContent: "center", opacity: line }}>
        <div style={{ ...head, fontSize: 64, color: "#fff", textShadow: "0 4px 30px rgba(0,0,0,0.8)" }}>The bank details aren't theirs.</div>
      </div>
    </AbsoluteFill>
  );
};

const ShotClip: React.FC<{ src: string | null }> = ({ src }) => {
  const frame = useCurrentFrame();
  return src ? <OffthreadVideo src={src} muted style={{ width: 1920, height: 1080, objectFit: "cover", opacity: interpolate(frame, [0, 8], [0, 1], clamp) }} /> : null;
};

// Scene 2: why filters miss it, and the size of it in South Africa (SABRIC Annual Crime Statistics 2025, p. 7: all digital banking fraud, not phishing alone).
const LOSSES = [
  { year: "2023", rand: 1.09 },
  { year: "2024", rand: 1.86 },
  { year: "2025", rand: 2.41 },
];

const FiltersScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const o = fade(frame, frames);
  const top = 2.41;
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <Plate src={GENERATED.plateA} dim={0.2} side="left" />
      <div style={{ position: "absolute", left: 110, top: 110, width: 1000 }}>
        <div style={{ ...head, fontSize: 76, lineHeight: 1.05 }}>The email is real.</div>
        <div style={{ ...head, fontSize: 76, lineHeight: 1.05, color: c.orange }}>So the filter passes it.</div>
        <div style={{ ...body, fontSize: 32, marginTop: 24, maxWidth: 820 }}>Sent from your supplier's own mailbox, so SPF, DKIM and DMARC all pass.</div>
      </div>
      <div style={{ ...body, position: "absolute", left: 110, bottom: 590, width: 760, fontSize: 28, opacity: interpolate(frame, [50, 75], [0, 1], clamp) }}>Digital banking fraud losses in South Africa, every channel.</div>
      <div style={{ position: "absolute", left: 110, bottom: 140, display: "flex", alignItems: "flex-end", gap: 36 }}>
        {LOSSES.map((l, i) => {
          const grow = interpolate(frame, [60 + i * 14, 100 + i * 14], [0, 1], clamp);
          return (
            <div key={l.year} style={{ width: 170, textAlign: "center" }}>
              <div style={{ ...head, fontSize: 38, color: i === 2 ? c.orange : c.ink, opacity: grow }}>R{l.rand.toFixed(2)} bn</div>
              <div style={{ height: (l.rand / top) * 330 * grow, background: i === 2 ? c.orange : "rgba(255,255,255,0.28)", borderRadius: "8px 8px 0 0", marginTop: 8 }} />
              <div style={{ ...body, fontSize: 28, marginTop: 8 }}>{l.year}</div>
            </div>
          );
        })}
      </div>
      <Source text="Source: SABRIC Annual Crime Statistics 2025, p. 7. All digital banking fraud, not phishing alone." />
    </AbsoluteFill>
  );
};

// Scene 3: our own client's month, anonymised totals only (operator's authority, 2026-10-31).
const ClientScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const count = Math.round(interpolate(frame, [20, 80], [0, 533], clamp));
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames), alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <div style={{ ...head, fontSize: 280, lineHeight: 1, color: c.orange }}>{count}</div>
      <div style={{ ...head, fontSize: 64, marginTop: 6 }}>phishing emails in 30 days</div>
      <div style={{ ...body, fontSize: 32, marginTop: 28 }}>One Rizonetech client, a small South African business, 27 Sep to 26 Oct 2026.</div>
      <div style={{ ...body, fontSize: 32, marginTop: 8 }}>Rated by Microsoft Defender, which stopped them all.</div>
      <div style={{ ...head, fontSize: 40, marginTop: 44, opacity: interpolate(frame, [150, 180], [0, 1], clamp) }}>The ones no filter can catch come from someone you trust.</div>
    </AbsoluteFill>
  );
};

// Scene 4: the live report.
const ReportScene: React.FC<{ frames: number }> = ({ frames }) => {
  const up = beat("upload-and-report");
  const frame = useCurrentFrame();
  if (!up) return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}><div style={{ ...head, fontSize: 60 }}>No capture yet: run pnpm capture:demo</div></AbsoluteFill>;
  const m = up.marks;
  const from = Math.max(0, m.uploadPage - 0.5);
  const to = (m.scrolled ?? m.finished + 2) + 0.5;
  const took = (m.finished - m.reportOpened).toFixed(1);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <Held clipFrames={s(to - from)}>
        <Window src={up.src} startAt={from} />
      </Held>
      <Captions
        startAt={from}
        items={[
          { at: m.uploadPage, hold: Math.max(1.5, m.fileChosen - m.uploadPage), text: "A saved email, uploaded" },
          { at: m.reportOpened, hold: Math.max(1.5, m.finished - m.reportOpened), text: "The report fills in live" },
          { at: m.finished, hold: 3, text: `Checked in ${took} s on the live service` },
          { at: m.scrolled ?? m.finished + 3.5, hold: 4, text: "Every finding shows its evidence" },
        ]}
      />
    </AbsoluteFill>
  );
};

// Scene 5: why verifying is the answer: Hawarden v Edward Nathan Sonnenbergs, as its final outcome ([2024] ZASCA 90).
const CourtScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <Plate src={GENERATED.plateB} dim={0.25} side="right" />
      <div style={{ position: "absolute", right: 110, top: 150, width: 780 }}>
        <div style={{ ...body, fontSize: 28, color: c.orange, letterSpacing: 2, textTransform: "uppercase" }}>Hawarden v Edward Nathan Sonnenbergs</div>
        <div style={{ ...head, fontSize: 84, lineHeight: 1.05, marginTop: 14 }}>R5.5 million paid to a fraudster.</div>
        <div style={{ ...body, fontSize: 32, marginTop: 28 }}>A hacked inbox and a one-letter lookalike address. The High Court ordered the law firm to pay (2023). The Supreme Court of Appeal overturned it (10 June 2024).</div>
        <div style={{ ...head, fontSize: 40, marginTop: 36, opacity: interpolate(frame, [180, 215], [0, 1], clamp), borderLeft: `6px solid ${c.orange}`, paddingLeft: 24 }}>The buyer could reasonably have avoided the risk by verifying the account details.</div>
      </div>
      <Source text="Source: [2024] ZASCA 90, Supreme Court of Appeal of South Africa, 10 June 2024." />
    </AbsoluteFill>
  );
};

// Scene 6: proof, the Loupe model card from the pinned facts (data/loupe-facts.json).
const ProofScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const tiles = [
    { big: fact("lureRecallOf"), small: "caught on held-out pages" },
    { big: fact("falseAlarmsOf"), small: "false alarms on benign pages" },
    { big: fact("latency"), small: "median time per page" },
    { big: fact("trainLines"), small: `training lines, ${fact("trainTime")} of training` },
  ];
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", opacity: interpolate(frame, [8, 26, 80, 100], [0, 1, 1, 0], clamp) }}>
        <div style={{ ...head, fontSize: 76 }}>We hold our own models</div>
        <div style={{ ...head, fontSize: 76, color: c.orange }}>to the same standard.</div>
        <div style={{ ...body, fontSize: 34, marginTop: 20 }}>Verify, don't assume.</div>
      </AbsoluteFill>
      <AbsoluteFill style={{ padding: "100px 150px", opacity: interpolate(frame, [90, 115], [0, 1], clamp) }}>
      <MetaBadge text={fact("baseModel")} />
      <div style={{ ...head, fontSize: 84 }}>Loupe 1.0</div>
      <div style={{ ...body, fontSize: 34, marginTop: 6 }}>Our fine-tune of {fact("baseModel")}, trained on our own data, deployed on its own GPU.</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, marginTop: 44 }}>
        {tiles.map((t, i) => (
          <div key={t.small} style={{ background: c.surface, border: `2px solid ${c.line}`, borderRadius: 20, padding: "26px 34px", opacity: interpolate(frame, [120 + i * 24, 140 + i * 24], [0, 1], clamp) }}>
            <div style={{ ...head, fontSize: 64, color: i === 0 ? c.orange : c.ink }}>{t.big}</div>
            <div style={{ ...body, fontSize: 28, marginTop: 4 }}>{t.small}</div>
          </div>
        ))}
      </div>
      <div style={{ ...body, fontSize: 30, marginTop: 34, opacity: interpolate(frame, [440, 480], [0, 1], clamp) }}>
        Its weak spot, shown too: it names the lure type right only {`${(Number(fact("lureTypeRight")) * 100).toFixed(1)}%`} of the time.
      </div>
      </AbsoluteFill>
      {[0, 1, 2, 3].map((i) => (
        <Sequence key={i} from={120 + i * 24} layout="none">
          <Sfx name="tick" />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

// Scene 7: the close.
const CloseCard: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const stamp = CAPTURE ? `Captured live on ${CAPTURE.capturedAt.slice(0, 10)}, commit ${(CAPTURE.liveCommit ?? "unknown").slice(0, 8)}` : "No capture yet";
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <Plate src={GENERATED.plateC} dim={0.3} />
      <CloseScene lines={["Your filter protects your inbox.", "We protect you from everyone else's.", "app.isitlegit.co.za", stamp]} />
    </AbsoluteFill>
  );
};

// Each scene's shortest length in seconds; the narration stretches it (src/kit/voice.tsx).
const SCENES = [12, 18, 14, 28, 14, 26, 12];

export const demoFrames = () => {
  const clips = voiceFor("demo", SCENES.length);
  return voicedFrames(SCENES, clips).reduce((a, f) => a + f, 0);
};

export const Demo: React.FC = () => {
  const clips = voiceFor("demo", SCENES.length);
  const frames = voicedFrames(SCENES, clips);
  const nodes = [
    <ColdOpen key="cold" frames={frames[0]} />,
    <FiltersScene key="filters" frames={frames[1]} />,
    <ClientScene key="client" frames={frames[2]} />,
    <ReportScene key="report" frames={frames[3]} />,
    <CourtScene key="court" frames={frames[4]} />,
    <ProofScene key="proof" frames={frames[5]} />,
    <CloseCard key="close" frames={frames[6]} />,
  ];
  const total = frames.reduce((a, f) => a + f, 0);
  return (
    <AbsoluteFill style={{ background: "#0B0A0D" }}>
      {GENERATED.loop ? (
        <AbsoluteFill>
          <Loop durationInFrames={s(8)}>
            <OffthreadVideo src={GENERATED.loop} muted style={{ width: 1920, height: 1080, objectFit: "cover" }} />
          </Loop>
          <AbsoluteFill style={{ background: "rgba(11,10,13,0.45)" }} />
        </AbsoluteFill>
      ) : null}
      <Series>
        {nodes.map((node, i) => (
          <Series.Sequence key={i} durationInFrames={frames[i]}>
            <Sequence>{node}</Sequence>
            <Voice clip={clips?.[i]} />
            {i === 0 ? null : <Sfx name={i === frames.length - 1 ? "swell" : "whoosh"} />}
          </Series.Sequence>
        ))}
      </Series>
      <MusicBed name="demo-bed" frames={total} voice={voiceSpans(frames, clips)} />
    </AbsoluteFill>
  );
};
