// The report as drawn (D07 T03 §1): the case's state, its evidence and the footer, in the member or the public frame.
// Kept apart from the route (./report), which reads the case, so a browser test can render it with no storage.

import { artefactUrl } from "../artefact-url";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { Document } from "../components/Document";
import { type CardItem, EvidenceCards } from "../components/evidence/cards";
import { type CheckState, VerdictBadge, type VerdictName } from "../components/Verdict";
import { type Coverage, type LiveProps, ReportLive } from "./report-live";
import { type Progress, progressOf } from "./report-progress";
import type { ReportVerdict } from "./report-verdict";

// What the page draws of a case and its evidence (the stored rows' own fields, src/db/cases.ts and src/checks/evidence.ts).
export type ReportCase = {
  id: string;
  status: "received" | "running" | "done" | "partial";
  verdict: VerdictName | null;
  sourceKind: "mail" | "document" | "image" | "audio";
  channel: "email" | "upload";
  createdAt: string;
};
export type ReportEvidence = CardItem;

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
  delivery: LiveProps["delivery"];
  feedback?: LiveProps["feedback"];
}) {
  const { stored, evidence, view } = props;
  const shown = shownState(stored);
  const arrived = sast.format(new Date(stored.createdAt));
  // A finished case whose verdict row cannot be found keeps its stored state line, never a failed check (§1).
  const orphan = !props.verdict && (shown.state === "complete" || shown.state === "partial");
  return (
    <article class="flex flex-col gap-24 px-16 py-24 md:px-48 md:py-40">
      {view === "member" && (
        <a href="/cases" class="md:hidden self-start inline-flex items-center min-h-24 type-small text-orange-text">
          ← Cases
        </a>
      )}
      <header class="flex flex-col gap-8">
        <h1 class="type-h2 wrap-anywhere">Case received {arrived} SAST</h1>
        {orphan && (
          <p class="flex flex-wrap items-center gap-12">
            <VerdictBadge state={shown.state} {...(shown.verdict ? { verdict: shown.verdict } : {})} />
            <span class="type-small text-muted">{shown.words}</span>
          </p>
        )}
      </header>
      {/* The live region a running report's changes are said through, outside the region the poll replaces. */}
      <p id="report-announce" role="status" aria-live="polite" class="sr-only" />
      {orphan ? (
        <EvidenceCards
          items={evidence}
          cited={[]}
          file={(key) => artefactUrl(stored.id, key, view === "public" ? props.link : undefined)}
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
          evidence={evidence}
          progress={props.progress}
          coverage={props.coverage}
          view={view}
          {...(props.link ? { link: props.link } : {})}
        />
      )}
      <footer class="type-small text-muted border-t border-line pt-16">
        {view === "member"
          ? "Raw files are deleted after 30 days. This summary stays while your organisation has an account."
          : `Anyone with this link can read this report until ${sastDate.format(new Date((props.linkExpires ?? 0) * 1000))}. Raw files are deleted after 30 days.`}
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
  delivery?: LiveProps["delivery"];
  feedback?: LiveProps["feedback"];
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
      coverage={props.coverage ?? null}
      delivery={props.delivery ?? null}
      {...(props.feedback !== undefined ? { feedback: props.feedback } : {})}
    />
  );
  return (
    <Document title="Report">
      {shell ? <AppShell {...shell}>{body}</AppShell> : <AppShell variant="public">{body}</AppShell>}
    </Document>
  );
}
