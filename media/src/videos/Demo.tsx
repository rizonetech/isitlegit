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
// Approved boards for the trust-network features still being built (design/mockups/png, operator approval 2026-10-26).
// They stand in for the live capture in drafts only; each is replaced by a capture of the live service before the
// final cut, which shows built features alone (operator, 2026-11-01).
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

const Window: React.FC<{ src: string; startAt: number; path?: string; zoomFrom?: number; zoomTo?: number; focusY?: number; rate?: number }> = ({
  src,
  startAt,
  path = "app.isitlegit.co.za",
  zoomFrom,
  zoomTo,
  focusY = 540,
  rate = 1,
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

/**
 * One stretch of a capture, from `from` to `to` seconds of the take, played into a slot of `slot` frames: in real time
 * when it fits, sped up (at most 3.5x) when the clicks and typing take longer than the narration allows, and held on
 * its last frame only when the take runs out first. The pointer drawn in the capture (capture/cursor.ts) keeps moving
 * throughout, so the page is seen being used rather than shown.
 */
const clipRate = (from: number, to: number, slot: number) => Math.min(3.5, Math.max(1, ((to - from) * FPS) / Math.max(1, slot)));

const Clip: React.FC<{ src: string; from: number; to: number; slot: number; path?: string }> = ({ src, from, to, slot, path }) => {
  const rate = clipRate(from, to, slot);
  return (
    <Held clipFrames={Math.max(1, Math.floor(((to - from) * FPS) / rate))}>
      <Window src={src} startAt={from} path={path} rate={rate} />
    </Held>
  );
};

/** The clip plays, then holds its last frame for as long as the scene runs on. */
const Held: React.FC<{ children: React.ReactNode; clipFrames: number }> = ({ children, clipFrames }) => (
  <Freeze frame={Math.min(useCurrentFrame(), clipFrames - 1)}>{children}</Freeze>
);

type Caption = { at: number; hold: number; text: string };

const Captions: React.FC<{ startAt: number; items: Caption[]; rate?: number }> = ({ startAt, items, rate = 1 }) => {
  const t = startAt + (useCurrentFrame() * rate) / FPS;
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

// Scene 3: sending the suspicious email from demo@rizonetech.com in Outlook to check@isitlegit.co.za, receiving the
// threaded reply, and inspecting the live report with extracted E4/E5 prompt-injection and E3/E6 link evidence cards.
const ReportScene: React.FC<{ frames: number }> = ({ frames }) => {
  const mail = beat("mail-send");
  const up = beat("upload-and-report");
  const frame = useCurrentFrame();
  if (!up) return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}><div style={{ ...head, fontSize: 60 }}>No capture yet: run pnpm capture:demo</div></AbsoluteFill>;
  const m = up.marks;
  const took = (m.finished - m.reportOpened).toFixed(1);
  const hasMail = !!mail;
  const hasReply = !!(mail && mail.marks.replied);
  // The send takes the opening of the narration ("Forward it to Is It Legit"), the reply a short beat, and the live
  // report the rest; each stretch plays its real clicks and typing, sped up to fit (Clip).
  const tSend = hasMail ? Math.round(frames * (hasReply ? 0.34 : 0.4)) : 0;
  const tReply = hasMail ? (hasReply ? Math.round(frames * 0.5) : tSend) : 0;
  const sendAlpha = hasMail ? interpolate(frame, [0, 12, tSend - 10, tSend], [0, 1, 1, 0], clamp) : 0;
  const replyAlpha = hasReply ? interpolate(frame, [tSend - 6, tSend + 10, tReply - 10, tReply], [0, 1, 1, 0], clamp) : 0;
  const repAlpha = hasMail ? interpolate(frame, [tReply - 6, tReply + 12], [0, 1], clamp) : 1;
  const mm = mail?.marks ?? {};
  // The send is two stretches joined by a cut: addressing the message, then attaching the lure and pressing Send. The
  // wait in between (Outlook loading the compose tools, the upload) is cut, so neither stretch has to race.
  const aFrom = Math.max(0, (mm.composeOpened ?? mm.inbox ?? 5) - 0.6);
  const aTo = (mm.addressed ?? aFrom + 4) + 0.8;
  const bFrom = Math.max(aTo, (mm.composed ?? mm.sent ?? aTo + 3) - 2.5);
  const bTo = (mm.sent ?? mm.composed ?? bFrom + 3) + 1.2;
  const aSlot = Math.round((tSend * (aTo - aFrom)) / Math.max(0.1, aTo - aFrom + bTo - bFrom));
  const replyFrom = Math.max(0, (mm.replyArrived ?? mm.replied ?? 0) - 0.5);
  const replyTo = (mm.link ?? mm.replied ?? replyFrom + 3) + 0.6;
  const repFrom = hasMail ? Math.max(0, m.reportOpened - 1.2) : Math.max(0, m.uploadPage - 0.5);
  const repTo = (m.scrolled ?? m.finished + 2) + 0.5;
  const repRate = clipRate(repFrom, repTo, frames - tReply);
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
            <div style={{ ...head, fontSize: 32, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
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
              <div style={{ ...head, fontSize: 32, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
                Threaded reply arrives in demo@rizonetech.com's inbox with the signed report link
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
          <Clip src={up.src} from={repFrom} to={repTo} slot={frames - tReply} path={`app.isitlegit.co.za/r/${up.caseId ?? ""}`} />
          <Captions
            startAt={repFrom}
            rate={repRate}
            items={[
              { at: m.reportOpened, hold: Math.max(1.2, m.finished - m.reportOpened), text: `Live report polling ${fact("reportPoll")}` },
              { at: m.finished, hold: Math.max(2.5, (m.evidenceStart ?? m.finished + 3.2) - m.finished + 2 * repRate), text: `E4 & E5: Hidden text written to steer an AI extracted (${took} s)` },
              { at: (m.evidenceStart ?? m.finished + 3.2) + 2 * repRate, hold: Math.max(3, repTo - (m.evidenceStart ?? m.finished + 3.2)), text: "E3 & E6: Reply-To mismatch and deceptive link target cited" },
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
      </Sequence>
    </AbsoluteFill>
  );
};

// Scene 4: Protected identity (/protect and /settings/domains), supplier ledger (/suppliers), Cases console (/cases), and the Hawarden v ENS verification ruling.
const ProtectAndCasesScene: React.FC<{ frames: number }> = ({ frames }) => {
  const dom = beat("domains");
  const prot = beat("protect");
  const cases = beat("cases");
  const sup = beat("suppliers");
  const frame = useCurrentFrame();
  // Protect (and /settings/domains when captured), then the supplier ledger (while the narration names bank accounts), then cases, then Hawarden.
  const tD = dom ? Math.round(frames * 0.12) : 0;
  const t0 = Math.round(frames * (sup ? 0.34 : 0.42));
  const t1 = sup ? Math.round(frames * 0.49) : t0;
  const t2 = Math.round(frames * 0.7);
  const pD = dom ? interpolate(frame, [0, 12, tD - 10, tD], [0, 1, 1, 0], clamp) : 0;
  const p1 = interpolate(frame, [dom ? tD - 6 : 0, dom ? tD + 12 : 14, t0 - 12, t0], [0, 1, 1, 0], clamp);
  const pS = sup ? interpolate(frame, [t0 - 6, t0 + 12, t1 - 12, t1], [0, 1, 1, 0], clamp) : 0;
  const p2 = interpolate(frame, [t1 - 6, t1 + 12, t2 - 12, t2], [0, 1, 1, 0], clamp);
  const p3 = interpolate(frame, [t2 - 6, t2 + 14], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {dom ? (
        <AbsoluteFill style={{ opacity: pD }}>
          <Clip src={dom.src} from={Math.max(0, (dom.marks.loaded ?? 1) - 0.4)} to={(dom.marks.addresses ?? dom.marks.domains ?? 5.5) + 0.6} slot={tD} path="app.isitlegit.co.za/settings/domains" />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
            <div style={{ ...head, fontSize: 32, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
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
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
            <div style={{ ...head, fontSize: 32, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
              Protected: Fynbos Freight's names, protea logo (for SAM 3.1), finance contact and bank ledger on /protect
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
            <div style={{ ...head, fontSize: 32, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>
              Suppliers' bank accounts kept encrypted, checked match or no match
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
            <Clip src={cases.src} from={Math.max(0, (cases.marks.loaded ?? 1) - 0.4)} to={(cases.marks.opened ?? cases.marks.loaded ?? 4.5) + 1.2} slot={t2 - t1} path="app.isitlegit.co.za/cases" />
          </Sequence>
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
// Scene 5 (draft): the trust network's outward side, from approved boards until each feature is live. Every panel says
// it is a placeholder and which plan section replaces it, so no draft viewer mistakes a board for the live service.
type BoardPanel = { src: string; w: number; h: number; path: string; caption: string; section: string };
const TRUST_PANELS: BoardPanel[] = [
  { src: boardAlert, w: 760, h: 1380, path: "Outlook | Someone is impersonating Fynbos Freight", caption: "Fynbos Freight is alerted when someone checks a fake that uses its name", section: "D05 T02 §4" },
  { src: boardMonitorMail, w: 760, h: 1780, path: "Outlook | Fake website found: fynbosfreight-payments.example", caption: "The monitor finds fake login and payment sites, with a takedown pack", section: "D05 T04 §5" },
  { src: boardMonitor, w: 1440, h: 1200, path: "app.isitlegit.co.za/monitor", caption: "Every lookalike watched nightly: live, parked, taken offline", section: "D05 T04 §6" },
  { src: boardBadges, w: 1440, h: 760, path: "app.isitlegit.co.za/b/fynbos-freight.png", caption: "A live signature badge: copied into a fake, it triggers an alert", section: "D05 T02 §7, §8" },
  { src: boardSeal, w: 1440, h: 760, path: "app.isitlegit.co.za/s/fynbos-freight", caption: "A website seal the browser refuses to draw on a counterfeit domain", section: "D05 T02 §9" },
  { src: boardVerify, w: 1440, h: 1200, path: "isitlegit.co.za/v/fynbos-freight", caption: "Customers check the real addresses on the verify page", section: "D05 T02 §9" },
];
// Each panel's share of the scene, in the narration's order: alert, monitor (mail, then page), badge, seal, verify.
const TRUST_SHARE = [0.2, 0.2, 0.14, 0.16, 0.16, 0.14];

const BoardWindow: React.FC<{ panel: BoardPanel; frames: number }> = ({ panel, frames }) => {
  const frame = useCurrentFrame();
  const scale = FRAME_W / panel.w;
  // A board narrower than the window (the 760 px emails) sits centred at 1.3x, the width a mail client shows it.
  const k = panel.w < 1000 ? 1.3 : scale;
  const shownH = panel.h * k;
  const travel = Math.max(0, shownH - FRAME_H);
  const y = interpolate(frame, [s(0.6), Math.max(s(0.7), frames - s(0.6))], [0, travel], { ...clamp, easing: (t) => t * t * (3 - 2 * t) });
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

const PlaceholderTag: React.FC<{ section: string }> = ({ section }) => (
  <div style={{ position: "absolute", left: (1920 - FRAME_W) / 2 + 24, top: (1080 - FRAME_H - BAR) / 2 + 12 + BAR + 18, display: "flex", alignItems: "center", gap: 10, background: "#FFF4D6", border: "2px dashed #B7791F", borderRadius: 10, padding: "8px 16px" }}>
    <span style={{ ...mono, fontSize: 18, fontWeight: 700, color: "#7A4B00" }}>PLACEHOLDER</span>
    <span style={{ ...body, fontSize: 18, color: "#7A4B00" }}>approved design, being built ({section})</span>
  </div>
);

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
            <AbsoluteFill style={{ opacity: interpolate(frame - from, [0, 10, len - 8, len], [0, 1, 1, 0], clamp) }}>
              <BoardWindow panel={panel} frames={len} />
              <PlaceholderTag section={panel.section} />
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 72, display: "flex", justifyContent: "center" }}>
                <div style={{ ...head, fontSize: 32, color: c.ink, background: c.surface, border: `2px solid ${c.orange}`, borderRadius: 999, padding: "10px 30px" }}>{panel.caption}</div>
              </div>
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

// Floors under each scene; the voice sets the length when longer (voicedFrames). The whole cut stays under 3 minutes.
const SCENES = [12, 22, 22, 26, 12, 22, 26, 12];

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
