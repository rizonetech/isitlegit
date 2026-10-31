// The 3-minute demo video (D09 T02 §3 and §4; docs/specs/2026-10-31-demo-video-design.md), built from captures of the
// live service (media/capture/). Every clip is the live app as the rig recorded it; every time on screen is measured
// from the capture's own marks, and every zoom lands on the boxes the rig read from the page. With no capture, the
// cards render alone. Beats whose features are not live yet (the invoice hero, the walkthrough) join as they deploy.
import type React from "react";
import { interpolate, OffthreadVideo, Sequence, Series, useCurrentFrame } from "remotion";
import { CAPTURE } from "../data/demo-capture";
import { Backdrop, body, c, CloseScene, head, mono, TitleScene } from "../brand";

const FPS = 30;
const s = (seconds: number) => Math.max(1, Math.round(seconds * FPS));
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

type Box = { x: number; y: number; width: number; height: number };
type Beat = { src: string; caseId: string | null; marks: Record<string, number>; boxes: Record<string, Box | null> };
const beat = (name: string): Beat | null => ((CAPTURE?.beats as Record<string, Beat> | undefined)?.[name] ?? null);

// The browser window the footage sits in: the capture is 1920 x 1080, shown at FRAME_W wide under a title bar.
const FRAME_W = 1600;
const SCALE = FRAME_W / 1920;
const FRAME_H = Math.round(1080 * SCALE);
const BAR = 44;

/** A zoom from the whole page to a box and back: [start, end] in seconds of the clip, the box in page pixels. */
type Zoom = { from: number; to: number; box: Box; fill?: number };

/** The scale k and the page point (fx, fy) that sits at the frame's centre at clip time t. */
function zoomAt(t: number, zooms: Zoom[]): { k: number; fx: number; fy: number } {
  for (const z of zooms) {
    const ramp = 0.6;
    const p = Math.min(interpolate(t, [z.from, z.from + ramp], [0, 1], clamp), interpolate(t, [z.to - ramp, z.to], [1, 0], clamp));
    if (p <= 0) continue;
    // Fill a share of the frame with the box, never zooming past 2x so text stays sharp.
    const k = 1 + (Math.min(2, Math.min(1920 / z.box.width, 1080 / z.box.height) * (z.fill ?? 0.8)) - 1) * p;
    return { k, fx: 960 + (z.box.x + z.box.width / 2 - 960) * p, fy: 540 + (z.box.y + z.box.height / 2 - 540) * p };
  }
  return { k: 1, fx: 960, fy: 540 };
}

const Window: React.FC<{ src: string; startAt: number; zooms: Zoom[] }> = ({ src, startAt, zooms }) => {
  const frame = useCurrentFrame();
  const z = zoomAt(startAt + frame / FPS, zooms);
  return (
    <div style={{ position: "absolute", left: (1920 - FRAME_W) / 2, top: (1080 - FRAME_H - BAR) / 2 + 20, width: FRAME_W, borderRadius: 18, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.45)", border: `2px solid ${c.line}` }}>
      <div style={{ height: BAR, background: c.surface, display: "flex", alignItems: "center", gap: 10, padding: "0 18px" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
          <div key={dot} style={{ width: 13, height: 13, borderRadius: 7, background: dot }} />
        ))}
        <div style={{ ...mono, fontSize: 18, color: c.muted, marginLeft: 18 }}>app.isitlegit.co.za</div>
      </div>
      <div style={{ width: FRAME_W, height: FRAME_H, overflow: "hidden", position: "relative", background: "#fff" }}>
        <div style={{ width: 1920, height: 1080, transformOrigin: "0 0", transform: `scale(${SCALE}) translate(${960 - z.fx * z.k}px, ${540 - z.fy * z.k}px) scale(${z.k})` }}>
          <OffthreadVideo src={src} startFrom={s(startAt)} muted style={{ width: 1920, height: 1080 }} />
        </div>
      </div>
    </div>
  );
};

/** A short caption naming what the viewer sees, shown from `at` seconds into the clip for `hold` seconds. */
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

type Part = { key: string; frames: number; node: React.ReactNode };

function clipPart(key: string, b: Beat, from: number, to: number, zooms: Zoom[], captions: Caption[]): Part {
  return {
    key,
    frames: s(to - from),
    node: (
      <>
        <Window src={b.src} startAt={from} zooms={zooms} />
        <Captions startAt={from} items={captions} />
      </>
    ),
  };
}

function parts(): Part[] {
  const out: Part[] = [{ key: "title", frames: s(4), node: <TitleScene line="IsItLegit" sub="Forward a suspicious email. Get a verdict, with the evidence." /> }];
  const up = beat("upload-and-report");
  if (up) {
    const m = up.marks;
    const took = (m.finished - m.reportOpened).toFixed(1);
    const zooms: Zoom[] = [];
    if (up.boxes.verdict) zooms.push({ from: m.finished + 0.2, to: m.finished + 1.4, box: up.boxes.verdict, fill: 0.9 });
    out.push(
      clipPart("upload", up, Math.max(0, m.uploadPage - 0.5), (m.scrolled ?? m.finished + 2) + 0.5, zooms, [
        { at: m.uploadPage, hold: Math.max(1.5, m.fileChosen - m.uploadPage), text: "A saved email, uploaded" },
        { at: m.reportOpened, hold: Math.max(1.5, m.finished - m.reportOpened), text: "The report fills in live" },
        { at: m.finished, hold: 2.5, text: `Checked in ${took} s on the live service` },
      ]),
    );
  }
  const cases = beat("cases");
  if (cases) out.push(clipPart("cases", cases, 0, cases.marks.loaded + 2, [], [{ at: 0.5, hold: 2.5, text: "Every case your business has checked" }]));
  const stamp = CAPTURE ? `Captured live on ${CAPTURE.capturedAt.slice(0, 10)}, commit ${(CAPTURE.liveCommit ?? "unknown").slice(0, 8)}` : "No capture yet";
  out.push({ key: "close", frames: s(5), node: <CloseScene lines={["app.isitlegit.co.za", stamp]} /> });
  return out;
}

export const demoFrames = () => parts().reduce((a, p) => a + p.frames, 0);

export const Demo: React.FC = () => (
  <>
    <Backdrop />
    <Series>
      {parts().map((p) => (
        <Series.Sequence key={p.key} durationInFrames={p.frames}>
          <Sequence>{p.node}</Sequence>
        </Series.Sequence>
      ))}
    </Series>
    {CAPTURE ? null : <div style={{ ...body, position: "absolute", bottom: 20, right: 30, fontSize: 20 }}>cards only: run pnpm capture:demo</div>}
  </>
);
