// The 3-minute demo video (D09 T02 §3 and §4; docs/specs/2026-10-31-demo-video-design.md), built from captures of the
// live service (media/capture/), the operator's on-camera intro and generated shots and plates, and narration in
// Brian's voice (data/narration/demo.json). Every clip of the product is the live app as the rig recorded it; every
// time on screen is measured from the capture's own marks; every figure is a pinned fact or a sourced figure.
//
// Rules this cut keeps (operator review, 2026-11-04): each scene lasts as long as its narration, so a line is never cut
// off and no scene runs on in silence; nothing is drawn on top of the product: captions sit under the browser window
// and the Meta model marker sits in the window's title bar; nothing is shown that the live service cannot back.
import type React from "react";
import { AbsoluteFill, Freeze, Img, interpolate, Loop, OffthreadVideo, Sequence, Series, useCurrentFrame } from "remotion";
import loupe from "../../data/loupe-facts.json";
import tech from "../../data/tech-facts.json";
import { body, CARD, c, head, Logo, MetaAttributionStrip, MetaInfinity, mono } from "../brand";
import { CAPTURE, GENERATED } from "../data/demo-capture";
import { MusicBed, Sfx } from "../kit/sound";
import { type Clip as VoiceClip, Voice, voiceFor } from "../kit/voice";

const FPS = 30;
const s = (seconds: number) => Math.max(1, Math.round(seconds * FPS));
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const fact = (key: string): string =>
  ((loupe.facts as Record<string, { value: string }>)[key] ?? (tech.facts as Record<string, { value: string }>)[key]).value;

type Box = { x: number; y: number; width: number; height: number };
type Beat = { src: string; caseId: string | null; marks: Record<string, number>; boxes: Record<string, Box | null> };
export const beat = (name: string): Beat | null => ((CAPTURE?.beats as Record<string, Beat> | undefined)?.[name] ?? null);

// Narration timing: the voice starts LEAD after its scene does and the scene ends TAIL after the last word.
const LEAD = 0.3;
const TAIL = 0.5;
// The operator's intro (GENERATED.intro, 6.6 s) brought to the narration's reference level (tools/voice-index.py,
// REFERENCE -24 LUFS; the clip measures -16.8 LUFS).
const INTRO_SECONDS = 6.6;
const INTRO_GAIN = 0.43;

// The browser window every capture plays in: 1440 wide (the 1920 capture at 0.75), under a 44 px title bar, high on
// the frame so the caption band below it never covers the product.
const FRAME_W = 1440;
const SCALE = FRAME_W / 1920;
const FRAME_H = Math.round(1080 * SCALE);
const BAR = 44;
const WIN_LEFT = (1920 - FRAME_W) / 2;
const WIN_TOP = 56;
const CAPTION_TOP = WIN_TOP + BAR + FRAME_H + 22;

/** The Meta model at work in a window, named in its title bar (never over the page). */
export type Model = { name: string; job: string };

const Window: React.FC<{ src: string; startAt: number; path: string; rate?: number; model?: Model; chip?: string }> = ({ src, startAt, path, rate = 1, model, chip }) => (
  <div style={{ position: "absolute", left: WIN_LEFT, top: WIN_TOP, width: FRAME_W, borderRadius: 16, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.6)", border: `1px solid ${c["line-strong"]}` }}>
    <div style={{ height: BAR, background: c.surface, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
          <div key={dot} style={{ width: 12, height: 12, borderRadius: 6, background: dot }} />
        ))}
        <div style={{ ...mono, fontSize: 17, color: c.muted, marginLeft: 16 }}>{path}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {chip ? <div style={{ ...mono, fontSize: 15, color: c.orange, border: `1px solid ${c.orange}`, borderRadius: 999, padding: "2px 12px" }}>{chip}</div> : null}
        {model ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, ...body, fontSize: 17, fontWeight: 600, color: c.ink }}>
            <MetaInfinity size={26} />
            {model.name}
            <span style={{ fontWeight: 500, color: c.muted }}>{model.job}</span>
          </div>
        ) : null}
      </div>
    </div>
    <div style={{ width: FRAME_W, height: FRAME_H, overflow: "hidden", background: "#fff" }}>
      <OffthreadVideo src={src} startFrom={s(startAt)} playbackRate={rate} muted style={{ width: FRAME_W, height: FRAME_H }} />
    </div>
  </div>
);

const rateFor = (from: number, to: number, slot: number, max = 3.5) => Math.min(max, Math.max(1, ((to - from) * FPS) / Math.max(1, slot)));

/**
 * One stretch of a capture, from `from` to `to` seconds of the take, played into `slot` frames: in real time when it
 * fits, sped up when it does not (the chip then says how much), and held on its last frame if the take runs out first.
 */
// The rig's marks are wall-clock seconds; Playwright's recordings run about 9.5% longer than the wall clock (measured on
// the 2026-11-03 capture: every beat's video over its last mark, 1.075 to 1.104), so a mark is scaled onto the video.
const VIDEO_PER_MARK = 1.095;

export const Take: React.FC<{ src: string; from: number; to: number; slot: number; path: string; model?: Model; max?: number; chip?: string }> = ({ src, from: markFrom, to: markTo, slot, path, model, max, chip }) => {
  const from = markFrom * VIDEO_PER_MARK;
  const to = markTo * VIDEO_PER_MARK;
  const rate = rateFor(from, to, slot, max);
  const frames = Math.max(1, Math.floor(((to - from) * FPS) / rate));
  const label = chip ?? (rate >= 1.5 ? `${rate.toFixed(rate >= 10 ? 0 : 1)}x speed` : undefined);
  return (
    <Freeze frame={Math.min(useCurrentFrame(), frames - 1)}>
      <Window src={src} startAt={from} path={path} rate={rate} model={model} chip={label} />
    </Freeze>
  );
};

/** One caption under the window, content-sized and centred, shown from `from` to `to` frames of its scene. */
export const Caption: React.FC<{ from: number; to: number; text: string }> = ({ from, to, text }) => {
  const f = useCurrentFrame();
  const o = Math.min(interpolate(f, [from, from + 10], [0, 1], clamp), interpolate(f, [to - 10, to], [1, 0], clamp));
  if (o <= 0) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: CAPTION_TOP, display: "flex", justifyContent: "center", opacity: o }}>
      <div style={{ ...body, fontSize: 30, fontWeight: 600, color: c.ink, background: `${CARD}f2`, border: `1px solid ${c["line-strong"]}`, borderRadius: 999, padding: "9px 28px" }}>{text}</div>
    </div>
  );
};

/** A stretch of a scene that cross-fades in at `from` and out at `to`. */
export const Part: React.FC<{ from: number; to: number; children: React.ReactNode; last?: boolean }> = ({ from, to, children, last }) => {
  const f = useCurrentFrame();
  const o = last ? interpolate(f, [from - 6, from + 10], [0, 1], clamp) : interpolate(f, [from - 6, from + 10, to - 10, to], [0, 1, 1, 0], clamp);
  if (o <= 0) return null;
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <Sequence from={Math.max(0, from - 6)}>{children}</Sequence>
    </AbsoluteFill>
  );
};

const fade = (frame: number, total: number, edge = 12) => interpolate(frame, [0, edge, total - edge, total], [0, 1, 1, 0], clamp);

/** A generated plate behind a scene, dimmed so the text on top stays the brightest thing. */
const Plate: React.FC<{ src: string | null; dim?: number; side?: "left" | "right" }> = ({ src, dim = 0.35, side }) => {
  const frame = useCurrentFrame();
  if (!src) return null;
  return (
    <AbsoluteFill>
      <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${1 + frame / 6000})` }} />
      <AbsoluteFill style={{ background: `rgba(7,6,9,${dim})` }} />
      {side ? <AbsoluteFill style={{ background: `linear-gradient(${side === "left" ? 90 : 270}deg, rgba(7,6,9,0.9), transparent 65%)` }} /> : null}
    </AbsoluteFill>
  );
};

const Source: React.FC<{ text: string }> = ({ text }) => <div style={{ ...body, position: "absolute", left: 110, right: 110, bottom: 44, fontSize: 21, color: c.muted }}>{text}</div>;

// Intro: the operator on camera, picture in picture, over the moving background, beside the built-from-scratch line.
const Intro: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const a = interpolate(frame, [0, 14], [0, 1], clamp);
  const b = interpolate(frame, [10, 26], [0, 1], clamp);
  const pip = interpolate(frame, [4, 20], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames, 8) }}>
      <div style={{ position: "absolute", left: 120, top: 150, width: 900 }}>
        <div style={{ opacity: a }}>
          <Logo width={420} />
        </div>
        <div style={{ ...head, fontSize: 70, lineHeight: 1.06, marginTop: 56, opacity: b, transform: `translateY(${(1 - b) * 20}px)` }}>
          From zero to production-ready <span style={{ color: c.orange }}>in 9 days.</span>
        </div>
        <div style={{ ...body, fontSize: 28, lineHeight: 1.45, marginTop: 26, color: c["ink-2"], opacity: b }}>
          Product engineering, brand identity, design system, model fine-tuning, evaluation harness and marketing site, all built from scratch during the hackathon.
        </div>
        <div style={{ ...mono, fontSize: 18, color: c.muted, marginTop: 34, opacity: b, letterSpacing: 1 }}>META GLOBAL AI DEVELOPER HACKATHON · STARTUP TRACK</div>
      </div>
      {GENERATED.intro ? (
        <div style={{ position: "absolute", right: 110, top: 190, width: 720, opacity: pip, transform: `scale(${0.96 + 0.04 * pip})`, transformOrigin: "right center" }}>
          <div style={{ width: 720, height: 405, borderRadius: 22, overflow: "hidden", border: `2px solid ${c["line-strong"]}`, boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}>
            <OffthreadVideo src={GENERATED.intro} volume={INTRO_GAIN} style={{ width: 720, height: 405, objectFit: "cover" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
            <div style={{ width: 10, height: 10, borderRadius: 5, background: c.orange }} />
            <span style={{ ...body, fontSize: 24, fontWeight: 600, color: c.ink }}>Derick Payne</span>
            <span style={{ ...body, fontSize: 22, color: c.muted }}>Founder, Rizonetech</span>
          </div>
        </div>
      ) : null}
      <MetaAttributionStrip style={{ position: "absolute", left: 0, right: 0, bottom: 64, opacity: b }} />
    </AbsoluteFill>
  );
};

// Scene 1: the cold open, two generated shots and the line (kept short so the product gets the time).
const SHOTS: (keyof typeof GENERATED)[] = ["inbox", "hover"];

const ShotClip: React.FC<{ src: string | null }> = ({ src }) => {
  const frame = useCurrentFrame();
  return src ? <OffthreadVideo src={src} muted style={{ width: 1920, height: 1080, objectFit: "cover", opacity: interpolate(frame, [0, 8], [0, 1], clamp) }} /> : null;
};

const ColdOpen: React.FC<{ frames: number }> = ({ frames }) => {
  const per = Math.floor(frames / SHOTS.length);
  const frame = useCurrentFrame();
  const line = interpolate(frame, [frames - per + 20, frames - per + 40], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Series>
        {SHOTS.map((name, i) => (
          <Series.Sequence key={name} durationInFrames={i === SHOTS.length - 1 ? frames - per * (SHOTS.length - 1) : per}>
            <ShotClip src={GENERATED[name] as string | null} />
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

// Scene 2: the stakes in one beat: why filters pass it, SABRIC's national losses, then the Hawarden ruling right after
// (operator, 2026-11-03: the court case follows the South African figures).
const LOSSES = [
  { year: "2023", rand: 1.09 },
  { year: "2024", rand: 1.86 },
  { year: "2025", rand: 2.41 },
];

const StakesScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const split = Math.round(frames * 0.5);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <Part from={0} to={split}>
        <Plate src={GENERATED.plateA} dim={0.25} side="left" />
        <div style={{ position: "absolute", left: 110, top: 110, width: 1000 }}>
          <div style={{ ...head, fontSize: 76, lineHeight: 1.05 }}>The email is real.</div>
          <div style={{ ...head, fontSize: 76, lineHeight: 1.05, color: c.orange }}>So the filter passes it.</div>
          <div style={{ ...body, fontSize: 32, marginTop: 24, maxWidth: 820 }}>Sent from your supplier's own mailbox, so SPF, DKIM and DMARC all pass.</div>
        </div>
        <div style={{ ...body, position: "absolute", left: 110, bottom: 590, width: 760, fontSize: 28, opacity: interpolate(frame, [s(3.5), s(4.2)], [0, 1], clamp) }}>Digital banking fraud losses in South Africa, every channel.</div>
        <div style={{ position: "absolute", left: 110, bottom: 140, display: "flex", alignItems: "flex-end", gap: 36 }}>
          {LOSSES.map((l, i) => {
            const grow = interpolate(frame, [s(4) + i * 10, s(5) + i * 10], [0, 1], clamp);
            return (
              <div key={l.year} style={{ width: 170, textAlign: "center" }}>
                <div style={{ ...head, fontSize: 38, color: i === 2 ? c.orange : c.ink, opacity: grow }}>R{l.rand.toFixed(2)} bn</div>
                <div style={{ height: (l.rand / 2.41) * 330 * grow, background: i === 2 ? c.orange : "rgba(255,255,255,0.28)", borderRadius: "8px 8px 0 0", marginTop: 8 }} />
                <div style={{ ...body, fontSize: 28, marginTop: 8 }}>{l.year}</div>
              </div>
            );
          })}
        </div>
        <Source text="Source: SABRIC Annual Crime Statistics 2025, p. 7. All digital banking fraud, not phishing alone." />
      </Part>
      <Part from={split} to={frames} last>
        <Plate src={GENERATED.plateB} dim={0.3} side="right" />
        <div style={{ position: "absolute", right: 110, top: 150, width: 840 }}>
          <div style={{ ...body, fontSize: 26, color: c.orange, letterSpacing: 2, textTransform: "uppercase" }}>Hawarden v Edward Nathan Sonnenbergs</div>
          <div style={{ ...head, fontSize: 78, lineHeight: 1.05, marginTop: 14 }}>R5.5 million paid to a fraudster.</div>
          <div style={{ ...body, fontSize: 30, marginTop: 24 }}>A hacked inbox and a one-letter lookalike address. The High Court ordered the law firm to pay (2023). The Supreme Court of Appeal overturned it (10 June 2024).</div>
          <div style={{ ...head, fontSize: 38, marginTop: 32, borderLeft: `6px solid ${c.orange}`, paddingLeft: 24 }}>The buyer could reasonably have avoided the risk by verifying the account details.</div>
        </div>
        <Source text="Source: [2024] ZASCA 90, Supreme Court of Appeal of South Africa, 10 June 2024." />
      </Part>
    </AbsoluteFill>
  );
};

// Scene 3: the forward from Outlook, then the live report filling in and its evidence. The wait while the checks run
// is shown sped up, with the measured time, never cut silently.
const ReportScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const mail = beat("mail-send");
  const up = beat("upload-and-report");
  if (!up) return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}><div style={{ ...head, fontSize: 60 }}>No capture yet: run pnpm capture:demo</div></AbsoluteFill>;
  const m = up.marks;
  const took = (m.finished - m.reportOpened).toFixed(0);
  const mm = mail?.marks ?? {};
  const tSend = mail ? Math.round(frames * 0.2) : 0;
  const tWait = tSend + s(3);
  const tVerdict = Math.round(frames * 0.66);
  const tEvidence = Math.round(tWait + (tVerdict - tWait) * 0.5);
  const tAdvice = Math.round(frames * 0.84);
  const spark: Model = { name: "Muse Spark 1.3", job: "writes the verdict" };
  const aFrom = Math.max(0, (mm.composeOpened ?? mm.inbox ?? 5) - 0.6);
  const aTo = (mm.addressed ?? aFrom + 4) + 0.8;
  const bFrom = Math.max(aTo, (mm.composed ?? mm.sent ?? aTo + 3) - 2.5);
  const bTo = (mm.sent ?? mm.composed ?? bFrom + 3) + 1.2;
  const aSlot = Math.round((tSend * (aTo - aFrom)) / Math.max(0.1, aTo - aFrom + bTo - bFrom));
  const outlook = "outlook.office.com/mail · demo@rizonetech.com";
  const report = `app.isitlegit.co.za/r/${up.caseId ?? ""}`;
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {mail ? (
        <Part from={0} to={tSend}>
          <Sequence durationInFrames={aSlot}>
            <Take src={mail.src} from={aFrom} to={aTo} slot={aSlot} path={outlook} chip="" />
          </Sequence>
          <Sequence from={aSlot}>
            <Take src={mail.src} from={bFrom} to={bTo} slot={tSend - aSlot} path={outlook} chip="" />
          </Sequence>
        </Part>
      ) : null}
      <Part from={tSend} to={tWait}>
        <Take src={up.src} from={Math.max(0, m.reportOpened - 0.5)} to={m.finished} slot={tWait - tSend} path={report} max={40} chip={`checks running · ${took} s, shown sped up`} />
      </Part>
      <Part from={tWait} to={m.traceOpened ? tVerdict : frames} last={!m.traceOpened}>
        <Take src={up.src} from={m.finished - 0.5} to={(m.scrolled ?? m.finished + 12) + 0.5} slot={(m.traceOpened ? tVerdict : frames) - tWait} path={report} />
      </Part>
      {m.traceOpened ? (
        <Part from={tVerdict} to={frames} last>
          <Take src={up.src} from={m.traceShown ?? m.traceOpened + 2} to={(m.traceDone ?? m.traceOpened + 8) + 0.5} slot={frames - tVerdict} path={report} model={spark} />
        </Part>
      ) : null}
      {mail ? <Caption from={0} to={tSend} text="Forwarded from Outlook to check@isitlegit.co.za" /> : null}
      <Caption from={tSend} to={tWait} text={`The report fills in live: the checks finished in ${took} seconds`} />
      <Caption from={tWait} to={tEvidence} text="Text hidden from the reader, written to steer an AI, caught before any model reads the mail" />
      <Caption from={tEvidence} to={tVerdict} text="A reply address and a link that go somewhere else, each with its evidence" />
      <Caption from={tVerdict} to={tAdvice} text="Muse Spark writes the verdict, and every reason cites a finding: E4, E5, E3" />
      <Caption from={tAdvice} to={frames} text="First advice: do not pay until you call the number in your own records" />
    </AbsoluteFill>
  );
};

// Scene 4: who the business really is (/settings/domains, /protect), the suppliers it pays (/suppliers), and the
// cases console (/cases), each the live page.
const ProtectScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const dom = beat("domains");
  const prot = beat("protect");
  const sup = beat("suppliers");
  const cases = beat("cases");
  const tD = dom ? Math.round(frames * 0.14) : 0;
  const tP = Math.round(frames * 0.46);
  const tS = Math.round(frames * 0.72);
  const pLogo = tD + Math.round((tP - tD) * 0.45);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {dom ? (
        <Part from={0} to={tD}>
          <Take src={dom.src} from={Math.max(0, (dom.marks.loaded ?? 1) - 0.4)} to={(dom.marks.addresses ?? 5.5) + 0.6} slot={tD} path="app.isitlegit.co.za/settings/domains" />
        </Part>
      ) : null}
      {prot ? (
        <Part from={tD} to={tP}>
          <Take
            src={prot.src}
            from={Math.max(0, (prot.marks.loaded ?? 1) - 0.4)}
            to={(prot.marks.bank ?? 5.5) + 0.6}
            slot={tP - tD}
            path="app.isitlegit.co.za/protect"
            model={frame >= pLogo ? { name: "SAM 3.1", job: "compares this logo with mail" } : undefined}
          />
        </Part>
      ) : null}
      {sup ? (
        <Part from={tP} to={tS}>
          <Take src={sup.src} from={Math.max(0, (sup.marks.loaded ?? 1) - 0.4)} to={(sup.marks.importShown ?? 6) + 0.6} slot={tS - tP} path="app.isitlegit.co.za/suppliers" max={4} />
        </Part>
      ) : null}
      {cases ? (
        <Part from={tS} to={frames} last>
          <Take src={cases.src} from={Math.max(0, (cases.marks.loaded ?? 1) - 0.4)} to={(cases.marks.filtered ?? cases.marks.opened ?? 6) + 0.8} slot={frames - tS} path="app.isitlegit.co.za/cases" max={4} />
        </Part>
      ) : null}
      {dom ? <Caption from={0} to={tD} text="Fynbos Freight's verified domain and finance mailbox" /> : null}
      {prot ? <Caption from={tD} to={tP} text="Who the business really is: its names, its domains and its logo" /> : null}
      {sup ? <Caption from={tP} to={tS} text="The suppliers it pays, with bank details checked only as match or no match" /> : null}
      {cases ? <Caption from={tS} to={frames} text="Every check in one cases console, searchable by the whole team" /> : null}
    </AbsoluteFill>
  );
};

// Scene 5: the impersonation monitor, live: the lookalikes it watches and the fake portal it found.
const MonitorScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const mon = beat("monitor");
  const split = Math.round(frames * 0.42);
  if (!mon) return null;
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <Take src={mon.src} from={Math.max(0, (mon.marks.loaded ?? 1) - 0.4)} to={(mon.marks.scrolled ?? 10) + 0.8} slot={frames} path="app.isitlegit.co.za/monitor" />
      <Caption from={0} to={split} text="Over five hundred lookalikes of the business's domain, checked every morning" />
      <Caption from={split} to={frames} text="A live fake Fynbos Freight portal, asking for a sign-in and a new bank account" />
    </AbsoluteFill>
  );
};

// Scene 6: how it works: the five Meta models inside one safety contract, then the in-Worker voice decoder bench.
const PIPE: { name: string; job: string; meta: boolean }[] = [
  { name: "SAM 3.1", job: "finds and compares logos", meta: true },
  { name: "Muse Wonder", job: "follows links in a sealed browser", meta: true },
  { name: "Loupe on Muse Glimmer", job: "screens lookalike pages", meta: true },
  { name: "Muse Voice", job: "transcribes voice notes", meta: true },
];
const RULES = ["Untrusted text stays inside sealed blocks", "Critical evidence sets a floor no model can lower", "Every claim cites an evidence ID"];
const BENCH = [
  { label: "Voice note (3 s, Ogg Opus)", ours: fact("benchNoteOurs"), ffmpeg: fact("benchNoteFfmpeg") },
  { label: "Long recording (25 min, Ogg Opus)", ours: fact("benchLongOurs"), ffmpeg: fact("benchLongFfmpeg") },
  { label: "Upload-sized (25 MiB, WAV 48 kHz)", ours: fact("benchWavOurs"), ffmpeg: fact("benchWavFfmpeg") },
];

const Node: React.FC<{ title: string; sub: string; meta?: boolean; on?: boolean; p: number; w?: number }> = ({ title, sub, meta, on, p, w = 340 }) => (
  <div style={{ width: w, background: CARD, border: `2px solid ${on ? c.orange : c["line-strong"]}`, borderRadius: 18, padding: "18px 22px", opacity: p, transform: `translateY(${(1 - p) * 14}px)` }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {meta ? <MetaInfinity size={30} /> : null}
      <span style={{ ...head, fontSize: 28 }}>{title}</span>
    </div>
    <div style={{ ...body, fontSize: 21, marginTop: 6, color: c.muted }}>{sub}</div>
  </div>
);

const Arrow: React.FC<{ p: number }> = ({ p }) => <div style={{ ...head, fontSize: 40, color: c.orange, opacity: p, alignSelf: "center" }}>→</div>;

const ArchitectureScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const split = Math.round(frames * 0.66);
  const at = (i: number) => interpolate(frame, [12 + i * 12, 30 + i * 12], [0, 1], clamp);
  const archO = interpolate(frame, [0, 12, split - 12, split], [0, 1, 1, 0], clamp);
  const benchO = interpolate(frame, [split - 6, split + 14], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <AbsoluteFill style={{ padding: "130px 110px", opacity: archO }}>
        <div style={{ ...head, fontSize: 64 }}>Five Meta models. One safety contract.</div>
        <div style={{ display: "flex", alignItems: "center", gap: 22, marginTop: 90 }}>
          <Node title="Email, file or voice note" sub="forwarded or uploaded" p={at(0)} w={300} />
          <Arrow p={at(1)} />
          <Node title="Deterministic checks" sub="evidence with IDs, and the floor" p={at(1)} w={300} />
          <Arrow p={at(2)} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {PIPE.map((n, i) => (
              <Node key={n.name} title={n.name} sub={n.job} meta={n.meta} p={at(2 + i * 0.5)} w={330} />
            ))}
          </div>
          <Arrow p={at(5)} />
          <Node title="Muse Spark" sub="writes the verdict, citing evidence" meta on p={at(5)} w={260} />
        </div>
        <div style={{ display: "flex", gap: 18, marginTop: 60 }}>
          {RULES.map((r, i) => (
            <div key={r} style={{ ...body, fontSize: 25, fontWeight: 600, color: c.ink, border: `1px solid ${c["line-strong"]}`, borderLeft: `5px solid ${c.orange}`, borderRadius: 12, padding: "14px 22px", background: `${CARD}cc`, opacity: interpolate(frame, [s(4.5) + i * s(2.2), s(4.5) + i * s(2.2) + 14], [0, 1], clamp) }}>
              {r}
            </div>
          ))}
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ padding: "100px 150px", opacity: benchO }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <MetaInfinity size={40} />
          <span style={{ ...body, fontSize: 26, color: c.muted }}>before Muse Voice transcribes it</span>
        </div>
        <div style={{ ...head, fontSize: 62, marginTop: 12 }}>Voice notes decoded inside the Worker</div>
        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr", padding: "0 28px", ...mono, fontSize: 21, color: c.muted, marginTop: 44 }}>
          <div>INPUT</div>
          <div style={{ color: c.orange }}>OUR DECODER</div>
          <div>FFMPEG</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
          {BENCH.map((r, i) => (
            <div key={r.label} style={{ background: CARD, border: `1px solid ${c["line-strong"]}`, borderRadius: 16, padding: "18px 28px", display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr", alignItems: "center", opacity: interpolate(frame, [split + 14 + i * 10, split + 26 + i * 10], [0, 1], clamp) }}>
              <div style={{ ...body, fontSize: 26, color: c.ink }}>{r.label}</div>
              <div style={{ ...head, fontSize: 36, color: c.orange }}>{r.ours}</div>
              <div style={{ ...mono, fontSize: 26, color: c.muted }}>{r.ffmpeg}</div>
            </div>
          ))}
        </div>
        <Source text={`Source: CI run ${fact("benchCiRun")}, medians of 3, ${fact("benchFfmpegVer")}. FFmpeg's times include starting its process; output quality is not compared.`} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 7: proof, the Loupe model card from the pinned facts (data/loupe-facts.json).
const ProofScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const ev = beat("eval");
  const split = ev ? Math.round(frames * 0.66) : frames;
  const tiles = [
    { big: fact("lureRecallOf"), small: "caught on held-out pages" },
    { big: fact("falseAlarmsOf"), small: "false alarms on benign pages" },
    { big: fact("latency"), small: "median time per page" },
    { big: fact("trainLines"), small: `training lines, ${fact("trainTime")} of training` },
  ];
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <AbsoluteFill style={{ padding: "100px 150px", opacity: interpolate(frame, [0, 14, split - 12, split], [0, 1, 1, 0], clamp) }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <MetaInfinity size={46} />
          <span style={{ ...body, fontSize: 28, color: c.muted }}>fine-tuned from {fact("baseModel")}</span>
        </div>
        <div style={{ ...head, fontSize: 84, marginTop: 6 }}>Loupe 1.0</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, marginTop: 40 }}>
          {tiles.map((t, i) => (
            <div key={t.small} style={{ background: CARD, border: `1px solid ${c["line-strong"]}`, borderRadius: 20, padding: "26px 34px", opacity: interpolate(frame, [s(2.5) + i * 20, s(2.5) + i * 20 + 16], [0, 1], clamp) }}>
              <div style={{ ...head, fontSize: 64, color: i === 0 ? c.orange : c.ink }}>{t.big}</div>
              <div style={{ ...body, fontSize: 28, marginTop: 4 }}>{t.small}</div>
            </div>
          ))}
        </div>
        <div style={{ ...body, fontSize: 30, marginTop: 34, opacity: interpolate(frame, [split - s(5.5), split - s(4.8)], [0, 1], clamp) }}>
          Its weak spot, shown too: it names the lure type right {`${(Number(fact("lureTypeRight")) * 100).toFixed(1)}%`} of the time.
        </div>
      </AbsoluteFill>
      {ev ? (
        <Part from={split} to={frames} last>
          <Take src={ev.src} from={Math.max(0, (ev.marks.loaded ?? 1) - 0.3)} to={(ev.marks.scrolled ?? 10) + 0.5} slot={frames - split} path="app.isitlegit.co.za/eval" max={3} />
          <Caption from={0} to={frames - split} text="Every evaluation run, published whether good or not" />
        </Part>
      ) : null}
      {[0, 1, 2, 3].map((i) => (
        <Sequence key={i} from={s(2.5) + i * 20} layout="none">
          <Sfx name="tick" />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

// Scene 8: the close.
const CloseCard: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const a = interpolate(frame, [0, 20], [0, 1], clamp);
  const b = interpolate(frame, [s(2.5), s(3.2)], [0, 1], clamp);
  const stamp = CAPTURE ? `Captured live on ${CAPTURE.capturedAt.slice(0, 10)}, Worker commit ${(CAPTURE.liveCommit ?? "unknown").slice(0, 8)}` : "";
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <Plate src={GENERATED.plateC} dim={0.62} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", paddingBottom: 120 }}>
        <div style={{ opacity: a }}>
          <Logo width={520} />
        </div>
        <div style={{ ...head, fontSize: 66, marginTop: 64, opacity: a, textShadow: "0 4px 24px rgba(0,0,0,0.8)" }}>Your filter protects your inbox.</div>
        <div style={{ ...head, fontSize: 66, color: c.orange, opacity: b, textShadow: "0 4px 24px rgba(0,0,0,0.8)" }}>We protect you from everyone else's.</div>
        <div style={{ ...mono, fontSize: 34, marginTop: 40, color: c.ink, opacity: b }}>app.isitlegit.co.za</div>
        <div style={{ ...body, fontSize: 20, marginTop: 14, color: c.muted, opacity: b }}>{stamp}</div>
      </AbsoluteFill>
      <MetaAttributionStrip style={{ position: "absolute", left: 0, right: 0, bottom: 60, opacity: b }} />
    </AbsoluteFill>
  );
};

const SCENES = [ColdOpen, StakesScene, ReportScene, ProtectScene, MonitorScene, ArchitectureScene, ProofScene, CloseCard];
// Each scene's shortest length in seconds, for a render with no narration yet.
const FLOORS = [7, 24, 30, 22, 14, 20, 20, 9];

const introFrames = () => (GENERATED.intro ? s(INTRO_SECONDS + 0.4) : 0);
/** Each narrated scene's frames: its clip, LEAD before and TAIL after, never shorter than its floor without a voice. */
const sceneFrames = (clips: VoiceClip[] | null) => FLOORS.map((f, i) => (clips ? Math.ceil((LEAD + clips[i].seconds + TAIL) * FPS) : f * FPS));

export const demoFrames = () => introFrames() + sceneFrames(voiceFor("demo", SCENES.length)).reduce((a, f) => a + f, 0);

/** The whole demo: the intro, then the eight narrated scenes over one moving background and one music bed. */
export const Demo: React.FC = () => {
  const clips = voiceFor("demo", SCENES.length);
  const frames = sceneFrames(clips);
  const intro = introFrames();
  const total = intro + frames.reduce((a, f) => a + f, 0);
  // Where anyone speaks: the operator through the intro, then each narration clip, so the bed rises only in the gaps.
  const spans: [number, number][] = intro ? [[0, intro]] : [];
  let t = intro;
  frames.forEach((f, i) => {
    if (clips) spans.push([t + s(LEAD), t + s(LEAD) + Math.ceil(clips[i].seconds * FPS)]);
    t += f;
  });
  return (
    <AbsoluteFill style={{ background: "#0B0A0D" }}>
      {GENERATED.loop ? (
        <AbsoluteFill>
          <Loop durationInFrames={s(8)}>
            <OffthreadVideo src={GENERATED.loop} muted style={{ width: 1920, height: 1080, objectFit: "cover" }} />
          </Loop>
          <AbsoluteFill style={{ background: "rgba(11,10,13,0.55)" }} />
        </AbsoluteFill>
      ) : null}
      <Series>
        {intro ? (
          <Series.Sequence durationInFrames={intro}>
            <Intro frames={intro} />
          </Series.Sequence>
        ) : null}
        {SCENES.map((Scene, i) => (
          <Series.Sequence key={Scene.name} durationInFrames={frames[i]}>
            <Scene frames={frames[i]} />
            <Voice clip={clips?.[i]} at={s(LEAD)} />
            {i === 0 ? null : <Sfx name={i === SCENES.length - 1 ? "swell" : "whoosh"} />}
          </Series.Sequence>
        ))}
      </Series>
      <MusicBed name="demo-bed" frames={total} voice={spans} />
    </AbsoluteFill>
  );
};

// Standalone cuts of single scenes, each with its own narration and the bed, so none renders silent.
const Standalone: React.FC<{ index: number }> = ({ index }) => {
  const clips = voiceFor("demo", SCENES.length);
  const f = sceneFrames(clips)[index];
  const Scene = SCENES[index];
  return (
    <AbsoluteFill style={{ background: "#0B0A0D" }}>
      <Scene frames={f} />
      <Voice clip={clips?.[index]} at={s(LEAD)} />
      <MusicBed name="demo-bed" frames={f} voice={clips ? [[s(LEAD), s(LEAD) + Math.ceil(clips[index].seconds * FPS)]] : []} />
    </AbsoluteFill>
  );
};
export const DemoTitleOpen: React.FC = () => (
  <AbsoluteFill style={{ background: "#0B0A0D" }}>
    <Intro frames={introFrames() || s(7)} />
  </AbsoluteFill>
);
export const DemoArchitecture: React.FC = () => <Standalone index={5} />;
export const DemoTitleClose: React.FC = () => <Standalone index={7} />;
export const standaloneFrames = (index: number) => sceneFrames(voiceFor("demo", SCENES.length))[index];
export const introLength = () => introFrames() || s(7);

// The 45-second X teaser (D10 T01 §9): the cold open's line without narration, then the live report and the close,
// each with its own narration, so the teaser is the demo's strongest minute cut down, never a separate mock.
const TEASER_HOOK = s(5);
const TEASER_SCENES = [2, 7];
export const teaserFrames = () => {
  const f = sceneFrames(voiceFor("demo", SCENES.length));
  return TEASER_HOOK + TEASER_SCENES.reduce((a, i) => a + f[i], 0);
};
export const DemoTeaser: React.FC = () => {
  const clips = voiceFor("demo", SCENES.length);
  const f = sceneFrames(clips);
  const total = teaserFrames();
  const spans: [number, number][] = [];
  let t = TEASER_HOOK;
  for (const i of TEASER_SCENES) {
    if (clips) spans.push([t + s(LEAD), t + s(LEAD) + Math.ceil(clips[i].seconds * FPS)]);
    t += f[i];
  }
  return (
    <AbsoluteFill style={{ background: "#0B0A0D" }}>
      {GENERATED.loop ? (
        <AbsoluteFill>
          <Loop durationInFrames={s(8)}>
            <OffthreadVideo src={GENERATED.loop} muted style={{ width: 1920, height: 1080, objectFit: "cover" }} />
          </Loop>
          <AbsoluteFill style={{ background: "rgba(11,10,13,0.55)" }} />
        </AbsoluteFill>
      ) : null}
      <Series>
        <Series.Sequence durationInFrames={TEASER_HOOK}>
          <ColdOpen frames={TEASER_HOOK} />
        </Series.Sequence>
        {TEASER_SCENES.map((i) => {
          const Scene = SCENES[i];
          return (
            <Series.Sequence key={i} durationInFrames={f[i]}>
              <Scene frames={f[i]} />
              <Voice clip={clips?.[i]} at={s(LEAD)} />
              <Sfx name={i === 7 ? "swell" : "whoosh"} />
            </Series.Sequence>
          );
        })}
      </Series>
      <MusicBed name="demo-bed" frames={total} voice={spans} />
    </AbsoluteFill>
  );
};
