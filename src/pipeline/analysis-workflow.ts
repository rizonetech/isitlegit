import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { type CaseResult, getCaseForPipeline, setHeadersAvailable, setStatus, type Verdict } from "../db/cases";
import { getVerdict, storeVerdict, type VerdictResult, type VerdictView } from "../db/verdicts";
import { extractOriginal, ParseError } from "../intake/forward";
import { parseMsg } from "../intake/msg";
import { type ParsedSummary, parseMessage, storeParsed } from "../intake/parse";
import { parsedKey, rawKey, readArtefact, type Store } from "../intake/store";
import {
  buildReply,
  HEADER_RANGE,
  parentHeaders,
  REPLY_FROM,
  type ReplyReport,
  reportOrigin,
  threading,
} from "../mail/reply";
import { sendMail } from "../mail/smtp2go";
import { signReportLink } from "../web/report-link";
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

// Four attempts (the first and three retries), 2, 4 and 8 seconds apart, each stopped at 30 seconds: a stalled step ends
// in `fail` within about two minutes, inside the product's three-minute p95 (design spec 4.9), where the platform's
// default of ten minutes an attempt would not (completion review). Later steps that call models set their own budget.
const RETRIES: WorkflowStepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "30 seconds",
};
// A failure's record has longer to land (11 attempts over about 85 minutes): it is what keeps a case from staying
// `running` when the database is away for a while, and nothing re-drives a case whose instance has ended.
const FAIL_RETRIES: WorkflowStepConfig = {
  retries: { limit: 10, delay: "5 seconds", backoff: "exponential" },
  timeout: "30 seconds",
};

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
  const named = error.message.replace(/^(NonRetryableError|Error):\s*/, "");
  return (FATAL as readonly string[]).includes(named) || CLASS.test(named) ? named : error.name;
}
const CLASS = /^[A-Z][A-Za-z0-9]{0,63}$/;

// A step's own error, made safe before it leaves the step: Cloudflare keeps each attempt's error message in the
// instance's logs, and an error from below can quote the message analysed (a storage error names an attachment's file,
// round 1). What leaves is the error's class alone; a non-retryable error already carries only its class.
export async function safely<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NonRetryableError) throw error;
    const name = error instanceof Error && CLASS.test(error.name) ? error.name : "Error";
    throw new Error(name);
  }
}

// A typed refusal thrown, so the step retries it; a missing case after admission cannot be repaired by a retry.
function must<T>(
  result: CaseResult<T> | VerdictResult | { ok: false; error: { code: "transition"; message: string } },
  what: string,
): T {
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

    // The step that failed after its last attempt: `recordFailure` names it and its error class and ends the case
    // partial, reading the case itself, so it works whichever step failed (admission included).
    const fail = (failedStep: StepName, error: unknown) =>
      // Each failure is its own step, named for the step that failed, so a replay never answers one failure with
      // another's cached result.
      step.do(`fail:${failedStep}`, FAIL_RETRIES, () =>
        safely(() => recordFailure(db, caseId, failedStep, classOf(error))),
      );

    // One step with its `started` and `done` events and its duration; a refused event is retried with the step.
    const timed = <T>(name: StepName, work: () => Promise<T>) =>
      step.do(name, RETRIES, () =>
        safely(async () => {
          const startedAt = new Date().toISOString();
          const began = Date.now();
          must(await recordEvent(db, caseId, name, "started", { startedAt }), `recording ${name}`);
          let result: T;
          try {
            result = await work();
          } catch (error) {
            // The attempt's end, so every `started` has one; a refusal here leaves the step's own error to report.
            // Our own non-retryable errors carry their class as their message; any other error is named by its class.
            const errorClass =
              error instanceof NonRetryableError
                ? error.message
                : error instanceof Error && CLASS.test(error.name)
                  ? error.name
                  : "Error";
            await recordEvent(db, caseId, name, "error", { startedAt, ms: Date.now() - began, errorClass });
            throw error;
          }
          must(await recordEvent(db, caseId, name, "done", { startedAt, ms: Date.now() - began }), `recording ${name}`);
          // Step results are plain values (keys, flags, the verdict view), which the Workflow stores as they are.
          return result as Rpc.Serializable<T>;
        }),
      ) as Promise<T>;

    // A case to analyse, or none: no such case (the binding smoke's instances, a case removed since) or one already
    // finished. A lookup failure is thrown and retried, never taken for a missing case; an admission that fails after
    // its last attempt (the case perhaps already running) goes to `fail` and the reply like any other.
    let admitted: Awaited<ReturnType<typeof admit>>;
    try {
      admitted = await step.do("admit", RETRIES, () => safely(() => admit(db, caseId)));
    } catch (error) {
      const state = await fail("admit", error);
      await timed("reply", () => reply(this.env, caseId, state)).catch((replyError) => fail("reply", replyError));
      return { caseId, state };
    }
    if (!admitted.admit) return { caseId, skipped: true };
    const { orgId } = admitted;

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
        must(await storeVerdict(db, orgId, caseId, view), "storing the verdict");
        return null;
      });
      state = { status: "ready", verdict: view.verdict };
    } catch (error) {
      state = await fail(current, error);
    }

    // The reply hands the report state on; D01 T02 §3 sends it. A reply that fails ends a ready case partial, and on a
    // case already partial its failure is recorded too, the first failure kept as the report's.
    try {
      await timed("reply", () => reply(this.env, caseId, state));
    } catch (error) {
      const failed = await fail("reply", error);
      if (state.status === "ready") state = failed;
    }

    // `done` last, once the reply step has run. A finish that fails after its last attempt is recorded and ends the case
    // partial through `fail`; the reply already handed on stands, since a second one would contradict it.
    if (state.status === "ready") {
      try {
        await timed("finish", async () => must(await setStatus(db, orgId, caseId, "done"), "finishing"));
      } catch (error) {
        state = await fail("finish", error);
      }
    }
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
  const startedAt = new Date().toISOString();
  const began = Date.now();
  const found = await getCaseForPipeline(db, caseId);
  if (!found.ok) {
    if (found.error.code === "not_found" || found.error.code === "invalid") return { admit: false };
    throw new Error(`looking the case up: ${found.error.code}`);
  }
  const current = found.value;
  if (current.status === "done" || current.status === "partial") return { admit: false };
  // Its events once the case is known to exist (an event needs its case row).
  must(await recordEvent(db, caseId, "admit", "started", { startedAt }), "recording admit");
  if (current.status === "received") must(await setStatus(db, current.orgId, caseId, "running"), "starting the case");
  must(await recordEvent(db, caseId, "admit", "done", { startedAt, ms: Date.now() - began }), "recording admit");
  return { admit: true, orgId: current.orgId };
}

// A step's failure after its last attempt: an event naming the step and its error class, and the case `partial`
// (moved through `running` if admission failed before it got there). A case already `done` stays so: its `finish`
// committed and only what followed failed. A case that no longer exists has nothing to record.
export async function recordFailure(
  db: D1Database,
  caseId: string,
  failedStep: StepName,
  errorClass: string,
): Promise<ReportState> {
  const state: ReportState = { status: "partial", failedStep, errorClass };
  const found = await getCaseForPipeline(db, caseId);
  if (!found.ok) {
    if (found.error.code === "not_found" || found.error.code === "invalid") return state;
    throw new Error(`looking the case up: ${found.error.code}`);
  }
  const { orgId, status } = found.value;
  must(await recordEvent(db, caseId, failedStep, "failed", { errorClass, once: true }), "recording the failure");
  if (status === "received") must(await setStatus(db, orgId, caseId, "running"), "starting the case");
  if (status !== "done") must(await setStatus(db, orgId, caseId, "partial"), "ending the case partial");
  return state;
}

// Reads the forward, parses the original it carries (§4 to §6) and stores the summary (§5); the header state (§4, or
// the .msg parser's own, §6) goes to the case and the summary alike. A message the parsers refuse is not retried.
export async function parse(store: Store, caseId: string): Promise<string> {
  // A case re-driven after an interrupted run keeps the summary it already has (its header state was written with it),
  // so it does not need the raw message, which expires after 30 days.
  const stored = await readArtefact(store, caseId, parsedKey(caseId));
  if (stored && "body" in stored) return parsedKey(caseId);
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

// Sends the member the answer (D01 T02 §3): the stored verdict, or for a partial case a notice that it could not
// finish, as a reply in the forward's thread, to the admitted forwarder, under one send key a case. The forward's
// subject and threading come from its stored header block (read by a bounded range), else from the case's stored
// Message-ID with a subject made by code. A case with no forwarder (an upload) has no one to reply to. A failed send
// throws so the step retries; an uncertain one is left to the reconcile job; refused and duplicate are final.
export async function reply(env: Env, caseId: string, state: ReportState) {
  const found = must(await getCaseForPipeline(env.DB, caseId), "reading the case for the reply");
  const base = { state, caseStatus: found.status };
  if (!found.forwardedBy) return { ...base, mail: "none" as const };
  const store: Store = { bucket: env.ARTEFACTS, db: env.DB };

  let report: ReplyReport;
  if (state.status === "ready") {
    const stored = await getVerdict(env.DB, caseId);
    if (!stored?.ok) throw new Error(`reading the verdict for the reply: ${stored ? stored.error.code : "missing"}`);
    report = { status: "ready", view: stored.value };
  } else {
    report = { status: "partial", failedStep: state.failedStep, errorClass: state.errorClass };
  }
  // The summary and the forward's header block are optional: either unreadable (gone, or a storage fault) and the reply
  // still goes, with no other-originals note and the fallback subject and threading.
  const otherOriginals = await readArtefact(store, caseId, parsedKey(caseId))
    .then((summary) =>
      summary && "body" in summary
        ? Number((JSON.parse(new TextDecoder().decode(summary.body)) as ParsedSummary).forward?.otherOriginals ?? 0)
        : 0,
    )
    .catch(() => 0);
  const head = await env.ARTEFACTS.get(rawKey(caseId), { range: { offset: 0, length: HEADER_RANGE } })
    .then(async (object) => (object ? new Uint8Array(await object.arrayBuffer()) : null))
    .catch(() => null);
  const parent = (await parentHeaders(head)) ?? {
    subject: null,
    messageId: null,
    references: null,
    inReplyTo: null,
  };
  const link = `${reportOrigin(env.PUBLIC_ORIGIN)}${await signReportLink(env.REPORT_LINK_SECRET, caseId, found.orgId)}`;
  const built = buildReply({
    parentSubject: parent.subject,
    headersAvailable: found.headersAvailable,
    otherOriginals,
    report,
    reportUrl: link,
  });
  const outcome = await sendMail(
    { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
    {
      sendKey: `reply:${caseId}`,
      kind: "reply",
      to: found.forwardedBy,
      from: REPLY_FROM,
      subject: built.subject,
      text: built.text,
      html: built.html,
      headers: threading({ ...parent, messageId: parent.messageId ?? found.messageId }),
      caseId,
    },
  );
  if (outcome.status === "failed") throw new Error("ReplyNotSent");
  return { ...base, mail: outcome.status };
}
