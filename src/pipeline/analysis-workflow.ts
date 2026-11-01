import { connect } from "cloudflare:sockets";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { ruleVerdict } from "../agent/rule-verdict";
import { type LookupMx, lookupMx, receiversForOrg } from "../auth/receivers";
import { attachmentPhrases, bodyPhrases, instructionsOf } from "../checks/ai-instructions";
import { attachmentRisksOf } from "../checks/attachment-risk";
import { type BrandTable, brandTable, bundled } from "../checks/brands";
import { caseViewOf, type Tenant } from "../checks/case-view";
import { type Evidence, readCheckOutcomes, readEvidence, saveEvidence } from "../checks/evidence";
import { hiddenTextOf } from "../checks/hidden-text";
import { htmlAttachmentsOf } from "../checks/html-attachment";
import { invisibleOf, PhraseLog, withoutInstructions } from "../checks/instruction-phrases";
import { invisibleRuns } from "../checks/invisible-unicode";
import { linksOf } from "../checks/links";
import { domainAgesOf, type RdapDeps } from "../checks/rdap";
import { runChecksWithOutcomes } from "../checks/runner";
import { observeSender, originalSender } from "../checks/senders-seen";
import { attachmentHeadsOf } from "../checks/sniff";
import { listOwnDomains, listSupplierDomains } from "../checks/suppliers";
import {
  type CaseResult,
  getCaseForPipeline,
  type SourceKind,
  setHeadersAvailable,
  setOriginalHeader,
  setStatus,
  type Verdict,
} from "../db/cases";
import { getVerdict, storeVerdict, type VerdictResult, type VerdictView } from "../db/verdicts";
import { extractOriginal, ParseError } from "../intake/forward";
import { parseMsg } from "../intake/msg";
import { NO_HEADER, originalHeaderOf } from "../intake/original-header";
import { type ParsedSummary, parseMessage, storeParsed } from "../intake/parse";
import { artefactsOf, parsedKey, putParsed, putVisible, rawKey, readArtefact, type Store } from "../intake/store";
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
import { BudgetExceeded } from "../meta/guard";
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
// The reply's own budget (the final review): its two optional reads (OPTIONAL_READ_MS each), then up to MAX_ATTEMPTS
// provider calls of REPLY_SEND_TIMEOUT_MS with 1 and 2 seconds between them, all inside one attempt, so the attempt is
// never stopped while SMTP2GO is still inside its own timeout and the send's outcome unrecorded.
export const REPLY_SEND_TIMEOUT_MS = 20_000;
export const REPLY_STEP_TIMEOUT_MS = 90_000;
const REPLY_RETRIES: WorkflowStepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: `${REPLY_STEP_TIMEOUT_MS / 1000} seconds`,
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
      step.do(name, name === "reply" ? REPLY_RETRIES : RETRIES, () =>
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
    const { orgId, channel, sourceKind, headersAvailable } = admitted;

    let state: ReportState;
    let current: StepName = "parse";
    try {
      const key = await timed("parse", () => parse(store, caseId, { channel, sourceKind, headersAvailable }));
      current = "checks";
      // The brand table is read inside the step: KV's copy when it reads in time, else the bundled one (D02 T02 §4).
      await timed("checks", async () =>
        checks(store, caseId, key, { orgId, channel }, lookupMx, await brandTable(this.env), rdapDeps(this.env)),
      );
      current = "verdict";
      const { view } = await timed("verdict", () => verdict(db, caseId));
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
  const read = caseViewOf(
    JSON.parse(new TextDecoder().decode(summary.body)),
    {
      ...tenant,
      receivers,
      // The domains the organisation trusts, for the lookalike check (D02 T03 §2).
      trusted: {
        own: await listOwnDomains(store.db, tenant.orgId),
        suppliers: counterparty ? [] : await listSupplierDomains(store.db, tenant.orgId),
      },
    },
    rawKey(caseId),
    brands,
  );
  // The sender's history, classified once per case before the checks (D02 T02 §5), so a retried step reads the same.
  const sender = originalSender(read);
  // The phrases written to steer an AI (D02 T05 §2), matched over every text whole as it is read: the body's, through
  // the hidden-text scan, and the text and HTML attachments'.
  const phrases = new PhraseLog();
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
  const instructions = read.source.kind === "message" || read.attachments.length ? instructionsOf(phrases) : null;
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
  const view = {
    ...read,
    htmlAttachments,
    links,
    // Macros, encrypted archives and programs in the attachments (D02 T04 §3).
    attachmentRisks: await attachmentRisksOf(store.bucket, { attachments: read.attachments, attachmentHeads: heads }),
    instructions,
    invisibleText: read.source.kind === "message" || read.attachments.length ? invisibleOf(phrases) : null,
    senderHistory: sender && !counterparty ? await observeSender(store.db, tenant.orgId, caseId, sender) : null,
    // The header domains' registration dates (D02 T03 §4), looked up here since a check never reaches the network.
    domainAges: rdap ? await domainAgesOf(read, rdap) : null,
    // Each attachment's first bytes, for the type-mismatch check (D02 T04 §1).
    attachmentHeads: heads,
    // Hidden text and the visible text a model reads (D02 T05 §1); the visible text is stored before the evidence.
    hiddenText: scanned?.hidden ?? null,
  };
  // Each check's outcome is stored with the evidence (D02 T01 §3), for the report's count of checks run.
  const { items, outcomes } = await runChecksWithOutcomes(view);
  const saved = await saveEvidence(store.db, caseId, items, undefined, undefined, outcomes);
  return { evidence: saved.length };
}

// The verdict from the case's stored evidence, in its order: the rule-based verdict (D04 T01 §2), floored by the
// evidence (§1), until the agent's replaces it (§4). The step's result names the evidence it read, beside the view.
export async function verdict(
  db: D1Database,
  caseId: string,
): Promise<{ view: VerdictView; evidence: { id: string; check: string }[] }> {
  const evidence = await readEvidence(db, caseId);
  const row = await db
    .prepare("SELECT headers_available FROM cases WHERE id = ?")
    .bind(caseId)
    .first<{ headers_available: number }>();
  const view = ruleVerdict(evidence, { headersAvailable: row?.headers_available === 1 });
  return { view, evidence: evidence.map(({ id, check }) => ({ id, check })) };
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
  // The authentication results, when this run stored all three (D01 T02 §11).
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
      ...(headers ? { headers } : {}),
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
