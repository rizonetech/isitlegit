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
export type Step = { step: string; words: string; state: StepState; ms: number | null; error: string | null };
export type Progress = { steps: Step[]; startedAt: string | null; failed: Step | null; current: number };

// The Workflow's steps in the order they run (src/pipeline/analysis-workflow.ts), each in the board's plain words.
export const STEPS: [string, string][] = [
  ["admit", "Received and stored"],
  ["parse", "Opened the message and its attachments"],
  ["checks", "Checked the sender, authentication, domains and content"],
  ["verdict", "Weighed the evidence and wrote the verdict"],
  ["store", "Saved the verdict"],
  ["reply", "Emailed the answer"],
  ["finish", "Finished"],
];

export function progressOf(events: readonly StepEvent[]): Progress {
  const known = new Map(STEPS);
  // Steps in the Workflow's order, then any recorded step this list does not know, in the order it was recorded.
  const names = [...STEPS.map(([step]) => step), ...events.map((e) => e.step).filter((step) => !known.has(step))];
  const order = [...new Set(names)];
  const steps = order.map((step): Step => {
    const mine = events.filter((e) => e.step === step);
    const words = known.get(step) ?? "Another step";
    const failed = mine.find((e) => e.status === "failed");
    if (failed) return { step, words, state: "failed", ms: failed.ms, error: failed.error };
    const done = mine.filter((e) => e.status === "done").at(-1);
    if (done) return { step, words, state: "done", ms: done.ms, error: null };
    const last = mine.at(-1);
    if (!last) return { step, words, state: "waiting", ms: null, error: null };
    return { step, words, state: last.status === "error" ? "retrying" : "running", ms: null, error: last.error };
  });
  const starts = events.map((e) => e.startedAt).filter((at) => !Number.isNaN(Date.parse(at)));
  const startedAt = starts.length ? starts.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
  const failed = steps.find((s) => s.state === "failed") ?? null;
  const running = steps.findIndex((s) => s.state === "running" || s.state === "retrying");
  const lastDone = steps.map((s) => s.state).lastIndexOf("done");
  return { steps, startedAt, failed, current: running >= 0 ? running + 1 : Math.min(steps.length, lastDone + 2) };
}

// A failed step's error class in plain words: the class only, never a message (src/pipeline/events.ts).
export function errorWords(error: string | null): string {
  if (error === "ParseError") return "The message could not be opened: its file is damaged or not a message.";
  if (error === "RawMissing") return "The original message was not found in storage.";
  if (error === "CaseRefused") return "The case could not be taken for checking.";
  if (error === "Timeout") return "A step ran out of time.";
  if (error?.startsWith("budget:")) return "Today's model limit was reached before the check could finish.";
  return "A step failed on our side. This is not a sign that the message is safe or unsafe.";
}
