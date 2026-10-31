// The 3-minute demo video (D09 T02 §3 and §4; docs/specs/2026-10-31-demo-video-design.md), built from captures of the
// live service (media/capture/), the operator's generated shots and plates, and narration in Brian's voice
// (data/narration/demo.json). Every clip of the product is the live app as the rig recorded it; every time on screen is
// measured from the capture's own marks; every figure is a pinned fact or a sourced figure from the spec. A beat whose
// feature is not live yet (the invoice hero, the closed loop, the walkthrough) is left out, never mocked.
import type React from "react";
import { AbsoluteFill, Freeze, Img, interpolate, Loop, OffthreadVideo, Sequence, Series, useCurrentFrame } from "remotion";
import { CAPTURE, GENERATED } from "../data/demo-capture";
import loupe from "../../data/loupe-facts.json";
import tech from "../../data/tech-facts.json";
import { body, CARD, c, CloseScene, head, mono, MetaBadge } from "../brand";
import { Sfx, MusicBed } from "../kit/sound";
import { Voice, voicedFrames, voiceFor, voiceSpans } from "../kit/voice";

const FPS = 30;
const s = (seconds: number) => Math.max(1, Math.round(seconds * FPS));
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const fact = (key: string): string =>
  ((loupe.facts as Record<string, { value: string }>)[key] ?? (tech.facts as Record<string, { value: string }>)[key]).value;

type Box = { x: number; y: number; width: number; height: number };
type Beat = { src: string; caseId: string | null; marks: Record<string, number>; boxes: Record<string, Box | null> };
const beat = (name: string): Beat | null => ((CAPTURE?.beats as Record<string, Beat> | undefined)?.[name] ?? null);

// The browser window the footage sits in: the capture is 1920 x 1080, shown at FRAME_W wide under a title bar.
const FRAME_W = 1600;
const SCALE = FRAME_W / 1920;
const FRAME_H = Math.round(1080 * SCALE);
const BAR = 44;

const Window: React.FC<{ src: string; startAt: number; path?: string; zoomFrom?: number; zoomTo?: number; focusY?: number }> = ({
  src,
  startAt,
  path = "app.isitlegit.co.za",
  zoomFrom,
  zoomTo,
  focusY = 540,
}) => {
  const frame = useCurrentFrame();
  const z =
    zoomFrom !== undefined && zoomTo !== undefined
      ? interpolate(frame, [s(zoomFrom), s(zoomFrom + 1.2), s(zoomTo - 1.0), s(zoomTo)], [1, 1.22, 1.22, 1], clamp)
      : 1;
  return (
    <div style={{ position: "absolute", left: (1920 - FRAME_W) / 2, top: (1080 - FRAME_H - BAR) / 2 + 12, width: FRAME_W, borderRadius: 18, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.55)", border: `2px solid ${c.line}` }}>
      <div style={{ height: BAR, background: c.surface, display: "flex", alignItems: "center", gap: 10, padding: "0 18px" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
          <div key={dot} style={{ width: 13, height: 13, borderRadius: 7, background: dot }} />
        ))}
        <div style={{ ...mono, fontSize: 18, color: c.muted, marginLeft: 18 }}>{path}</div>
      </div>
      <div style={{ width: FRAME_W, height: FRAME_H, overflow: "hidden", position: "relative", background: "#fff" }}>
        <div
          style={{
            width: 1920,
            height: 1080,
            transformOrigin: `960px ${focusY}px`,
            transform: `scale(${SCALE * z})`,
          }}
        >
          <OffthreadVideo src={src} startFrom={s(startAt)} muted style={{ width: 1920, height: 1080 }} />
        </div>
      </div>
    </div>
  );
};

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
          <div key={cap.text} style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center", opacity: o }}>
            <div style={{ ...head, fontSize: 32, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px", boxShadow: "0 10px 30px rgba(0,0,0,0.45)" }}>{cap.text}</div>
          </div>
        ) : null;
      })}
    </>
  );
};

/** Thin trace strip along the foot of every live beat (docs/specs/2026-10-31-demo-video-design.md, "Trace strip"). */
const TraceStrip: React.FC<{ items: { label: string; value: string }[] }> = ({ items }) => (
  <div
    style={{
      position: "absolute",
      left: (1920 - FRAME_W) / 2,
      width: FRAME_W,
      bottom: 18,
      height: 42,
      background: `${CARD}ee`,
      border: `1px solid ${c.line}`,
      borderRadius: 999,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 26px",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 10, height: 10, borderRadius: 5, background: c.orange }} />
      <span style={{ ...mono, fontSize: 18, color: c.orange, fontWeight: 700 }}>LIVE TRACE</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
      {items.map((item) => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ ...body, fontSize: 18, color: c.muted }}>{item.label}:</span>
          <span style={{ ...mono, fontSize: 18, color: c.ink, fontWeight: 600 }}>{item.value}</span>
        </div>
      ))}
    </div>
  </div>
);

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

// Scene 2: why filters miss it (SABRIC 2025, p. 7) + our own client's 533 phishing emails in 30 days.
const LOSSES = [
  { year: "2023", rand: 1.09 },
  { year: "2024", rand: 1.86 },
  { year: "2025", rand: 2.41 },
];

const FiltersAndClientScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const o = fade(frame, frames);
  const top = 2.41;
  const split = Math.round(frames * 0.52);
  const leftOpacity = interpolate(frame, [0, 16, split - 16, split], [0, 1, 1, 0], clamp);
  const rightOpacity = interpolate(frame, [split - 8, split + 14], [0, 1], clamp);
  const count = Math.round(interpolate(frame, [split + 10, split + 65], [0, 533], clamp));
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <Plate src={GENERATED.plateA} dim={0.25} side="left" />
      <AbsoluteFill style={{ opacity: leftOpacity }}>
        <div style={{ position: "absolute", left: 110, top: 110, width: 1000 }}>
          <div style={{ ...head, fontSize: 76, lineHeight: 1.05 }}>The email is real.</div>
          <div style={{ ...head, fontSize: 76, lineHeight: 1.05, color: c.orange }}>So the filter passes it.</div>
          <div style={{ ...body, fontSize: 32, marginTop: 24, maxWidth: 820 }}>Sent from your supplier's own mailbox, so SPF, DKIM and DMARC all pass.</div>
        </div>
        <div style={{ ...body, position: "absolute", left: 110, bottom: 590, width: 760, fontSize: 28, opacity: interpolate(frame, [35, 55], [0, 1], clamp) }}>Digital banking fraud losses in South Africa, every channel.</div>
        <div style={{ position: "absolute", left: 110, bottom: 140, display: "flex", alignItems: "flex-end", gap: 36 }}>
          {LOSSES.map((l, i) => {
            const grow = interpolate(frame, [45 + i * 12, 80 + i * 12], [0, 1], clamp);
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
      <AbsoluteFill style={{ opacity: rightOpacity, alignItems: "center", justifyContent: "center", textAlign: "center", background: "rgba(11,10,13,0.72)" }}>
        <div style={{ ...head, fontSize: 250, lineHeight: 1, color: c.orange }}>{count}</div>
        <div style={{ ...head, fontSize: 60, marginTop: 6 }}>phishing emails in 30 days</div>
        <div style={{ ...body, fontSize: 30, marginTop: 24 }}>One Rizonetech client, a small South African business, 27 Sep to 26 Oct 2026.</div>
        <div style={{ ...body, fontSize: 30, marginTop: 8 }}>Rated by Microsoft Defender, which stopped them all.</div>
        <div style={{ ...head, fontSize: 42, marginTop: 40, color: c.ink, opacity: interpolate(frame, [split + 90, split + 115], [0, 1], clamp) }}>
          The ones no filter can catch come from someone you trust.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 3: the live report, with zoom into the extracted hidden AI instructions and deceptive link evidence cards.
const ReportScene: React.FC<{ frames: number }> = ({ frames }) => {
  const up = beat("upload-and-report");
  const frame = useCurrentFrame();
  if (!up) return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}><div style={{ ...head, fontSize: 60 }}>No capture yet: run pnpm capture:demo</div></AbsoluteFill>;
  const m = up.marks;
  const from = Math.max(0, m.uploadPage - 0.5);
  const to = (m.scrolled ?? m.finished + 2) + 0.5;
  const took = (m.finished - m.reportOpened).toFixed(1);
  const evFocusY = up.boxes.evidence ? Math.min(820, up.boxes.evidence.y + 120) : 680;
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <Held clipFrames={s(to - from)}>
        <Window
          src={up.src}
          startAt={from}
          path={`app.isitlegit.co.za/r/${up.caseId ?? ""}`}
          zoomFrom={Math.max(1, m.finished - from + 0.8)}
          zoomTo={Math.max(3, (m.scrolled ?? m.finished + 4) - from + 2)}
          focusY={evFocusY}
        />
      </Held>
      <Captions
        startAt={from}
        items={[
          { at: m.uploadPage, hold: Math.max(1.5, m.fileChosen - m.uploadPage), text: "A saved email, uploaded to /upload" },
          { at: m.reportOpened, hold: Math.max(1.5, m.finished - m.reportOpened), text: `Live report polling ${fact("reportPoll")}` },
          { at: m.finished, hold: 3.2, text: `E4 & E5: Hidden text written to steer an AI extracted (${took} s)` },
          { at: m.scrolled ?? m.finished + 3.5, hold: 4.5, text: "E3 & E6: Reply-To mismatch and deceptive link target cited" },
        ]}
      />
      <TraceStrip
        items={[
          { label: "Case", value: (up.caseId ?? "").slice(0, 12) },
          { label: "Workflow", value: fact("stepNames") },
          { label: "Live check time", value: `${took} s` },
          { label: "Worker commit", value: (CAPTURE?.liveCommit ?? "").slice(0, 8) },
        ]}
      />
    </AbsoluteFill>
  );
};

// Scene 4: Protected identity (/protect), Cases console (/cases), and the Hawarden v ENS verification ruling.
const ProtectAndCasesScene: React.FC<{ frames: number }> = ({ frames }) => {
  const prot = beat("protect");
  const cases = beat("cases");
  const frame = useCurrentFrame();
  const t1 = Math.round(frames * 0.42);
  const t2 = Math.round(frames * 0.68);
  const p1 = interpolate(frame, [0, 14, t1 - 12, t1], [0, 1, 1, 0], clamp);
  const p2 = interpolate(frame, [t1 - 6, t1 + 12, t2 - 12, t2], [0, 1, 1, 0], clamp);
  const p3 = interpolate(frame, [t2 - 6, t2 + 14], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {prot ? (
        <AbsoluteFill style={{ opacity: p1 }}>
          <Held clipFrames={s((prot.marks.scrolled ?? 5.5) + 1.5)}>
            <Window src={prot.src} startAt={0.5} path="app.isitlegit.co.za/protect" />
          </Held>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
            <div style={{ ...head, fontSize: 32, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
              Fynbos Freight's registered names, protea logo (for SAM 3.1) and bank ledger on /protect
            </div>
          </div>
          <TraceStrip
            items={[
              { label: "Organisation", value: "Fynbos Freight (Pty) Ltd" },
              { label: "Logo check", value: "SAM 3.1 (sam-3.1)" },
              { label: "Bank privacy", value: "Match or no match only" },
            ]}
          />
        </AbsoluteFill>
      ) : null}
      {cases ? (
        <AbsoluteFill style={{ opacity: p2 }}>
          <Held clipFrames={s((cases.marks.loaded ?? 4.5) + 1)}>
            <Window src={cases.src} startAt={0.5} path="app.isitlegit.co.za/cases" />
          </Held>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
            <div style={{ ...head, fontSize: 32, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
              Every check indexed and searchable in the member's Cases console
            </div>
          </div>
          <TraceStrip
            items={[
              { label: "Console", value: "/cases" },
              { label: "Tenant isolation", value: fact("orgScope") },
              { label: "Raw retention", value: `R2 ${fact("r2Retention")}` },
            ]}
          />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill style={{ opacity: p3 }}>
        <Plate src={GENERATED.plateB} dim={0.25} side="right" />
        <div style={{ position: "absolute", right: 110, top: 150, width: 820 }}>
          <div style={{ ...body, fontSize: 28, color: c.orange, letterSpacing: 2, textTransform: "uppercase" }}>Hawarden v Edward Nathan Sonnenbergs</div>
          <div style={{ ...head, fontSize: 80, lineHeight: 1.05, marginTop: 14 }}>R5.5 million paid to a fraudster.</div>
          <div style={{ ...body, fontSize: 30, marginTop: 24 }}>
            A hacked inbox and a one-letter lookalike address. The High Court ordered the law firm to pay (2023). The Supreme Court of Appeal overturned it (10 June 2024).
          </div>
          <div style={{ ...head, fontSize: 38, marginTop: 32, borderLeft: `6px solid ${c.orange}`, paddingLeft: 24 }}>
            The buyer could reasonably have avoided the risk by verifying the account details.
          </div>
        </div>
        <Source text="Source: [2024] ZASCA 90, Supreme Court of Appeal of South Africa, 10 June 2024." />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 5: Technical depth: the 5 Meta models, the frozen safety contract, and the in-Worker voice decoder benchmark (D01 T03 §9, D09 T02 §3 and §4).
const MODELS = [
  { name: "Muse Spark", id: fact("sparkModel"), job: "Verdict reasoning & evidence citation inside delimited untrusted blocks" },
  { name: "Loupe 1.0", id: fact("baseModel"), job: "Fine-tuned page screener on 52,019 lines with Spark failover" },
  { name: "Muse Wonder", id: fact("wonderModel"), job: `Contained browser walkthrough (${fact("wonderLimits")}, ${fact("wonderCanary")})` },
  { name: "SAM 3.1", id: fact("samModel"), job: "Visual logo and stamp segmentation against registered brand marks" },
  { name: "Muse Voice", id: fact("voiceModel"), job: `Voice-note transcription after in-Worker ${fact("voiceWav")} decode` },
];

const BENCH_ROWS = [
  { label: "Voice note (3 s, Ogg Opus)", ours: fact("benchNoteOurs"), ffmpeg: fact("benchNoteFfmpeg") },
  { label: "Long recording (25 min, Ogg Opus)", ours: fact("benchLongOurs"), ffmpeg: fact("benchLongFfmpeg") },
  { label: "Upload-sized (25 MiB, WAV 48 kHz)", ours: fact("benchWavOurs"), ffmpeg: fact("benchWavFfmpeg") },
  { label: "Damaged stream (Ogg Opus)", ours: fact("benchDamagedOurs"), ffmpeg: fact("benchDamagedFfmpeg") },
];

const ArchitectureAndVoiceScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const split = Math.round(frames * 0.54);
  const archO = interpolate(frame, [0, 14, split - 14, split], [0, 1, 1, 0], clamp);
  const benchO = interpolate(frame, [split - 6, split + 14], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <AbsoluteFill style={{ padding: "88px 130px", opacity: archO }}>
        <MetaBadge text="5 Models · Standard API · store: false" />
        <div style={{ ...head, fontSize: 68 }}>Five Meta models. One safety contract.</div>
        <div style={{ ...body, fontSize: 30, marginTop: 8 }}>
          Every call runs with <span style={{ ...mono, color: c.orange }}>{fact("storeFalse")}</span> and <span style={{ ...mono, color: c.orange }}>{fact("standardOnly")}</span>; critical evidence sets a deterministic floor no model can lower.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 32 }}>
          {MODELS.map((m, i) => {
            const p = interpolate(frame, [16 + i * 12, 32 + i * 12], [0, 1], clamp);
            return (
              <div
                key={m.name}
                style={{
                  background: c.surface,
                  border: `2px solid ${i === 0 ? c.orange : c.line}`,
                  borderRadius: 16,
                  padding: "16px 28px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  opacity: p,
                  transform: `translateX(${(1 - p) * 24}px)`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 18, minWidth: 420 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 6, background: c.orange }} />
                  <span style={{ ...head, fontSize: 32 }}>{m.name}</span>
                  <span style={{ ...mono, fontSize: 20, color: c.muted }}>{m.id}</span>
                </div>
                <div style={{ ...body, fontSize: 25, color: c["ink-2"] }}>{m.job}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ padding: "88px 130px", opacity: benchO }}>
        <MetaBadge text={fact("voiceModel")} />
        <div style={{ ...head, fontSize: 66 }}>In-Worker Voice Decoder vs FFmpeg</div>
        <div style={{ ...body, fontSize: 28, marginTop: 10, maxWidth: 1550 }}>
          For voice-note intake inside a Worker, our WebAssembly SIMD decoder finishes faster than calling FFmpeg on every input we benchmarked, decoding Opus straight to 16 kHz in-process with {fact("benchStopband")} alias suppression.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 34 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1.2fr", padding: "0 28px", ...mono, fontSize: 22, color: c.muted }}>
            <div>BENCHMARK INPUT</div>
            <div style={{ color: c.orange }}>OURS (IN-WORKER WASM)</div>
            <div>FFMPEG (PROCESS SPAWN)</div>
          </div>
          {BENCH_ROWS.map((r, i) => {
            const p = interpolate(frame, [split + 14 + i * 12, split + 28 + i * 12], [0, 1], clamp);
            return (
              <div
                key={r.label}
                style={{
                  background: c.surface,
                  border: `2px solid ${c.line}`,
                  borderRadius: 16,
                  padding: "18px 28px",
                  display: "grid",
                  gridTemplateColumns: "1.6fr 1fr 1.2fr",
                  alignItems: "center",
                  opacity: p,
                }}
              >
                <div style={{ ...body, fontSize: 26, color: c.ink }}>{r.label}</div>
                <div style={{ ...head, fontSize: 34, color: c.orange }}>{r.ours}</div>
                <div style={{ ...mono, fontSize: 26, color: c.muted }}>{r.ffmpeg}</div>
              </div>
            );
          })}
        </div>
        <Source
          text={`Source: CI run ${fact("benchCiRun")} (medians of 3, ${fact("benchFfmpegVer")}). FFmpeg times include starting its process; output quality is not compared.`}
        />
      </AbsoluteFill>
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
const SCENES = [12, 22, 24, 26, 28, 26, 12];

export const demoFrames = () => {
  const clips = voiceFor("demo", SCENES.length);
  return voicedFrames(SCENES, clips).reduce((a, f) => a + f, 0);
};

export const Demo: React.FC = () => {
  const clips = voiceFor("demo", SCENES.length);
  const frames = voicedFrames(SCENES, clips);
  const nodes = [
    <ColdOpen key="cold" frames={frames[0]} />,
    <FiltersAndClientScene key="filters" frames={frames[1]} />,
    <ReportScene key="report" frames={frames[2]} />,
    <ProtectAndCasesScene key="protect" frames={frames[3]} />,
    <ArchitectureAndVoiceScene key="arch" frames={frames[4]} />,
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
