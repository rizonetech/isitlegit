// 45-second X Viral Teaser Clip (D10 T01 §9), highlighting the forward-to-verdict live investigation and all 5 Meta
// Model "How It's Done" X-Ray overlays (muse-spark-1.3, sam-3.1, muse-wonder-1.0, Loupe 1.1 -> Muse Spark, and
// in-Worker WASM Opus -> muse-voice-transcribe-1.0) plus #model-trace for the @AIMetaDevs viral X post.
import type React from "react";
import { AbsoluteFill, Freeze, interpolate, Loop, OffthreadVideo, Sequence, Series, useCurrentFrame } from "remotion";
import { Backdrop, body, CARD, c, head, Logo, MetaAttributionStrip, MetaBadge, mono } from "../brand";
import { CAPTURE, GENERATED } from "../data/demo-capture";
import tech from "../../data/tech-facts.json";
import { MusicBed, Sfx } from "../kit/sound";
import { LoupeCascadeXRay, ModelTraceXRay, SamXRay, SparkXRay, VoiceDecoderXRay, WonderXRay } from "../kit/xray";

const FPS = 30;
const s = (sec: number) => Math.round(sec * FPS);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const fade = (frame: number, total: number, edge = 10) => interpolate(frame, [0, edge, total - edge, total], [0, 1, 1, 0], clamp);
const fact = (key: string): string => ((tech.facts as Record<string, { value: string }>)[key]).value;

type Beat = { src: string; caseId: string | null; marks: Record<string, number> };
const beat = (name: string): Beat | null => ((CAPTURE?.beats as Record<string, Beat> | undefined)?.[name] ?? null);

const FRAME_W = 1580;
const SCALE = FRAME_W / 1920;
const FRAME_H = Math.round(1080 * SCALE);
const BAR = 42;

const TeaserBrowser: React.FC<{ src: string; from: number; to: number; slot: number; path: string }> = ({ src, from, to, slot, path }) => {
  const frame = useCurrentFrame();
  const rate = Math.min(3.5, Math.max(1, ((to - from) * FPS) / Math.max(1, slot)));
  const clipFrames = Math.max(1, Math.floor(((to - from) * FPS) / rate));
  return (
    <Freeze frame={Math.min(frame, clipFrames - 1)}>
      <div style={{ position: "absolute", left: (1920 - FRAME_W) / 2, top: 82, width: FRAME_W, borderRadius: 16, overflow: "hidden", boxShadow: "0 28px 70px rgba(0,0,0,0.6)", border: `2px solid ${c.line}` }}>
        <div style={{ height: BAR, background: c.surface, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
              <div key={dot} style={{ width: 12, height: 12, borderRadius: 6, background: dot }} />
            ))}
            <div style={{ ...mono, fontSize: 17, color: c.muted, marginLeft: 14 }}>{path}</div>
          </div>
          <div style={{ ...mono, fontSize: 14, color: c.orange }}>#demo-clock · #model-trace (?trace=1)</div>
        </div>
        <div style={{ width: FRAME_W, height: FRAME_H, background: "#fff", overflow: "hidden" }}>
          <OffthreadVideo src={src} startFrom={s(from)} playbackRate={rate} muted style={{ width: FRAME_W, height: FRAME_H }} />
        </div>
      </div>
    </Freeze>
  );
};

// Beat 1 (6 s): Hook card (SABRIC R2.41 bn + Hawarden R5.5m + 5 Meta models built from scratch in 9 days).
const HookBeat: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames), padding: "70px 116px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Logo width={380} />
        <div style={{ ...mono, fontSize: 19, color: c.orange, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "8px 20px", background: `${CARD}dd` }}>
          @AIMetaDevs · 5 META MODELS · 9-DAY BUILD
        </div>
      </div>
      <div>
        <div style={{ ...head, fontSize: 66, lineHeight: 1.06, color: c.ink }}>
          The email is real. <span style={{ color: c.orange }}>The bank details aren&apos;t theirs.</span>
        </div>
        <div style={{ ...body, fontSize: 27, color: c["ink-2"], marginTop: 16 }}>
          R2.41 bn SA digital banking fraud (SABRIC 2025) · R5.5m BEC loss in Hawarden v ENS [2024] ZASCA 90 · Forward any suspicious email, PDF invoice or voice note to check@isitlegit.co.za.
        </div>
      </div>
      <MetaAttributionStrip />
    </AbsoluteFill>
  );
};

// Beat 2 (32 s): Live forward-to-verdict + all 5 Meta Model "How It's Done" X-Ray overlays + #model-trace.
const InvestigationXRayBeat: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const mail = beat("mail-send");
  const up = beat("upload-and-report");
  const tForward = s(5);
  const step = Math.floor((frames - tForward) / 5);
  const t1 = tForward + step;
  const t2 = tForward + step * 2;
  const t3 = tForward + step * 3;
  const t4 = tForward + step * 4;
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {mail ? (
        <Sequence durationInFrames={tForward}>
          <TeaserBrowser
            src={mail.src}
            from={Math.max(0, (mail.marks.composeOpened ?? 4) - 0.4)}
            to={(mail.marks.replied ?? mail.marks.sent ?? 12) + 0.5}
            slot={tForward}
            path="outlook.office.com/mail/inbox -> check@isitlegit.co.za"
          />
          <MetaBadge text="Forward to check@isitlegit.co.za" />
        </Sequence>
      ) : null}
      {up ? (
        <Sequence from={tForward} durationInFrames={frames - tForward}>
          <TeaserBrowser
            src={up.src}
            from={Math.max(0, (up.marks.reportOpened ?? 2) - 0.5)}
            to={(up.marks.scrolled ?? up.marks.finished + 2) + 0.5}
            slot={frames - tForward}
            path={`app.isitlegit.co.za/r/${up.caseId ?? ""}?clock=1&trace=1`}
          />
        </Sequence>
      ) : null}
      <Sequence from={tForward} durationInFrames={t1 - tForward}>
        <MetaBadge text="1/5 · muse-spark-1.3" />
        <SparkXRay style={{ position: "absolute", left: 170, right: 170, bottom: 28 }} />
      </Sequence>
      <Sequence from={t1} durationInFrames={t2 - t1}>
        <MetaBadge text="2/5 · sam-3.1" />
        <SamXRay style={{ position: "absolute", left: 170, right: 170, bottom: 28 }} />
      </Sequence>
      <Sequence from={t2} durationInFrames={t3 - t2}>
        <MetaBadge text="3/5 · muse-wonder-1.0" />
        <WonderXRay style={{ position: "absolute", left: 170, right: 170, bottom: 28 }} />
      </Sequence>
      <Sequence from={t3} durationInFrames={t4 - t3}>
        <MetaBadge text="4/5 · Loupe 1.1 (Muse Glimmer 30B LoRA)" />
        <LoupeCascadeXRay style={{ position: "absolute", left: 170, right: 170, bottom: 28 }} />
      </Sequence>
      <Sequence from={t4} durationInFrames={frames - t4}>
        <MetaBadge text="5/5 · muse-voice-transcribe-1.0 + #model-trace" />
        <VoiceDecoderXRay
          noteOurs={fact("benchNoteOurs")}
          noteFfmpeg={fact("benchNoteFfmpeg")}
          ciRun="40606229380"
          ffmpegVer={fact("benchFfmpegVer")}
          style={{ position: "absolute", left: 170, right: 170, bottom: 185 }}
        />
        <ModelTraceXRay style={{ position: "absolute", left: 170, right: 170, bottom: 20 }} />
      </Sequence>
    </AbsoluteFill>
  );
};

// Beat 3 (7 s): Closing CTA card.
const CloseBeat: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames), padding: "70px 116px", display: "flex", flexDirection: "column", justifyContent: "space-between", alignItems: "center", textAlign: "center" }}>
      <Logo width={440} />
      <div>
        <div style={{ ...head, fontSize: 60, color: c.ink }}>Your filter protects your inbox.</div>
        <div style={{ ...head, fontSize: 60, color: c.orange, marginTop: 6 }}>We protect you from everyone else&apos;s.</div>
        <div style={{ display: "flex", gap: 20, justifyContent: "center", marginTop: 24 }}>
          {[
            ["Live Web", "isitlegit.co.za · app.isitlegit.co.za"],
            ["Local Replay", "pnpm judge:demo"],
            ["Open Weights", "huggingface.co/rizonetech/isitlegit-loupe"],
          ].map(([k, v]) => (
            <div key={k} style={{ background: `${CARD}ee`, border: `2px solid ${c.line}`, borderRadius: 14, padding: "12px 22px", textAlign: "left" }}>
              <div style={{ ...mono, fontSize: 15, color: c.orange }}>{k}</div>
              <div style={{ ...mono, fontSize: 20, color: c.ink, fontWeight: 700, marginTop: 4 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
      <MetaAttributionStrip style={{ width: "100%", textAlign: "left" }} />
    </AbsoluteFill>
  );
};

export const TEASER_SCENES = [6, 32, 7]; // 45 seconds = 1350 frames at 30 fps
export const TEASER_FRAMES = TEASER_SCENES.reduce((a, b) => a + b, 0) * FPS;

export const XTeaser: React.FC = () => {
  const frames = TEASER_SCENES.map((sec) => sec * FPS);
  const nodes = [
    <HookBeat key="hook" frames={frames[0]} />,
    <InvestigationXRayBeat key="xray" frames={frames[1]} />,
    <CloseBeat key="close" frames={frames[2]} />,
  ];
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
            {i === 0 ? <Sfx name="hit" /> : <Sfx name={i === frames.length - 1 ? "swell" : "whoosh"} />}
          </Series.Sequence>
        ))}
      </Series>
      <MusicBed name="demo-bed" frames={TEASER_FRAMES} voice={[]} />
    </AbsoluteFill>
  );
};
