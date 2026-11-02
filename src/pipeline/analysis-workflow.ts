import { connect } from "cloudflare:sockets";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import puppeteer from "@cloudflare/puppeteer";
import { decodeWords } from "postal-mime";
import { caseSummary, runAgent, verdictToolDeps } from "../agent/loop";
import { createToolExecutor } from "../agent/tools";
import { type LookupMx, lookupMx, receiversForOrg } from "../auth/receivers";
import { caseLookups, chainsForOrg, type Resolve, resolveDoh } from "../auth/receiving-chains";
import { attachmentPhrases, bodyPhrases, instructionsOf } from "../checks/ai-instructions";
import { attachmentRisksOf } from "../checks/attachment-risk";
import { type BrandTable, brandTableRead, bundled } from "../checks/brands";
import { type CaseView, caseViewOf, type Tenant } from "../checks/case-view";
import { cloudflareBlocked } from "../checks/cf-block";
import { readCheckOutcomes, readEvidence, saveEvidence } from "../checks/evidence";
import { type Expansions, type FollowLink, followLinks, livePolicy } from "../checks/expand";
import { hiddenTextOf } from "../checks/hidden-text";
import { htmlAttachmentsOf } from "../checks/html-attachment";
import { checks as fullRegistry } from "../checks/index";
import { invisibleOf, PhraseLog, PhraseStream, withoutInstructions } from "../checks/instruction-phrases";
import { invisibleRuns } from "../checks/invisible-unicode";
import { settleLandings } from "../checks/landing-store";
import { linksOf } from "../checks/links";
import { domainAgesOf, type RdapDeps } from "../checks/rdap";
import { CheckRegistry } from "../checks/registry";
import { type ReputationDeps, reputationOf } from "../checks/reputation";
import { reputationResultStatements } from "../checks/reputation-results";
import { type DetectionData, runChecksWithOutcomes } from "../checks/runner";
import { observeSender, originalSender } from "../checks/senders-seen";
import { attachmentHeadsOf, sniff } from "../checks/sniff";
import { listOwnDomains, listSupplierDomains } from "../checks/suppliers";
import { isWellKnown } from "../checks/top-sites";
import { webRiskSearch } from "../checks/webrisk";
import {
  type CaseResult,
  getCaseForPipeline,
  type SourceKind,
  setHeadersAvailable,
  setOriginalHeader,
  setStatus,
  type Verdict,
} from "../db/cases";
import { ulid } from "../db/ulid";
import { getVerdict, storeVerdict, type VerdictResult, type VerdictView } from "../db/verdicts";
import { extractOriginal, ParseError } from "../intake/forward";
import { parseMsg } from "../intake/msg";
import { NO_HEADER, originalHeaderOf } from "../intake/original-header";
import { type ParsedSummary, parseMessage, storeParsed } from "../intake/parse";
import {
  artefactsOf,
  parsedKey,
  putArtefact,
  putParsed,
  putVisible,
  rawKey,
  readArtefact,
  type Store,
  StoreError,
} from "../intake/store";
import { invoiceStep, recordInvoiceNotRun } from "../invoice/step";
import {
  buildReply,
  HEADER_RANGE,
  parentHeaders,
  REPLY_FROM,
  type ReplyReport,
  replyHeaders,
  reportOrigin,
  threading,
} from "../mail/reply";
import { sendMail } from "../mail/smtp2go";
import { d1Budget } from "../meta/budget";
import { type MetaEnv, ModelError } from "../meta/client";
import { BudgetExceeded } from "../meta/guard";
import { ModelOutputError } from "../meta/structured";
import { bankKeys } from "../trust/bank";
import { recordVisionNotRun, visionStep } from "../vision/step";
import { AudioTooLong, CorruptAudio, decodeToWavChunks, UnsupportedAudio } from "../voice/decode";
import { readVoice, storeVoice, VOICE_STEP_TIMEOUT_MS, voice } from "../voice/step";
import { TRANSCRIPT_NAME, transcribe as transcribeChunks } from "../voice/transcribe";
import { kvCache, recordWalkNotRun, walkthroughStep } from "../walkthrough/trigger";
import { allowedUrl, dohResolve } from "../walkthrough/url-policy";
import { walk } from "../walkthrough/wonder";
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

export type StepName =
  | "admit"
  | "parse"
  | "transcribe"
  | "voice"
  | "checks"
  | "walkthrough"
  | "vision"
  | "invoice"
  | "verdict"
  | "store"
  | "reply"
  | "finish";
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
// The reply's own budget (the final review): its two optional reads (OPTIONAL_READ_MS each), then up to MAX_ATTEMPTS
// provider calls of REPLY_SEND_TIMEOUT_MS with 1 and 2 seconds between them, all inside one attempt, so the attempt is
// never stopped while SMTP2GO is still inside its own timeout and the send's outcome unrecorded.
export const REPLY_SEND_TIMEOUT_MS = 20_000;
export const REPLY_STEP_TIMEOUT_MS = 90_000;
const REPLY_RETRIES: WorkflowStepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: `${REPLY_STEP_TIMEOUT_MS / 1000} seconds`,
};
// The transcription's own budget (D01 T03 §3): up to three 10-minute chunks, each a paid call the client already
// retries inside its deadline, so two attempts of five minutes; a second attempt pays for every chunk again.
export const TRANSCRIBE_STEP_TIMEOUT_MS = 300_000;
export const TRANSCRIBE_CALL_MS = 90_000;
const TRANSCRIBE_RETRIES: WorkflowStepConfig = {
  retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
  timeout: `${TRANSCRIBE_STEP_TIMEOUT_MS / 1000} seconds`,
};
// The voice note read for what it asks (D01 T03 §4): one Spark call inside its own 60-second deadline, retries and repair
// included, so one attempt of two minutes; a retry is for a database or network fault, and pays for the call again,
// recorded in the budget's ledger like the first.
const VOICE_RETRIES: WorkflowStepConfig = {
  retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
  timeout: `${VOICE_STEP_TIMEOUT_MS / 1000} seconds`,
};
// The walkthrough's own budget (D04 T02 §6): the driver caps the walk at 60 seconds, so one attempt of two minutes
// covers the launch, the walk and the evidence write; no retry, since a second attempt would pay for the walk again
// and the step states what it could not do instead of failing the case.
export const WALKTHROUGH_STEP_TIMEOUT_MS = 120_000;
const WALKTHROUGH_RETRIES: WorkflowStepConfig = {
  retries: { limit: 0, delay: "1 second", backoff: "constant" },
  timeout: `${WALKTHROUGH_STEP_TIMEOUT_MS / 1000} seconds`,
};
// The vision step's budget (D03 T02 §3): the render, the PDF rasteriser's own 90-second deadline and the
// reading's 60-second call run one after another, so one attempt of five minutes; a retry is for a database
// or network fault and pays for the render and reading again, recorded like the first.
export const VISION_STEP_TIMEOUT_MS = 300_000;
const VISION_RETRIES: WorkflowStepConfig = {
  retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
  timeout: `${VISION_STEP_TIMEOUT_MS / 1000} seconds`,
};
// The invoice step's budget (D06 T01 §1): at most three documents, each one 60-second Spark call, run one
// after another, so one attempt of four minutes; a retry is for a database or network fault and pays for
// the calls again, recorded like the first.
export const INVOICE_STEP_TIMEOUT_MS = 240_000;
const INVOICE_RETRIES: WorkflowStepConfig = {
  retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
  timeout: `${INVOICE_STEP_TIMEOUT_MS / 1000} seconds`,
};
// The verdict agent's budget (D04 T01 §4): one shared 150-second deadline over its turns, tools and final answer;
// no retry, since a second attempt would pay for the investigation again and the agent falls back to the rules.
export const VERDICT_STEP_TIMEOUT_MS = 180_000;
const VERDICT_RETRIES: WorkflowStepConfig = {
  retries: { limit: 0, delay: "1 second", backoff: "constant" },
  timeout: `${VERDICT_STEP_TIMEOUT_MS / 1000} seconds`,
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
  meaning: null,
  source: "stub",
  floorApplied: null,
};

// A step error the Workflow must not retry carries only its class as its message (`NonRetryableError` keeps its own name,
// which is how the engine knows it), so no message content reaches the instance's error or the event.
// A recording that cannot be read, is too long or of a type not taken, and a transcription answer outside its shape,
// are final too (D01 T03 §3): a retry would decode the same bytes again, or pay for the same answer again.
const FATAL = [
  "ParseError",
  "RawMissing",
  "CaseRefused",
  "CorruptAudio",
  "AudioTooLong",
  "UnsupportedAudio",
  "ModelOutputError",
] as const;
const fatal = (errorClass: (typeof FATAL)[number]) => new NonRetryableError(errorClass);
// The class of the error a step threw after its last attempt. The engine hands a non-retryable error on as a plain
// Error, so its class is read from its message, and only when it is one of the classes above: any other message stays
// unread.
function classOf(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  const named = error.message.replace(/^(NonRetryableError|Error):\s*/, "");
  return (FATAL as readonly string[]).includes(named) || CLASS.test(named) || BUDGET.test(named) ? named : error.name;
}
const CLASS = /^[A-Z][A-Za-z0-9]{0,63}$/;
// A model call the budget refused (D03 T01 §2): its cap and model, which the reply turns into the member's next step.
const BUDGET = /^budget:(day|total|reserve):[a-z0-9.-]{1,64}$/;

// A step's own error, made safe before it leaves the step: Cloudflare keeps each attempt's error message in the
// instance's logs, and an error from below can quote the message analysed (a storage error names an attachment's file,
// round 1). What leaves is the error's class alone; a non-retryable error already carries only its class.
export async function safely<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NonRetryableError) throw error;
    // A cap's refusal is never retried: the step ends at once, carrying the cap and the model.
    if (error instanceof BudgetExceeded) throw new NonRetryableError(`budget:${error.cap}:${error.model}`);
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
      step.do(
        name,
        name === "reply"
          ? REPLY_RETRIES
          : name === "transcribe"
            ? TRANSCRIBE_RETRIES
            : name === "voice"
              ? VOICE_RETRIES
              : name === "walkthrough"
                ? WALKTHROUGH_RETRIES
                : name === "vision"
                  ? VISION_RETRIES
                  : name === "invoice"
                    ? INVOICE_RETRIES
                    : name === "verdict"
                      ? VERDICT_RETRIES
                      : RETRIES,
        () =>
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
                  : error instanceof BudgetExceeded
                    ? `budget:${error.cap}:${error.model}`
                    : error instanceof Error && CLASS.test(error.name)
                      ? error.name
                      : "Error";
              await recordEvent(db, caseId, name, "error", { startedAt, ms: Date.now() - began, errorClass });
              throw error;
            }
            must(
              await recordEvent(db, caseId, name, "done", { startedAt, ms: Date.now() - began }),
              `recording ${name}`,
            );
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
    const { orgId, channel, sourceKind, headersAvailable } = admitted;

    let state: ReportState;
    let current: StepName = "parse";
    try {
      const key = await timed("parse", () => parse(store, caseId, { channel, sourceKind, headersAvailable }));
      // A voice note's transcript, for the voice evidence that reads it (D01 T03 §3, §4).
      if (sourceKind === "audio") {
        current = "transcribe";
        await timed("transcribe", () => transcribe(this.env, store, caseId, key));
        // What the speaker asks, in its own step with its own budget (D01 T03 §4). A step that fails after its last
        // attempt is stated as not checked and the case goes on to the checks, so a voice note whose reading failed is
        // still checked, partial in that evidence.
        current = "voice";
        try {
          await timed("voice", () => voice(this.env, store, caseId));
        } catch (error) {
          const why = `the reading did not finish (${classOf(error)})`;
          await step.do("voice:unchecked", RETRIES, () =>
            safely(async () => {
              await storeVoice(store, caseId, { state: "not_checked", reason: why });
              return null;
            }),
          );
        }
      }
      // A mail case's voicemail attachments (D01 T03 §5), through the same two steps. The gate is its own small
      // step (no event of its own), so a mail case with no audio attachment records no transcribe step, as before.
      if (sourceKind === "mail") {
        const gate = await step.do("transcribe:gate", RETRIES, () => safely(() => mailAudioCount(store, caseId, key)));
        if (gate) {
          current = "transcribe";
          await timed("transcribe", () => transcribeAttachments(this.env, store, caseId, key));
          current = "voice";
          try {
            await timed("voice", () => voice(this.env, store, caseId));
          } catch (error) {
            const why = `the reading did not finish (${classOf(error)})`;
            await step.do("voice:unchecked", RETRIES, () =>
              safely(async () => {
                await storeVoice(store, caseId, { state: "not_checked", reason: why });
                return null;
              }),
            );
          }
        }
      }
      current = "checks";
      // The brand table is read inside the step: KV's copy when it reads in time, else the bundled one (D02 T02 §4).
      await timed("checks", async () => {
        // The table and where it was read from, stored with the outcomes (D02 T01 §6): what the checks judged by.
        const { table, source, id } = await brandTableRead(this.env);
        return checks(
          store,
          caseId,
          key,
          { orgId, channel },
          lookupMx,
          table,
          rdapDeps(this.env),
          // Following the case's links in Browser Run (D02 T07 §2).
          { read: (links) => followLinks(this.env.BROWSER, links, { policy: livePolicy() }) },
          this.env.CF_VERSION_METADATA?.id ?? null,
          undefined,
          { revision: table.revision, id, source },
          reputationDeps(this.env, caseId, orgId),
        );
      });
      // The phishing-site walkthrough (D04 T02 §6): only when the link checks found a form or a lure, its evidence
      // cached by page. It never fails the case: a step that cannot run states so on the case and the verdict goes
      // on with what the checks found.
      current = "walkthrough";
      try {
        await timed("walkthrough", async () => {
          const { table } = await brandTableRead(this.env);
          return walkthroughStep(
            {
              db,
              store,
              cache: kvCache(this.env.CACHE),
              launch: () => puppeteer.launch(this.env.BROWSER),
              walk,
              resolve: dohResolve(),
              meta: { env: this.env, budget: d1Budget(db, { caller: "walkthrough", caseId }) },
              table,
              revision: this.env.CF_VERSION_METADATA?.id ?? null,
              walkId: () => ulid(),
            },
            caseId,
          );
        });
      } catch {
        // The failure past the helper is stated on the case in its own step, so the verdict that follows knows the
        // walkthrough could not run; a write that fails here too leaves the step's events as the record.
        await step
          .do("walkthrough:unchecked", RETRIES, () =>
            safely(() => recordWalkNotRun(db, caseId, this.env.CF_VERSION_METADATA?.id ?? null)),
          )
          .catch(() => undefined);
      }
      // The pictures read as evidence (D03 T02 §3): the email rendered, its PDF pages rasterised, and
      // Muse Spark's structured reading of them. It never fails the case: what could not be read is
      // stated on the case and the verdict goes on with what it has.
      current = "vision";
      try {
        await timed("vision", () =>
          visionStep(
            {
              db,
              store,
              launch: () => puppeteer.launch(this.env.BROWSER),
              meta: { env: this.env, budget: d1Budget(db, { caller: "vision", caseId }) },
              kv: this.env.CACHE,
              waitUntil: (p) => void p.catch(() => {}),
              policy: (raw) => allowedUrl(raw, dohResolve()),
            },
            caseId,
          ),
        );
      } catch {
        // The failure statement is itself retried; a case it cannot land on ends partial below rather
        // than reach its verdict with the missing coverage concealed.
        await step.do("vision:unchecked", RETRIES, () => safely(() => recordVisionNotRun(db, caseId, "error")));
      }
      // The invoice documents read and their payee accounts sealed (D06 T01 §1), before the verdict so a
      // later section's rules judge the case with them. It never fails the case: what could not be read is
      // stated on the case and the verdict goes on with what it has.
      current = "invoice";
      try {
        await timed("invoice", () =>
          invoiceStep(
            {
              db,
              store,
              meta: { env: this.env, budget: d1Budget(db, { caller: "invoice", caseId }) },
              keys: () => bankKeys(this.env),
              waitUntil: (p) => void p.catch(() => {}),
            },
            caseId,
            orgId,
          ),
        );
      } catch {
        await step.do("invoice:unchecked", RETRIES, () => safely(() => recordInvoiceNotRun(store, caseId, "error")));
      }
      current = "verdict";
      const { view } = await timed("verdict", () => verdict(this.env, db, store, caseId));
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
): Promise<{ admit: false } | ({ admit: true; orgId: string } & Source)> {
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
  return {
    admit: true,
    orgId: current.orgId,
    channel: current.channel,
    sourceKind: current.sourceKind,
    headersAvailable: current.headersAvailable,
  };
}

// What the case came from, as the parse step needs it: a forward, an uploaded message or an uploaded file.
export type Source = { channel: "email" | "upload"; sourceKind: SourceKind; headersAvailable: boolean };

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
export async function parse(store: Store, caseId: string, source: Source): Promise<string> {
  // A case re-driven after an interrupted run keeps the summary it already has (its header state was written with it),
  // so it does not need the raw message, which expires after 30 days.
  const stored = await readArtefact(store, caseId, parsedKey(caseId));
  if (stored && "body" in stored) return parsedKey(caseId);
  // An uploaded document, image or voice note (D01 T03 §1): no message to parse; its summary names the file, which the
  // later steps read (the document path, D06 T02 §3; transcription, D01 T03 §3).
  if (source.sourceKind !== "mail") {
    const [file] = await artefactsOf(store, caseId, "attachment");
    if (!file) throw fatal("RawMissing");
    // What the file claimed to be, from the case row, for the type-mismatch check (D02 T04 §4).
    const row = must(await getCaseForPipeline(store.db, caseId), "reading the upload's claims");
    const claimed =
      row.uploadName || row.uploadMediaType ? { name: row.uploadName, mediaType: row.uploadMediaType } : undefined;
    await putParsed(store, caseId, {
      source: {
        kind: source.sourceKind,
        mediaType: file.mediaType,
        key: file.key,
        bytes: file.bytes,
        ...(claimed ? { claimed } : {}),
      },
      forward: { headersAvailable: false },
    });
    return parsedKey(caseId);
  }
  const raw = await readArtefact(store, caseId, rawKey(caseId));
  if (!raw || !("body" in raw)) throw fatal("RawMissing");
  try {
    // An uploaded message is the original itself, not a forward: read directly, an .eml with the header state its
    // trace gave it at upload, a .msg by its own answer.
    if (source.channel === "upload") {
      const isMsg = raw.stored.mediaType === "application/vnd.ms-outlook";
      const { parsed, headersAvailable, sender } = isMsg
        ? await parseMsg(raw.body)
        : { parsed: await parseMessage(raw.body), headersAvailable: source.headersAvailable, sender: undefined };
      must(await setHeadersAvailable(store.db, caseId, headersAvailable), "storing the header state");
      // The upload is the original itself, so its Subject and From are taken whatever its header state (D01 T01 §16).
      must(
        await setOriginalHeader(store.db, caseId, originalHeaderOf(parsed.headers, sender)),
        "storing the original's header",
      );
      await storeParsed(store, caseId, parsed, {
        original: raw.body,
        format: isMsg ? "msg" : "eml",
        headersAvailable,
        path: isMsg ? "msg" : "eml",
        otherOriginals: 0,
      });
      return parsedKey(caseId);
    }
    const forward = await extractOriginal(raw.body);
    const { parsed, headersAvailable, sender } =
      forward.format === "msg"
        ? await parseMsg(forward.original)
        : {
            parsed: await parseMessage(forward.original),
            headersAvailable: forward.headersAvailable,
            sender: undefined,
          };
    must(await setHeadersAvailable(store.db, caseId, headersAvailable), "storing the header state");
    // An inline forward is the member's own message: its Subject and From are theirs, not the original's (D01 T01 §16).
    must(
      await setOriginalHeader(
        store.db,
        caseId,
        forward.path === "inline" ? NO_HEADER : originalHeaderOf(parsed.headers, sender),
      ),
      "storing the original's header",
    );
    await storeParsed(store, caseId, parsed, { ...forward, headersAvailable });
    return parsedKey(caseId);
  } catch (error) {
    if (error instanceof ParseError) throw fatal("ParseError");
    throw error;
  }
}

// Every registered check run against the case view built from the summary (D02 T01 §2), the list stored in D1 in one
// replacing batch, so a retried step leaves one list; the step passes on only the count (a step's output is at most
// 1 MiB). A missing or malformed summary fails the step.
// The organisation's receiving systems join the tenant here (D02 T02 §1): the step reads them, learning again within its
// bounded lookups those missing or stale, so the checks stay pure.
export async function checks(
  store: Store,
  caseId: string,
  key: string,
  tenant: Omit<Tenant, "receivers" | "trusted">,
  lookup: LookupMx = lookupMx,
  brands: BrandTable = bundled,
  // RDAP for the domain-age check (D02 T03 §4): none by default, so a caller that gives none reads no ages (null).
  rdap: RdapDeps | null = null,
  // Browser Run and the URL policy for following the case's links (D02 T07 §2): none by default, so a caller that gives
  // none follows nothing and the link checks report they could not run.
  follow: { read: (links: FollowLink[]) => Promise<Expansions | null> } | null = null,
  // The Worker version running the checks (D02 T01 §4), stored on each outcome.
  revision: string | null = null,
  // DNS for the gateway addresses a receiving chain is proven by (D02 T02 §6).
  resolve: Resolve = resolveDoh,
  // The table the checks judged by and where it was read from (D02 T01 §6), stored on each outcome; null when unknown.
  data: DetectionData | null = null,
  // How the case's link and sender-domain reputation is asked (D02 T06 §5): none by default, so a caller that gives
  // none reads no reputation (null on the view).
  reputation: ReputationDeps | null = null,
): Promise<{ evidence: number }> {
  const summary = await readArtefact(store, caseId, key);
  if (!summary || !("body" in summary)) throw new Error("the parsed summary is not stored");
  // A counterparty case (D05 T02 §1) is an outsider's check about a protected business, answered to that outsider: it
  // is read with what is public about the business only. Its verified domains are public (the verify page shows them);
  // its supplier ledger, the receivers learned from its own inbound mail and its sender history are its private record,
  // never read for an outsider, and an outsider's mail never adds to that history (round 1).
  const origin = await store.db
    .prepare("SELECT origin FROM cases WHERE id = ?")
    .bind(caseId)
    .first<{ origin: string | null }>();
  const counterparty = origin?.origin === "counterparty";
  const receivers = counterparty ? [] : await receiversForOrg(store.db, tenant.orgId, lookup);
  // Its receiving chains behind a gateway, read from its own DNS (D02 T02 §6): never from a message, and never for a
  // counterparty case, which is no mail the organisation received.
  const chains = counterparty ? [] : await chainsForOrg(store.db, tenant.orgId, caseLookups(resolve));
  const read = caseViewOf(
    JSON.parse(new TextDecoder().decode(summary.body)),
    {
      ...tenant,
      receivers,
      chains,
      // The domains the organisation trusts, for the lookalike check (D02 T03 §2).
      trusted: {
        own: await listOwnDomains(store.db, tenant.orgId),
        suppliers: counterparty ? [] : await listSupplierDomains(store.db, tenant.orgId),
      },
    },
    rawKey(caseId),
    brands,
  );
  // The intake and authentication prefix, stored before any enrichment (D01 T01 §23): a slow or failed
  // enrichment (Browser Run, RDAP, reputation) then leaves the fast header outcomes already readable, and
  // because the subset is the registry's own prefix in order, its Evidence IDs are the full run's first IDs.
  const prefix = new CheckRegistry();
  for (const check of fullRegistry.all())
    if (check.name.startsWith("intake.") || check.name.startsWith("auth.")) prefix.register(check);
  const early = await runChecksWithOutcomes(read, prefix);
  // The run's reputation results go with its evidence (D02 T06 §9, round 3): a retried step's prefix write
  // clears the previous attempt's results in the same batch, so they never stand beside incomplete evidence.
  await saveEvidence(
    store.db,
    caseId,
    early.items,
    prefix,
    undefined,
    early.outcomes,
    revision,
    data,
    reputationResultStatements(store.db, caseId, null),
  );
  // The sender's history, classified once per case before the checks (D02 T02 §5), so a retried step reads the same.
  const sender = originalSender(read);
  // The phrases written to steer an AI (D02 T05 §2), matched over every text whole as it is read: the body's, through
  // the hidden-text scan, and the text and HTML attachments'.
  const phrases = new PhraseLog();
  // The original's subject, unfolded and its encoded words decoded, read as its own location (D02 T05 §5).
  const subject = read.headers.find((h) => h.name.trim().toLowerCase() === "subject")?.value;
  if (subject) {
    const stream = new PhraseStream(phrases, "subject", "body", false);
    stream.feed(decodeWords(subject.replace(/\r?\n[ \t]*/g, " ")));
    stream.end();
  }
  const scanned =
    read.source.kind === "message" && (read.html !== null || read.truncated.length)
      ? await hiddenTextOf(store.bucket, read, bodyPhrases(phrases))
      : null;
  if (read.source.kind === "message" && !scanned && read.text !== null) {
    const stream = bodyPhrases(phrases).stream("text");
    stream.feed(read.text);
    stream.end();
  }
  await attachmentPhrases(store.bucket, read.attachments, phrases);
  // An uploaded document is read as an attached one is (D02 T05 §8), under the name it claimed; an image or a voice note
  // holds no text to read here.
  const uploaded = read.source.kind === "upload" && read.source.fileKind === "document";
  if (read.source.kind === "upload" && uploaded)
    await attachmentPhrases(
      store.bucket,
      [
        {
          key: read.source.key,
          filename: read.source.claimed?.name ?? "upload",
          mediaType: read.source.mediaType,
          contentId: null,
          disposition: null,
          bytes: read.source.bytes,
        },
      ],
      phrases,
      "upload",
    );
  const instructions =
    read.source.kind === "message" || read.attachments.length || uploaded ? instructionsOf(phrases) : null;
  // What a model reads has the phrases written to steer it removed (D02 T05's Goal); each one is evidence, and the
  // original stays in R2.
  // The phrase streams found the invisible runs as they read every text (D02 T05 §3); what a model reads has them taken
  // out too, before the phrases are.
  if (read.source.kind === "message")
    await putVisible(store, caseId, withoutInstructions(invisibleRuns(scanned?.visible ?? read.text ?? "").cleaned));
  // An uploaded document or image's own first bytes too, when it said what it was (D02 T04 §4).
  const heads = read.attachments.length
    ? await attachmentHeadsOf(store.bucket, read.attachments)
    : read.source.kind === "upload" && read.source.claimed
      ? await attachmentHeadsOf(store.bucket, [{ key: read.source.key }])
      : null;
  // HTML and SVG attachments read and analysed (D02 T04 §2).
  const htmlAttachments = await htmlAttachmentsOf(store.bucket, {
    attachments: read.attachments,
    attachmentHeads: heads,
  });
  // Every link the case holds (D02 T07 §1), the HTML attachments' from the read above.
  const links = await linksOf(store.bucket, { ...read, attachmentHeads: heads, htmlAttachments });
  // The links' and the sender domain's reputation (D02 T06 §5), started now so its lookups run beside the reads
  // below and are awaited when the view is built; a refusal it raises is the step's, read there.
  const reputationAnswers = reputation
    ? reputationOf(links, reputation, sender ? sender.slice(sender.lastIndexOf("@") + 1) : null)
    : null;
  reputationAnswers?.catch(() => undefined);
  // The links followed in Browser Run (D02 T07 §2), bounded; a throw leaves them unread, never the case failed.
  const expansions = links ? await (follow ? follow.read(links.items) : Promise.resolve(null)).catch(() => null) : null;
  // The pages the links reached: screenshots stored, their text read for instructions written for a model (D02 T07 §3).
  const landingText = expansions ? await settleLandings(store, caseId, expansions, phrases).catch(() => false) : false;
  const view = {
    ...read,
    htmlAttachments,
    links,
    expansions,
    // Macros, encrypted archives and programs in the attachments (D02 T04 §3).
    attachmentRisks: await attachmentRisksOf(store.bucket, { attachments: read.attachments, attachmentHeads: heads }),
    instructions: landingText ? instructionsOf(phrases) : instructions,
    invisibleText: read.source.kind === "message" || read.attachments.length || uploaded ? invisibleOf(phrases) : null,
    senderHistory: sender && !counterparty ? await observeSender(store.db, tenant.orgId, caseId, sender) : null,
    // The case's domains' registration dates (D02 T03 §4, §10: link and landing hosts beside the header domains),
    // looked up here since a check never reaches the network.
    domainAges: rdap ? await domainAgesOf({ ...read, links, expansions } as CaseView, rdap) : null,
    // The reputation answers started above (D02 T06 §5).
    reputation: reputationAnswers ? await reputationAnswers : null,
    // Each attachment's first bytes, for the type-mismatch check (D02 T04 §1).
    attachmentHeads: heads,
    // Hidden text and the visible text a model reads (D02 T05 §1); the visible text is stored before the evidence.
    hiddenText: scanned?.hidden ?? null,
    // A voice note read for what it asks (D01 T03 §4), from the `voice` step's stored result: an uploaded voice
    // note, or a mail case whose voicemail attachments were transcribed (D01 T03 §5); a mail case with none reads
    // no claim and the voice checks skip as before.
    voice:
      read.source.kind === "upload" && read.source.fileKind === "audio"
        ? ((await readVoice(store, caseId)) ?? { state: "not_checked" as const, reason: "the voice step did not run" })
        : read.source.kind === "message"
          ? await readVoice(store, caseId)
          : null,
    // Each stored transcript, for the transcript evidence (D01 T03 §16).
    transcripts: await storedTranscripts(store, caseId, key, read),
  };
  // Each check's outcome is stored with the evidence (D02 T01 §3), for the report's count of checks run.
  const { items, outcomes } = await runChecksWithOutcomes(view);
  // Each provider's own answer beside the evidence it weighed into (D02 T06 §9), in the same batch, so a
  // failed write leaves the previous evidence and results together and the step retries from them.
  const saved = await saveEvidence(
    store.db,
    caseId,
    items,
    undefined,
    undefined,
    outcomes,
    revision,
    data,
    reputationResultStatements(store.db, caseId, view.reputation),
  );
  return { evidence: saved.length };
}

// Every stored transcript of the case (D01 T03 §16): each `audio` artefact whose name is a transcript (the
// uploaded note's `transcript.json`, or a mail recording's `transcript-<n>.json` in attachment order), read for
// its turns. The mail case's aggregate `transcript.json` holds no turns and is left out; one that cannot be
// read or parsed is kept and named malformed, beside the valid ones.
async function storedTranscripts(
  store: Store,
  caseId: string,
  key: string,
  read: ReturnType<typeof caseViewOf>,
): Promise<NonNullable<CaseView["transcripts"]> | null> {
  const named = (await artefactsOf(store, caseId, "audio")).filter((s) => /transcript(-\d+)?\.json$/.test(s.key));
  if (!named.length) return null;
  const selected = (await audioAttachmentsOf(store, caseId, key)).selected;
  const out: NonNullable<CaseView["transcripts"]> = [];
  for (const s of named) {
    const numbered = /transcript-(\d+)\.json$/.exec(s.key);
    const recording = numbered ? selected[Number(numbered[1]) - 1] : undefined;
    const recordingKey =
      recording?.key ?? (read.source.kind === "upload" && read.source.fileKind === "audio" ? read.source.key : null);
    const base = { transcriptKey: s.key, recordingKey, filename: recording?.filename ?? null };
    const got = await readArtefact(store, caseId, s.key);
    if (!got || !("body" in got)) {
      out.push({ ...base, turns: [], gaps: [], complete: false, malformed: true });
      continue;
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(got.body)) as {
        turns?: unknown;
        gaps?: unknown;
        complete?: unknown;
      };
      // The mail aggregate holds no turns and is left out; any other transcript without a valid turns
      // list (or with a turn that is not a turn) is malformed, named beside its valid siblings, never
      // silently skipped and never left to throw inside the evidence mapping (completion review).
      const validTurns =
        Array.isArray(parsed.turns) &&
        parsed.turns.every(
          (turn) =>
            turn !== null &&
            typeof turn === "object" &&
            typeof (turn as { chunk?: unknown }).chunk === "number" &&
            typeof (turn as { startMs?: unknown }).startMs === "number" &&
            typeof (turn as { endMs?: unknown }).endMs === "number" &&
            typeof (turn as { text?: unknown }).text === "string" &&
            ((turn as { speaker?: unknown }).speaker === undefined ||
              (turn as { speaker?: unknown }).speaker === null ||
              typeof (turn as { speaker?: unknown }).speaker === "string"),
        );
      if (!validTurns) {
        const aggregate = !numbered && !(read.source.kind === "upload" && read.source.fileKind === "audio");
        if (aggregate) continue;
        out.push({ ...base, turns: [], gaps: [], complete: false, malformed: true });
        continue;
      }
      out.push({
        ...base,
        turns: parsed.turns as NonNullable<CaseView["transcripts"]>[number]["turns"],
        gaps: Array.isArray(parsed.gaps) ? (parsed.gaps as NonNullable<CaseView["transcripts"]>[number]["gaps"]) : [],
        complete: parsed.complete === true,
      });
    } catch {
      out.push({ ...base, turns: [], gaps: [], complete: false, malformed: true });
    }
  }
  return out.length ? out : null;
}

// Transcribes an uploaded voice note (D01 T03 §3): the stored recording the summary names, decoded to 10-minute WAV
// chunks and sent in turn under the case's budget, the transcript stored as its `audio` artefact. A recording that
// cannot be read, is too long or of a type not taken, and an answer outside its shape, end the step at once.
export async function transcribe(
  env: MetaEnv & { DB: D1Database },
  store: Store,
  caseId: string,
  key: string,
): Promise<{ transcript: string; chunks: number }> {
  const summary = await readArtefact(store, caseId, key);
  if (!summary || !("body" in summary)) throw new Error("the parsed summary is not stored");
  const source = (
    JSON.parse(new TextDecoder().decode(summary.body)) as { source?: { key?: string; mediaType?: string } }
  ).source;
  const recording = source?.key ? await readArtefact(store, caseId, source.key) : null;
  if (!recording || !("body" in recording)) throw fatal("RawMissing");
  const ctx = {
    env,
    budget: d1Budget(env.DB, { caller: "transcribe", caseId }),
    owner: { kind: "case" as const, caseId, step: "transcribe" },
    // Each chunk's call, retries included: three fit inside the step's attempt.
    deadlineMs: TRANSCRIBE_CALL_MS,
  };
  try {
    const { transcript, key: stored } = await transcribeChunks(
      store,
      caseId,
      decodeToWavChunks(recording.body, source?.mediaType ?? ""),
      ctx,
    );
    return { transcript: stored, chunks: transcript.chunks };
  } catch (error) {
    // Named here, never from the class's own name, which a minified build may change.
    if (error instanceof CorruptAudio) throw fatal("CorruptAudio");
    if (error instanceof AudioTooLong) throw fatal("AudioTooLong");
    if (error instanceof UnsupportedAudio) throw fatal("UnsupportedAudio");
    if (error instanceof ModelOutputError) throw fatal("ModelOutputError");
    // A 200 whose body could not be read (truncated JSON, empty, `null`) is the same paid, unusable answer (round 1).
    if (error instanceof ModelError && error.kind === "malformed") throw fatal("ModelOutputError");
    throw error;
  }
}

// At most this many recordings are transcribed for one mail case, in attachment order; the rest are stated as not
// read, since each is a paid call and a message can carry any number of attachments.
export const MAX_MAIL_RECORDINGS = 3;
const AUDIO_TYPES = new Set(["wav", "ogg", "m4a", "mp3"]);

// The bounded selection both the gate and the transcription use (D01 T03 §5): the first MAX_SNIFFED attachments'
// heads sniffed, as the type-mismatch check reads them; the rest are counted as unexamined, never silently passed.
async function audioAttachmentsOf(
  store: Store,
  caseId: string,
  key: string,
): Promise<{
  selected: { key: string; filename: string; mediaType: string; kind: string }[];
  unexamined: number;
}> {
  const summary = await readArtefact(store, caseId, key);
  if (!summary || !("body" in summary)) throw new Error("the parsed summary is not stored");
  const attachments =
    (
      JSON.parse(new TextDecoder().decode(summary.body)) as {
        attachments?: { key: string; filename: string; mediaType: string }[];
      }
    ).attachments ?? [];
  if (!attachments.length) return { selected: [], unexamined: 0 };
  const { heads, unread } = await attachmentHeadsOf(store.bucket, attachments);
  const byKey = new Map(attachments.map((a) => [a.key, a]));
  const kindOf = new Map<string, string>();
  const selected = heads
    .filter((h) => {
      const kind = sniff(Uint8Array.from(atob(h.head), (c) => c.charCodeAt(0)));
      if (kind === null || !AUDIO_TYPES.has(kind)) return false;
      kindOf.set(h.key, kind);
      return true;
    })
    .map((h) => byKey.get(h.key))
    .filter((a): a is { key: string; filename: string; mediaType: string } => a !== undefined)
    .map((a) => ({ ...a, kind: kindOf.get(a.key) as string }));
  // An attachment whose head could not be read at all, declared as audio by its type or name, is still a
  // candidate: its body read in the loop names it missing, rather than it vanishing from the accounting.
  if (attachments.length <= 20) {
    const headed = new Set(heads.map((h) => h.key));
    for (const a of attachments) {
      if (headed.has(a.key) || selected.some((x) => x.key === a.key)) continue;
      const ext = a.filename.slice(a.filename.lastIndexOf(".") + 1).toLowerCase();
      if (a.mediaType.toLowerCase().startsWith("audio/") || ["wav", "ogg", "m4a", "mp3"].includes(ext))
        selected.push({ ...a, kind: ext });
    }
  }
  return { selected, unexamined: unread };
}

export async function mailAudioCount(store: Store, caseId: string, key: string): Promise<number> {
  return (await audioAttachmentsOf(store, caseId, key)).selected.length;
}

// What happened to one recording, stored with the transcript so the voice evidence can name it.
export type RecordingOutcome =
  | "transcribed"
  | "silent"
  | "corrupt"
  | "unsupported"
  | "too-long"
  | "refused"
  | "missing"
  | "past-bound";

// A mail case's audio attachments, transcribed (D01 T03 §5): every selected recording decoded and transcribed in
// attachment order, each under its own stored name (`transcript-<n>.json`, holding its source filename) so its
// identity survives, and the texts joined into the case's one transcript, complete only when every selected
// recording was transcribed whole and nothing was left unexamined. A finished recording is resumed from its
// stored transcript, never paid for twice; a provider failure a retry may cure is thrown for the step's retry,
// and a recording that cannot be read has its outcome named in the stored transcript instead of failing the case.
export async function transcribeAttachments(
  env: MetaEnv & { DB: D1Database },
  store: Store,
  caseId: string,
  key: string,
): Promise<{ recordings: number; transcribed: number }> {
  const { selected, unexamined } = await audioAttachmentsOf(store, caseId, key);
  const ctx = {
    env,
    budget: d1Budget(env.DB, { caller: "transcribe", caseId }),
    owner: { kind: "case" as const, caseId, step: "transcribe" },
    deadlineMs: TRANSCRIBE_CALL_MS,
  };
  const stored = await artefactsOf(store, caseId, "audio");
  let allWhole = true;
  // Each recording's words under its own boundary line, naming its file, so a claim is read against the recording
  // it came from and two speakers are never one continuous statement.
  const texts: string[] = [];
  const spoken = (i: number, filename: string, text: string) =>
    texts.push(`[Recording ${i + 1} of the message's audio attachments: ${filename}]\n${text}`);
  const outcomes: { filename: string; outcome: RecordingOutcome }[] = [];
  let transcribed = 0;
  for (const [i, a] of selected.entries()) {
    if (i >= MAX_MAIL_RECORDINGS) {
      outcomes.push({ filename: a.filename, outcome: "past-bound" });
      continue;
    }
    const name = `transcript-${i + 1}.json`;
    const prior = stored.find((x) => x.key.endsWith(`-${name}`));
    if (prior) {
      const read = await readArtefact(store, caseId, prior.key);
      const parsed =
        read && "body" in read
          ? (JSON.parse(new TextDecoder().decode(read.body)) as { text?: unknown; complete?: unknown })
          : null;
      if (typeof parsed?.text === "string") {
        transcribed++;
        outcomes.push({ filename: a.filename, outcome: parsed.text.trim() ? "transcribed" : "silent" });
        if (parsed.text.trim()) spoken(i, a.filename, parsed.text.trim());
        if (parsed.complete !== true) allWhole = false;
        continue;
      }
    }
    const read = await readArtefact(store, caseId, a.key);
    if (!read || !("body" in read)) {
      outcomes.push({ filename: a.filename, outcome: "missing" });
      continue;
    }
    try {
      const { transcript } = await transcribeChunks(
        store,
        caseId,
        decodeToWavChunks(
          read.body,
          { wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp3: "audio/mpeg" }[a.kind] ?? a.mediaType,
        ),
        ctx,
        name,
      );
      transcribed++;
      outcomes.push({ filename: a.filename, outcome: transcript.text.trim() ? "transcribed" : "silent" });
      if (transcript.text.trim()) spoken(i, a.filename, transcript.text.trim());
      if (!transcript.complete) allWhole = false;
    } catch (error) {
      // A provider or storage failure a retry may cure fails the step; the recordings already stored are resumed.
      if (error instanceof ModelError && error.kind !== "malformed") throw error;
      if (error instanceof StoreError) throw error;
      outcomes.push({
        filename: a.filename,
        outcome:
          error instanceof CorruptAudio
            ? "corrupt"
            : error instanceof AudioTooLong
              ? "too-long"
              : error instanceof UnsupportedAudio
                ? "unsupported"
                : "refused",
      });
    }
  }
  const complete =
    allWhole &&
    unexamined === 0 &&
    outcomes.length > 0 &&
    outcomes.every((o) => o.outcome === "transcribed" || o.outcome === "silent") &&
    transcribed === Math.min(selected.length, MAX_MAIL_RECORDINGS);
  if (selected.length)
    await putArtefact(
      store,
      caseId,
      "audio",
      TRANSCRIPT_NAME,
      new TextEncoder().encode(JSON.stringify({ text: texts.join("\n"), complete, recordings: outcomes })),
      "application/json",
    );
  return { recordings: selected.length, transcribed };
}

// The verdict from the case's stored evidence, in its order: the rule-based verdict (D04 T01 §2), floored by the
// evidence (§1), until the agent's replaces it (§4). The step's result names the evidence it read, beside the view.
export async function verdict(
  env: Env,
  db: D1Database,
  store: Store,
  caseId: string,
): Promise<{ view: VerdictView; evidence: { id: string; check: string }[] }> {
  const evidence = await readEvidence(db, caseId);
  const row = await db
    .prepare("SELECT headers_available, org_id FROM cases WHERE id = ?")
    .bind(caseId)
    .first<{ headers_available: number; org_id: string }>();
  const headersAvailable = row?.headers_available === 1;
  const { table } = await brandTableRead(env);
  const summary = await (async () => {
    const read = await readArtefact(store, caseId, parsedKey(caseId));
    if (!read || !("body" in read)) return "(the message content could not be read)";
    try {
      return caseSummary(
        JSON.parse(new TextDecoder().decode(read.body)) as {
          headers?: unknown;
          text?: string | null;
          html?: string | null;
        },
      );
    } catch {
      return "(the message content could not be read)";
    }
  })();
  const keys = await bankKeys(env).catch(() => null);
  const deps = verdictToolDeps(env, db, store, caseId, row?.org_id ?? null, table, keys);
  // Every address the case already holds, from the evidence that carries it: landing pages, link chains and the
  // addresses they settled on, so the agent can investigate a link the checks found without following a new one.
  const collect = (value: unknown, out: string[]) => {
    if (typeof value === "string" && /^https?:\/\//.test(value)) out.push(value);
    else if (Array.isArray(value)) for (const v of value) collect(v, out);
    else if (value && typeof value === "object") for (const v of Object.values(value)) collect(v, out);
  };
  const found: string[] = [];
  for (const e of evidence) collect(e.detail, found);
  const urls = [...new Set(found)];
  const executor = createToolExecutor({ db, caseId, urls }, deps);
  const view = await runAgent(
    {
      db,
      meta: { env, budget: d1Budget(db, { caller: "verdict-agent", caseId }) },
      summary,
      headersAvailable,
      executor,
    },
    caseId,
  );
  const fresh = await readEvidence(db, caseId);
  return { view, evidence: fresh.map(({ id, check }) => ({ id, check })) };
}

// An optional read given at most OPTIONAL_READ_MS, rejecting after it, so the reply step's 30-second attempt keeps its
// time for the send.
// What the `checks` step's registration-date lookups reach the network with: RDAP over fetch, ZACR's WHOIS for `.za`
// names over a TCP socket (D02 T03 §9), and KV as their cache.
export const rdapDeps = (env: Pick<Env, "CACHE">): RdapDeps => ({
  fetch: (input, init) => fetch(input, init),
  connect,
  cache: env.CACHE,
});

// What the checks step's reputation lookups reach the providers with (D02 T06 §5): Web Risk (its key, KV cache, D1
// for its caps and audit), Cloudflare's resolver and the well-known list, both through the same cache.
export const reputationDeps = (
  env: Pick<Env, "CACHE" | "DB" | "WEB_RISK_API_KEY">,
  caseId: string,
  orgId: string,
): ReputationDeps => ({
  webRisk: (url) =>
    webRiskSearch(url, {
      fetch: (input, init) => fetch(input, init),
      cache: env.CACHE,
      db: env.DB,
      key: env.WEB_RISK_API_KEY ?? null,
      orgId,
      caseId,
    }),
  cloudflare: (domain) =>
    cloudflareBlocked(domain, { fetch: (input, init) => fetch(input, init), cache: env.CACHE, db: env.DB, caseId }),
  wellKnown: (host) => isWellKnown(host, { cache: env.CACHE }),
});

export const OPTIONAL_READ_MS = 5_000;
function withinDeadline<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("OptionalReadTimeout")), OPTIONAL_READ_MS);
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

// Sends the member the answer (D01 T02 §3): the stored verdict, or for a partial case a notice that it could not
// finish, as a reply in the forward's thread, to the admitted forwarder, under one send key a case. The forward's
// subject and threading come from its stored header block (read by a bounded range), else from the case's stored
// Message-ID with a subject made by code. A case with no forwarder (an upload) has no one to reply to. A failed send
// throws so the step retries; an uncertain one is left to the reconcile job; refused and duplicate are final.
// `sendKey`: the delivery a resend is for (D01 T01 §17's completion review), else the case's current run's.
export async function reply(env: Env, caseId: string, state: ReportState, sendKey?: string) {
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
  // The summary and the forward's header block are optional: either unreadable (gone, a storage fault, or still not
  // read after OPTIONAL_READ_MS, so a stalled read cannot use up the attempt) and the reply still goes, with no
  // other-originals note and the fallback subject and threading.
  const otherOriginals = await withinDeadline(readArtefact(store, caseId, parsedKey(caseId)))
    .then((summary) =>
      summary && "body" in summary
        ? Number((JSON.parse(new TextDecoder().decode(summary.body)) as ParsedSummary).forward?.otherOriginals ?? 0)
        : 0,
    )
    .catch(() => 0);
  const head = await withinDeadline(
    env.ARTEFACTS.get(rawKey(caseId), { range: { offset: 0, length: HEADER_RANGE } }).then(async (object) =>
      object ? new Uint8Array(await object.arrayBuffer()) : null,
    ),
  ).catch(() => null);
  const parent = (await parentHeaders(head)) ?? {
    subject: null,
    messageId: null,
    references: null,
    inReplyTo: null,
  };
  const link = `${reportOrigin(env.PUBLIC_ORIGIN)}${await signReportLink(env.REPORT_LINK_SECRET, caseId, found.orgId)}`;
  // N1's design (D07 T03 §7): the organisation, this run's evidence (the reasons' pills, the further findings and the
  // authentication results) and its stored check outcomes, read here so the operator's resend (src/mail/resend.ts)
  // carries the same. A read that fails throws, and the step tries again.
  const organisation = await env.DB.prepare(`SELECT name FROM "organization" WHERE id = ?`)
    .bind(found.orgId)
    .first<{ name: string }>();
  const evidence = await readEvidence(env.DB, caseId);
  const coverage = await readCheckOutcomes(env.DB, caseId);
  // The authentication results this run stored, each method the receiver reported (D01 T02 §11, §16).
  const headers = replyHeaders(evidence);
  const built = buildReply({
    parentSubject: parent.subject,
    headersAvailable: found.headersAvailable,
    otherOriginals,
    report,
    reportUrl: link,
    design: {
      appUrl: env.APP_URL,
      organisation: organisation?.name ?? null,
      evidence: evidence.map((item) => ({ id: item.id, severity: item.severity })),
      coverage,
      voice: found.sourceKind === "audio",
      ...(Object.keys(headers).length ? { headers } : {}),
    },
  });
  const outcome = await sendMail(
    { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL, timeoutMs: REPLY_SEND_TIMEOUT_MS },
    {
      // One reply per run: a retried run's verdict is not the first run's notice sent again (D01 T01 §17).
      sendKey: sendKey ?? `reply:${found.runId ?? caseId}`,
      kind: "reply",
      to: found.forwardedBy,
      from: REPLY_FROM,
      subject: built.subject,
      text: built.text,
      html: built.html,
      // RFC 3834: an automatic response says so, so a well-behaved responder never answers it.
      headers: {
        ...threading({ ...parent, messageId: parent.messageId || found.messageId }),
        "Auto-Submitted": "auto-replied",
      },
      caseId,
    },
  );
  if (outcome.status === "failed") throw new Error("ReplyNotSent");
  // The send's whole outcome, `previous` included, for a caller that must know a duplicate's own result (D01 T02 §8).
  return { ...base, mail: outcome.status, outcome };
}
