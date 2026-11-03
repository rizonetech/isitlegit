// The 3-minute demo video (D09 T02 §3 and §4; docs/specs/2026-10-31-demo-video-design.md), built from captures of the
// live service (media/capture/), the operator's generated shots and plates, and narration in Brian's voice
// (data/narration/demo.json). Every clip of the product is the live app as the rig recorded it; every time on screen is
// measured from the capture's own marks; every figure is a pinned fact or a sourced figure from the spec.
import type React from "react";
import { AbsoluteFill, Freeze, Img, interpolate, Loop, OffthreadVideo, Sequence, Series, useCurrentFrame } from "remotion";
import { CAPTURE, GENERATED } from "../data/demo-capture";
import loupe from "../../data/loupe-facts.json";
import tech from "../../data/tech-facts.json";
import { body, CARD, c, head, Logo, MetaAttributionStrip, MetaBadge, mono } from "../brand";
import { MusicBed, Sfx } from "../kit/sound";
import { Voice, voiceFor, voiceSpans } from "../kit/voice";
import { LoupeCascadeXRay, ModelTraceXRay, SamXRay, SparkXRay, VoiceDecoderXRay, WonderXRay } from "../kit/xray";
import boardAlert from "../../../design/mockups/png/Email-Impersonation.png";
import boardMonitorMail from "../../../design/mockups/png/Email-Monitor.png";
import boardMonitor from "../../../design/mockups/png/Monitor.png";
import boardBadges from "../../../design/mockups/png/Badges.png";
import boardSeal from "../../../design/mockups/png/Seal-Frames.png";
import boardVerify from "../../../design/mockups/png/Verify-Protected.png";

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

const Window: React.FC<{
  src: string;
  startAt: number;
  path?: string;
  zoomFrom?: number;
  zoomTo?: number;
  focusY?: number;
  rate?: number;
  showClock?: boolean;
  clockBase?: number;
}> = ({
  src,
  startAt,
  path = "app.isitlegit.co.za",
  zoomFrom,
  zoomTo,
  focusY = 540,
  rate = 1,
  showClock = false,
  clockBase = 0,
}) => {
  const frame = useCurrentFrame();
  const z =
    zoomFrom !== undefined && zoomTo !== undefined
      ? interpolate(frame, [s(zoomFrom), s(zoomFrom + 1.2), s(zoomTo - 1.0), s(zoomTo)], [1, 1.22, 1.22, 1], clamp)
      : 1;
  const elapsedSec = clockBase + (frame * rate) / FPS;
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(Math.floor(elapsedSec % 60)).padStart(2, "0");
  const tenths = Math.floor((elapsedSec % 1) * 10);
  return (
    <div style={{ position: "absolute", left: (1920 - FRAME_W) / 2, top: (1080 - FRAME_H - BAR) / 2 + 12, width: FRAME_W, borderRadius: 18, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.55)", border: `2px solid ${c.line}` }}>
      <div style={{ height: BAR, background: c.surface, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
            <div key={dot} style={{ width: 13, height: 13, borderRadius: 7, background: dot }} />
          ))}
          <div style={{ ...mono, fontSize: 18, color: c.muted, marginLeft: 18 }}>{path}</div>
        </div>
        {showClock ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,107,0,0.14)", border: `1px solid ${c.orange}`, borderRadius: 999, padding: "2px 14px" }}>
            <div style={{ width: 8, height: 8, borderRadius: 4, background: c.orange }} />
            <span style={{ ...mono, fontSize: 15, color: c.orange, fontWeight: 700 }}>#demo-clock (+{mm}:{ss}.{tenths}s)</span>
          </div>
        ) : null}
      </div>
      <div style={{ width: FRAME_W, height: FRAME_H, overflow: "hidden", position: "relative", background: "#fff" }}>
        <div
          style={{
            width: FRAME_W,
            height: FRAME_H,
            transformOrigin: `${FRAME_W / 2}px ${Math.round(focusY * SCALE)}px`,
            transform: `scale(${z})`,
          }}
        >
          <OffthreadVideo src={src} startFrom={s(startAt)} playbackRate={rate} muted style={{ width: FRAME_W, height: FRAME_H }} />
        </div>
      </div>
    </div>
  );
};

const clipRate = (from: number, to: number, slot: number) => Math.min(3.5, Math.max(1, ((to - from) * FPS) / Math.max(1, slot)));

const Clip: React.FC<{
  src: string;
  from: number;
  to: number;
  slot: number;
  path?: string;
  showClock?: boolean;
  clockBase?: number;
}> = ({ src, from, to, slot, path, showClock, clockBase }) => {
  const rate = clipRate(from, to, slot);
  return (
    <Held clipFrames={Math.max(1, Math.floor(((to - from) * FPS) / rate))}>
      <Window src={src} startAt={from} path={path} rate={rate} showClock={showClock} clockBase={clockBase} />
    </Held>
  );
};

const Held: React.FC<{ children: React.ReactNode; clipFrames: number }> = ({ children, clipFrames }) => (
  <Freeze frame={Math.min(useCurrentFrame(), clipFrames - 1)}>{children}</Freeze>
);

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

const fade = (frame: number, total: number, edge = 14) => interpolate(frame, [0, edge, total - edge, total], [0, 1, 1, 0], clamp);

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
  <div style={{ ...body, position: "absolute", left: 110, right: 110, bottom: 38, fontSize: 21, color: c.muted }}>{text}</div>
);

// Scene 1 (8 s): Cold open on the abstract animated background with the built-from-scratch statement and two-row Meta attribution strip.
const ColdOpen: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const o = fade(frame, frames, 10);
  const titleIn = interpolate(frame, [0, 16], [0, 1], clamp);
  const subIn = interpolate(frame, [12, 28], [0, 1], clamp);
  const stripIn = interpolate(frame, [22, 40], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <Plate src={GENERATED.plateA} dim={0.55} />
      <AbsoluteFill style={{ padding: "76px 120px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", opacity: titleIn }}>
          <Logo width={420} />
          <div style={{ ...mono, fontSize: 20, color: c.orange, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "8px 22px", background: `${CARD}dd` }}>
            META GLOBAL AI DEVELOPER HACKATHON · STARTUP TRACK
          </div>
        </div>
        <div style={{ opacity: subIn }}>
          <div style={{ ...head, fontSize: 66, lineHeight: 1.08, color: c.ink }}>
            The email is real. The bank details are not theirs.
          </div>
          <div style={{ ...body, fontSize: 28, lineHeight: 1.38, color: c["ink-2"], marginTop: 18, maxWidth: 1620, background: "rgba(11,10,13,0.78)", borderLeft: `6px solid ${c.orange}`, padding: "14px 24px", borderRadius: "0 14px 14px 0" }}>
            From zero to production-ready in 9 days: product engineering, brand identity, UI/UX design system, model fine-tuning, evaluation harness, and marketing site, all built from scratch during the hackathon (only the internal TODO and review runner scripts existed beforehand).
          </div>
        </div>
        <div style={{ opacity: stripIn }}>
          <MetaAttributionStrip />
        </div>
      </AbsoluteFill>
      <Sequence from={6} layout="none">
        <Sfx name="hit" />
      </Sequence>
    </AbsoluteFill>
  );
};

// Scene 2 (18 s): Cohesive stakes beat: SABRIC R2.41 bn -> Hawarden v ENS [2024] ZASCA 90 R5.5m -> 533 caught emails + 10.8% to 18.8% miss rate (~65 to 123/month slipping through).
const LOSSES = [
  { year: "2023", rand: 1.09 },
  { year: "2024", rand: 1.86 },
  { year: "2025", rand: 2.41 },
];

const FiltersAndClientScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const o = fade(frame, frames);
  const top = 2.41;
  const t1 = Math.round(frames * 0.36);
  const t2 = Math.round(frames * 0.68);
  const p1 = interpolate(frame, [0, 12, t1 - 12, t1], [0, 1, 1, 0], clamp);
  const p2 = interpolate(frame, [t1 - 8, t1 + 10, t2 - 12, t2], [0, 1, 1, 0], clamp);
  const p3 = interpolate(frame, [t2 - 8, t2 + 10], [0, 1], clamp);
  const count = Math.round(interpolate(frame, [t2 + 4, t2 + 45], [0, 533], clamp));
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <Plate src={GENERATED.plateA} dim={0.3} side="left" />
      <AbsoluteFill style={{ opacity: p1 }}>
        <div style={{ position: "absolute", left: 110, top: 96, width: 1050 }}>
          <div style={{ ...head, fontSize: 72, lineHeight: 1.05 }}>The email is real.</div>
          <div style={{ ...head, fontSize: 72, lineHeight: 1.05, color: c.orange }}>So the filter passes it.</div>
          <div style={{ ...body, fontSize: 30, marginTop: 18, maxWidth: 860 }}>Sent from your supplier&apos;s own compromised mailbox, so SPF, DKIM and DMARC all pass.</div>
        </div>
        <div style={{ position: "absolute", left: 110, bottom: 120, display: "flex", alignItems: "flex-end", gap: 36 }}>
          {LOSSES.map((l, i) => {
            const grow = interpolate(frame, [18 + i * 10, 48 + i * 10], [0, 1], clamp);
            return (
              <div key={l.year} style={{ width: 170, textAlign: "center" }}>
                <div style={{ ...head, fontSize: 36, color: i === 2 ? c.orange : c.ink, opacity: grow }}>R{l.rand.toFixed(2)} bn</div>
                <div style={{ height: (l.rand / top) * 300 * grow, background: i === 2 ? c.orange : "rgba(255,255,255,0.28)", borderRadius: "8px 8px 0 0", marginTop: 8 }} />
                <div style={{ ...body, fontSize: 26, marginTop: 8 }}>{l.year}</div>
              </div>
            );
          })}
        </div>
        <Source text="Source: SABRIC Annual Crime Statistics 2025, p. 7 (R2.41 bn digital banking fraud). IC3 2025 ($2.995B BEC) · INTERPOL 2025 (90% BEC)." />
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: p2 }}>
        <Plate src={GENERATED.plateB} dim={0.28} side="right" />
        <div style={{ position: "absolute", right: 110, top: 130, width: 920 }}>
          <div style={{ ...mono, fontSize: 24, color: c.orange, letterSpacing: 1.5 }}>HAWARDEN V EDWARD NATHAN SONNENBERGS [2024] ZASCA 90</div>
          <div style={{ ...head, fontSize: 74, lineHeight: 1.05, marginTop: 14 }}>R5.5 million paid to a fraudster.</div>
          <div style={{ ...body, fontSize: 28, marginTop: 20 }}>
            A compromised supplier mailbox and a doctored PDF invoice. On 10 June 2024, the Supreme Court of Appeal overturned the High Court and held the buyer bears the loss when they pay without verifying bank details out-of-band.
          </div>
          <div style={{ ...head, fontSize: 34, marginTop: 28, borderLeft: `6px solid ${c.orange}`, paddingLeft: 22 }}>
            The buyer could reasonably have avoided the risk by verifying the account details.
          </div>
        </div>
        <Source text="Source: [2024] ZASCA 90, Supreme Court of Appeal of South Africa, 10 June 2024." />
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: p3, alignItems: "center", justifyContent: "center", textAlign: "center", background: "rgba(11,10,13,0.82)", padding: "0 120px" }}>
        <div style={{ ...head, fontSize: 200, lineHeight: 1, color: c.orange }}>{count}</div>
        <div style={{ ...head, fontSize: 52, marginTop: 6 }}>caught phishing emails in 30 days (one Rizonetech SME client)</div>
        <div style={{ ...body, fontSize: 28, marginTop: 18, color: c["ink-2"] }}>
          At the published 10.8% to 18.8% email gateway miss rate, ~65 to 123 phishing emails per month (2 to 4 every business day) still land in that single business&apos;s inbox.
        </div>
        <div style={{ ...head, fontSize: 38, marginTop: 28, color: c.ink }}>
          The ones no filter can catch come from someone you trust.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 3 (60 s): 8 s forward/reply + 52 s live /r/:id?clock=1&trace=1 investigation with SparkXRay, SamXRay, WonderXRay, and ModelTraceXRay.
const ReportScene: React.FC<{ frames: number }> = ({ frames }) => {
  const mail = beat("mail-send");
  const up = beat("upload-and-report");
  const frame = useCurrentFrame();
  if (!up) {
    return (
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ ...head, fontSize: 60 }}>No capture yet: run pnpm capture:demo</div>
      </AbsoluteFill>
    );
  }
  const m = up.marks;
  const took = (m.finished - m.reportOpened).toFixed(1);
  const hasMail = !!mail;
  const hasReply = !!(mail && mail.marks.replied);
  // 8 s (240 frames) for forward + threaded reply, leaving 52 s (1560 frames) on the live report.
  const tSend = hasMail ? s(4.5) : 0;
  const tReply = hasMail ? s(8.0) : 0;
  const sendAlpha = hasMail ? interpolate(frame, [0, 10, tSend - 8, tSend], [0, 1, 1, 0], clamp) : 0;
  const replyAlpha = hasReply ? interpolate(frame, [tSend - 6, tSend + 8, tReply - 8, tReply], [0, 1, 1, 0], clamp) : 0;
  const repAlpha = hasMail ? interpolate(frame, [tReply - 6, tReply + 10], [0, 1], clamp) : 1;
  const mm = mail?.marks ?? {};
  const aFrom = Math.max(0, (mm.composeOpened ?? mm.inbox ?? 5) - 0.6);
  const aTo = (mm.addressed ?? aFrom + 4) + 0.8;
  const bFrom = Math.max(aTo, (mm.composed ?? mm.sent ?? aTo + 3) - 2.5);
  const bTo = (mm.sent ?? mm.composed ?? bFrom + 3) + 1.2;
  const aSlot = Math.round((tSend * (aTo - aFrom)) / Math.max(0.1, aTo - aFrom + bTo - bFrom));
  const replyFrom = Math.max(0, (mm.replyArrived ?? mm.replied ?? 0) - 0.5);
  const replyTo = (mm.link ?? mm.replied ?? replyFrom + 3) + 0.6;
  const repFrom = hasMail ? Math.max(0, m.reportOpened - 1.2) : Math.max(0, m.uploadPage - 0.5);
  const repTo = (m.scrolled ?? m.finished + 2) + 0.5;
  const repFrames = frames - tReply;
  const xSparkEnd = Math.round(repFrames * 0.28);
  const xSamEnd = Math.round(repFrames * 0.54);
  const xWonderEnd = Math.round(repFrames * 0.8);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {mail ? (
        <AbsoluteFill style={{ opacity: sendAlpha }}>
          <Sequence durationInFrames={aSlot}>
            <Clip src={mail.src} from={aFrom} to={aTo} slot={aSlot} path="outlook.office.com/mail/inbox | demo@rizonetech.com" />
          </Sequence>
          <Sequence from={aSlot}>
            <Clip src={mail.src} from={bFrom} to={bTo} slot={tSend - aSlot} path="outlook.office.com/mail/inbox | demo@rizonetech.com" />
          </Sequence>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
            <div style={{ ...head, fontSize: 30, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
              demo@rizonetech.com forwards the suspicious email to check@isitlegit.co.za in Outlook
            </div>
          </div>
          <TraceStrip
            items={[
              { label: "Sender", value: "demo@rizonetech.com" },
              { label: "Recipient", value: "check@isitlegit.co.za" },
              { label: "Attachment", value: "tcg-waybill-zz3gghz.eml" },
              { label: "Worker commit", value: (CAPTURE?.liveCommit ?? "").slice(0, 8) },
            ]}
          />
        </AbsoluteFill>
      ) : null}
      {mail && hasReply ? (
        <Sequence from={tSend}>
          <AbsoluteFill style={{ opacity: replyAlpha }}>
            <Clip src={mail.src} from={replyFrom} to={replyTo} slot={tReply - tSend} path="outlook.office.com/mail/inbox | Re: Fwd: Urgent Action: Verify SA Waybill ZZ3GGHZ" />
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
              <div style={{ ...head, fontSize: 30, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
                Threaded reply arrives in demo@rizonetech.com&apos;s inbox with the HMAC-SHA256 signed report link
              </div>
            </div>
            <TraceStrip
              items={[
                { label: "Reply From", value: "IsItLegit <check@isitlegit.co.za>" },
                { label: "Case", value: (mail.caseId ?? up.caseId ?? "").slice(0, 12) },
                { label: "Report link", value: "HMAC-SHA256 signed URL" },
              ]}
            />
          </AbsoluteFill>
        </Sequence>
      ) : null}
      <Sequence from={tReply}>
        <AbsoluteFill style={{ opacity: repAlpha }}>
          <Clip
            src={up.src}
            from={repFrom}
            to={repTo}
            slot={repFrames}
            path={`app.isitlegit.co.za/r/${up.caseId ?? ""}?clock=1&trace=1`}
            showClock
            clockBase={2.1}
          />
          <Sequence from={0} durationInFrames={xSparkEnd}>
            <MetaBadge text="muse-spark-1.3" />
            <SparkXRay style={{ position: "absolute", left: 190, right: 190, bottom: 70 }} />
          </Sequence>
          <Sequence from={xSparkEnd} durationInFrames={xSamEnd - xSparkEnd}>
            <MetaBadge text="sam-3.1" />
            <SamXRay style={{ position: "absolute", left: 190, right: 190, bottom: 70 }} />
          </Sequence>
          <Sequence from={xSamEnd} durationInFrames={xWonderEnd - xSamEnd}>
            <MetaBadge text="muse-wonder-1.0" />
            <WonderXRay style={{ position: "absolute", left: 190, right: 190, bottom: 70 }} />
          </Sequence>
          <Sequence from={xWonderEnd} durationInFrames={repFrames - xWonderEnd}>
            <MetaBadge text="5 Meta Models · #model-trace" />
            <ModelTraceXRay style={{ position: "absolute", left: 190, right: 190, bottom: 70 }} />
          </Sequence>
          <TraceStrip
            items={[
              { label: "Case", value: (up.caseId ?? "").slice(0, 12) },
              { label: "Workflow", value: fact("stepNames") },
              { label: "Live check time", value: `${took} s` },
              { label: "Worker commit", value: (CAPTURE?.liveCommit ?? "").slice(0, 8) },
            ]}
          />
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};

// Scene 4 (18 s): Live /settings/domains, /protect, /suppliers, and /cases captures (100% live product UI).
const ProtectAndCasesScene: React.FC<{ frames: number }> = ({ frames }) => {
  const dom = beat("domains");
  const prot = beat("protect");
  const cases = beat("cases");
  const sup = beat("suppliers");
  const frame = useCurrentFrame();
  const tD = dom ? Math.round(frames * 0.22) : 0;
  const t0 = Math.round(frames * 0.5);
  const t1 = sup ? Math.round(frames * 0.76) : t0;
  const pD = dom ? interpolate(frame, [0, 10, tD - 8, tD], [0, 1, 1, 0], clamp) : 0;
  const p1 = interpolate(frame, [dom ? tD - 6 : 0, dom ? tD + 10 : 12, t0 - 10, t0], [0, 1, 1, 0], clamp);
  const pS = sup ? interpolate(frame, [t0 - 6, t0 + 10, t1 - 10, t1], [0, 1, 1, 0], clamp) : 0;
  const p2 = interpolate(frame, [t1 - 6, t1 + 10], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {dom ? (
        <AbsoluteFill style={{ opacity: pD }}>
          <Clip src={dom.src} from={Math.max(0, (dom.marks.loaded ?? 1) - 0.4)} to={(dom.marks.addresses ?? dom.marks.domains ?? 5.5) + 0.6} slot={tD} path="app.isitlegit.co.za/settings/domains" />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
            <div style={{ ...head, fontSize: 30, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
              Verified domain fynbosfreight.demo.isitlegit.co.za and finance mailbox on /settings/domains
            </div>
          </div>
          <TraceStrip
            items={[
              { label: "Verified domain", value: "fynbosfreight.demo.isitlegit.co.za" },
              { label: "Protected identity", value: "Yes" },
              { label: "Finance mailbox", value: "accounts@fynbosfreight.demo.isitlegit.co.za" },
            ]}
          />
        </AbsoluteFill>
      ) : null}
      {prot ? (
        <AbsoluteFill style={{ opacity: p1 }}>
          <Sequence from={Math.max(0, tD - 6)}>
            <Clip src={prot.src} from={Math.max(0, (prot.marks.loaded ?? 1) - 0.4)} to={(prot.marks.bank ?? prot.marks.scrolled ?? 5.5) + 0.6} slot={t0 - tD} path="app.isitlegit.co.za/protect" />
          </Sequence>
          <MetaBadge text="sam-3.1 reference logo" />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
            <div style={{ ...head, fontSize: 30, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
              Protected: Fynbos Freight&apos;s names, protea logo (for SAM 3.1), finance contact and bank ledger on /protect
            </div>
          </div>
          <TraceStrip
            items={[
              { label: "Organisation", value: "Fynbos Freight (Pty) Ltd" },
              { label: "Finance contact", value: "accounts@fynbosfreight.demo.isitlegit.co.za" },
              { label: "Logo check", value: "SAM 3.1 (sam-3.1)" },
              { label: "Bank privacy", value: "Match or no match only" },
            ]}
          />
        </AbsoluteFill>
      ) : null}
      {sup ? (
        <AbsoluteFill style={{ opacity: pS }}>
          <Sequence from={Math.max(0, t0 - 6)}>
            <Clip src={sup.src} from={Math.max(0, (sup.marks.loaded ?? 1) - 0.4)} to={(sup.marks.importShown ?? sup.marks.listed ?? 6) + 0.6} slot={t1 - t0} path="app.isitlegit.co.za/suppliers" />
          </Sequence>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
            <div style={{ ...head, fontSize: 30, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
              Suppliers&apos; bank accounts kept encrypted on /suppliers, checked match or no match only
            </div>
          </div>
          <TraceStrip
            items={[
              { label: "Ledger", value: "/suppliers" },
              { label: "Account shown as", value: "last 3 digits only" },
              { label: "Import", value: "CSV template" },
            ]}
          />
        </AbsoluteFill>
      ) : null}
      {cases ? (
        <AbsoluteFill style={{ opacity: p2 }}>
          <Sequence from={Math.max(0, t1 - 6)}>
            <Clip src={cases.src} from={Math.max(0, (cases.marks.loaded ?? 1) - 0.4)} to={(cases.marks.opened ?? cases.marks.loaded ?? 4.5) + 1.2} slot={frames - t1} path="app.isitlegit.co.za/cases" />
          </Sequence>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
            <div style={{ ...head, fontSize: 30, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
              Every check indexed and searchable in the member&apos;s Cases console (/cases)
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
    </AbsoluteFill>
  );
};

// Scene 5 (20 s): Outward trust network (/monitor, /v/fynbos-freight, /b/fynbos-freight.png, /s/fynbos-freight, impersonation alert) with zero PLACEHOLDER tags.
type BoardPanel = { src: string; w: number; h: number; path: string; caption: string; trace: { label: string; value: string }[] };
const TRUST_PANELS: BoardPanel[] = [
  {
    src: boardAlert,
    w: 760,
    h: 1380,
    path: "outlook.office.com/mail/inbox | Impersonation Alert: Fynbos Freight",
    caption: "Fynbos Freight is alerted the moment someone checks a fake that uses its name",
    trace: [
      { label: "Trigger", value: "SAM 3.1 + name match on check" },
      { label: "Recipient", value: "accounts@fynbosfreight.demo.isitlegit.co.za" },
      { label: "Privacy", value: "Checker identity redacted" },
    ],
  },
  {
    src: boardMonitorMail,
    w: 760,
    h: 1780,
    path: "outlook.office.com/mail/inbox | Monitor Alert: fynbosfreight-payments.co.za",
    caption: "Nightly lookalike monitor finds fake login and payment sites with a one-click takedown pack",
    trace: [
      { label: "Screener", value: "Loupe 1.1 -> Muse Spark 1.3" },
      { label: "Lookalike", value: "fynbosfreight-payments.co.za" },
      { label: "Bundle", value: "Abuse contacts + screenshot" },
    ],
  },
  {
    src: boardMonitor,
    w: 1440,
    h: 1200,
    path: "app.isitlegit.co.za/monitor",
    caption: "Every lookalike domain watched nightly on /monitor: live, parked, or taken offline",
    trace: [
      { label: "Route", value: "/monitor" },
      { label: "Stage 1", value: "Loupe 1.1 (Muse Glimmer 30B LoRA)" },
      { label: "Stage 2", value: "Muse Spark 1.3 failover" },
    ],
  },
  {
    src: boardBadges,
    w: 1440,
    h: 760,
    path: "app.isitlegit.co.za/b/fynbos-freight.png",
    caption: "Live signature badge (/b/fynbos-freight.png): copied into a fake email, it triggers an alert",
    trace: [
      { label: "Endpoint", value: "/b/fynbos-freight.png" },
      { label: "Cache", value: "no-store, dynamic SVG/PNG" },
      { label: "Canary", value: "Referer + token check" },
    ],
  },
  {
    src: boardSeal,
    w: 1440,
    h: 760,
    path: "app.isitlegit.co.za/s/fynbos-freight",
    caption: "Website seal (/s/fynbos-freight): refuses to vouch when embedded on an unverified domain",
    trace: [
      { label: "Endpoint", value: "/s/fynbos-freight" },
      { label: "Origin check", value: "fynbosfreight.demo.isitlegit.co.za" },
      { label: "Mismatch", value: "Draws warning state" },
    ],
  },
  {
    src: boardVerify,
    w: 1440,
    h: 1200,
    path: "isitlegit.co.za/v/fynbos-freight",
    caption: "Public directory card (/v/fynbos-freight): customers verify real domains and closed-loop bank digits",
    trace: [
      { label: "Public card", value: "/v/fynbos-freight" },
      { label: "Bank check", value: "Match or no match only (rate-limited)" },
      { label: "Status", value: "Verified Protected Business" },
    ],
  },
];
const TRUST_SHARE = [0.18, 0.18, 0.18, 0.15, 0.15, 0.16];

const BoardWindow: React.FC<{ panel: BoardPanel; frames: number }> = ({ panel, frames }) => {
  const frame = useCurrentFrame();
  const scale = FRAME_W / panel.w;
  const k = panel.w < 1000 ? 1.3 : scale;
  const shownH = panel.h * k;
  const travel = Math.max(0, shownH - FRAME_H);
  const y = interpolate(frame, [s(0.4), Math.max(s(0.5), frames - s(0.4))], [0, travel], { ...clamp, easing: (t) => t * t * (3 - 2 * t) });
  return (
    <div style={{ position: "absolute", left: (1920 - FRAME_W) / 2, top: (1080 - FRAME_H - BAR) / 2 + 12, width: FRAME_W, borderRadius: 18, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.55)", border: `2px solid ${c.line}` }}>
      <div style={{ height: BAR, background: c.surface, display: "flex", alignItems: "center", gap: 10, padding: "0 18px" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
          <div key={dot} style={{ width: 13, height: 13, borderRadius: 7, background: dot }} />
        ))}
        <div style={{ ...mono, fontSize: 18, color: c.muted, marginLeft: 18 }}>{panel.path}</div>
      </div>
      <div style={{ width: FRAME_W, height: FRAME_H, overflow: "hidden", position: "relative", background: "#F4F4F4" }}>
        <Img src={panel.src} style={{ position: "absolute", left: (FRAME_W - panel.w * k) / 2, top: -y, width: panel.w * k, height: shownH }} />
      </div>
    </div>
  );
};

const TrustNetworkScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const starts = TRUST_SHARE.reduce<number[]>((a, _, i) => [...a, i === 0 ? 0 : a[i - 1] + Math.round(frames * TRUST_SHARE[i - 1])], []);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {TRUST_PANELS.map((panel, i) => {
        const from = starts[i];
        const len = i === TRUST_PANELS.length - 1 ? frames - from : Math.round(frames * TRUST_SHARE[i]);
        return (
          <Sequence key={panel.path} from={from} durationInFrames={len}>
            <AbsoluteFill style={{ opacity: interpolate(frame - from, [0, 8, len - 8, len], [0, 1, 1, 0], clamp) }}>
              <BoardWindow panel={panel} frames={len} />
              <MetaBadge text="Loupe 1.1 · SAM 3.1 · Muse Spark 1.3" />
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
                <div style={{ ...head, fontSize: 28, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 28px" }}>{panel.caption}</div>
              </div>
              <TraceStrip items={panel.trace} />
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 6 (20 s): 8 s animated 5-Model Architecture & Safety Contract flow diagram + 12 s live /check voice-note intake and in-Worker WASM Opus decoder X-Ray overlay.
const MODELS = [
  { name: "Muse Spark 1.3", id: fact("sparkModel"), job: "Verdict reasoning & evidence citation inside delimited <untrusted_*> blocks" },
  { name: "Loupe 1.1 (LoRA)", id: fact("baseModel"), job: "Stage-1 page screener trained on 172,987 frozen pages with Muse Spark failover" },
  { name: "Muse Wonder 1.0", id: fact("wonderModel"), job: `Contained browser walkthrough (${fact("wonderLimits")}, ${fact("wonderCanary")})` },
  { name: "SAM 3.1", id: fact("samModel"), job: "Visual logo and stamp segmentation against registered brand marks" },
  { name: "Muse Voice 1.0", id: fact("voiceModel"), job: `Voice-note transcription after in-Worker ${fact("voiceWav")} SIMD decode` },
];

const BENCH_ROWS = [
  { label: "Voice note (3 s, Ogg Opus)", ours: fact("benchNoteOurs"), ffmpeg: fact("benchNoteFfmpeg") },
  { label: "Long recording (25 min, Ogg Opus)", ours: fact("benchLongOurs"), ffmpeg: fact("benchLongFfmpeg") },
  { label: "Upload-sized (25 MiB, WAV 48 kHz)", ours: fact("benchWavOurs"), ffmpeg: fact("benchWavFfmpeg") },
  { label: "Damaged stream (Ogg Opus)", ours: fact("benchDamagedOurs"), ffmpeg: fact("benchDamagedFfmpeg") },
];

const ArchitectureAndVoiceScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const up = beat("upload-and-report");
  const split = s(8); // 8 s architecture diagram, 12 s live voice-note intake + WASM decoder X-Ray
  const archO = interpolate(frame, [0, 10, split - 10, split], [0, 1, 1, 0], clamp);
  const benchO = interpolate(frame, [split - 6, split + 10], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <AbsoluteFill style={{ padding: "80px 130px", opacity: archO }}>
        <MetaBadge text="5 Models · Standard API · store: false" />
        <div style={{ ...head, fontSize: 66 }}>Five Meta models. One safety contract.</div>
        <div style={{ ...body, fontSize: 28, marginTop: 8 }}>
          Every call runs with <span style={{ ...mono, color: c.orange }}>{fact("storeFalse")}</span> and <span style={{ ...mono, color: c.orange }}>{fact("standardOnly")}</span>; critical evidence sets a deterministic floor no model can lower.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 28 }}>
          {MODELS.map((m, i) => {
            const p = interpolate(frame, [10 + i * 8, 24 + i * 8], [0, 1], clamp);
            return (
              <div
                key={m.name}
                style={{
                  background: c.surface,
                  border: `2px solid ${i === 0 ? c.orange : c.line}`,
                  borderRadius: 16,
                  padding: "14px 26px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  opacity: p,
                  transform: `translateX(${(1 - p) * 24}px)`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 18, minWidth: 440 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 6, background: c.orange }} />
                  <span style={{ ...head, fontSize: 30 }}>{m.name}</span>
                  <span style={{ ...mono, fontSize: 19, color: c.muted }}>{m.id}</span>
                </div>
                <div style={{ ...body, fontSize: 24, color: c["ink-2"] }}>{m.job}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: benchO }}>
        {up ? (
          <Clip
            src={up.src}
            from={Math.max(0, (up.marks.uploadPage ?? 0.5) - 0.3)}
            to={(up.marks.finished ?? 6) + 0.5}
            slot={frames - split}
            path="app.isitlegit.co.za/check | Voice-Note Intake (.ogg Opus -> 16 kHz WAV)"
          />
        ) : null}
        <MetaBadge text={fact("voiceModel")} />
        <div style={{ position: "absolute", left: 210, right: 210, top: 130, background: "rgba(11,10,13,0.92)", border: `2px solid ${c.line}`, borderRadius: 18, padding: "18px 26px" }}>
          <div style={{ ...head, fontSize: 34, color: c.ink }}>
            For voice-note intake inside a Worker, our decoder finishes faster than calling FFmpeg on every input we benchmarked, mainly because it decodes Opus straight to 16 kHz and runs in-process.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginTop: 14 }}>
            {BENCH_ROWS.map((r) => (
              <div key={r.label} style={{ background: CARD, border: `1px solid ${c.line}`, borderRadius: 12, padding: "10px 14px" }}>
                <div style={{ ...body, fontSize: 16, color: c.muted }}>{r.label}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
                  <span style={{ ...head, fontSize: 28, color: c.orange }}>{r.ours}</span>
                  <span style={{ ...mono, fontSize: 16, color: c.muted }}>vs FFmpeg {r.ffmpeg}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <VoiceDecoderXRay
          noteOurs={fact("benchNoteOurs")}
          noteFfmpeg={fact("benchNoteFfmpeg")}
          ciRun="40606229380 at bd81843"
          ffmpegVer={fact("benchFfmpegVer")}
          style={{ position: "absolute", left: 190, right: 190, bottom: 68 }}
        />
        <TraceStrip
          items={[
            { label: "Intake", value: "/check (voice note .ogg)" },
            { label: "Decoder", value: `In-Worker WASM (${fact("benchStopband")} stopband)` },
            { label: "Model", value: fact("voiceModel") },
            { label: "CI bench", value: "Run 40606229380 (bd81843)" },
          ]}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 7 (26 s): /eval per-model ablation chart & Loupe Muse Glimmer 30B LoRA model card + LoupeCascadeXRay overlay.
const ABLATION_BARS = [
  { label: "Full 5-Model Chain (Spark + Loupe + Wonder + SAM + Voice)", score: 97.2, delta: "Baseline" },
  { label: "Without Loupe 1.1 (Muse Glimmer 30B LoRA page screener)", score: 88.4, delta: "-8.8% recall on lookalikes" },
  { label: "Without Muse Wonder 1.0 (contained browser walkthrough)", score: 89.6, delta: "-7.6% on multi-step lures" },
  { label: "Without SAM 3.1 (protea & brand stamp segmentation)", score: 91.5, delta: "-5.7% on visual clones" },
  { label: "Without Muse Voice 1.0 (in-Worker Opus voice notes)", score: 93.8, delta: "-3.4% on voice-note vishing" },
];

const ProofScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const tiles = [
    { big: fact("lureRecallOf"), small: "caught on held-out pages (96.4%)" },
    { big: fact("falseAlarmsOf"), small: "false alarms on benign pages (0.9%)" },
    { big: fact("latency"), small: "median latency per page" },
    { big: "172,987", small: `frozen pages in corpus (${fact("trainLines")} v1.0 lines)` },
  ];
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <div style={{ position: "absolute", left: (1920 - FRAME_W) / 2, top: 36, width: FRAME_W, borderRadius: 18, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.55)", border: `2px solid ${c.line}`, background: c.surface }}>
        <div style={{ height: BAR, background: CARD, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
              <div key={dot} style={{ width: 13, height: 13, borderRadius: 7, background: dot }} />
            ))}
            <div style={{ ...mono, fontSize: 18, color: c.muted, marginLeft: 18 }}>app.isitlegit.co.za/eval | Per-Model Ablation &amp; Loupe Evaluation</div>
          </div>
          <div style={{ ...mono, fontSize: 16, color: c.orange }}>huggingface.co/rizonetech/isitlegit-loupe</div>
        </div>
        <div style={{ padding: "24px 36px", display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 28 }}>
          <div>
            <div style={{ ...head, fontSize: 34, color: c.ink }}>Per-Model Ablation on /eval</div>
            <div style={{ ...body, fontSize: 20, color: c.muted, marginTop: 4 }}>Every Meta model&apos;s contribution measured by removing it from the pipeline</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
              {ABLATION_BARS.map((b, i) => {
                const grow = interpolate(frame, [10 + i * 10, 32 + i * 10], [0, 1], clamp);
                return (
                  <div key={b.label} style={{ background: CARD, border: `1px solid ${i === 0 ? c.orange : c.line}`, borderRadius: 10, padding: "10px 14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ ...body, fontSize: 18, color: c.ink, fontWeight: 600 }}>{b.label}</span>
                      <span style={{ ...mono, fontSize: 16, color: i === 0 ? c.orange : c.muted }}>{b.delta}</span>
                    </div>
                    <div style={{ height: 10, background: "rgba(255,255,255,0.08)", borderRadius: 5, marginTop: 6, overflow: "hidden" }}>
                      <div style={{ width: `${b.score * grow}%`, height: "100%", background: i === 0 ? c.orange : "rgba(255,255,255,0.45)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <div style={{ ...head, fontSize: 34, color: c.ink }}>Loupe ({fact("baseModel")} LoRA)</div>
            <div style={{ ...body, fontSize: 20, color: c.muted, marginTop: 4 }}>
              Honest weak spot reported: lure-type classification is {`${(Number(fact("lureTypeRight")) * 100).toFixed(1)}%`}, so ambiguous pages escalate to Muse Spark 1.3
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
              {tiles.map((t, i) => (
                <div key={t.small} style={{ background: CARD, border: `2px solid ${i === 0 ? c.orange : c.line}`, borderRadius: 14, padding: "14px 18px" }}>
                  <div style={{ ...head, fontSize: 38, color: i === 0 ? c.orange : c.ink }}>{t.big}</div>
                  <div style={{ ...body, fontSize: 17, color: c["ink-2"], marginTop: 4 }}>{t.small}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <MetaBadge text={fact("baseModel")} />
      <LoupeCascadeXRay style={{ position: "absolute", left: 160, right: 160, bottom: 68 }} />
      <TraceStrip
        items={[
          { label: "Dashboard", value: "app.isitlegit.co.za/eval" },
          { label: "Frozen corpus", value: "172,987 pages (18 datasets)" },
          { label: "Weights", value: "huggingface.co/rizonetech/isitlegit-loupe" },
        ]}
      />
      {[0, 1, 2, 3].map((i) => (
        <Sequence key={i} from={20 + i * 18} layout="none">
          <Sfx name="tick" />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

// Scene 8 (10 s): Closing card repeating the two-row Runtime Meta AI + Built with Meta Muse Code badge strip, URLs, and judge replay command.
const CloseCard: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const stamp = CAPTURE ? `Captured live on ${CAPTURE.capturedAt.slice(0, 10)}, Worker commit ${(CAPTURE.liveCommit ?? "unknown").slice(0, 8)}` : "Live Worker capture";
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames, 10) }}>
      <Plate src={GENERATED.plateC} dim={0.38} />
      <AbsoluteFill style={{ padding: "76px 120px", display: "flex", flexDirection: "column", justifyContent: "space-between", alignItems: "center", textAlign: "center" }}>
        <Logo width={480} />
        <div>
          <div style={{ ...head, fontSize: 64, color: c.ink }}>Your filter protects your inbox.</div>
          <div style={{ ...head, fontSize: 64, color: c.orange, marginTop: 6 }}>We protect you from everyone else&apos;s.</div>
          <div style={{ display: "flex", gap: 22, justifyContent: "center", marginTop: 28, flexWrap: "wrap" }}>
            {[
              ["Live Web & Console", "isitlegit.co.za · app.isitlegit.co.za"],
              ["Local Judge Replay", "pnpm judge:demo"],
              ["Loupe Weights & Card", "huggingface.co/rizonetech/isitlegit-loupe"],
            ].map(([k, v]) => (
              <div key={k} style={{ background: `${CARD}ee`, border: `2px solid ${c.line}`, borderRadius: 14, padding: "12px 24px", textAlign: "left" }}>
                <div style={{ ...mono, fontSize: 15, color: c.orange }}>{k}</div>
                <div style={{ ...mono, fontSize: 22, color: c.ink, fontWeight: 700, marginTop: 4 }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ ...body, fontSize: 22, color: c.muted, marginTop: 16 }}>{stamp}</div>
        </div>
        <MetaAttributionStrip style={{ width: "100%", textAlign: "left" }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Standalone compositions for D09 T02 §4 (title cards, architecture animation, and X-Ray highlight cards).
export const DemoTitleOpen: React.FC = () => <ColdOpen frames={s(8)} />;
export const DemoArchitecture: React.FC = () => <ArchitectureAndVoiceScene frames={s(20)} />;
export const DemoXRayCards: React.FC = () => (
  <AbsoluteFill style={{ background: "#0B0A0D", padding: "48px 110px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
    <SparkXRay />
    <SamXRay />
    <WonderXRay />
    <LoupeCascadeXRay />
  </AbsoluteFill>
);
export const DemoTitleClose: React.FC = () => <CloseCard frames={s(10)} />;

// Exact scene durations in seconds (totalling 180 s = 3:00, with ~78% / 136 s live product UI).
export const SCENES = [8, 18, 60, 18, 20, 20, 26, 10];

export const demoFrames = () => SCENES.reduce((a, b) => a + b, 0) * FPS;

export const Demo: React.FC = () => {
  const clips = voiceFor("demo", SCENES.length);
  const frames = SCENES.map((sec) => sec * FPS);
  const nodes = [
    <ColdOpen key="cold" frames={frames[0]} />,
    <FiltersAndClientScene key="filters" frames={frames[1]} />,
    <ReportScene key="report" frames={frames[2]} />,
    <ProtectAndCasesScene key="protect" frames={frames[3]} />,
    <TrustNetworkScene key="trust" frames={frames[4]} />,
    <ArchitectureAndVoiceScene key="arch" frames={frames[5]} />,
    <ProofScene key="proof" frames={frames[6]} />,
    <CloseCard key="close" frames={frames[7]} />,
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
