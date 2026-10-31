// The report's header (D07 T03 §9; design/SPEC.md M3, boards `Main` and `Report-Mobile`): which message the report is
// about before its verdict. On a wide screen the breadcrumb back to Cases, the subject as the title, who sent it and who
// forwarded it when, and Download PDF and Copy link; on a phone the subject, sender and time as one line under the band
// (`MetaLine`, drawn by the live region so the poll keeps it current) and the title kept for screen readers. A link
// holder outside the organisation sees the subject and sender, never who forwarded it. Every stored part may be missing
// (a case not parsed yet, an upload, a header that would not decode): each says only what is stored.
import { Button } from "../components/Button";

export type HeaderFacts = {
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  channel: "email" | "upload";
  // Whether the forward carried the original's headers: forwarded as an attachment.
  headersAvailable: boolean;
  forwardedBy: string | null;
  // The forwarding or uploading member's name, when a member of the case's organisation matches (`checkerName`).
  checker: string | null;
  // When it arrived, in SAST words.
  at: string;
};

const subjectOf = (facts: HeaderFacts) => facts.subject?.trim() || "No subject";

// A short fingerprint of what the header says (FNV-1a over its facts): the status poll sends the header out of band only
// when this differs from the one the page holds, so a reader's focus, copy feedback or selection in the header survives
// every poll that changes nothing (in practice, all but the one after parsing).
export function headerKey(facts: HeaderFacts): string {
  const text = JSON.stringify([facts.subject, facts.fromName, facts.fromAddress, facts.checker, facts.forwardedBy]);
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
  if (facts.channel === "upload") return facts.checker ? `Uploaded by ${facts.checker}` : "Uploaded";
  const verb = facts.headersAvailable ? "Forwarded as an attachment" : "Forwarded";
  const who = facts.checker ?? facts.forwardedBy;
  return who ? `${verb} by ${who}` : verb;
}

export function ReportHeader(props: {
  facts: HeaderFacts;
  view: "member" | "public";
  // The report's own absolute address: a member's `/r/<id>`, a link holder's signed link.
  copy: string;
  // Swapped into the page out of band by the status poll, so a report opened before parsing catches up.
  oob?: boolean;
}) {
  const { facts, view } = props;
  const subject = subjectOf(facts);
  const sender = senderOf(facts);
  const member = view === "member";
  return (
    <div
      id="report-header"
      data-key={headerKey(facts)}
      class="flex flex-col gap-12"
      {...(props.oob ? { "hx-swap-oob": "true" } : {})}
    >
      {member && (
        <>
          <a href="/cases" class="md:hidden self-start inline-flex items-center min-h-24 type-small text-orange-text">
            ← Cases
          </a>
          <nav aria-label="Breadcrumb" class="hidden md:flex min-w-0 gap-8 items-center type-small text-muted">
            <a href="/cases" class="text-muted hover:text-ink">
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
          <h1 class="sr-only md:not-sr-only print:not-sr-only type-h2 wrap-anywhere">{subject}</h1>
          <p class="hidden md:block type-small text-muted wrap-anywhere print:block">
            {sender && (
              <>
                From <strong class="text-ink weight-text-strong">{sender}</strong>
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
export function MetaLine(props: { facts: HeaderFacts }) {
  const { facts } = props;
  const from = facts.fromAddress?.trim() || facts.fromName?.trim();
  const parts = [subjectOf(facts), from ? `from ${from}` : null, facts.at].filter(Boolean);
  return <p class="md:hidden print:hidden type-small text-muted wrap-anywhere">{parts.join(" · ")}</p>;
}
