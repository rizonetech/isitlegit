// The report's header (D07 T03 §9; design/SPEC.md M3, boards `Main` and `Report-Mobile`): which message the report is
// about before its verdict. On a wide screen the breadcrumb back to Cases, the subject as the title, who sent it and who
// forwarded it when, and Download PDF and Copy link; on a phone the subject, sender and time as one line under the band
// (`MetaLine`, drawn by the live region so the poll keeps it current) and the title kept for screen readers. A link
// holder outside the organisation sees the subject and sender, never who forwarded it. Every stored part may be missing
// (a case not parsed yet, an upload, a header that would not decode): each says only what is stored.

import type { Checker } from "../../db/checker";
import { Button } from "../components/Button";

export type HeaderFacts = {
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  channel: "email" | "upload";
  // Whether the forward carried the original's headers: forwarded as an attachment.
  headersAvailable: boolean;
  forwardedBy: string | null;
  // Who brought it in, as the Cases list says it (`checkerName`, D07 T03 §42): a member, a former member, or no one.
  checker: Checker;
  // When it arrived, in SAST words.
  at: string;
  // An upload's file name (D07 T03 §28), or null for a forward.
  fileName?: string | null;
};

// The title (D07 T03 §28): a stored subject first, a forward's or an uploaded email's once parsed; otherwise an
// upload's file name (a document, image or voice note, or an email not yet parsed or with no subject); otherwise none.
const subjectOf = (facts: HeaderFacts) => facts.subject?.trim() || facts.fileName?.trim() || "No subject";
// Whether the title is the file's name, labelled as such for a screen reader.
const titledByFile = (facts: HeaderFacts) => !facts.subject?.trim() && !!facts.fileName?.trim();
// An uploaded email titled by its subject names its file beside it.
const fileBeside = (facts: HeaderFacts) =>
  facts.subject?.trim() && facts.fileName?.trim() ? facts.fileName.trim() : null;

// A short fingerprint of what the header says (FNV-1a over the facts it draws for this view): the status poll sends the
// header out of band only when this differs from the one the page holds, so a reader's focus, copy feedback or selection
// in the header survives every poll that changes nothing (in practice, all but the one after parsing). It covers exactly
// what the view shows: every fact that can change what is drawn (the arrival line's attachment wording included), and
// for a link holder nothing more, since a fingerprint over a hidden fact (who forwarded it) would let them test guesses.
export function headerKey(facts: HeaderFacts, view: "member" | "public"): string {
  // An upload's file name is set when its case is made and never changes, so it is not part of the key.
  const shown = [facts.subject, facts.fromName, facts.fromAddress];
  const text = JSON.stringify(
    view === "member" ? [...shown, facts.channel, facts.headersAvailable, facts.checker, facts.forwardedBy] : shown,
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(36);
}

// "Name <address>", or whichever part is stored, or null.
function senderOf(facts: HeaderFacts): string | null {
  const name = facts.fromName?.trim();
  const address = facts.fromAddress?.trim();
  if (name && address) return `${name} <${address}>`;
  return name || address || null;
}

// Who brought it in and when: "Forwarded as an attachment by <name> · <time>", "Forwarded by", "Uploaded by", or no one
// named when no member matches (a forward still names its forwarding address, which is the forwarder's own).
function arrivalOf(facts: HeaderFacts): string {
  const name = facts.checker?.kind === "member" ? facts.checker.name : null;
  if (facts.channel === "upload")
    return name ? `Uploaded by ${name}` : facts.checker?.kind === "former" ? "Uploaded by a former member" : "Uploaded";
  const verb = facts.headersAvailable ? "Forwarded as an attachment" : "Forwarded";
  const who = name ?? facts.forwardedBy;
  return who ? `${verb} by ${who}` : verb;
}

export function ReportHeader(props: {
  facts: HeaderFacts;
  view: "member" | "public";
  // The report's own absolute address: a member's `/r/<id>`, a link holder's signed link.
  copy: string;
  // Swapped into the page out of band by the status poll, so a report opened before parsing catches up.
  oob?: boolean;
  // Where Cases goes: the filtered list the member came from, when they came from one (D07 T04 §9).
  backHref?: string;
}) {
  const { facts, view } = props;
  const subject = subjectOf(facts);
  const sender = senderOf(facts);
  const member = view === "member";
  return (
    <div
      id="report-header"
      data-key={headerKey(facts, view)}
      class="flex flex-col gap-12"
      {...(props.oob ? { "hx-swap-oob": "true" } : {})}
    >
      {member && (
        <>
          <a
            href={props.backHref ?? "/cases"}
            class="md:hidden self-start inline-flex items-center min-h-24 type-small text-orange-text"
          >
            ← Cases
          </a>
          <nav aria-label="Breadcrumb" class="hidden md:flex min-w-0 gap-8 items-center type-small text-muted">
            <a href={props.backHref ?? "/cases"} class="text-muted hover:text-ink">
              Cases
            </a>
            <span aria-hidden="true">/</span>
            <span aria-current="page" class="min-w-0 truncate">
              {subject}
            </span>
          </nav>
        </>
      )}
      <header class="flex flex-col gap-12 md:flex-row md:items-start md:justify-between md:gap-24">
        <div class="flex min-w-0 flex-col gap-8">
          <h1 class="sr-only md:not-sr-only print:not-sr-only type-h2 wrap-anywhere">
            {titledByFile(facts) && <span class="sr-only">Uploaded file: </span>}
            {subject}
          </h1>
          <p class="hidden md:block type-small text-muted wrap-anywhere print:block">
            {sender && (
              <>
                From <strong class="text-ink weight-text-strong">{sender}</strong>
                {" · "}
              </>
            )}
            {fileBeside(facts) && (
              <>
                Uploaded file <strong class="text-ink weight-text-strong">{fileBeside(facts)}</strong>
                {" · "}
              </>
            )}
            {member ? `${arrivalOf(facts)} · ${facts.at}` : facts.at}
          </p>
        </div>
        <div data-copy-group class="flex flex-wrap items-center gap-8 shrink-0 print:hidden">
          {/* Shown only where the app script runs (it marks the page `data-script` and binds the button to the
              browser's print, src/web/client/app.ts), by the stylesheet, so a header the poll swaps in is right from
              its first paint: without scripts there is no control that does nothing. */}
          <span data-print-control="" class="hidden [[data-script]_&]:inline-flex">
            <Button variant="ghost" size="small" data-print="">
              Download PDF
            </Button>
          </span>
          {/* Copy link works only through the app script, so it is shown by the same mark as Download PDF. Without
              the script the address itself is shown to select by hand; with it, only after a refused copy, which marks
              it shown (src/web/client/app.ts). */}
          <span data-copy-control="" class="hidden [[data-script]_&]:inline-flex">
            <Button variant="ghost" size="small" data-copy={props.copy}>
              Copy link
            </Button>
          </span>
          <span data-copy-reveal="" class="basis-full text-13 text-muted [[data-script]_&:not([data-shown])]:hidden">
            Link to this report:{" "}
            <span data-copy-source class="font-mono text-ink wrap-anywhere">
              {props.copy}
            </span>
          </span>
          <p data-copy-status role="status" aria-live="polite" class="basis-full text-13 text-muted" />
        </div>
      </header>
    </div>
  );
}

// The phone's one line under the band (`Report-Mobile`): the subject, "from <address>" (or the name when only that is
// stored), and the time, joined only from the parts that exist.
export function MetaLine(props: { facts: HeaderFacts; view?: "member" | "public" }) {
  const { facts } = props;
  const from = facts.fromAddress?.trim() || facts.fromName?.trim();
  // The phone's only title: an upload titled by its file says so, and an uploaded email titled by its subject names its
  // file after it, so two uploads with one subject stay told apart (D07 T03 §28).
  const beside = fileBeside(facts);
  const parts = [
    titledByFile(facts) ? `Uploaded file ${subjectOf(facts)}` : subjectOf(facts),
    beside ? `Uploaded file ${beside}` : null,
    from ? `from ${from}` : null,
    facts.at,
  ].filter(Boolean);
  // Option A (D07 T03 §43, board `Report-Mobile-Attribution`): who brought the case in, as a line of its own under
  // the subject line on a phone, in reading order; a member's only, never a link holder's.
  const name = facts.checker?.kind === "member" ? facts.checker.name : null;
  const verb =
    facts.channel === "upload" ? "Uploaded" : facts.headersAvailable ? "Forwarded as an attachment" : "Forwarded";
  const who = facts.channel === "upload" ? name : (name ?? facts.forwardedBy);
  return (
    <>
      <p class="md:hidden print:hidden type-small text-muted wrap-anywhere">{parts.join(" · ")}</p>
      {props.view === "member" && (
        <p class="md:hidden print:hidden type-small text-muted wrap-anywhere">
          {facts.checker?.kind === "former" && facts.channel === "upload" ? (
            "Uploaded by a former member"
          ) : who ? (
            <>
              {verb} by <strong class="text-ink weight-text-strong">{who}</strong>
            </>
          ) : (
            verb
          )}
        </p>
      )}
    </>
  );
}
