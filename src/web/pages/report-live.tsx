// The part of the report that changes while a case runs (D07 T03 §4; design/SPEC.md M3 running, partial and failed
// states, boards `Report-Running`, `Report-Partial`, `Report-Mobile`): one region, `#report-live`, which a running case
// polls every 2 seconds (`GET /r/:caseId/status`, src/web/pages/report.tsx) and which a finished case answers once,
// with no trigger, so the polling stops. Its words for the live region outside it are `data-announce`, which the app
// script says once when they change. Coverage (what the checks covered) is read from the stored check outcomes, apart
// from the case's lifecycle, and a reply that could not be sent is its own notice.

import { artefactUrl } from "../artefact-url";
import { cx } from "../components/attrs";
import { Button } from "../components/Button";
import { type CardItem, CHECK_WORDS, EvidenceCards } from "../components/evidence/cards";
import { PartialNotice } from "../components/States";
import { VerdictBand, type VerdictName } from "../components/Verdict";
import { errorWords, type Progress } from "./report-progress";
import { cited, type ReportVerdict, VerdictSection } from "./report-verdict";

// A stored check outcome (D02 T01 §3, `readCheckOutcomes`), as the report reads it; `null` for a case checked before
// outcomes were stored.
export type Coverage =
  | { check: string; outcome: "ran" | "partial" | "skipped" | "failed"; reason: string | null; findings: number }[]
  | null;

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
  progress: Progress;
  coverage: Coverage;
  view: "member" | "public";
  // A link holder's signature parameters, kept on every URL the region asks for.
  link?: string;
  now?: Date;
};

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const seconds = (ms: number | null) => (ms === null ? "" : `${(ms / 1000).toFixed(1)} s`);
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
function CoverageNotice(props: { coverage: Coverage }) {
  if (props.coverage === null)
    return (
      <p class="type-small text-muted">
        Coverage not recorded for this check: it ran before each check's outcome was kept.
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
  // A failed check turns `partial` before its reply has run: it is still live until that reply settles.
  const settling = status === "partial" && !verdict && (replyStep === "running" || replyStep === "retrying");
  const running = status === "received" || status === "running" || settling;
  const failedCheck = !running && !verdict;
  const current = progress.steps[progress.current - 1];
  // A partial check is one whose coverage has a gap, whatever the lifecycle says: a reply that could not be sent leaves
  // a case `partial` with every check run, and a failed check can finish `done`. Without stored outcomes, the
  // lifecycle's own `partial` is all there is, less a reply failure.
  const gaps = props.coverage ? props.coverage.some((o) => o.outcome !== "ran") : status === "partial" && !reply;
  const announce = running
    ? `Step ${progress.current} of ${progress.steps.length}: ${current?.words ?? "Checking"}${current?.state === "retrying" ? " (trying again)" : ""}`
    : failedCheck
      ? "The check failed. Nothing was concluded."
      : `${gaps ? "Partly checked" : "Checked"}: ${WORD[(verdict as ReportVerdict).verdict]}`;
  const poll = running
    ? {
        "hx-get": `/r/${caseId}/status${link}`,
        "hx-trigger": "every 2s",
        "hx-swap": "outerHTML",
        // A poll still waiting keeps its request to its answer or this timeout; htmx drops the next trigger meanwhile, so
        // a slow server is still answered (test/node/report-status-browser.test.tsx).
        "hx-request": '{"timeout":10000}',
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
          <VerdictBand state="running" elapsed={elapsed} headline="We are investigating this message.">
            {props.channel === "email"
              ? "Most checks finish within a minute. This page updates by itself, and we also email you the verdict."
              : "Most checks finish within a minute. This page updates by itself."}
          </VerdictBand>
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
          {/* `Report-Partial`'s failed state: what happened beside what can be done. */}
          <div class="grid gap-24 md:grid-cols-[1.3fr_1fr] md:items-start">
            <section
              aria-labelledby="happened-heading"
              class="flex flex-col gap-12 p-24 bg-surface border border-line rounded-card-large"
            >
              <h2 id="happened-heading" class="type-h3">
                What happened
              </h2>
              <p class="text-14">
                {progress.failed
                  ? errorWords(progress.failed.error)
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
              <div class="flex flex-wrap gap-12">
                <Button variant="dark" href="/upload">
                  Upload it instead
                </Button>
              </div>
            </section>
          </div>
          {props.evidence.length > 0 && (
            <EvidenceCards
              items={props.evidence}
              cited={[]}
              file={(key) => artefactUrl(caseId, key, props.view === "public" ? props.link : undefined)}
            />
          )}
        </>
      ) : (
        <>
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
            columns={(verdict as ReportVerdict).verdict === "safe" ? 3 : 2}
          />
        </>
      )}
    </div>
  );
}
