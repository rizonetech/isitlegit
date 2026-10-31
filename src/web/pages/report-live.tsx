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

export type LiveProps = {
  caseId: string;
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
  const gaps = props.coverage.filter((o) => o.outcome !== "ran");
  if (gaps.length === 0) return null;
  const ran = props.coverage.filter((o) => o.outcome === "ran" || o.outcome === "partial").length;
  return (
    <PartialNotice
      ran={ran}
      skipped={gaps.map((o) => ({
        name: CHECK_WORDS[o.check] ?? "A check",
        reason:
          o.outcome === "failed"
            ? `${REASON[o.reason ?? ""] ?? "it failed"}.`
            : o.outcome === "partial"
              ? `it read only part of its input${o.reason ? ` (${o.reason})` : ""}.`
              : `it had nothing to check${o.reason ? ` (${o.reason})` : ""}.`,
      }))}
    />
  );
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
      />
      <section aria-labelledby="wait-heading" class="flex flex-col gap-8 p-24 bg-subtle rounded-card-large">
        <h2 id="wait-heading" class="type-h3">
          While you wait
        </h2>
        <p class="text-14">
          Do not act on the message yet. You can leave this page: the verdict is also emailed to whoever sent it to us.
        </p>
      </section>
    </>
  );
}

export function ReportLive(props: LiveProps) {
  const { status, verdict, progress, caseId } = props;
  const link = props.view === "public" ? (props.link ?? "") : "";
  const now = props.now ?? new Date();
  const running = status === "received" || status === "running";
  const failedCheck = !running && !verdict;
  const reply = progress.steps.find((s) => s.step === "reply")?.state === "failed";
  // A partial check is one whose coverage has a gap, whatever the lifecycle says: a reply that could not be sent leaves
  // a case `partial` with every check run, and a failed check can finish `done`. Without stored outcomes, the
  // lifecycle's own `partial` is all there is, less a reply failure.
  const gaps = props.coverage ? props.coverage.some((o) => o.outcome !== "ran") : status === "partial" && !reply;
  const announce = running
    ? `Step ${progress.current} of ${progress.steps.length}: ${progress.steps[progress.current - 1]?.words ?? "Checking"}`
    : failedCheck
      ? "The check failed. Nothing was concluded."
      : `${gaps ? "Partly checked" : "Checked"}: ${WORD[(verdict as ReportVerdict).verdict]}`;
  const poll = running
    ? {
        "hx-get": `/r/${caseId}/status${link}`,
        "hx-trigger": "every 2s",
        "hx-swap": "outerHTML",
        "hx-request": '{"timeout":10000}',
        "data-poll": `/r/${caseId}${link}`,
      }
    : {};
  const elapsed = progress.startedAt ? Math.max(0, (now.getTime() - Date.parse(progress.startedAt)) / 1000) : 0;
  return (
    <div id="report-live" data-announce={announce} class="flex flex-col gap-24" {...poll}>
      {running ? (
        <>
          <VerdictBand state="running" elapsed={elapsed} headline="We are investigating this message.">
            Most checks finish within a minute. This page updates by itself.
          </VerdictBand>
          <Steps progress={progress} />
          <Found {...props} />
        </>
      ) : failedCheck ? (
        <>
          <VerdictBand state="failed" headline="We could not finish checking this message.">
            Nothing was concluded. Until it is checked, do not click its links, open its attachments or pay anything it
            asks for.
          </VerdictBand>
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
              } · ${clock.format(now)} SAST`}
            </p>
          </section>
          <section aria-labelledby="next-heading" class="flex flex-col gap-12">
            <h2 id="next-heading" class="type-h3">
              What you can do
            </h2>
            <div class="flex flex-wrap gap-12">
              <Button variant="dark" href="/upload">
                Upload it instead
              </Button>
            </div>
          </section>
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
          {reply && (
            <p role="note" class="px-16 py-12 bg-subtle border border-line rounded-card type-small">
              We could not email this answer. It is here, and it is complete.
            </p>
          )}
          <CoverageNotice coverage={props.coverage} />
          <VerdictSection
            state={gaps ? "partial" : "complete"}
            stored={verdict as ReportVerdict}
            evidence={props.evidence}
            voice={props.sourceKind === "audio"}
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
