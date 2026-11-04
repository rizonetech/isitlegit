// A case's progress as the report shows it (D07 T03 §4; design/SPEC.md M3 running state, board `Report-Running`), read
// from its recorded step events (`case_events`, src/pipeline/events.ts): each Workflow attempt records `started`, then
// `done` or `error`, and a step that failed after its last attempt records `failed` once. Attempts are reduced per step:
// a later `done` clears an earlier `error`, so a recovered step is never shown failed, and `failed` is a step's last
// word. Pure, so the browser tests can draw it with no storage.

export type StepEvent = {
  step: string;
  status: "started" | "done" | "error" | "failed";
  startedAt: string;
  ms: number | null;
  error: string | null;
};
export type StepState = "waiting" | "running" | "retrying" | "done" | "failed";
// `at`: when the step's last recorded attempt began, so a failure keeps its own time on every later read.
export type Step = {
  step: string;
  words: string;
  state: StepState;
  ms: number | null;
  error: string | null;
  at: string | null;
};
export type Progress = { steps: Step[]; startedAt: string | null; failed: Step | null; current: number };

// The Workflow's steps in the order they run (src/pipeline/analysis-workflow.ts), each in the board's plain words.
export const STEPS: [string, string][] = [
  ["admit", "Received and stored"],
  ["parse", "Opened the message and its attachments"],
  ["checks", "Checked the sender, authentication, domains and content"],
  ["verdict", "Weighed the evidence and prepared the verdict"],
  ["store", "Saved the verdict"],
  ["reply", "Emailed the answer"],
  ["finish", "Finished"],
];

// A step only some cases run, drawn only when the case recorded it (D07 T03 §38): a voice note is transcribed after
// `parse`, and a message without one keeps its list. [step, plain words, the step it follows].
const CONDITIONAL: [string, string, string][] = [
  ["transcribe", "Transcribed the voice note", "parse"],
  ["walkthrough", "Sign-in page walk in a contained browser", "checks"],
];

export function progressOf(events: readonly StepEvent[]): Progress {
  const recorded = new Set(events.map((e) => e.step));
  const listed: [string, string][] = [...STEPS];
  for (const [step, words, after] of CONDITIONAL)
    if (recorded.has(step)) listed.splice(listed.findIndex(([name]) => name === after) + 1, 0, [step, words]);
  const known = new Map(listed);
  // Steps in the Workflow's order, then any recorded step this list does not know, in the order it was recorded.
  const names = [...listed.map(([step]) => step), ...events.map((e) => e.step).filter((step) => !known.has(step))];
  const order = [...new Set(names)];
  const steps = order.map((step): Step => {
    const mine = events.filter((e) => e.step === step);
    const words = known.get(step) ?? "Another step";
    const failed = mine.find((e) => e.status === "failed");
    if (failed) return { step, words, state: "failed", ms: failed.ms, error: failed.error, at: failed.startedAt };
    const done = mine.filter((e) => e.status === "done").at(-1);
    if (done) return { step, words, state: "done", ms: done.ms, error: null, at: done.startedAt };
    const last = mine.at(-1);
    if (!last) return { step, words, state: "waiting", ms: null, error: null, at: null };
    const state = last.status === "error" ? "retrying" : "running";
    return { step, words, state, ms: null, error: last.error, at: last.startedAt };
  });
  const starts = events.map((e) => e.startedAt).filter((at) => !Number.isNaN(Date.parse(at)));
  const startedAt = starts.length ? starts.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
  const failed = steps.find((s) => s.state === "failed") ?? null;
  const running = steps.findIndex((s) => s.state === "running" || s.state === "retrying");
  const lastDone = steps.map((s) => s.state).lastIndexOf("done");
  return { steps, startedAt, failed, current: running >= 0 ? running + 1 : Math.min(steps.length, lastDone + 2) };
}

// A failed step's error class in plain words: the class only, never a message (src/pipeline/events.ts).
// A failed step's words by how the case came. A file that never arrived (`RawMissing`, D07 T03 §40) is worded by how it came: an upload names its file (as text, by
// the stored name) and an email says the message did not arrive in full and to forward it again.
export function errorWords(error: string | null, came?: { channel: "email" | "upload"; uploadName?: string | null }) {
  if (error === "ParseError") return "The message could not be opened: its file is damaged or not a message.";
  if (error === "RawMissing") {
    if (came?.channel === "upload")
      return `${came.uploadName ? `The file "${came.uploadName}"` : "The file"} did not arrive in full, so it could not be checked. Nothing was concluded about it.`;
    return "The message did not arrive in full, so it could not be checked. Nothing was concluded about it. Forward it again.";
  }
  // A recording the member must mend (D07 T03 §38), never "on our side": the fix, by how it came.
  const again = came?.channel === "upload" ? "upload it again" : "forward it again";
  if (error === "CorruptAudio")
    return `The recording is damaged, so it could not be transcribed. Replace it and ${again}.`;
  if (error === "AudioTooLong")
    return `The recording is longer than 30 minutes, so it could not be transcribed. Shorten it to 30 minutes or less and ${again}.`;
  if (error === "UnsupportedAudio")
    return "We cannot transcribe this recording's format. Send it as an Ogg, Opus, WAV or MP3 voice note.";
  if (error === "CaseRefused") return "The case could not be taken for checking.";
  if (error === "Timeout") return "A step ran out of time.";
  if (error?.startsWith("budget:")) return "Today's model limit was reached before the check could finish.";
  return "A step failed on our side. This is not a sign that the message is safe or unsafe.";
}

// A case the intake kept after its file never stored (its `admit` step failed `RawMissing`, written by `endUnstored` in
// src/intake/admit.ts) never had a Workflow: no reply is coming and nothing is left to wait for (D07 T03 §48). The Workflow's
// own admit step can fail too (a database outage), and then it still runs the reply, so only this class is the intake's.
export const admissionFailed = (progress: Pick<Progress, "failed">): boolean =>
  progress.failed?.step === "admit" && progress.failed.error === "RawMissing";

// The failures a second run cannot mend, because the same file would fail again: the original is gone (D07 T03 §40) or
// the recording is one the member must replace (D07 T03 §38).
export const UNMENDABLE = ["RawMissing", "CorruptAudio", "AudioTooLong", "UnsupportedAudio"];
