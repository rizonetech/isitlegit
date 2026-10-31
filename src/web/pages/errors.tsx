// The pages a member page answers with when it cannot show itself (E1 to E5's compositions, design/SPEC.md; D07 T08 §1
// later owns them all): the report's (D07 T03 §1) and the Cases list's (D07 T04 §1). Each is private and unindexed, and
// an outage's reference is the one its log line carries.
import { CHECK_ADDRESS } from "../components/AppShell";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { type ErrorCode, ErrorState, referenceLine } from "../components/States";

export const HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex",
  // The signed link's query goes nowhere else: the page loads only its own files.
  "referrer-policy": "same-origin",
  "content-type": "text/html; charset=utf-8",
};

export function page(title: string, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(String(<Document title={title}>{body as never}</Document>), {
    status,
    headers: { ...HEADERS, ...extra },
  });
}

export const reference = (code: number | string) =>
  `${code}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;

const forward = (
  <>
    Forwarding still works: send suspicious mail to <strong class="font-mono text-ink">{CHECK_ADDRESS}</strong> as
    usual.
  </>
);

// The error pages, in E1, E2, E3 and E5's compositions. Their actions are the boards' own: the cases list (D07 T04 §1) and the upload page (D01 T03 §6) are their sections' pages.
// `retry` is the page an outage's "Try again" opens: the address asked for, its signed link kept, so a link holder is
// not sent to sign in. `ref` is the reference shown, the same one the outage's log line carries.
export function errorPage(
  code: Extract<ErrorCode, 403 | 404 | 410 | 500>,
  caseId: string,
  options: { retry?: string; ref?: string; now?: Date; email?: string } = {},
) {
  const footer = referenceLine(options.ref ?? reference(code), options.now ?? new Date());
  const body =
    code === 403 ? (
      // E3, answered by the Cases list itself (D07 T04 §1): the board's "Go to your own cases" is this page, so only Sign
      // out is offered (a Deviation in design/SPEC.md E3).
      <ErrorState
        code={403}
        title="You're not a member of this organisation."
        actions={[
          <form method="post" action="/auth/sign-out">
            <Button type="submit" variant="dark">
              Sign out
            </Button>
          </form>,
        ]}
        footer={footer}
      >
        You are signed in as <strong class="text-ink">{options.email}</strong>, which has no access here. Ask an owner
        of the organisation to invite this address, or sign in with another one.
      </ErrorState>
    ) : code === 404 ? (
      <ErrorState
        code={404}
        title="We can't show you that page."
        actions={[
          <Button variant="dark" href="/cases">
            Go to your cases
          </Button>,
          <Button variant="ghost" href="/upload">
            Check a file
          </Button>,
        ]}
        note={forward}
        footer={footer}
      >
        It may not exist, the address may be mistyped, or it may belong to an organisation you are not part of. We don't
        say which, so case links never reveal anything.
      </ErrorState>
    ) : code === 410 ? (
      <ErrorState
        code={410}
        title="This report link has expired."
        actions={[
          <Button variant="dark" href={`/signin?next=${encodeURIComponent(`/r/${caseId}`)}`}>
            Sign in to see the case
          </Button>,
        ]}
        note={
          <>
            No account? Forward the email again to <strong class="font-mono text-ink">{CHECK_ADDRESS}</strong> for a
            fresh report.
          </>
        }
        footer={footer}
      >
        Links in our reply emails work for 7 days, so an old email can't be used to read a report. The case itself stays
        in your organisation's account: sign in to open it.
      </ErrorState>
    ) : (
      <ErrorState
        code={500}
        title="Sorry, something broke on our side."
        actions={[
          <Button variant="dark" href={options.retry ?? `/r/${caseId}`}>
            Try again
          </Button>,
          <Button variant="ghost" href="mailto:support@isitlegit.co.za">
            Email support
          </Button>,
        ]}
        note={forward}
        footer={footer}
      >
        This was our fault, not yours. Try again in a minute. If it keeps happening, send us the reference below.
      </ErrorState>
    );
  const titles = { 403: "No access", 404: "Not found", 410: "Link expired", 500: "Something broke" } as const;
  return page(
    titles[code],
    <main id="content" class="min-h-screen p-16 md:px-56 md:py-40 bg-subtle">
      {body}
    </main>,
    code === 500 ? 503 : code,
    code === 500 ? { "retry-after": "5" } : {},
  );
}

// An evidence file that is no longer stored (D07 T03 §3): the finding and the verdict stay on the report, which the
// one action opens. The privacy sentence is said only for a case old enough for the 30-day rule to have removed it
// (D00 T01 §5); a newer case's missing file is said as missing, never as expired.
export function artefactGone(back: string, pastRetention: boolean, options: { ref?: string; now?: Date } = {}) {
  const footer = referenceLine(options.ref ?? reference(410), options.now ?? new Date());
  return page(
    "File not available",
    <main id="content" class="min-h-screen p-16 md:px-56 md:py-40 bg-subtle">
      <ErrorState
        code={410}
        title="The original file is no longer available."
        actions={[
          <Button variant="dark" href={back}>
            Back to the report
          </Button>,
        ]}
        footer={footer}
      >
        {pastRetention
          ? "Original files are deleted after 30 days for privacy. The finding and the verdict stay on the report."
          : "The finding and the verdict stay on the report."}
      </ErrorState>
    </main>,
    410,
  );
}

// An evidence file that could not be read just now (D07 T03 §3): Try again asks for the same file with the reader's own
// access (the address as asked, a link holder's signature kept), and the report stays one press away.
export function artefactFailed(retry: string, back: string, options: { ref?: string; now?: Date } = {}) {
  const footer = referenceLine(options.ref ?? reference(500), options.now ?? new Date());
  return page(
    "File not loaded",
    <main id="content" class="min-h-screen p-16 md:px-56 md:py-40 bg-subtle">
      <ErrorState
        code={500}
        title="This file could not be loaded just now."
        actions={[
          <Button variant="dark" href={retry}>
            Try again
          </Button>,
          <Button variant="ghost" href={back}>
            Back to the report
          </Button>,
        ]}
        footer={footer}
      >
        This was our fault, not yours. The finding and the verdict stay on the report. Try again in a minute; if it
        keeps happening, send us the reference below.
      </ErrorState>
    </main>,
    503,
    { "retry-after": "5" },
  );
}
