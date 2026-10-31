// The shapes of the model trace (D07 T03 §5), in a module of their own, free of the Worker's types, so the panel (rendered in
// Node tests too) can name them without importing the database code (src/db/model-trace.ts reads them).
export type TraceCall = {
  id: string;
  // When the call was made (reserved): the work that followed it, until the next call, is what it led to.
  at: string;
  step: string | null;
  model: string;
  // Null when the call recorded no time (an interrupted settlement): unknown, never a measured zero.
  ms: number | null;
  attempt: number;
  // Null when never settled: unknown, never a success.
  outcome: "ok" | "error" | "refused" | null;
  errorClass: string | null;
  cached: boolean;
  usd: number;
  certainty: "measured" | "estimated";
};
export type TraceAction = {
  walk: string;
  seq: number;
  kind: "action" | "request" | "popup" | "end";
  // The tool an action used (click, scroll, ...), when it was one of the walkthrough's known tools.
  tool: string | null;
  outcome: "done" | "refused" | "limit" | "error";
  // The reason the walkthrough stored for a refused, limited or failed action (its own short words), else null.
  reason: string | null;
  at: string;
  ms: number;
};
export type TraceSend = {
  kind: string;
  status: "pending" | "sent" | "failed" | "uncertain" | "refused";
  attempts: number;
  error: string | null;
  at: string;
};
export type ModelTrace = {
  calls: TraceCall[];
  actions: TraceAction[];
  sends: TraceSend[];
  total: { ms: number; unknownTime: number; measuredUsd: number; estimatedUsd: number; estimatedCalls: number };
};
