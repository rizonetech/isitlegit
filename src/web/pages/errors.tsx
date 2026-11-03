// The pages a member page answers with when it cannot show itself (E1 to E5's compositions, design/SPEC.md; D07 T08 §1
// later owns them all): the report's (D07 T03 §1) and the Cases list's (D07 T04 §1). Each is private and unindexed, and
// an outage's reference is the one its log line carries.
import { LOGO, LOGO_ON_DARK } from "../assets";
import { CHECK_ADDRESS } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
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

// The boards' frame: the linked logo and the app's hostname above the card (boards `Error-404` to `Error-Maintenance`).
function ErrorFrame(props: { children: unknown }) {
  return (
    <div class="min-h-screen p-16 md:px-56 md:py-40 bg-subtle flex flex-col gap-32">
      <header class="flex items-center justify-between">
        <a href="/" class={cx("rounded-small", FOCUS)}>
          <img src={LOGO} alt="IsItLegit" class="block h-28 dark:hidden" />
          <img src={LOGO_ON_DARK} alt="IsItLegit" class="hidden h-28 dark:block" />
        </a>
        <span class="type-small text-muted">app.isitlegit.co.za</span>
      </header>
      <main id="content">{props.children as never}</main>
    </div>
  );
}

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
  options: { retry?: string; ref?: string; now?: Date; email?: string; closed?: boolean } = {},
) {
  const footer = referenceLine(options.ref ?? reference(code), options.now ?? new Date());
  const body =
    code === 403 && options.closed ? (
      <ErrorState
        code={403}
        title="This organisation is closed."
        actions={[
          <Button variant="dark" href="/settings/account">
            Your account
          </Button>,
          <form method="post" action="/auth/sign-out">
            <Button type="submit" variant="ghost">
              Sign out
            </Button>
          </form>,
        ]}
        footer={footer}
      >
        Its owner closed it, so it no longer takes cases. Your account page says when its stored mail, cases and history
        will be deleted.
      </ErrorState>
    ) : code === 403 ? (
      // E3, answered by the Cases list itself (D07 T04 §1): the board's "Go to your own cases" is this page, so only Sign
      // out is offered (a Deviation in design/SPEC.md E3).
      <ErrorState
        code={403}
        title="You're not a member of this organisation."
        actions={[
          <Button variant="dark" href="/settings/account">
            Your account
          </Button>,
          <form method="post" action="/auth/sign-out">
            <Button type="submit" variant="ghost">
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
    <ErrorFrame>{body}</ErrorFrame>,
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
    <ErrorFrame>
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
    </ErrorFrame>,
    410,
    { "x-artefact-state": "gone" },
  );
}

// An evidence file that could not be read just now (D07 T03 §3): Try again asks for the same file with the reader's own
// access (the address as asked, a link holder's signature kept), and the report stays one press away.
export function artefactFailed(retry: string, back: string, options: { ref?: string; now?: Date } = {}) {
  const footer = referenceLine(options.ref ?? reference(500), options.now ?? new Date());
  return page(
    "File not loaded",
    <ErrorFrame>
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
    </ErrorFrame>,
    503,
    { "retry-after": "5", "x-artefact-state": "unavailable" },
  );
}

const SAST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const SAST_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const sastDay = (at: Date) => {
  const part = Object.fromEntries(SAST_DAY.formatToParts(at).map(({ type, value }) => [type, value]));
  return `${part.weekday} ${part.day} ${part.month} ${part.year}`;
};
const sastClock = (at: Date) => `${SAST_TIME.format(at)} SAST`;
// "5 h 12 min", "12 min", "less than a minute": the wait in words, rounded up to the minute.
const waitWords = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  if (ms < 60_000) return "less than a minute";
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
};

// E4 (design/SPEC.md; board `Error-429`): the daily cap, with when it resets, or the short burst limit with its seconds.
// The answer is 429 with `retry-after` in seconds. Only words the page chose reach it: the organisation's name is the
// one value from outside, drawn escaped.
export function slowDownPage(
  options:
    | { kind: "daily"; orgName: string; limit: number; resetsAt: Date; ref?: string; now?: Date }
    | { kind: "burst"; retryInSeconds: number; ref?: string; now?: Date },
) {
  const now = options.now ?? new Date();
  const footer = referenceLine(options.ref ?? reference(429), now);
  const actions = [
    <Button variant="dark" href="/settings/plan">
      See your plan
    </Button>,
    <Button variant="ghost" href="/cases">
      Back to cases
    </Button>,
  ];
  if (options.kind === "burst") {
    const seconds = Math.max(1, Math.ceil(options.retryInSeconds));
    return page(
      "Slow down",
      <ErrorFrame>
        <ErrorState
          code={429}
          title="Too many requests at once."
          actions={actions}
          footer={footer}
        >{`Nothing is lost. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`}</ErrorState>
      </ErrorFrame>,
      429,
      { "retry-after": String(seconds) },
    );
  }
  const wait = Math.max(0, options.resetsAt.getTime() - now.getTime());
  // A daily limit of 0 is an operator's pause (`pausedAlert`, ./upload-view.tsx): nothing restarts at midnight, so no
  // reset time is promised.
  if (options.limit === 0)
    return page(
      "Checks paused",
      <ErrorFrame>
        <ErrorState code={429} title={`Checks are paused for ${options.orgName}.`} actions={actions} footer={footer}>
          Nothing has gone wrong on your side, and nothing resets at midnight. Email {CHECK_ADDRESS} or ask the
          organisation's owner to contact us, and we will tell you when checking is back on.
        </ErrorState>
      </ErrorFrame>,
      429,
    );
  return page(
    "Slow down",
    <ErrorFrame>
      <ErrorState
        code={429}
        title={`You've reached today's limit of ${options.limit} checks.`}
        actions={actions}
        panel={{
          lead: "Too many requests at once?",
          sentence: 'The same page also covers a short burst limit: then it says "try again in 30 seconds".',
        }}
        footer={footer}
      >
        {options.orgName} can check {options.limit} emails or files a day during the launch. The limit resets at{" "}
        {sastClock(options.resetsAt)}, in {waitWords(wait)}. Mail forwarded before then is not checked: you get one
        email saying so, and can forward it again after the reset.
      </ErrorState>
    </ErrorFrame>,
    429,
    { "retry-after": String(Math.max(1, Math.ceil(wait / 1000))) },
  );
}

// E6 (board `Error-Maintenance`): a planned downtime notice, 503 with `retry-after`. `window` is the stretch announced;
// without one the page says only that the work is under way.
export function maintenancePage(options: { window?: { from: Date; to: Date }; reload?: string; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const { window } = options;
  // Where the work stands against the announced window: not begun, under way, or past its expected end. A window that
  // runs over is said so, never promised as a return time already gone; the switch is not turned off by the clock.
  const phase = !window ? "none" : now < window.from ? "before" : now <= window.to ? "during" : "overdue";
  // A time with its date when the window crosses midnight, so neither end is attributed to the wrong day.
  const crosses = window ? sastDay(window.from) !== sastDay(window.to) : false;
  const at = (date: Date) => (crosses ? `${sastClock(date)} on ${sastDay(date)}` : sastClock(date));
  const wait = window ? Math.ceil((window.to.getTime() - now.getTime()) / 1000) : 300;
  const title =
    window && phase !== "overdue"
      ? `We're upgrading IsItLegit. Back by ${at(window.to)}.`
      : window
        ? "We're upgrading IsItLegit. It is taking longer than planned."
        : "We're upgrading IsItLegit. Back shortly.";
  const footer = !window
    ? "Planned maintenance in progress"
    : `${phase === "before" ? "Starts" : "Started"} ${at(window.from)} · ${phase === "overdue" ? "was expected back" : "expected back"} ${at(window.to)}`;
  const late = `Replies to email forwarded to ${CHECK_ADDRESS} ${window ? "during this window " : ""}may be late; if one has not arrived an hour after we are back, forward the email again.`;
  const sentence = !window
    ? `The dashboard is offline for a short while. Your cases and settings are safe. ${late}`
    : phase === "overdue"
      ? `The work that began at ${at(window.from)} is running past ${at(window.to)}. The dashboard is still offline; your cases and settings are safe. Reload in a few minutes. ${late}`
      : `The dashboard is ${phase === "before" ? "going offline" : "offline"} from ${at(window.from)} to ${at(window.to)}${crosses ? "" : ` on ${sastDay(window.from)}`}. Your cases and settings are safe. ${late}`;
  return page(
    "Maintenance",
    <ErrorFrame>
      <ErrorState
        code="maintenance"
        title={title}
        actions={[
          <Button variant="ghost" href={options.reload ?? "/"}>
            Reload
          </Button>,
        ]}
        footer={footer}
      >
        {sentence}
      </ErrorState>
    </ErrorFrame>,
    503,
    { "retry-after": String(phase === "overdue" ? 60 : Math.min(3600, Math.max(30, wait))) },
  );
}

// The `MAINTENANCE` variable's window: "<start ISO>/<end ISO>" names one, any other non-empty value switches the page on
// without a window, and empty or unset leaves the app as it is.
export function maintenanceFrom(value: string | undefined): { on: boolean; window?: { from: Date; to: Date } } {
  const text = (value ?? "").trim();
  if (!text) return { on: false };
  const [a, b] = text.split("/");
  const from = new Date(a ?? "");
  const to = new Date(b ?? "");
  return Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from
    ? { on: true }
    : { on: true, window: { from, to } };
}

const attachmentName = (key: string) => (key.split("/").pop() ?? "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);

export function attachmentHeaders(key: string): Record<string, string> {
  return {
    ...HEADERS,
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${attachmentName(key)}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  };
}
