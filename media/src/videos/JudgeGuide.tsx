// Video 04: 75-second Judge Getting-Started walkthrough (D10 T01 §8), walking judges through:
// Path 1 (Live Web Quickstart at isitlegit.co.za / app.isitlegit.co.za with ?trace=1, /eval, and Hugging Face)
// Path 2 (Zero-account local replay via pnpm judge:demo with recorded provider request/response pairs and provenance labels).
import type React from "react";
import { AbsoluteFill, Freeze, interpolate, Loop, OffthreadVideo, Sequence, Series, useCurrentFrame } from "remotion";
import { Backdrop, body, CARD, c, head, Logo, MetaAttributionStrip, MetaBadge, mono } from "../brand";
import { CAPTURE, GENERATED } from "../data/demo-capture";
import { MusicBed, Sfx } from "../kit/sound";
import { Voice, voicedFrames, voiceFor, voiceSpans } from "../kit/voice";
import { LoupeCascadeXRay, ModelTraceXRay, SparkXRay, WonderXRay } from "../kit/xray";

const FPS = 30;
const s = (sec: number) => Math.round(sec * FPS);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const fade = (frame: number, total: number, edge = 12) => interpolate(frame, [0, edge, total - edge, total], [0, 1, 1, 0], clamp);

type Beat = { src: string; caseId: string | null; marks: Record<string, number> };
const beat = (name: string): Beat | null => ((CAPTURE?.beats as Record<string, Beat> | undefined)?.[name] ?? null);

const FRAME_W = 1560;
const SCALE = FRAME_W / 1920;
const FRAME_H = Math.round(1080 * SCALE);
const BAR = 42;

const LiveBrowser: React.FC<{ src: string; from: number; to: number; slot: number; path: string }> = ({ src, from, to, slot, path }) => {
  const frame = useCurrentFrame();
  const rate = Math.min(3.5, Math.max(1, ((to - from) * FPS) / Math.max(1, slot)));
  const clipFrames = Math.max(1, Math.floor(((to - from) * FPS) / rate));
  return (
    <Freeze frame={Math.min(frame, clipFrames - 1)}>
      <div style={{ position: "absolute", left: (1920 - FRAME_W) / 2, top: 88, width: FRAME_W, borderRadius: 16, overflow: "hidden", boxShadow: "0 28px 70px rgba(0,0,0,0.6)", border: `2px solid ${c.line}` }}>
        <div style={{ height: BAR, background: c.surface, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
              <div key={dot} style={{ width: 12, height: 12, borderRadius: 6, background: dot }} />
            ))}
            <div style={{ ...mono, fontSize: 17, color: c.muted, marginLeft: 14 }}>{path}</div>
          </div>
          <div style={{ ...mono, fontSize: 14, color: c.orange }}>LIVE CAPTURE · FYNBOS FREIGHT DEMO ORG</div>
        </div>
        <div style={{ width: FRAME_W, height: FRAME_H, background: "#fff", overflow: "hidden" }}>
          <OffthreadVideo src={src} startFrom={s(from)} playbackRate={rate} muted style={{ width: FRAME_W, height: FRAME_H }} />
        </div>
      </div>
    </Freeze>
  );
};

// Scene 1 (10 s): Opening card introducing the two zero-friction judge paths.
const IntroScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames), padding: "76px 120px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Logo width={400} />
        <div style={{ ...mono, fontSize: 20, color: c.orange, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "8px 22px", background: `${CARD}dd` }}>
          JUDGE GETTING-STARTED GUIDE · 75 SECONDS
        </div>
      </div>
      <div>
        <div style={{ ...head, fontSize: 68, lineHeight: 1.06, color: c.ink }}>Two Zero-Friction Paths to Verify IsItLegit</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, marginTop: 28 }}>
          <div style={{ background: `${CARD}ee`, border: `2px solid ${c.orange}`, borderRadius: 18, padding: "24px 30px" }}>
            <div style={{ ...mono, fontSize: 18, color: c.orange, fontWeight: 700 }}>PATH 1 · 60-SECOND LIVE WEB QUICKSTART</div>
            <div style={{ ...head, fontSize: 34, color: c.ink, marginTop: 8 }}>isitlegit.co.za &amp; app.isitlegit.co.za</div>
            <div style={{ ...body, fontSize: 23, color: c["ink-2"], marginTop: 10 }}>
              Pre-populated Fynbos Freight demo org: upload an email, PDF invoice or voice note on /check, open ?trace=1 &amp; ?clock=1 on /r/:id, and inspect /eval &amp; Hugging Face.
            </div>
          </div>
          <div style={{ background: `${CARD}ee`, border: `2px solid ${c.line}`, borderRadius: 18, padding: "24px 30px" }}>
            <div style={{ ...mono, fontSize: 18, color: c.orange, fontWeight: 700 }}>PATH 2 · ZERO-ACCOUNT LOCAL REPLAY</div>
            <div style={{ ...head, fontSize: 34, color: c.ink, marginTop: 8 }}>pnpm judge:demo</div>
            <div style={{ ...body, fontSize: 23, color: c["ink-2"], marginTop: 10 }}>
              Runs locally with zero cloud credentials using recorded Meta Model API &amp; Fireworks request/response pairs and explicit provenance badges.
            </div>
          </div>
        </div>
      </div>
      <MetaAttributionStrip />
    </AbsoluteFill>
  );
};

// Scene 2 (35 s): Path 1 — Live Web Quickstart (/check -> /r/:id?trace=1&clock=1 -> /eval & Hugging Face).
const LiveWebPathScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const up = beat("upload-and-report");
  const prot = beat("protect");
  const t1 = Math.round(frames * 0.42);
  const t2 = Math.round(frames * 0.74);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {up ? (
        <Sequence durationInFrames={t2}>
          <LiveBrowser
            src={up.src}
            from={Math.max(0, (up.marks.uploadPage ?? 0.5) - 0.3)}
            to={(up.marks.scrolled ?? up.marks.finished + 2) + 0.5}
            slot={t2}
            path={`app.isitlegit.co.za/r/${up.caseId ?? ""}?trace=1&clock=1`}
          />
        </Sequence>
      ) : null}
      {prot ? (
        <Sequence from={t2} durationInFrames={frames - t2}>
          <LiveBrowser
            src={prot.src}
            from={Math.max(0, (prot.marks.loaded ?? 1) - 0.3)}
            to={(prot.marks.bank ?? prot.marks.scrolled ?? 5) + 0.5}
            slot={frames - t2}
            path="app.isitlegit.co.za/eval & huggingface.co/rizonetech/isitlegit-loupe"
          />
        </Sequence>
      ) : null}
      <MetaBadge text="PATH 1 · Live Web Quickstart" />
      <Sequence from={0} durationInFrames={t1}>
        <SparkXRay style={{ position: "absolute", left: 180, right: 180, bottom: 36 }} />
      </Sequence>
      <Sequence from={t1} durationInFrames={t2 - t1}>
        <WonderXRay style={{ position: "absolute", left: 180, right: 180, bottom: 185 }} />
        <ModelTraceXRay style={{ position: "absolute", left: 180, right: 180, bottom: 24 }} />
      </Sequence>
      <Sequence from={t2} durationInFrames={frames - t2}>
        <LoupeCascadeXRay style={{ position: "absolute", left: 180, right: 180, bottom: 36 }} />
      </Sequence>
    </AbsoluteFill>
  );
};

// Scene 3 (22 s): Path 2 — Zero-Account Local Replay (pnpm judge:demo).
const TERM_LINES = [
  "$ git clone https://github.com/rizonetech/isitlegit && cd isitlegit",
  "$ pnpm install && pnpm judge:demo",
  "[judge:demo] Mode: REPLAYED FROM RECORDED PROVIDER PAIRS (zero API keys needed)",
  "[judge:demo] Fixture 1/3: tcg-waybill-zz3gghz.eml (hidden prompt injection + lookalike link)",
  "  -> Step 1 deterministic-checks: E3 reply-to mismatch, E4/E5 hidden AI steering text extracted",
  "  -> Step 2 sam-3.1: protea emblem segmented (IoU 0.94 vs Fynbos Freight reference mark)",
  "  -> Step 3 loupe-1.1 (Muse Glimmer 30B LoRA): brand lure score 0.98 (172,987-page adapter)",
  "  -> Step 4 muse-wonder-1.0: 3/8 steps, 60 s cap, canary-9f2a@isitlegit.co.za typed",
  "  -> Step 5 muse-spark-1.3: store:false, cited_evidence_ids:[E3,E4,E5,E6], floor=MALICIOUS",
  "[judge:demo] Fixture 2/3: fynbos-invoice-bank-change.pdf -> MALICIOUS (closed-loop bank mismatch)",
  "[judge:demo] Fixture 3/3: urgent-callback-note.ogg -> WASM Opus 14 ms -> muse-voice-transcribe-1.0",
  "[judge:demo] Report server ready at http://127.0.0.1:8788/r/01J9JUDGE?trace=1&clock=1 [PROVENANCE: RECORDED PAIR]",
];

const LocalReplayScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames), padding: "78px 120px" }}>
      <MetaBadge text="PATH 2 · pnpm judge:demo (Zero API Keys)" />
      <div style={{ ...head, fontSize: 58, color: c.ink }}>Zero-Account Local Replay: pnpm judge:demo</div>
      <div style={{ ...body, fontSize: 26, color: c["ink-2"], marginTop: 8 }}>
        Replays recorded Meta Model API &amp; Fireworks AI request/response pairs through the real Worker pipeline with explicit provenance labels.
      </div>
      <div style={{ marginTop: 24, background: "#070609", border: `2px solid ${c.orange}`, borderRadius: 18, padding: "22px 28px", boxShadow: "0 24px 60px rgba(0,0,0,0.65)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${c.line}`, paddingBottom: 12, marginBottom: 14 }}>
          <span style={{ ...mono, fontSize: 17, color: c.orange, fontWeight: 700 }}>TERMINAL · pnpm judge:demo</span>
          <span style={{ ...mono, fontSize: 15, color: c.muted, background: CARD, padding: "4px 12px", borderRadius: 999 }}>
            PROVENANCE BADGE: RECORDED PROVIDER PAIR (SHA-256 VERIFIED)
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {TERM_LINES.map((line, i) => {
            const p = interpolate(frame, [8 + i * 10, 18 + i * 10], [0, 1], clamp);
            const isCmd = line.startsWith("$");
            const isReady = line.includes("Report server ready");
            return (
              <div
                key={line}
                style={{
                  ...mono,
                  fontSize: 19,
                  color: isCmd ? c.orange : isReady ? "#4ADE80" : c.ink,
                  fontWeight: isCmd || isReady ? 700 : 400,
                  opacity: p,
                }}
              >
                {line}
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4 (8 s): Close card with all judge links.
const OutroScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames), padding: "76px 120px", display: "flex", flexDirection: "column", justifyContent: "space-between", alignItems: "center", textAlign: "center" }}>
      <Logo width={440} />
      <div>
        <div style={{ ...head, fontSize: 58, color: c.ink }}>Start Checking in Under 60 Seconds</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 18, marginTop: 24, width: 1560, textAlign: "left" }}>
          {[
            ["1. Live Web & Pre-Populated Org", "https://isitlegit.co.za · https://app.isitlegit.co.za"],
            ["2. Live Model Trace & Demo Clock", "Append ?trace=1&clock=1 to any /r/:caseId report"],
            ["3. Per-Model Ablation & Open Weights", "https://app.isitlegit.co.za/eval · huggingface.co/rizonetech/isitlegit-loupe"],
            ["4. Zero-Account Local Replay", "pnpm install && pnpm judge:demo"],
          ].map(([title, val]) => (
            <div key={title} style={{ background: `${CARD}ee`, border: `2px solid ${c.line}`, borderRadius: 14, padding: "14px 22px" }}>
              <div style={{ ...mono, fontSize: 16, color: c.orange, fontWeight: 700 }}>{title}</div>
              <div style={{ ...mono, fontSize: 21, color: c.ink, marginTop: 4 }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
      <MetaAttributionStrip style={{ width: "100%", textAlign: "left" }} />
    </AbsoluteFill>
  );
};

export const JUDGE_SCENES = [10, 35, 18, 8]; // floors in seconds; voiced clips make it ~87 s (within 60 to 90 s)
export const judgeGuideFrames = () => {
  const clips = voiceFor("04", JUDGE_SCENES.length);
  return voicedFrames(JUDGE_SCENES, clips).reduce((a, b) => a + b, 0);
};

export const JudgeGuide: React.FC = () => {
  const clips = voiceFor("04", JUDGE_SCENES.length);
  const frames = voicedFrames(JUDGE_SCENES, clips);
  const nodes = [
    <IntroScene key="intro" frames={frames[0]} />,
    <LiveWebPathScene key="web" frames={frames[1]} />,
    <LocalReplayScene key="local" frames={frames[2]} />,
    <OutroScene key="outro" frames={frames[3]} />,
  ];
  const total = frames.reduce((a, b) => a + b, 0);
  return (
    <AbsoluteFill style={{ background: "#0B0A0D" }}>
      <Backdrop />
      {GENERATED.loop ? (
        <AbsoluteFill>
          <Loop durationInFrames={s(8)}>
            <OffthreadVideo src={GENERATED.loop} muted style={{ width: 1920, height: 1080, objectFit: "cover", opacity: 0.35 }} />
          </Loop>
        </AbsoluteFill>
      ) : null}
      <Series>
        {nodes.map((node, i) => (
          <Series.Sequence key={i} durationInFrames={frames[i]}>
            <Sequence>{node}</Sequence>
            <Voice clip={clips?.[i]} />
            {i === 0 ? <Sfx name="hit" /> : <Sfx name={i === frames.length - 1 ? "swell" : "whoosh"} />}
          </Series.Sequence>
        ))}
      </Series>
      <MusicBed name="demo-bed" frames={total} voice={voiceSpans(frames, clips)} />
    </AbsoluteFill>
  );
};
