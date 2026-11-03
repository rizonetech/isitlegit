// The report as drawn (D07 T03 §1): the case's state, its evidence and the footer, in the member or the public frame.
// Kept apart from the route (./report), which reads the case, so a browser test can render it with no storage.

import type { Checker } from "../../db/checker";
import { artefactUrl } from "../artefact-url";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Document } from "../components/Document";
import { type CardItem, EvidenceCards, type ReputationRow } from "../components/evidence/cards";
import { type CheckState, VerdictBadge, type VerdictName } from "../components/Verdict";
import { type HeaderFacts, headerKey, MetaLine, ReportHeader } from "./report-header";
import { type Coverage, CoverageNotice, evidenceCount, type LiveProps, ReportLive } from "./report-live";
import { type Progress, progressOf } from "./report-progress";
import type { ReportVerdict } from "./report-verdict";
import { SIGNIN_PATH } from "./signin";

// What the page draws of a case and its evidence (the stored rows' own fields, src/db/cases.ts and src/checks/evidence.ts).
export type ReportCase = {
  id: string;
  status: "received" | "running" | "done" | "partial";
  verdict: VerdictName | null;
  sourceKind: "mail" | "document" | "image" | "audio";
  channel: "email" | "upload";
  createdAt: string;
  // What the header names (D07 T03 §9): the original's subject and sender as intake stored them (D01 T01 §16), whether
  // the forward carried its headers, and who forwarded or uploaded it. Absent on a fixture that does not draw them.
  originalSubject?: string | null;
  originalFromName?: string | null;
  originalFromAddress?: string | null;
  headersAvailable?: boolean;
  forwardedBy?: string | null;
  // An upload's file name (D07 T03 §28).
  uploadName?: string | null;
};
export type ReportEvidence = CardItem;

// The header's facts from the stored case (D07 T03 §9).
export function headerFacts(stored: ReportCase, checker: Checker): HeaderFacts {
  return {
    subject: stored.originalSubject ?? null,
    fromName: stored.originalFromName ?? null,
    fromAddress: stored.originalFromAddress ?? null,
    channel: stored.channel,
    headersAvailable: stored.headersAvailable ?? false,
    forwardedBy: stored.forwardedBy ?? null,
    fileName: stored.uploadName ?? null,
    checker,
    at: `${sast.format(new Date(stored.createdAt))} SAST`,
  };
}

const sast = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const sastDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export type Shown = { state: CheckState; verdict?: VerdictName; words: string };

// A stored case as the page shows it: its status and its nullable verdict. A finished case with no verdict (a pipeline
// failure stores `partial` with none) is a failed check, never a guessed verdict.
export function shownState(stored: Pick<ReportCase, "status" | "verdict">): Shown {
  const { status, verdict } = stored;
  if (status === "received") return { state: "running", words: "Received" };
  if (status === "running") return { state: "running", words: "Checking" };
  if (!verdict) return { state: "failed", words: "Could not be checked" };
  if (status === "partial") return { state: "partial", verdict, words: "Partly checked" };
  return { state: "complete", verdict, words: "Checked" };
}

function ReportBody(props: {
  stored: ReportCase;
  verdict: ReportVerdict | null;
  evidence: ReportEvidence[];
  view: "member" | "public";
  linkExpires?: number;
  // A link holder's signature parameters, carried by every URL the page asks for (files, the status poll).
  link?: string;
  progress: Progress;
  coverage: Coverage;
  reputation?: readonly ReputationRow[];
  delivery: LiveProps["delivery"];
  feedback?: LiveProps["feedback"];
  dispute?: boolean;
  checker?: Checker;
  copy?: string;
  retry?: LiveProps["retry"];
  confirming?: boolean;
  trace?: LiveProps["trace"];
  traceOpen?: boolean;
}) {
  const { stored, evidence, view } = props;
  const shown = shownState(stored);
  const facts = headerFacts(stored, props.checker ?? null);
  // A finished case whose verdict row cannot be found keeps its stored state line, never a failed check (§1).
  const orphan = !props.verdict && (shown.state === "complete" || shown.state === "partial");
  return (
    <article class="flex flex-col gap-24 px-16 py-24 md:px-48 md:py-40">
      <ReportHeader facts={facts} view={view} copy={props.copy ?? `/r/${stored.id}${props.link ?? ""}`} />
      {orphan && (
        <>
          <MetaLine facts={facts} view={view} />
          <p class="flex flex-wrap items-center gap-12">
            <VerdictBadge state={shown.state} {...(shown.verdict ? { verdict: shown.verdict } : {})} />
            <span class="type-small text-muted">{shown.words}</span>
          </p>
          {/* Beside its count, what the count can say: a case whose outcomes were not kept counts findings alone
              (D07 T03 §18). */}
          <CoverageNotice coverage={props.coverage} />
        </>
      )}
      {/* The live region a running report's changes are said through, outside the region the poll replaces. */}
      <p id="report-announce" role="status" aria-live="polite" class="sr-only" />
      {orphan ? (
        <EvidenceCards
          items={evidence}
          cited={[]}
          file={(key) => artefactUrl(stored.id, key, view === "public" ? props.link : undefined)}
          intro={evidenceCount(evidence, props.coverage)}
          versions={props.coverage}
          reputation={props.reputation ?? []}
        />
      ) : (
        <ReportLive
          caseId={stored.id}
          status={stored.status}
          verdict={props.verdict}
          sourceKind={stored.sourceKind}
          channel={stored.channel}
          delivery={props.delivery}
          {...(props.feedback !== undefined ? { feedback: props.feedback } : {})}
          {...(props.dispute ? { dispute: true } : {})}
          evidence={evidence}
          reputation={props.reputation ?? []}
          progress={props.progress}
          coverage={props.coverage}
          retry={props.retry ?? null}
          confirming={props.confirming ?? false}
          trace={props.trace ?? null}
          traceOpen={props.traceOpen ?? false}
          uploadName={stored.uploadName ?? null}
          view={view}
          {...(props.link ? { link: props.link } : {})}
          meta={<MetaLine facts={facts} view={view} />}
          headerKey={headerKey(facts, view)}
        />
      )}
      <footer class="flex flex-col gap-8 type-small text-muted border-t border-line pt-16">
        <p>
          {view === "member"
            ? "Raw files are deleted after 30 days. This summary stays while your organisation has an account."
            : `Anyone with this link can read this report until ${sastDate.format(new Date((props.linkExpires ?? 0) * 1000))}. Raw files are deleted after 30 days.`}
        </p>
        {/* A link holder who is a member signs in and comes back to this report by session (D07 T03 §26): the return
            is the report's own path, never the signed link, so a member opens the member view and anyone else §1's
            404. Feedback is offered only on a report with a verdict (§6), so the words say what signing in gives. */}
        {view === "public" && (
          <p>
            {"Is this your organisation's report? "}
            <a
              href={`${SIGNIN_PATH}?next=${encodeURIComponent(stored.verdict ? `/r/${stored.id}?dispute=1` : `/r/${stored.id}`)}`}
              class={cx("text-orange-text underline underline-offset-4", FOCUS)}
            >
              Sign in
            </a>
            {stored.verdict ? " to tell us if we got it wrong." : " to see it with your organisation's cases."}
          </p>
        )}
      </footer>
    </article>
  );
}

// The report as a whole document: the member frame for a member (its shell data given), the public frame for a link.
export function ReportDocument(props: {
  stored: ReportCase;
  verdict?: ReportVerdict | null;
  evidence: ReportEvidence[];
  shell: Omit<MemberShellProps, "children"> | null;
  linkExpires?: number;
  link?: string;
  // The case's step progress and stored check outcomes (§4); a caller with neither draws no steps and no coverage.
  progress?: Progress;
  coverage?: Coverage;
  reputation?: readonly ReputationRow[];
  delivery?: LiveProps["delivery"];
  feedback?: LiveProps["feedback"];
  dispute?: boolean;
  // The forwarding or uploading member's name and the report's own absolute address, for the header (D07 T03 §9).
  checker?: Checker;
  copy?: string;
  retry?: LiveProps["retry"];
  confirming?: boolean;
  trace?: LiveProps["trace"];
  traceOpen?: boolean;
}) {
  const { stored, evidence, shell, linkExpires } = props;
  const body = (
    <ReportBody
      stored={stored}
      verdict={props.verdict ?? null}
      evidence={evidence}
      view={shell ? "member" : "public"}
      {...(linkExpires ? { linkExpires } : {})}
      {...(props.link ? { link: props.link } : {})}
      progress={props.progress ?? progressOf([])}
      reputation={props.reputation ?? []}
      coverage={props.coverage ?? null}
      delivery={props.delivery ?? null}
      {...(props.feedback !== undefined ? { feedback: props.feedback } : {})}
      {...(props.dispute ? { dispute: true } : {})}
      {...(props.checker !== undefined ? { checker: props.checker } : {})}
      {...(props.copy ? { copy: props.copy } : {})}
      retry={props.retry ?? null}
      confirming={props.confirming ?? false}
      trace={props.trace ?? null}
      traceOpen={props.traceOpen ?? false}
    />
  );
  return (
    <Document title="Report">
      {shell ? <AppShell {...shell}>{body}</AppShell> : <AppShell variant="public">{body}</AppShell>}
    </Document>
  );
}
