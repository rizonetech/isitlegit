// The part of the report that changes while a case runs (D07 T03 §4; design/SPEC.md M3 running, partial and failed
// states, boards `Report-Running`, `Report-Partial`, `Report-Mobile`): one region, `#report-live`, which a running case
// polls every 2 seconds (`GET /r/:caseId/status`, src/web/pages/report.tsx) and which a finished case answers once,
// with no trigger, so the polling stops. Its words for the live region outside it are `data-announce`, which the app
// script says once when they change. Coverage (what the checks covered) is read from the stored check outcomes, apart
// from the case's lifecycle, and a reply that could not be sent is its own notice.

import type { ModelTrace } from "../../db/model-trace-types";
import { artefactUrl } from "../artefact-url";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { type CardItem, CHECK_WORDS, EvidenceCards, type ReputationRow } from "../components/evidence/cards";
import { ModelTracePanel, replyAwaited, type TraceFacts } from "../components/model-trace";
import { Pill, type PillVariant } from "../components/Pill";
import { PartialNotice } from "../components/States";
import { VerdictBand, type VerdictName } from "../components/Verdict";
import { FeedbackControl } from "./feedback-control";
import { admissionFailed, errorWords, type Progress, UNMENDABLE } from "./report-progress";
import { cited, type ReportVerdict, VerdictSection } from "./report-verdict";
import { CONFIRMING, RETRY_WORDS, type RetryNote } from "./retry-words";

// A stored check outcome (D02 T01 §3, `readCheckOutcomes`), as the report reads it; `null` for a case checked before
// outcomes were stored. `summary`: what a clean or finding run saw (D02 T01 §7), absent when none was stored.
// `revision`: the Worker version that ran it (D02 T01 §4), absent for a row stored before versions were kept.
export type Coverage =
  | {
      check: string;
      outcome: "ran" | "partial" | "skipped" | "failed";
      reason: string | null;
      findings: number;
      summary?: string;
      revision?: string;
      // The detection data the run judged by (D02 T01 §6), where stored; drawn beside the version (D07 T09 §12).
      data?: { revision: string; id: string; source: "kv" | "bundled" };
      // What a clean check examined, where stored (D02 T01 §8); drawn under the clean list (D07 T09 §10).
      examined?: { targets: string[]; omitted: number };
    }[]
  | null;

// The evidence's count line (D07 T03 §18, M3: "9 findings · 8 checks ran · nothing skipped"), from the cards drawn and
// the stored outcomes: a finding is a card, never the `not_checked` card (a check that did not run found nothing); a
// check that read part of its input ran, as the coverage notice counts it. A case with no stored outcomes counts its
// findings alone, since how many checks ran was not kept.
const words = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export function evidenceCount(evidence: readonly CardItem[], coverage: Coverage): string {
  const found = words(evidence.filter((e) => e.check !== "not_checked").length, "finding", "findings");
  if (coverage === null) return found;
  const ran = coverage.filter((o) => o.outcome === "ran" || o.outcome === "partial").length;
  const skipped = coverage.filter((o) => o.outcome === "skipped").length;
  const failed = coverage.filter((o) => o.outcome === "failed").length;
  const missed = [skipped ? `${skipped} skipped` : "", failed ? `${failed} failed` : ""].filter(Boolean);
  return [found, words(ran, "check ran", "checks ran"), ...(missed.length ? missed : ["nothing skipped"])].join(" · ");
}

// The safe board's "Checks that found nothing" (D07 T03 §18, Report-Safe): each check that ran over all of its input
// and found nothing, in run order, by its plain words, or by its stored name for a check retired since. A partial check
// is never clean (part of its input went unread). The board follows each with what the check saw (its stored result
// summary, D02 T01 §7; D07 T03 §44), or "nothing found" when none was kept; a stored summary is drawn as text.
export function CleanChecks(props: { coverage: Coverage }) {
  const clean = (props.coverage ?? []).filter((o) => o.outcome === "ran" && o.findings === 0);
  if (clean.length === 0) return null;
  return (
    <section aria-labelledby="clean-heading" class="flex flex-col gap-12 p-24 bg-subtle rounded-card-large">
      <h2 id="clean-heading" class="type-h3">
        Checks that found nothing
      </h2>
      <ul class="flex flex-col gap-8 text-14">
        {clean.map((o) => (
          <li class="wrap-anywhere">
            {`${CHECK_WORDS[o.check] ?? o.check}: ${o.summary?.trim() ? o.summary : "nothing found"}`}
            {o.examined &&
              (o.examined.targets.length > 0 ? (
                <details>
                  <summary class={cx("type-small text-muted cursor-pointer", FOCUS)}>
                    See what this check examined
                  </summary>
                  <ul class="flex flex-col gap-4 mt-8">
                    {o.examined.targets.map((target) => (
                      <li class="wrap-anywhere">{target}</li>
                    ))}
                  </ul>
                  {o.examined.omitted > 0 && (
                    <p class="type-small text-muted mt-8">{`${o.examined.omitted} more target${o.examined.omitted === 1 ? " was" : "s were"} examined but ${o.examined.omitted === 1 ? "is" : "are"} not listed.`}</p>
                  )}
                </details>
              ) : (
                <span class="block type-small text-muted">No targets were recorded for this check.</span>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

// The reply mail's stored status (`mail_sends`, read by src/db/case-progress.ts).
export type ReplySend = "pending" | "sent" | "failed" | "uncertain" | "refused";

export type LiveProps = {
  caseId: string;
  // How the case came: an email's answer is also emailed back; an upload's stays on this page only.
  channel: "email" | "upload";
  // The reply mail's stored outcome (`mail_sends`, src/db/case-progress.ts), null when none was attempted.
  delivery: ReplySend | null;
  status: "received" | "running" | "done" | "partial";
  verdict: ReportVerdict | null;
  sourceKind: string;
  evidence: readonly CardItem[];
  reputation?: readonly ReputationRow[] | null | undefined;
  progress: Progress;
  coverage: Coverage;
  view: "member" | "public";
  // A member's own feedback on this case (D07 T03 §6): `null` when none yet; absent for a link holder, who has no
  // control.
  feedback?: { kind: "false_alarm" | "missed"; note: string | null; at?: string } | null;
  // The member came to dispute this verdict (D07 T03 §22): the closed control says so and its button is focused.
  dispute?: boolean;
  // A link holder's signature parameters, kept on every URL the region asks for.
  link?: string;
  // A member's retry that met a refusal (D07 T03 §20), carried signed by the address the retry answered with, and said on
  // the failed report; and whether a retry's start is still unconfirmed, a fact of the case's stored state.
  retry?: RetryNote | null;
  confirming?: boolean;
  // An upload's stored file name, said when its file never arrived (D07 T03 §40).
  uploadName?: string | null;
  // The model trace (D07 T03 §5), a member's only and read only once the report is past running, so the poll that
  // finishes it carries it; `traceOpen` is the address's `?trace=1`, kept on the poll so a watched report finishes open.
  trace?: { data: ModelTrace; facts: TraceFacts; run: string } | null;
  traceOpen?: boolean;
  now?: Date;
  // The phone's line of which message this is (D07 T03 §9's `MetaLine`), drawn under the band so the poll keeps it
  // current, and the fingerprint of the header the page holds, sent with each poll so the header is replaced only when
  // it changed (`headerKey`).
  meta?: unknown;
  headerKey?: string;
  // The filtered list the member came from, as a query string (D07 T04 §9): the retry keeps it, so its answer
  // lands back in the same run.
  navQuery?: string;
};

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const clockSeconds = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// The early authentication card (D07 T03 §37, board `Report-Running-Early`): while a case runs, what the receiving
// mail system recorded for SPF, DKIM and DMARC, from each method's stored item. The stored outcomes say the checks
// have run; each item's own `detail.state` says what was recorded, so a pass and a failure never read alike. A
// method whose check failed, or whose results no trusted receiver stands behind, says so and invents no result.
const AUTH_METHODS = [
  { check: "auth.spf", method: "spf", name: "Sending server (SPF)" },
  { check: "auth.dkim", method: "dkim", name: "Signature (DKIM)" },
  { check: "auth.dmarc", method: "dmarc", name: "Domain policy (DMARC)" },
] as const;
type EarlyRow = { name: string; variant: PillVariant; word: string; sentence: string; details: string[] };
type EarlyAuthData =
  | { kind: "results"; rows: EarlyRow[]; composite: string | null }
  | { kind: "none"; sentence: string };

const cleanStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const propRecord = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    const s = cleanStr(val);
    if (s) out[k.toLowerCase()] = s;
  }
  return out;
};
const COMPAUTH_REASONS: Record<string, string> = {
  "000": "explicit authentication failed",
  "001": "implicit authentication failed",
  "002": "spoofed mail blocked by organisation policy",
  "010": "DMARC failed with reject or quarantine policy for an organisation accepted domain",
  "100": "explicit authentication passed",
  "101": "DKIM signed by the From domain",
  "109": "authentication would pass despite no DMARC record",
  "130": "trusted ARC seal overrode a DMARC failure",
};
const spfPropDomain = (value: string | undefined): string => {
  const v = (value ?? "").trim().toLowerCase().replace(/^<|>$/g, "");
  return v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
};
function joinWhy(comment: string | null, reason: string | null, needsReason: boolean): string | null {
  const parts: string[] = [];
  if (reason) parts.push(comment && comment !== reason ? `reason ${reason}` : reason);
  if (comment && comment !== reason) parts.push(comment);
  if (parts.length > 0) return parts.join(" · ");
  return needsReason ? "reason not recorded" : null;
}
function methodDiagnosticLines(
  method: "spf" | "dkim" | "dmarc",
  state: string,
  detail: Record<string, unknown>,
  rawForMethod: readonly Record<string, unknown>[],
): string[] {
  const results = Array.isArray(detail.results)
    ? detail.results.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
    : [];
  const lines: string[] = [];
  if (method === "spf") {
    const singleHelo = detail.helo === true && results.length === 1;
    for (let i = 0; i < results.length; i++) {
      const r = results[i] as Record<string, unknown>;
      const res = cleanStr(r.result) ?? "unknown";
      const id = cleanStr(r.identifier);
      const comment = cleanStr(r.comment);
      const props = propRecord(rawForMethod[i]?.props);
      const mailfrom = props["smtp.mailfrom"];
      const helo = props["smtp.helo"];
      const ip = props["client-ip"];
      const reason = props.reason ?? null;
      const mailfromDomain = spfPropDomain(mailfrom);
      const heloDomain = spfPropDomain(helo);
      const isHelo = mailfromDomain ? false : heloDomain ? true : singleHelo;
      if (res === "none" && !id && !mailfrom && !helo && !ip && !comment && !reason) continue;
      const who = [
        id ? (isHelo ? `${id} (HELO)` : id) : "no domain named",
        mailfrom && mailfrom !== id ? `smtp.mailfrom=${mailfrom}` : null,
        helo ? `smtp.helo=${helo}` : null,
        ip ? `IP ${ip}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const why = joinWhy(comment, reason, res !== "pass" && res !== "none");
      lines.push([`${who}: ${res}`, why].filter(Boolean).join(" · "));
    }
    return lines;
  }
  if (method === "dkim") {
    for (let i = 0; i < results.length; i++) {
      const r = results[i] as Record<string, unknown>;
      const res = cleanStr(r.result) ?? "unknown";
      const id = cleanStr(r.identifier);
      const comment = cleanStr(r.comment);
      const props = propRecord(rawForMethod[i]?.props);
      const hd = props["header.d"];
      const hi = props["header.i"];
      const hs = props["header.s"];
      const reason = props.reason ?? null;
      if (res === "none" && !id && !hd && !hi && !hs && !comment && !reason) continue;
      const signer = id ?? hd ?? hi ?? "no signer named";
      const who = [signer, hi && hi !== signer ? `header.i=${hi}` : null, hs ? `selector ${hs}` : null]
        .filter(Boolean)
        .join(", ");
      const why = joinWhy(comment, reason, res !== "pass" && res !== "none");
      lines.push([`${who}: ${res}`, why].filter(Boolean).join(" · "));
    }
    return lines;
  }
  const firstProps = propRecord(rawForMethod[0]?.props);
  const from = cleanStr(detail.from) ?? firstProps["header.from"] ?? null;
  const policy = detail.policy as { certain?: unknown; either?: unknown } | null | undefined;
  const either =
    Array.isArray(policy?.either) &&
    policy.either.length === 2 &&
    cleanStr(policy.either[0]) &&
    cleanStr(policy.either[1])
      ? `${cleanStr(policy.either[0])} or ${cleanStr(policy.either[1])}`
      : null;
  const policyWords = cleanStr(policy?.certain) ?? either ?? firstProps["policy.dmarc"] ?? null;
  if (from) lines.push(`From domain: ${from}`);
  if (policyWords) lines.push(`Policy: ${policyWords}`);
  else if (state === "failed" || state === "inconclusive") lines.push("Policy: not recorded");
  for (let i = 0; i < results.length; i++) {
    const r = results[i] as Record<string, unknown>;
    const res = cleanStr(r.result) ?? "unknown";
    const comment = cleanStr(r.comment);
    const props = propRecord(rawForMethod[i]?.props);
    const action = props.action;
    const reason = props.reason ?? null;
    if (res === "none" && !comment && !action && !reason) continue;
    const why = joinWhy(comment, reason, res !== "pass" && res !== "none" && res !== "bestguesspass");
    lines.push([`Result: ${res}`, action ? `action ${action}` : null, why].filter(Boolean).join(" · "));
  }
  return lines;
}
function compositeDiagnostic(authResultsItem: CardItem | undefined): string | null {
  if (!authResultsItem || authResultsItem.detail.trusted === false) return null;
  const raw = Array.isArray(authResultsItem.detail.results)
    ? authResultsItem.detail.results.filter(
        (r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r),
      )
    : [];
  const entries: string[] = [];
  for (const r of raw) {
    if (cleanStr(r.method)?.toLowerCase() !== "compauth") continue;
    const res = cleanStr(r.result);
    if (!res) continue;
    const props = propRecord(r.props);
    const code = props.reason;
    const explained = code ? (COMPAUTH_REASONS[code] ?? "reason code not documented") : null;
    const reason = code ? `reason ${code} (${explained})` : null;
    entries.push([res, reason].filter(Boolean).join(" · "));
  }
  return entries.length ? `Composite authentication (compauth): ${entries.join("; ")}` : null;
}
function earlyAuthOf(coverage: Coverage, evidence: readonly CardItem[]): EarlyAuthData | null {
  if (!coverage) return null;
  const outcomes = AUTH_METHODS.map((m) => ({ ...m, outcome: coverage.find((o) => o.check === m.check) })).filter(
    (m) => m.outcome,
  );
  if (outcomes.length === 0) return null;
  const authResults = evidence.find((e) => e.check === "auth.results");
  if (outcomes.every((m) => m.outcome?.outcome === "skipped")) {
    return {
      kind: "none",
      sentence:
        authResults?.summary ?? "No authentication results from a receiving system this service trusts were stored.",
    };
  }
  const rawResults =
    authResults && authResults.detail.trusted !== false && Array.isArray(authResults.detail.results)
      ? authResults.detail.results.filter(
          (r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r),
        )
      : [];
  const rows: EarlyRow[] = [];
  for (const m of outcomes) {
    if (m.outcome?.outcome === "failed") {
      rows.push({
        name: m.name,
        variant: "partial",
        word: "Could not be checked",
        sentence: "This check did not finish, so there is no result for it yet.",
        details: [],
      });
      continue;
    }
    if (m.outcome?.outcome === "skipped") continue;
    const item = evidence.find((e) => e.check === m.check);
    if (!item) continue;
    const state = typeof item.detail.state === "string" ? item.detail.state : "";
    const results = Array.isArray(item.detail.results) ? item.detail.results : [];
    const pill: { variant: PillVariant; word: string } =
      state === "passed"
        ? { variant: "safe", word: "Passed" }
        : state === "failed"
          ? { variant: "malicious", word: "Failed" }
          : state === "unavailable" &&
              m.check === "auth.dkim" &&
              results.some((r) => !!r && typeof r === "object" && (r as { result?: unknown }).result === "none")
            ? { variant: "partial", word: "Not signed" }
            : state === "unavailable"
              ? { variant: "partial", word: "Not reported" }
              : { variant: "partial", word: "Could not be checked" };
    const rawForMethod = rawResults.filter((r) => cleanStr(r.method)?.toLowerCase() === m.method);
    const details = methodDiagnosticLines(m.method, state, item.detail, rawForMethod);
    rows.push({ name: m.name, ...pill, sentence: item.summary, details });
  }
  return rows.length ? { kind: "results", rows, composite: compositeDiagnostic(authResults) } : null;
}
function EarlyAuth(props: { data: EarlyAuthData; now: Date }) {
  return (
    <section
      aria-labelledby="early-auth-title"
      class="flex flex-col overflow-hidden bg-surface border border-line rounded-card-large"
    >
      <div class="flex flex-wrap items-center justify-between gap-12 px-24 py-16 border-b border-line">
        <div class="flex flex-wrap items-center gap-12">
          <Pill variant="partial">Early result</Pill>
          <h2 id="early-auth-title" class="type-h3">
            What the receiving mail system recorded
          </h2>
        </div>
        <p class="type-small text-muted">{`Read at ${clockSeconds.format(props.now)} · before the investigation ends`}</p>
      </div>
      <div class="flex flex-col gap-16 p-24">
        {props.data.kind === "none" ? (
          <p class="text-14 wrap-anywhere">{props.data.sentence}</p>
        ) : (
          <>
            <ul class="grid gap-16 md:grid-cols-3">
              {props.data.rows.map((row) => (
                <li class="flex flex-col gap-6 p-16 bg-subtle rounded-card min-w-0">
                  <Pill variant={row.variant} class="self-start">
                    {row.word}
                  </Pill>
                  <strong class="text-14 wrap-anywhere">{row.name}</strong>
                  <span class="type-small text-muted wrap-anywhere">{row.sentence}</span>
                  {row.details.length > 0 && (
                    <ul class="flex flex-col gap-4 pt-4 border-t border-line type-small text-muted">
                      {row.details.map((line) => (
                        <li class="wrap-anywhere">{line}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {props.data.composite && <p class="type-small text-muted wrap-anywhere">{props.data.composite}</p>}
          </>
        )}
        <p class="type-small text-muted">
          These are what the receiving system recorded when the message arrived. They are not the verdict, and a later
          step may add to them.
        </p>
      </div>
    </section>
  );
}
const seconds = (ms: number | null) => (ms === null ? "" : `${(ms / 1000).toFixed(1)} s`);
// How long a failed check's report keeps polling for its reply to settle: past the reply step's retries
// (src/pipeline/analysis-workflow.ts REPLY_RETRIES, under two minutes) with room to spare.
const SETTLE_MS = 10 * 60 * 1000;
const WORD: Record<VerdictName, string> = { malicious: "Malicious", suspicious: "Suspicious", safe: "Safe" };

const STATE_WORDS = {
  waiting: "Waiting",
  running: "Running",
  retrying: "Trying again",
  done: "Done",
  failed: "Failed",
} as const;
function Steps(props: { progress: Progress }) {
  const { steps, current } = props.progress;
  return (
    <section
      aria-labelledby="progress-heading"
      class="flex flex-col gap-12 p-24 bg-surface border border-line rounded-card-large"
    >
      <div class="flex flex-wrap items-baseline justify-between gap-8">
        <h2 id="progress-heading" class="type-h3">
          Progress
        </h2>
        <p class="type-small text-muted">{`Step ${current} of ${steps.length}`}</p>
      </div>
      <ol class="flex flex-col gap-8">
        {steps.map((s) => (
          <li class="flex flex-wrap items-baseline justify-between gap-8 text-14">
            <span class={cx("min-w-0 wrap-anywhere", s.state === "waiting" && "text-muted")}>{s.words}</span>
            <span
              class={cx(
                "type-small weight-text-strong",
                s.state === "running" || s.state === "retrying"
                  ? "text-orange-text"
                  : s.state === "failed"
                    ? "text-mal"
                    : "text-muted",
              )}
            >
              {s.state === "done" ? seconds(s.ms) || "Done" : STATE_WORDS[s.state]}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// What the checks covered, said apart from whether the case finished: a check that read part of its input, had nothing
// to check or failed is named with why; a case with no stored outcomes says coverage was not recorded.
const REASON: Record<string, string> = {
  Timeout: "it ran out of time",
  EvidenceRefused: "its findings could not be stored",
};
// A failed check with no stored outcomes stopped before its checks stored any (a message that could not be parsed),
// which is not the old case's missing record: it says so (D07 T03 §18 round 1).
export function CoverageNotice(props: { coverage: Coverage; failed?: boolean }) {
  if (props.coverage === null)
    return (
      <p class="type-small text-muted">
        {props.failed
          ? "No check recorded an outcome before it stopped."
          : "Coverage not recorded for this check: it ran before each check's outcome was kept."}
      </p>
    );
  const notRun = props.coverage.filter((o) => o.outcome === "skipped" || o.outcome === "failed");
  const partial = props.coverage.filter((o) => o.outcome === "partial");
  if (notRun.length === 0 && partial.length === 0) return null;
  // A check that read part of its input ran: it is named apart and counted with those that ran, never as not run.
  const ran = props.coverage.filter((o) => o.outcome === "ran" || o.outcome === "partial").length;
  const name = (o: NonNullable<Coverage>[number]) => CHECK_WORDS[o.check] ?? "A check";
  return (
    <PartialNotice
      ran={ran}
      skipped={notRun.map((o) => ({
        name: name(o),
        reason:
          o.outcome === "failed"
            ? `${REASON[o.reason ?? ""] ?? "it failed"}.`
            : `it had nothing to check${o.reason ? ` (${o.reason})` : ""}.`,
      }))}
      partial={partial.map((o) => ({
        name: name(o),
        reason: o.reason ? `${o.reason}.` : "part of its input was not read.",
      }))}
    />
  );
}

// How the answer's email stands, said only when it did not plainly go: an upload's answer is never emailed, so says
// nothing. `complete` is whether the checks covered everything, so a notice never calls an incomplete check complete.
function Delivery(props: {
  channel: LiveProps["channel"];
  delivery: ReplySend | null;
  replyFailed: boolean;
  replied: boolean;
  complete: boolean;
}) {
  if (props.channel !== "email") return null;
  const here = props.complete ? "It is here, and it is complete." : "It is here.";
  // The stored send is the current word: a reply step that failed and a later resend that went (src/mail/resend.ts)
  // is sent, and says nothing.
  if (props.delivery === "sent") return null;
  const words =
    props.replyFailed || props.delivery === "failed" || props.delivery === "refused"
      ? `We could not email this answer. ${here}`
      : props.delivery === "uncertain"
        ? `We may not have emailed this answer: the mail service did not confirm it. ${here}`
        : props.delivery === "pending"
          ? `This answer is still being emailed. ${here}`
          : props.delivery === null && props.replied
            ? `This answer was not emailed: we had no address to send it to. ${here}`
            : null;
  return words ? (
    <p role="note" class="px-16 py-12 bg-subtle border border-line rounded-card type-small">
      {words}
    </p>
  ) : null;
}

function Found(props: LiveProps) {
  return (
    <>
      <EvidenceCards
        heading="Found so far"
        intro="Early findings. The verdict weighs all of them once every step has run."
        empty="Nothing found yet."
        items={props.evidence}
        cited={[]}
        file={(key) => artefactUrl(props.caseId, key, props.view === "public" ? props.link : undefined)}
        reputation={props.reputation}
        columns={1}
      />
      <section aria-labelledby="wait-heading" class="flex flex-col gap-8 p-24 bg-subtle rounded-card-large">
        <h2 id="wait-heading" class="type-h3">
          While you wait
        </h2>
        <p class="text-14">
          {props.channel === "email"
            ? "Do not act on the message yet. You can leave this page: the verdict is also emailed to whoever sent it to us."
            : "Do not act on the file yet. You can leave this page and come back: the answer stays on this report."}
        </p>
      </section>
    </>
  );
}

export function ReportLive(props: LiveProps) {
  const { status, verdict, progress, caseId } = props;
  const link = props.view === "public" ? (props.link ?? "") : "";
  const now = props.now ?? new Date();
  const replyStep = progress.steps.find((s) => s.step === "reply")?.state ?? "waiting";
  const reply = replyStep === "failed";
  // A failed check turns `partial` before its reply has run: it stays live until that reply settles (its step done or
  // failed, or a send that went), for at most SETTLE_MS after the failure, so a Workflow that stopped never
  // keeps a page polling for ever.
  const failedAt0 = progress.failed?.at ? Date.parse(progress.failed.at) : Number.NaN;
  // A stored failed send is not the end: the Workflow tries the reply again, so only the reply step's own end or a send
  // that went settles it.
  const settled = replyStep === "done" || replyStep === "failed" || props.delivery === "sent";
  // A case whose admission failed never had a Workflow, so no reply is coming and nothing is left to wait for (D07 T03 §48).
  const admitFailed = admissionFailed(progress);
  const settling =
    status === "partial" &&
    !admitFailed &&
    !verdict &&
    !settled &&
    props.channel === "email" &&
    !Number.isNaN(failedAt0) &&
    now.getTime() - failedAt0 < SETTLE_MS;
  const running = status === "received" || status === "running" || settling;
  const failedCheck = !running && !verdict;
  // A failure the same file would repeat (the original is gone, or a recording to replace): a retry cannot mend it.
  const gone = UNMENDABLE.includes(progress.failed?.error ?? "");
  const current = progress.steps[progress.current - 1];
  // A partial check is one whose coverage has a gap, whatever the lifecycle says: a reply that could not be sent leaves
  // a case `partial` with every check run, and a failed check can finish `done`. Without stored outcomes, the
  // lifecycle's own `partial` is all there is, less a reply failure.
  const gaps = props.coverage ? props.coverage.some((o) => o.outcome !== "ran") : status === "partial" && !reply;
  const early = running ? earlyAuthOf(props.coverage, props.evidence) : null;
  const announce = running
    ? `Step ${progress.current} of ${progress.steps.length}: ${current?.words ?? "Checking"}${current?.state === "retrying" ? " (trying again)" : ""}${early ? (early.kind === "results" ? " Early authentication results are in." : " No trusted authentication results were stored.") : ""}`
    : failedCheck
      ? "The check failed. Nothing was concluded."
      : `${gaps ? "Partly checked" : "Checked"}: ${WORD[(verdict as ReportVerdict).verdict]}`;
  const poll = running
    ? {
        "hx-get": `/r/${caseId}/status${link || (props.navQuery ?? "")}${props.traceOpen && !link ? `${props.navQuery ? "&" : "?"}trace=1` : ""}`,
        "hx-trigger": "every 2s",
        "hx-swap": "outerHTML",
        // A poll still waiting keeps its request to its answer or this timeout; htmx drops the next trigger meanwhile, so
        // a slow server is still answered (test/node/report-status-browser.test.tsx).
        "hx-request": '{"timeout":10000}',
        ...(props.headerKey ? { "hx-vals": JSON.stringify({ h: props.headerKey }) } : {}),
        "data-poll": `/r/${caseId}${link}`,
      }
    : {};
  // The failure's own recorded time, the same on every read (its step's last attempt plus how long it ran).
  const failedAt =
    progress.failed?.at && !Number.isNaN(Date.parse(progress.failed.at))
      ? new Date(Date.parse(progress.failed.at) + (progress.failed.ms ?? 0))
      : null;
  const elapsed = progress.startedAt ? Math.max(0, (now.getTime() - Date.parse(progress.startedAt)) / 1000) : 0;
  return (
    <div id="report-live" data-announce={announce} class="flex flex-col gap-24" {...poll}>
      {running ? (
        <>
          {props.meta as never}
          <VerdictBand state="running" elapsed={elapsed} headline="We are investigating this message.">
            {props.channel === "email"
              ? "Most checks finish within a minute. This page updates by itself, and we also email you the verdict."
              : "Most checks finish within a minute. This page updates by itself."}
          </VerdictBand>
          {props.confirming && (
            <p role="status" class="px-16 py-12 bg-subtle border border-line rounded-card type-small">
              {CONFIRMING}
            </p>
          )}
          {early && <EarlyAuth data={early} now={now} />}
          {/* `Report-Running`: the progress beside what was found so far and the advice while waiting. */}
          <div class="grid gap-24 md:grid-cols-[1.4fr_1fr] md:items-start">
            <Steps progress={progress} />
            <div class="flex min-w-0 flex-col gap-24">
              <Found {...props} />
            </div>
          </div>
        </>
      ) : failedCheck ? (
        <>
          {props.meta as never}
          <VerdictBand state="failed" headline="We could not finish checking this message.">
            Nothing was concluded. Until it is checked, do not click its links, open its attachments or pay anything it
            asks for.
          </VerdictBand>
          <Delivery
            channel={props.channel}
            delivery={props.delivery}
            replyFailed={reply}
            replied={replyStep === "done"}
            complete={false}
          />
          {/* What the checks covered before it stopped, as on every terminal report (D07 T03 §18): the checks that did
              not run named with why, or that coverage was not recorded. */}
          <CoverageNotice coverage={props.coverage} failed />
          {progress.failed?.step === "transcribe" && (
            <p class="text-14 text-muted">
              There is no transcript, so the recording's speech was not checked. The words would have been the speaker's
              own, and their meaning our reading of them. We read English recordings; Afrikaans, isiZulu and isiXhosa,
              and cloned or synthetic voices, are not detected.
            </p>
          )}
          {/* `Report-Partial`'s failed state: what happened beside what can be done. */}
          <div class="grid gap-24 md:grid-cols-[1.3fr_1fr] md:items-start">
            <section
              aria-labelledby="happened-heading"
              class="flex flex-col gap-12 p-24 bg-surface border border-line rounded-card-large"
            >
              <h2 id="happened-heading" class="type-h3">
                What happened
              </h2>
              <p class="text-14 wrap-anywhere">
                {progress.failed
                  ? errorWords(progress.failed.error, { channel: props.channel, uploadName: props.uploadName ?? null })
                  : "The check did not finish. This is not a sign that the message is safe or unsafe."}
              </p>
              <p class="type-small text-muted wrap-anywhere">
                {`Reference ${caseId}${
                  progress.failed
                    ? ` · failed at step ${progress.steps.indexOf(progress.failed) + 1} of ${progress.steps.length}`
                    : ""
                }${failedAt ? ` · ${clock.format(failedAt)} SAST` : ""}`}
              </p>
            </section>
            <section
              aria-labelledby="next-heading"
              class="flex flex-col gap-12 p-24 bg-surface border border-line rounded-card-large"
            >
              <h2 id="next-heading" class="type-h3">
                What you can do
              </h2>
              {/* A member runs it once more (D07 T03 §20, `Report-Partial`); a link holder reads only. */}
              {props.view === "member" && props.retry && (
                <p role="status" class="text-14 weight-text-strong">
                  {RETRY_WORDS[props.retry]}
                </p>
              )}
              {props.view === "member" && gone ? (
                // A second run cannot succeed: the channel's own next step instead (§40, §38).
                <div class="flex flex-wrap gap-12">
                  <Button variant="dark" href="/upload">
                    {props.channel === "upload" ? "Upload again" : "Upload it instead"}
                  </Button>
                </div>
              ) : props.view === "member" ? (
                <>
                  <form
                    method="post"
                    action={`/r/${caseId}/retry${props.navQuery ?? ""}`}
                    class="flex flex-wrap gap-12"
                    data-busy
                    data-busy-check={`/r/${caseId}${props.navQuery ?? ""}`}
                  >
                    <Button type="submit" variant="dark" data-busy-label="Retrying">
                      Retry the check
                    </Button>
                    <Button variant="ghost" href="/upload">
                      Upload it instead
                    </Button>
                  </form>
                  <p class="type-small text-muted">
                    Retry runs the check once more. While it runs, the button reads "Retrying" and is disabled.
                  </p>
                </>
              ) : (
                <div class="flex flex-wrap gap-12">
                  <Button variant="dark" href="/upload">
                    Upload it instead
                  </Button>
                </div>
              )}
            </section>
          </div>
          {/* What ran before the failure is said too (D07 T03 §18 completion review): the count from stored outcomes,
              even with no finding drawn. */}
          {(props.evidence.length > 0 || props.coverage !== null) && (
            <EvidenceCards
              items={props.evidence}
              cited={[]}
              file={(key) => artefactUrl(caseId, key, props.view === "public" ? props.link : undefined)}
              reputation={props.reputation}
              intro={evidenceCount(props.evidence, props.coverage)}
              versions={props.coverage}
              empty="Nothing was found before the check stopped."
            />
          )}
          {props.trace && (
            <ModelTracePanel
              caseId={caseId}
              run={props.trace.run}
              awaiting={replyAwaited(props.channel, props.status, progress, now)}
              trace={props.trace.data}
              facts={props.trace.facts}
              open={props.traceOpen === true}
            />
          )}
        </>
      ) : (
        <>
          {props.meta}
          {progress.failed?.step === "transcribe" && (
            <p class="text-14 text-muted">
              There is no transcript, so the recording's speech was not checked. The words would have been the speaker's
              own, and their meaning our reading of them. We read English recordings; Afrikaans, isiZulu and isiXhosa,
              and cloned or synthetic voices, are not detected.
            </p>
          )}
          <VerdictSection
            state={gaps ? "partial" : "complete"}
            stored={verdict as ReportVerdict}
            evidence={props.evidence}
            voice={props.sourceKind === "audio"}
            afterBand={
              <>
                <Delivery
                  channel={props.channel}
                  delivery={props.delivery}
                  replyFailed={reply}
                  replied={replyStep === "done"}
                  complete={!gaps && props.coverage !== null}
                />
                <CoverageNotice coverage={props.coverage} />
              </>
            }
          />
          <EvidenceCards
            items={props.evidence}
            cited={cited(verdict as ReportVerdict)}
            file={(key) => artefactUrl(caseId, key, props.view === "public" ? props.link : undefined)}
            reputation={props.reputation}
            columns={(verdict as ReportVerdict).verdict === "safe" ? 3 : 2}
            intro={evidenceCount(props.evidence, props.coverage)}
            versions={props.coverage}
          />
          {(verdict as ReportVerdict).verdict === "safe" && <CleanChecks coverage={props.coverage} />}
          {props.trace && (
            <ModelTracePanel
              caseId={caseId}
              run={props.trace.run}
              awaiting={replyAwaited(props.channel, props.status, progress, now)}
              trace={props.trace.data}
              facts={props.trace.facts}
              open={props.traceOpen === true}
            />
          )}
          {props.feedback !== undefined && (
            <FeedbackControl
              caseId={caseId}
              verdict={(verdict as ReportVerdict).verdict}
              saved={props.feedback}
              {...(props.dispute ? { dispute: true } : {})}
            />
          )}
        </>
      )}
    </div>
  );
}
