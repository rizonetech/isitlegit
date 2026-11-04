// Video 04: the judge getting-started guide (D10 T01 §8), about a minute on the live service: sign in, check a
// message and read its report, then Protect, Monitor and the public results page. Every clip is the live app as the
// capture rig recorded it (media/capture/), in the demo's browser window with captions under it, never over it.
import type React from "react";
import { AbsoluteFill, interpolate, Loop, OffthreadVideo, Series, useCurrentFrame } from "remotion";
import { body, c, head, Logo, MetaAttributionStrip, mono } from "../brand";
import { GENERATED } from "../data/demo-capture";
import { MusicBed, Sfx } from "../kit/sound";
import { type Clip, Voice, voiceFor } from "../kit/voice";
import { beat, Caption, Part, Take } from "./Demo";

const FPS = 30;
const s = (sec: number) => Math.max(1, Math.round(sec * FPS));
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const fade = (frame: number, total: number, edge = 12) => interpolate(frame, [0, edge, total - edge, total], [0, 1, 1, 0], clamp);
const LEAD = 0.3;
const TAIL = 0.9;

const Title: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const b = interpolate(frame, [10, 26], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames), alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <Logo width={520} />
      <div style={{ ...head, fontSize: 72, marginTop: 60, opacity: b }}>See it working in a minute</div>
      <div style={{ ...body, fontSize: 32, marginTop: 18, color: c.muted, opacity: b }}>The live service, with the Fynbos Freight demo organisation</div>
    </AbsoluteFill>
  );
};

const CheckScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const up = beat("upload-and-report");
  if (!up) return null;
  const m = up.marks;
  const tUpload = Math.round(frames * 0.3);
  const tWait = tUpload + s(2.5);
  const tVerdict = Math.round(frames * 0.72);
  const report = `app.isitlegit.co.za/r/${up.caseId ?? ""}`;
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      <Part from={0} to={tUpload}>
        <Take src={up.src} from={Math.max(0, m.uploadPage - 0.5)} to={m.fileChosen + 0.5} slot={tUpload} path="app.isitlegit.co.za/upload" />
      </Part>
      <Part from={tUpload} to={tWait}>
        <Take src={up.src} from={m.reportOpened} to={m.finished} slot={tWait - tUpload} path={report} max={40} chip={`checks running · ${(m.finished - m.reportOpened).toFixed(0)} s, shown sped up`} />
      </Part>
      <Part from={tWait} to={tVerdict}>
        <Take src={up.src} from={m.finished - 0.5} to={(m.scrolled ?? m.finished + 12) + 0.5} slot={tVerdict - tWait} path={report} />
      </Part>
      <Part from={tVerdict} to={frames} last>
        <Take src={up.src} from={m.traceShown ?? m.scrolled ?? m.finished} to={(m.traceDone ?? m.scrolled ?? m.finished) + 0.5} slot={frames - tVerdict} path={report} model={{ name: "Muse Spark 1.3", job: "writes the verdict" }} />
      </Part>
      <Caption from={0} to={tUpload} text="Check a file, or forward the email as an attachment to check@isitlegit.co.za" />
      <Caption from={tUpload} to={tVerdict} text="The report fills in live, every finding with its evidence" />
      <Caption from={tVerdict} to={frames} text="The verdict cites each finding, and says what to do first" />
    </AbsoluteFill>
  );
};

const TrustScene: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const prot = beat("protect");
  const mon = beat("monitor");
  const ev = beat("eval");
  const t1 = Math.round(frames * 0.36);
  const t2 = Math.round(frames * 0.66);
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames) }}>
      {prot ? (
        <Part from={0} to={t1}>
          <Take src={prot.src} from={Math.max(0, (prot.marks.loaded ?? 1) - 0.4)} to={(prot.marks.logo ?? 12) + 0.6} slot={t1} path="app.isitlegit.co.za/protect" model={{ name: "SAM 3.1", job: "compares this logo with mail" }} />
        </Part>
      ) : null}
      {mon ? (
        <Part from={t1} to={t2}>
          <Take src={mon.src} from={Math.max(0, (mon.marks.loaded ?? 1) - 0.4)} to={(mon.marks.scrolled ?? 10) + 0.6} slot={t2 - t1} path="app.isitlegit.co.za/monitor" />
        </Part>
      ) : null}
      {ev ? (
        <Part from={t2} to={frames} last>
          <Take src={ev.src} from={Math.max(0, (ev.marks.loaded ?? 1) - 0.3)} to={(ev.marks.scrolled ?? 10) + 0.5} slot={frames - t2} path="app.isitlegit.co.za/eval" max={3} />
        </Part>
      ) : null}
      <Caption from={0} to={t1} text="Protect: the business's names, domains and logo" />
      <Caption from={t1} to={t2} text="Monitor: the lookalike sites it has caught" />
      <Caption from={t2} to={frames} text="Results: how often it is right, published whether good or not" />
    </AbsoluteFill>
  );
};

const Close: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: fade(frame, frames), alignItems: "center", justifyContent: "center", textAlign: "center", paddingBottom: 100 }}>
      <Logo width={480} />
      <div style={{ ...mono, fontSize: 40, marginTop: 56, color: c.ink }}>app.isitlegit.co.za</div>
      <div style={{ ...mono, fontSize: 30, marginTop: 18, color: c.muted }}>github.com/rizonetech/isitlegit</div>
      <MetaAttributionStrip style={{ position: "absolute", left: 0, right: 0, bottom: 60 }} />
    </AbsoluteFill>
  );
};

const SCENES = [Title, CheckScene, TrustScene, Close];
const FLOORS = [6, 22, 18, 7];
const framesFor = (clips: Clip[] | null) => FLOORS.map((f, i) => (clips ? Math.ceil((LEAD + clips[i].seconds + TAIL) * FPS) : f * FPS));

export const judgeGuideFrames = () => framesFor(voiceFor("04", SCENES.length)).reduce((a, b) => a + b, 0);

export const JudgeGuide: React.FC = () => {
  const clips = voiceFor("04", SCENES.length);
  const frames = framesFor(clips);
  const total = frames.reduce((a, b) => a + b, 0);
  const spans: [number, number][] = [];
  let t = 0;
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
