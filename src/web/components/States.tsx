import type { Child } from "hono/jsx";
import { LOGO_MARK, MOTION } from "../assets";
import { cx, hasText, nonBlank } from "./attrs";

// The four states every page draws the same way (D07 T01 §8; design/SPEC.md M1, M3 and 7): nothing yet, something
// running, something wrong, and a partial result. Art is decorative (`alt=""`); the words carry the meaning. A card is
// `.card` in `ui.css` (16 px radius, `card-large`). The art is drawn in ink for a light ground, so in the dark theme it
// sits on the white `on-band` tile, as the verdict band's does (§7).
const CARD = "bg-surface border border-line rounded-card-large";
// Headings take the type roles of `design/tokens/typography.json` (size, line height, weight and tracking together), as
// the boards' `h2`, `h3` and `h4` in `ui.css` draw them.
const HEADING = "min-w-0 wrap-anywhere";

type Level = 1 | 2 | 3 | 4;

export type EmptyStateProps =
  | {
      // First run (board `Cases-Empty`): the question art beside an eyebrow, a heading and a sentence, with the page's
      // own content below them (the forward box and how-to tiles of D07 T04 §1).
      layout: "first-run";
      eyebrow: string;
      title: string;
      sentence: string;
      level?: Level;
      children?: Child;
    }
  | {
      // Nothing matches the filters (board `Cases-Empty`, second state): a heading, a sentence and a way back.
      layout: "filtered";
      title: string;
      sentence: string;
      level?: Level;
      action?: Child;
    };

export function EmptyState(props: EmptyStateProps) {
  const title = nonBlank(props.title);
  const sentence = nonBlank(props.sentence);
  if (!title) throw new Error("EmptyState: an empty state needs a heading");
  if (!sentence) throw new Error("EmptyState: an empty state needs its sentence");
  if (props.layout === "filtered") {
    const Heading = `h${props.level ?? 3}` as "h3";
    return (
      <section
        class={cx(CARD, "flex flex-col items-start gap-16 p-24 md:flex-row md:items-center md:justify-between md:p-32")}
      >
        <div class="flex min-w-0 flex-col gap-4">
          <Heading class={cx(HEADING, "type-h3")}>{title}</Heading>
          <p class="type-small text-muted wrap-anywhere">{sentence}</p>
        </div>
        {props.action}
      </section>
    );
  }
  const eyebrow = nonBlank(props.eyebrow);
  if (!eyebrow) throw new Error("EmptyState: a first-run state needs its eyebrow");
  const Heading = `h${props.level ?? 2}` as "h2";
  return (
    <section class={cx(CARD, "flex flex-col gap-24 p-24 md:flex-row md:items-center md:gap-48 md:p-48")}>
      <img
        src={MOTION.question}
        alt=""
        class="w-120 h-120 shrink-0 dark:p-16 dark:bg-on-band dark:rounded-card-large md:w-empty-art md:h-empty-art"
      />
      <div class="flex min-w-0 flex-col gap-20">
        <div class="flex flex-col gap-8">
          <p class="type-eyebrow text-orange-text">{eyebrow}</p>
          <Heading class={cx(HEADING, "type-h2")}>{title}</Heading>
          <p class="text-18 text-muted wrap-anywhere">{sentence}</p>
        </div>
        {props.children}
      </div>
    </section>
  );
}

// The running marker (board `Report-Running`: the running step's orange square, 18 px built 20, and "Running" in
// `orange-text` at 600). The square pulses only when the reader allows motion (`motion-safe`); the words are announced
// politely as they change.
export function LoadingState(props: { children: string }) {
  if (!nonBlank(props.children)) throw new Error("LoadingState: a loading state needs its words");
  return (
    <p
      role="status"
      aria-live="polite"
      class="inline-flex items-center gap-8 type-small weight-text-strong text-orange-text"
    >
      <span
        aria-hidden="true"
        class="inline-block w-20 h-20 shrink-0 rounded-small bg-orange motion-safe:animate-pulse"
      />
      {props.children}
    </p>
  );
}

export type ErrorCode = 403 | 404 | 410 | 429 | 500 | "maintenance";

// The art and the eyebrow's colour each error board draws.
const ERROR_ART: Record<ErrorCode, string> = {
  403: LOGO_MARK,
  404: MOTION.question,
  410: MOTION.question,
  429: MOTION.suspicious,
  500: MOTION.question,
  maintenance: MOTION.checking,
};
const EYEBROW_COLOUR: Record<ErrorCode, string> = {
  403: "text-orange-text",
  404: "text-orange-text",
  410: "text-orange-text",
  429: "text-sus",
  500: "text-mal",
  maintenance: "text-orange-text",
};

const SAST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// "Reference 404-7F3K2Q · Mon 27 Oct 2026, 10:12 SAST": the id a member quotes to support, with the time in South Africa.
export function referenceLine(id: string, at: Date): string {
  if (!nonBlank(id)) throw new Error("referenceLine: a reference needs its id");
  if (Number.isNaN(at.getTime())) throw new Error("referenceLine: a reference needs a valid time");
  const part = Object.fromEntries(SAST.formatToParts(at).map(({ type, value }) => [type, value]));
  return `Reference ${id} · ${part.weekday} ${part.day} ${part.month} ${part.year}, ${part.hour}:${part.minute} SAST`;
}

export type ErrorStateProps = {
  code: ErrorCode;
  title: string;
  // One plain sentence; it may hold inline markup (403's signed-in address).
  children: Child;
  // One or two `Button`s: dark, then ghost (maintenance's Reload is ghost alone).
  actions: Child[];
  // A plain muted line under the actions (the forwarding reminder).
  note?: Child;
  // A panel under the actions (429's burst limit): a bold lead and a muted sentence.
  panel?: { lead: string; sentence: string };
  // The line below the card: `referenceLine(...)` for an error, the window for maintenance.
  footer: string;
};

// An app error page's body (design/SPEC.md 7; boards `Error-404` to `Error-500`, `Error-Maintenance`): the art on its
// tile, the code, one plain sentence, one way forward and the reference. Nothing here can carry a stack trace or an
// error's own text: every slot is words the page chose.
export function ErrorState(props: ErrorStateProps) {
  const { code, actions, note, panel } = props;
  const title = nonBlank(props.title);
  if (!title) throw new Error("ErrorState: an error state needs its title");
  if (!hasText(props.children)) throw new Error("ErrorState: an error state needs its sentence");
  if (actions.length < 1 || actions.length > 2) throw new Error("ErrorState: an error state has one or two actions");
  const footer = nonBlank(props.footer);
  if (!footer) throw new Error("ErrorState: an error state needs its reference line");
  if (code !== "maintenance" && !footer.startsWith("Reference "))
    throw new Error("ErrorState: an error's footer is its reference (referenceLine)");
  const eyebrow = code === "maintenance" ? "Planned maintenance" : `Error ${code}`;
  return (
    <div class="flex flex-col gap-32">
      <div class={cx(CARD, "flex flex-col gap-24 p-24 md:flex-row md:items-center md:gap-40 md:px-48 md:py-40")}>
        <span class="inline-flex shrink-0 items-center justify-center w-88 h-88 rounded-card-large bg-light dark:bg-on-band md:w-state-art md:h-state-art">
          <img src={ERROR_ART[code]} alt="" class="w-72 h-72 md:w-120 md:h-120" />
        </span>
        <div class="flex min-w-0 flex-col gap-16">
          <p class={cx("type-eyebrow", EYEBROW_COLOUR[code])}>{eyebrow}</p>
          {/* The boards' 32 px title is the h2 role at 32 from `md`; at phone width it keeps the role's 28. */}
          <h1 class={cx(HEADING, "type-h2 md:text-32")}>{title}</h1>
          <p class="text-muted wrap-anywhere">{props.children}</p>
          <div class="flex flex-wrap gap-12 mt-8">{actions}</div>
          {note && <p class="type-small text-muted wrap-anywhere">{note}</p>}
          {panel && (
            <div class="px-16 py-12 bg-subtle border border-line rounded-card-large">
              <p class="type-small wrap-anywhere">
                <strong>{panel.lead}</strong> <span class="text-muted">{panel.sentence}</span>
              </p>
            </div>
          )}
        </div>
      </div>
      <div class="flex flex-wrap justify-between gap-x-24 gap-y-4 type-tiny text-muted">
        <span>{footer}</span>
        <span>IsItLegit by Rizonetech</span>
      </div>
    </div>
  );
}

export type SkippedCheck = { name: string; reason: string };

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const count = (n: number) => WORDS[n] ?? String(n);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The notice above a partial report (board `Report-Partial`): which checks did not run and why, and what that means for
// the verdict. The heading is counted from the checks themselves.
export function PartialNotice(props: { skipped: SkippedCheck[]; ran: number }) {
  const { skipped, ran } = props;
  if (skipped.length === 0) throw new Error("PartialNotice: a partial result names the checks that did not run");
  if (!Number.isInteger(ran) || ran < 0) throw new Error("PartialNotice: the checks that ran are zero or more");
  for (const check of skipped)
    if (!nonBlank(check.name) || !nonBlank(check.reason))
      throw new Error("PartialNotice: every check that did not run needs its name and reason");
  const heading = `${capital(count(skipped.length))} ${skipped.length === 1 ? "check" : "checks"} did not run, so this verdict rests on the ${count(ran)} that did.`;
  return (
    <section
      role="note"
      aria-label="Partial check"
      class="flex items-start gap-20 px-24 py-20 bg-partial-wash border border-line-strong border-l-8 border-l-partial rounded-card"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
        class="w-24 h-24 shrink-0 mt-2 text-partial"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 16.5v.5" />
      </svg>
      <div class="flex min-w-0 flex-1 flex-col gap-8">
        <h4 class={cx(HEADING, "type-h4")}>{heading}</h4>
        <ul class="flex flex-col gap-8 pl-20 list-disc type-small">
          {skipped.map((check) => (
            <li class="wrap-anywhere">
              <strong>{check.name}:</strong> {check.reason}
            </li>
          ))}
        </ul>
        <p class="type-small text-muted">
          What this means: the verdict could be stronger with the missing checks, never weaker. We will not guess what
          they would have found.
        </p>
      </div>
    </section>
  );
}
