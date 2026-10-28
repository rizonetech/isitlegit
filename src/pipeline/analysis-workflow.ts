import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  type CaseResult,
  getCaseForPipeline,
  setHeadersAvailable,
  setStatus,
  setVerdict,
  type Verdict,
} from "../db/cases";
import { saveVerdict, type VerdictResult, type VerdictView } from "../db/verdicts";
import { extractOriginal, ParseError } from "../intake/forward";
import { parseMsg } from "../intake/msg";
import { parseMessage, storeParsed } from "../intake/parse";
import { parsedKey, rawKey, readArtefact, type Store } from "../intake/store";
import { recordEvent } from "./events";

// The analysis pipeline for one case (D01 T01 §7): durable steps, so a failure resumes without repeating finished work
// (the paid model calls of later sections). `admit` takes the case, `parse` reads the forward, `checks` and `verdict`
// are stubs until D02 and D04, `store` writes the verdict, `reply` hands the report state on (D01 T02 §3 sends it) and
// `finish` marks the case `done`, last, since a finished case cannot become `partial`. A step that fails after its
// last attempt goes to `fail`, which ends the case `partial` naming it, and `reply` still runs.
//
// Workflows replay `run` from the start with each finished step's result cached, so every decision here is made from
// step results, never from state read outside a step.
export type AnalysisParams = { caseId: string };

export type StepName = "admit" | "parse" | "checks" | "verdict" | "store" | "reply" | "finish";
// What the reply reports: the verdict, or which step failed and its error class (no verdict, perhaps no summary).
export type ReportState =
  | { status: "ready"; verdict: Verdict }
  | { status: "partial"; failedStep: StepName; errorClass: string };

// Four attempts (the first and three retries), 2, 4 and 8 seconds apart.
const RETRIES: WorkflowStepConfig = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } };

// The stub verdict until the checks and the agent exist: never `safe`, which would mislead a member.
export const STUB_VERDICT: VerdictView = {
  verdict: "suspicious",
  headline: "Analysis in progress: checks are not built yet",
  confidence: 0,
  reasons: [],
  actions: [],
  source: "stub",
};

// A step error the Workflow must not retry carries only its class as its message (`NonRetryableError` keeps its own name,
// which is how the engine knows it), so no message content reaches the instance's error or the event.
const FATAL = ["ParseError", "RawMissing", "CaseRefused"] as const;
const fatal = (errorClass: (typeof FATAL)[number]) => new NonRetryableError(errorClass);
// The class of the error a step threw after its last attempt. The engine hands a non-retryable error on as a plain
// Error, so its class is read from its message, and only when it is one of the classes above: any other message stays
// unread.
function classOf(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  const named = error.message.replace(/^NonRetryableError:\s*/, "");
  return (FATAL as readonly string[]).includes(named) ? named : error.name;
}

// A typed refusal thrown, so the step retries it; a missing case after admission cannot be repaired by a retry.
function must<T>(result: CaseResult<T> | VerdictResult, what: string): T {
  if (result.ok) return result.value as T;
  const message = `${what}: ${result.error.code}`;
  if (result.error.code === "not_found" || result.error.code === "invalid" || result.error.code === "conflict")
    throw fatal("CaseRefused");
  throw new Error(message);
}

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisParams> {
  async run(event: WorkflowEvent<AnalysisParams>, step: WorkflowStep) {
    const { caseId } = event.payload;
    const db = this.env.DB;
    const store: Store = { bucket: this.env.ARTEFACTS, db };

    // A case to analyse, or none: no such case (the binding smoke's instances, a case removed since) or one already
    // finished. A lookup failure is thrown and retried, never taken for a missing case.
    const admitted = await step.do("admit", RETRIES, () => admit(db, caseId));
    if (!admitted.admit) return { caseId, skipped: true };
    const { orgId } = admitted;

    // One step with its `started` and `done` events and its duration; a refused event is retried with the step.
    const timed = <T>(name: StepName, work: () => Promise<T>) =>
      step.do(name, RETRIES, async () => {
        const startedAt = new Date().toISOString();
        const began = Date.now();
        must(await recordEvent(db, caseId, name, "started", { startedAt }), `recording ${name}`);
        const result = await work();
        must(await recordEvent(db, caseId, name, "done", { startedAt, ms: Date.now() - began }), `recording ${name}`);
        // Step results are plain values (keys, flags, the verdict view), which the Workflow stores as they are.
        return result as Rpc.Serializable<T>;
      }) as Promise<T>;

    // The step that failed after its last attempt: its event names it and its error class, and the case ends partial.
    const fail = (failedStep: StepName, error: unknown) =>
      step.do("fail", RETRIES, async (): Promise<ReportState> => {
        const errorClass = classOf(error);
        must(await recordEvent(db, caseId, failedStep, "failed", { errorClass }), "recording the failure");
        must(await setStatus(db, orgId, caseId, "partial"), "ending the case partial");
        return { status: "partial", failedStep, errorClass };
      });

    let state: ReportState;
    let current: StepName = "parse";
    try {
      const key = await timed("parse", () => parse(store, caseId));
      current = "checks";
      const evidence = await timed("checks", () => checks(store, caseId, key));
      current = "verdict";
      const view = await timed("verdict", async () => verdictOf(evidence));
      current = "store";
      await timed("store", async () => {
        must(await saveVerdict(db, caseId, view), "storing the verdict");
        must(await setVerdict(db, orgId, caseId, view.verdict), "setting the verdict");
        return null;
      });
      state = { status: "ready", verdict: view.verdict };
    } catch (error) {
      state = await fail(current, error);
    }

    // The reply hands the report state on; D01 T02 §3 sends it. A reply that fails ends a ready case partial.
    try {
      await timed("reply", () => reply(this.env.DB, caseId, state));
    } catch (error) {
      if (state.status === "ready") state = await fail("reply", error);
    }

    // `done` last, once the reply step has run.
    if (state.status === "ready")
      await timed("finish", async () => must(await setStatus(db, orgId, caseId, "done"), "finishing"));
    return { caseId, state };
  }
}

// A case to analyse, or none: no such case (the binding smoke's instances, a case removed since) or one already
// finished. A lookup failure is thrown, so the step retries it, never taken for a missing case. A replayed or
// restarted run finds its case already running and takes it as it is.
export async function admit(
  db: D1Database,
  caseId: string,
): Promise<{ admit: false } | { admit: true; orgId: string }> {
  const found = await getCaseForPipeline(db, caseId);
  if (!found.ok) {
    if (found.error.code === "not_found" || found.error.code === "invalid") return { admit: false };
    throw new Error(`looking the case up: ${found.error.code}`);
  }
  const current = found.value;
  if (current.status === "done" || current.status === "partial") return { admit: false };
  if (current.status === "received") must(await setStatus(db, current.orgId, caseId, "running"), "starting the case");
  must(await recordEvent(db, caseId, "admit", "done"), "recording admit");
  return { admit: true, orgId: current.orgId };
}

// Reads the forward, parses the original it carries (§4 to §6) and stores the summary (§5); the header state (§4, or
// the .msg parser's own, §6) goes to the case and the summary alike. A message the parsers refuse is not retried.
async function parse(store: Store, caseId: string): Promise<string> {
  const raw = await readArtefact(store, caseId, rawKey(caseId));
  if (!raw || !("body" in raw)) throw fatal("RawMissing");
  try {
    const forward = await extractOriginal(raw.body);
    const { parsed, headersAvailable } =
      forward.format === "msg"
        ? await parseMsg(forward.original)
        : { parsed: await parseMessage(forward.original), headersAvailable: forward.headersAvailable };
    must(await setHeadersAvailable(store.db, caseId, headersAvailable), "storing the header state");
    await storeParsed(store, caseId, parsed, { ...forward, headersAvailable });
    return parsedKey(caseId);
  } catch (error) {
    if (error instanceof ParseError) throw fatal("ParseError");
    throw error;
  }
}

// No checks are built yet (D02): the summary is read, so a missing one fails, and no evidence is returned.
export async function checks(store: Store, caseId: string, key: string): Promise<{ evidence: never[] }> {
  const summary = await readArtefact(store, caseId, key);
  if (!summary || !("body" in summary)) throw new Error("the parsed summary is not stored");
  return { evidence: [] };
}

const verdictOf = (_found: { evidence: never[] }): VerdictView => STUB_VERDICT;

// Hands the report state on without sending anything (D01 T02 §3 sends it); the case's status at this point is part
// of the result, so a test can see the case is not yet `done`.
async function reply(db: D1Database, caseId: string, state: ReportState) {
  const found = await getCaseForPipeline(db, caseId);
  return { state, caseStatus: found.ok ? found.value.status : null };
}
