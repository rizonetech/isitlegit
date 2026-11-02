// The Cases list page (D07 T04 §1; design/SPEC.md M1, boards `Cases` and `Cases-Empty`): every case of the active
// organisation, newest first, 25 a page, filtered by verdict, channel and period. The filters and the page live in the
// query string, so a link, a reload and Back all show the same list. Without JavaScript the filters are a GET form with
// its own Apply button; with htmx a change redraws only the results and pushes the address (the newest change wins).
// A results request that fails is loaded again as a whole page by the app script, so the reader meets the sign-in, 403
// or 503 page. Each row is named by its subject over its sender, or an upload's file name over its type, and the search
// box finds a case by either (D07 T04 §7), in the query string with the filters.
import {
  type CaseFilters,
  type CasePage,
  DEFAULT_FILTERS,
  type ListedCase,
  PAGE_SIZE,
  SEARCH_LIMIT,
  type WeeklyStats,
} from "../../db/case-filters";
import { unmatchedQuote } from "../../db/search-fold";
import { AppShell, CHECK_ADDRESS, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button, buttonClass } from "../components/Button";
import { Document } from "../components/Document";
// The board draws the search box's glass with the Monitor link's glyph.
import { MonitorIcon as SearchIcon } from "../components/icons";
import { EmptyState } from "../components/States";
import { VerdictBadge } from "../components/Verdict";
import { shownState } from "./report-view";
import { STEP_COUNT } from "./welcome-view";

const VERDICT_WORDS = { all: "All", malicious: "Malicious", suspicious: "Suspicious", safe: "Safe" } as const;
const CHANNEL_WORDS = { all: "All channels", email: "Email", upload: "Upload" } as const;
const PERIOD_WORDS = { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days", all: "All time" } as const;
const TYPE_WORDS: Record<ListedCase["sourceKind"], string> = {
  mail: "Email",
  document: "Document",
  image: "Image",
  audio: "Voice note",
};

// The Type words with the stored classification (D07 T04 §13): an email carrying an invoice, and an uploaded
// payment document, as the board draws them; everything else keeps its source words.
export function typeWord(item: ListedCase): string {
  if (item.channel === "email" && item.hasInvoice) return "Email, invoice";
  if (item.channel === "upload" && item.hasPaymentDocument) return "Payment document";
  return TYPE_WORDS[item.sourceKind];
}

// The query string for a set of filters, defaults left out so the plain list is plain `/cases`.
// A report's address from the list (D07 T04 §9): the list's origin marker with the filters, so the report can step
// through this run and come back to it.
export function reportHref(filters: CaseFilters, id: string): string {
  const query = casesHref(filters).replace("/cases", "");
  return `/r/${id}?list=1${query ? `&${query.slice(1)}` : ""}`;
}

export function casesHref(filters: CaseFilters): string {
  const query = new URLSearchParams();
  for (const name of ["verdict", "channel", "period"] as const)
    if (filters[name] !== DEFAULT_FILTERS[name]) query.set(name, filters[name]);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.checker) query.set("checker", filters.checker);
  if (filters.q) query.set("q", filters.q);
  if (filters.page !== 1) query.set("page", String(filters.page));
  const text = query.toString();
  return text ? `/cases?${text}` : "/cases";
}

const SAST_OFFSET_MS = 2 * 60 * 60_000;
const sastDay = (ms: number) => Math.floor((ms + SAST_OFFSET_MS) / 86_400_000);
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayMonth = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
});
const dayMonthYear = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const full = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const year = (ms: number) => new Date(ms + SAST_OFFSET_MS).getUTCFullYear();

// "When", in South African time (board `Cases`): "Just now" under a minute, the time today, "Yesterday", then the day
// ("Fri 24 Oct"), with the year when it is not this year's.
export function whenText(iso: string, now: Date): string {
  const at = Date.parse(iso);
  const nowMs = now.getTime();
  if (nowMs - at < 60_000) return "Just now";
  const days = sastDay(nowMs) - sastDay(at);
  if (days === 0) return clock.format(at);
  if (days === 1) return "Yesterday";
  return (year(at) === year(nowMs) ? dayMonth : dayMonthYear).format(at).replace(",", "");
}
export const fullTime = (iso: string) => `${full.format(Date.parse(iso)).replace(",", "")} SAST`;

// How an upload came in, as the board words it ("Uploaded PDF"): a PDF by its stored type or name, else its kind.
function uploadedWords(c: ListedCase): string {
  const pdf = c.uploadMediaType?.toLowerCase() === "application/pdf" || /\.pdf$/i.test(c.uploadName ?? "");
  return `Uploaded ${pdf ? "PDF" : TYPE_WORDS[c.sourceKind].toLowerCase()}`;
}

// The row's two lines (board `Cases`, "Subject and sender"): an email's subject over its sender's address (the name when
// no address is stored), "No subject" over a sender with no subject, and "Forwarded email" alone before either is
// stored or for an inline forward; an upload's file name over how it came in, an uploaded email's with its sender
// ("Uploaded email from accounts@example"), so a search by either shows what it found (completion review G1).
export function caseLines(c: ListedCase): { title: string; detail: string | null } {
  const subject = c.subject?.trim() || null;
  const sender = c.senderAddress?.trim() || c.senderName?.trim() || null;
  if (c.channel === "upload") {
    const how = sender ? `${uploadedWords(c)} from ${sender}` : uploadedWords(c);
    const title = c.uploadName?.trim() || subject;
    return title ? { title, detail: how } : { title: how, detail: null };
  }
  if (!subject && !sender) return { title: "Forwarded email", detail: null };
  return { title: subject ?? "No subject", detail: sender };
}

function CaseCell(props: { item: ListedCase; filters: CaseFilters; class?: string }) {
  const { title, detail } = caseLines(props.item);
  return (
    <span class={cx("flex flex-col gap-2 min-w-0", props.class)}>
      <a href={reportHref(props.filters, props.item.id)} class={ROW_LINK}>
        {title}
      </a>
      {detail && <span class="type-small text-muted wrap-anywhere">{detail}</span>}
    </span>
  );
}

// The header a results request carries naming the organisation the page was drawn for: the route reloads the whole page
// when the active one has changed since (switched in another tab), so the heading and switcher never mislabel the rows.
export const ORG_HEADER = "x-cases-org";

// The results region's htmx wiring, shared by the form and the pager: fetch the address, keep only the results, push
// the address, and let the newest request, from the form or the pager alike, replace one still in flight (the form is
// the one queue every results request joins).
const RESULTS = {
  "hx-sync": "#case-filters:replace",
  "hx-target": "#case-results",
  "hx-select": "#case-results",
  "hx-swap": "outerHTML",
  "hx-push-url": "true",
  // The count's announcement and the weekly stats (D07 T04 §2) redraw with every results request, and so does the
  // period's state beside the date range (D07 T04 §8), which a range disables.
  "hx-select-oob": "#case-count,#case-stats,#case-period-state,#case-range-state,#case-checker-state",
  "hx-indicator": "#case-loading",
} as const;

function Pill(props: { item: ListedCase }) {
  const shown = shownState(props.item);
  return (
    <span class="flex flex-col items-start gap-4">
      <VerdictBadge state={shown.state} {...(shown.verdict ? { verdict: shown.verdict } : {})} />
      {shown.state === "failed" && <span class="text-13 text-muted">Could not be checked</span>}
    </span>
  );
}

function When(props: { iso: string; now: Date }) {
  return (
    <time datetime={props.iso} title={fullTime(props.iso)}>
      {whenText(props.iso, props.now)}
    </time>
  );
}

function CheckedBy(props: { item: ListedCase }) {
  return props.item.checkedBy ? (
    <span class="wrap-anywhere">{props.item.checkedBy}</span>
  ) : (
    <span class="text-muted">Not recorded</span>
  );
}

const ROW_LINK = cx("weight-text-strong text-ink underline-offset-4 hover:underline wrap-anywhere", FOCUS);

function Rows(props: { list: CasePage; filters: CaseFilters; now: Date }) {
  const { list, now } = props;
  return (
    <>
      {/* Desktop: the board's table. */}
      <table class="hidden md:table w-full text-left border-collapse">
        <caption class="sr-only">Cases, newest first</caption>
        <thead>
          <tr class="type-small text-muted border-b border-line bg-subtle">
            <th scope="col" class="px-16 py-12 weight-text-strong">
              Verdict
            </th>
            <th scope="col" class="px-16 py-12 weight-text-strong">
              Subject and sender
            </th>
            <th scope="col" class="px-16 py-12 weight-text-strong">
              Type
            </th>
            <th scope="col" class="px-16 py-12 weight-text-strong">
              Checked by
            </th>
            <th scope="col" class="px-16 py-12 weight-text-strong">
              When
            </th>
          </tr>
        </thead>
        <tbody>
          {list.cases.map((item) => (
            <tr class="border-b border-line last:border-b-0">
              <td class="px-16 py-16 align-middle">
                <Pill item={item} />
              </td>
              <td class="px-16 py-16 align-middle">
                <CaseCell item={item} filters={props.filters} />
              </td>
              <td class="px-16 py-16 align-middle">{typeWord(item)}</td>
              <td class="px-16 py-16 align-middle">
                <CheckedBy item={item} />
              </td>
              <td class="px-16 py-16 align-middle text-muted">
                <When iso={item.createdAt} now={now} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Phone: one card per case, no sideways scroll. */}
      <ol class="md:hidden flex flex-col">
        {list.cases.map((item) => (
          <li class="flex flex-col gap-8 p-16 border-b border-line last:border-b-0">
            <div class="flex items-start justify-between gap-12">
              <Pill item={item} />
              <span class="type-small text-muted">
                <When iso={item.createdAt} now={now} />
              </span>
            </div>
            <CaseCell
              item={item}
              filters={props.filters}
              class="[&>a]:self-start [&>a]:inline-flex [&>a]:items-center [&>a]:min-h-24"
            />
            <p class="type-small text-muted">
              {typeWord(item)}, checked by <CheckedBy item={item} />
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}

// Each end keeps its id across a swap, so htmx returns focus to the link pressed; when that end is now disabled the app
// script moves focus to the other (src/web/client/app.ts).
function PagerLink(props: { id: string; to: CaseFilters | null; children: string }) {
  if (!props.to)
    return (
      // No page that way: a disabled button, announced as dimmed, never a link to nowhere.
      <button id={props.id} type="button" disabled class={cx(buttonClass("ghost", "small"), "opacity-50")}>
        {props.children}
      </button>
    );
  // With htmx the page goes with the form's filters as they are now, not as they were when these rows were drawn, so a
  // pager press during a pending filter change pages that filter's list, and the controls, address and rows agree. The
  // `href` keeps the drawn filters for a reader without JavaScript, whose form only changes on Apply.
  const href = casesHref(props.to);
  return (
    <a
      id={props.id}
      href={href}
      hx-get="/cases"
      hx-include="#case-filters"
      hx-vals={JSON.stringify({ page: props.to.page })}
      {...RESULTS}
      class={buttonClass("ghost", "small")}
    >
      {props.children}
    </a>
  );
}

// Said when a query had more search terms than the search uses, in the status line and at the head of the results, the two
// regions every search redraws, so it appears and goes as the member types.
export const CUT_NOTICE = "Searching the first 8 search terms. A quoted phrase counts as one.";
export const LONG_NOTICE = `Your search was longer than ${SEARCH_LIMIT} characters, so only the first ${SEARCH_LIMIT} were used.`;
export const QUOTE_NOTICE = "A quoted phrase was cut off, so it was searched as separate words.";

// What was changed about the search the member typed, in words: too many terms, too many characters, a phrase cut open.
export function searchNotices(cut: boolean, long: boolean, q: string): string[] {
  return [
    ...(long ? [LONG_NOTICE] : []),
    ...(long && unmatchedQuote(q) ? [QUOTE_NOTICE] : []),
    ...(cut ? [CUT_NOTICE] : []),
  ];
}

function countLine(list: CasePage): string {
  if (list.matching === 0) return "No cases match";
  const first = (list.page - 1) * PAGE_SIZE + 1;
  const last = first + list.cases.length - 1;
  return `Showing ${first} to ${last} of ${list.matching}`;
}

// The status line every search redraws: the count (or the no-match words), and the cap notice when the query was cut.
function countStatus(list: CasePage, filters: CaseFilters, notices: string[], checkerName?: string): string {
  const reversed =
    filters.from && filters.to && filters.from > filters.to ? " From is after To. Swap them to see that week." : "";
  const base =
    list.matching === 0
      ? `No cases match ${filterWords(filters, checkerName)}.`
      : filters.checker
        ? `${countLine(list)}, checked by ${checkerName ?? "Member no longer available"}`
        : countLine(list);
  return notices.length
    ? `${base}${base.endsWith(".") ? "" : "."} ${notices.join(" ")}${reversed}`
    : `${base}${reversed}`;
}

// One range day in words ('3 Oct', or '3 Oct 2026' across years), from its `YYYY-MM-DD` at midday UTC so no zone
// moves it.
const rangeDay = (v: string, year = false) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" as const } : {}),
  }).format(new Date(`${v}T12:00:00Z`));

// The chosen range in words ('from 3 Oct to 9 Oct'), or null when no date is set (D07 T04 §8).
export function rangeWords(f: CaseFilters): string | null {
  const years = Boolean(f.from && f.to && f.from.slice(0, 4) !== f.to.slice(0, 4));
  if (f.from && f.to) return `from ${rangeDay(f.from, years)} to ${rangeDay(f.to, years)}`;
  if (f.from) return `from ${rangeDay(f.from)}`;
  if (f.to) return `to ${rangeDay(f.to)}`;
  return null;
}

// The filters in words, for the filtered-empty heading ('No cases match Malicious, email, last 7 days.').
function filterWords(f: CaseFilters, checkerName?: string): string {
  const parts: string[] = [];
  if (f.q) parts.push(`"${f.q}"`);
  if (f.verdict !== "all") parts.push(VERDICT_WORDS[f.verdict]);
  if (f.channel !== "all") parts.push(f.channel === "email" ? "email" : "uploads");
  if (f.checker) parts.push(`checked by ${checkerName ?? "Member no longer available"}`);
  parts.push(rangeWords(f) ?? PERIOD_WORDS[f.period].toLowerCase());
  return parts.join(", ");
}

function Results(props: { list: CasePage; filters: CaseFilters; now: Date; notices: string[]; checkerName?: string }) {
  const { list, filters, now, notices } = props;
  const cut = notices.length ? (
    <p data-search-cut class="type-small text-muted px-16 pt-16">
      {notices.join(" ")}
    </p>
  ) : null;
  if (list.matching === 0)
    return (
      <div id="case-results">
        {cut}
        {filters.from && filters.to && filters.from > filters.to ? (
          <p id="case-range-error" class="type-small text-muted px-16 pt-16">
            From is after To.{" "}
            <a
              href={casesHref({ ...filters, from: filters.to, to: filters.from, page: 1 })}
              class="weight-text-strong text-orange-text"
            >
              Swap them
            </a>{" "}
            to see that week.
          </p>
        ) : null}
        <EmptyState
          layout="filtered"
          level={2}
          title={`No cases match ${filterWords(filters, props.checkerName)}.`}
          sentence={`${list.total} ${list.total === 1 ? "case" : "cases"} in total. Try a wider date range or another verdict.`}
          action={
            <Button variant="ghost" href={casesHref({ ...DEFAULT_FILTERS, period: "all" })}>
              Clear filters
            </Button>
          }
        />
      </div>
    );
  const at = { ...filters, page: list.page };
  return (
    <div id="case-results" class="bg-surface border border-line rounded-card-large overflow-hidden">
      {cut}
      <Rows list={list} filters={filters} now={now} />
      <nav
        aria-label="Pages"
        class="flex flex-wrap items-center justify-between gap-12 px-16 py-16 border-t border-line"
      >
        <p class="type-small text-muted">{countLine(list)}</p>
        <div class="flex gap-8">
          <PagerLink id="case-previous" to={list.page > 1 ? { ...at, page: list.page - 1 } : null}>
            Previous
          </PagerLink>
          <PagerLink id="case-next" to={list.page < list.pages ? { ...at, page: list.page + 1 } : null}>
            Next
          </PagerLink>
        </div>
      </nav>
    </div>
  );
}

const SEGMENT = cx(
  "inline-flex items-center px-16 min-h-control-small text-14 weight-text-strong text-ink cursor-pointer has-checked:bg-dark has-checked:text-on-dark has-focus-visible:outline-2 has-focus-visible:outline-orange-text has-focus-visible:outline-offset-2",
);
const SELECT = cx(
  "h-control px-16 border border-control-border rounded-control text-16 weight-text-strong text-ink bg-surface",
  FOCUS,
);

const SEARCH = cx(
  "h-control w-full pl-40 pr-16 border border-control-border rounded-control font-text text-16 text-ink bg-surface placeholder:text-muted focus:border-orange",
  FOCUS,
);

function Filters(props: { filters: CaseFilters; members?: { id: string; label: string }[] }) {
  const { filters } = props;
  const members = props.members ?? [];
  const unavailable = filters.checker !== "" && !members.some((m) => m.id === filters.checker);
  return (
    <form
      method="get"
      action="/cases"
      hx-get="/cases"
      id="case-filters"
      // A control's change applies it; Enter in the search box searches at once (the form's submit, kept by htmx). The
      // search box's own change on leaving it is no change: its typing has already searched.
      hx-trigger="change[target.name!='q'], submit"
      {...RESULTS}
      class="flex flex-wrap items-center gap-12"
    >
      {/* The board's search box: no visible label, the glass and the placeholder say what it is. */}
      <div class="flex-1 basis-full md:basis-[320px] min-w-0">
        <label for="case-search" class="sr-only">
          Search cases
        </label>
        <div class="relative">
          <SearchIcon class="absolute left-12 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            id="case-search"
            type="search"
            name="q"
            value={filters.q}
            placeholder="Search by sender or subject (press /)"
            autocomplete="off"
            enterkeyhint="search"
            hx-get="/cases"
            hx-trigger="input changed delay:300ms"
            hx-include="#case-filters"
            {...RESULTS}
            class={SEARCH}
          />
        </div>
        <p class="type-small text-muted mt-4">
          Press / to search{" "}
          <button type="button" data-slash-toggle aria-pressed="false" class="underline">
            Turn off the / shortcut
          </button>
        </p>
      </div>
      <fieldset class="flex border border-control-border rounded-control overflow-hidden bg-surface">
        <legend class="sr-only">Verdict</legend>
        {(Object.keys(VERDICT_WORDS) as (keyof typeof VERDICT_WORDS)[]).map((v) => (
          <label class={SEGMENT}>
            <input type="radio" name="verdict" value={v} checked={filters.verdict === v} class="sr-only" />
            {VERDICT_WORDS[v]}
          </label>
        ))}
      </fieldset>
      <label for="case-channel" class="sr-only">
        Channel
      </label>
      <select id="case-channel" name="channel" class={SELECT}>
        {(Object.keys(CHANNEL_WORDS) as (keyof typeof CHANNEL_WORDS)[]).map((v) => (
          <option value={v} selected={filters.channel === v}>
            {CHANNEL_WORDS[v]}
          </option>
        ))}
      </select>
      {/* Who checked (D07 T04 §10): Everyone, then each current member. A checker who has left keeps the
          restrictive filter as a disabled selected option, with Clear filters the way back to Everyone. */}
      <span id="case-checker-state" class="contents">
        <label for="case-checker" class="type-small weight-text-strong text-ink">
          Checked by
        </label>
        <select id="case-checker" name="checker" class={cx(SELECT, "max-w-full min-w-0")}>
          <option value="" selected={filters.checker === ""}>
            Everyone
          </option>
          {members.map((m) => (
            <option value={m.id} selected={filters.checker === m.id}>
              {m.label}
            </option>
          ))}
          {unavailable ? (
            <option value={filters.checker} selected disabled>
              Member no longer available
            </option>
          ) : null}
        </select>
        {unavailable ? <input type="hidden" name="checker" value={filters.checker} /> : null}
      </span>
      <span id="case-period-state" class="contents">
        {/* A hidden twin carries the preset while the select is disabled under a range, so a submission never
          defaults it and Clear dates returns to the period the member chose (completion review G1). It rides
          this out-of-band region so it appears when a range is set by an incremental redraw too. */}
        {rangeWords(filters) !== null ? <input type="hidden" name="period" value={filters.period} /> : null}
        <label for="case-period" class="sr-only">
          Period
        </label>
        <select id="case-period" name="period" class={SELECT} disabled={rangeWords(filters) !== null}>
          {(Object.keys(PERIOD_WORDS) as (keyof typeof PERIOD_WORDS)[]).map((v) => (
            <option value={v} selected={filters.period === v}>
              {PERIOD_WORDS[v]}
            </option>
          ))}
        </select>
      </span>
      {/* A chosen date range beside the period (D07 T04 §8): setting a date makes the range the date filter. */}
      <label for="case-from" class="type-small weight-text-strong text-ink">
        From
      </label>
      <input
        id="case-from"
        type="date"
        name="from"
        value={filters.from}
        class={SELECT}
        aria-describedby="case-range-hint"
      />
      <label for="case-to" class="type-small weight-text-strong text-ink">
        To
      </label>
      <input id="case-to" type="date" name="to" value={filters.to} class={SELECT} aria-describedby="case-range-hint" />
      <span id="case-range-hint" class="type-small text-muted">
        SAST dates, both included.
      </span>
      <span id="case-range-state" class="contents">
        {rangeWords(filters) !== null ? (
          <span class="flex items-center gap-8 type-small text-muted">
            <span data-active-range>Range {rangeWords(filters)}</span>
            <a href={casesHref({ ...filters, from: "", to: "", page: 1 })} class="weight-text-strong text-orange-text">
              Clear dates
            </a>
          </span>
        ) : null}
      </span>
      {/* Only without JavaScript: htmx applies each change as it is made. */}
      <noscript>
        <Button type="submit" variant="dark">
          Apply
        </Button>
      </noscript>
      <p id="case-loading" role="status" class="hidden [&.htmx-request]:inline type-small text-muted">
        Loading cases
      </p>
    </form>
  );
}

// The line under the first-run state: what mail the organisation accepts, from its verified domains and addresses.
function AcceptedSenders(props: { domains: string[]; addresses: string[] }) {
  const { domains, addresses } = props;
  const list = (items: string[]) =>
    items.map((item, i) => (
      <>
        {i > 0 && (i === items.length - 1 ? " and " : ", ")}
        <strong class="text-ink">{item}</strong>
      </>
    ));
  const upload = (
    <>
      {" "}
      <a href="/upload" class={cx("text-orange-text underline underline-offset-4", FOCUS)}>
        Or upload a file
      </a>
      , including invoices, proofs of payment and voice notes.
    </>
  );
  if (!domains.length && !addresses.length)
    return (
      <p class="type-small text-muted">
        No mail is accepted yet: verify your domain or an address first in{" "}
        <a href="/settings/domains" class={cx("text-orange-text underline underline-offset-4", FOCUS)}>
          Domains and addresses
        </a>
        .{upload}
      </p>
    );
  const domainPart = domains.length ? (
    <>
      mail sent from {list(domains)}, your verified {domains.length === 1 ? "domain" : "domains"}
    </>
  ) : null;
  const addressPart = addresses.length ? (
    <>
      mail from {list(addresses)}, your verified {addresses.length === 1 ? "address" : "addresses"}
    </>
  ) : null;
  return (
    <p class="type-small text-muted">
      Only {domainPart}
      {domainPart && addressPart ? ", and " : ""}
      {addressPart}, is accepted.{upload}
    </p>
  );
}

const HOW_TO = [
  ["Outlook desktop", "Select the email, then Home, More, Forward as attachment."],
  ["Outlook on the web", "Open the email, then More actions, Forward as attachment."],
  ["Gmail", "Tick the email in your inbox, then More at the top, Forward as attachment."],
] as const;

function FirstRun(props: { domains: string[]; addresses: string[] }) {
  return (
    <EmptyState
      layout="first-run"
      eyebrow="No cases yet"
      title="Check your first suspicious email."
      sentence="Forward it as an attachment, so its original headers come along. The verdict comes back by email in about a minute and appears here."
    >
      <div
        data-copy-group
        class="flex flex-wrap items-center justify-between gap-12 p-16 border border-line rounded-card bg-surface"
      >
        <div class="flex flex-col gap-4 min-w-0">
          <span class="text-13 text-muted">Forward it, as an attachment, to</span>
          <span data-copy-source class="font-mono text-22 weight-heading wrap-anywhere">
            {CHECK_ADDRESS}
          </span>
        </div>
        <Button variant="dark" data-copy={CHECK_ADDRESS}>
          Copy address
        </Button>
        <p data-copy-status role="status" aria-live="polite" class="basis-full text-13 text-muted" />
      </div>
      <ul class="grid gap-12 md:grid-cols-3">
        {HOW_TO.map(([title, steps]) => (
          <li class="flex flex-col gap-4 p-16 border border-line rounded-card bg-subtle">
            <span class="text-14 weight-heading">{title}</span>
            <span class="text-13 text-muted">{steps}</span>
          </li>
        ))}
      </ul>
      <AcceptedSenders {...props} />
    </EmptyState>
  );
}

// Median time to verdict as the board words it: "48 s", then whole minutes and seconds from 90 s ("2 min 5 s").
export function verdictTime(seconds: number | null): string {
  if (seconds === null) return "No verdicts yet";
  const s = Math.round(seconds);
  if (s < 90) return `${s} s`;
  const min = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${min} min ${rest} s` : `${min} min`;
}

const TILE = "flex flex-col gap-8 p-24 bg-surface border border-line rounded-card-large min-w-0";
const TILE_NUMBER = "font-heading weight-heading text-40 leading-none";

// The board's stats panel (D07 T04 §2): this week's tiles, labels tied to their numbers. Money at risk caught and the
// kinds line under Malicious or suspicious wait on data nothing stores yet (D07 T04 §17 and §18).
function StatsPanel(props: { stats: WeeklyStats; orgId: string }) {
  const { thisWeek, lastWeekChecked } = props.stats;
  const flagged = thisWeek.malicious + thisWeek.suspicious;
  return (
    <section id="case-stats" aria-labelledby="case-stats-heading">
      <h2 id="case-stats-heading" class="sr-only">
        This week
      </h2>
      <dl class="grid gap-16 grid-cols-1 md:grid-cols-3">
        <div class={TILE}>
          <dt class="text-14 text-muted">Checked this week</dt>
          <dd class={TILE_NUMBER}>{thisWeek.checked}</dd>
          <dd class="text-13 text-muted">{lastWeekChecked} last week</dd>
        </div>
        <div class={TILE}>
          <dt class="text-14 text-muted">Malicious or suspicious</dt>
          <dd class={cx(TILE_NUMBER, flagged ? "text-mal" : "text-ink")}>{flagged}</dd>
        </div>
        <div class={TILE}>
          <dt class="text-14 text-muted">Median time to verdict</dt>
          <dd class={cx(TILE_NUMBER, thisWeek.medianSecondsToVerdict === null && "text-22 text-muted")}>
            {verdictTime(thisWeek.medianSecondsToVerdict)}
          </dd>
          <dd class="text-13">
            <a
              // The organisation the page shows, so an export after a switch in another tab is refused, never another's
              // counts. No `download` attribute: the CSV's own Content-Disposition saves it, and any refusal (sign in,
              // 403, 503, a switched organisation) arrives as the page it is, which a download would swallow.
              href={`/cases/stats.csv?org=${encodeURIComponent(props.orgId)}`}
              class={cx("text-orange-text underline underline-offset-4", FOCUS)}
            >
              Export counts as CSV
            </a>
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function CasesPage(props: {
  shell: Omit<MemberShellProps, "children">;
  list: CasePage;
  filters: CaseFilters;
  senders: { domains: string[]; addresses: string[] };
  stats: WeeklyStats;
  now: Date;
  // How far the setup list is (D07 T08 §2), null when it is finished or could not be read.
  setup?: { done: number; hidden: boolean } | null;
  // The query asked for was longer than the search keeps (D07 T04 §14).
  searchLong?: boolean;
  // Date bounds the address named but did not give as real dates, named so leaving them out is said, not silent
  // (D07 T04 §8, completion review G4).
  datesIgnored?: string[];
  // The organisation's current members for the Checked by select (D07 T04 §10).
  members?: { id: string; label: string }[];
}) {
  const { shell, list, filters, senders, stats, now, setup } = props;
  const checkerName = props.members?.find((m) => m.id === filters.checker)?.label;
  const notices = [
    ...searchNotices(Boolean(list.searchCut), Boolean(props.searchLong), filters.q),
    ...(props.datesIgnored ?? []).map((name) => `The ${name} date was not a real date, so it was left out.`),
  ];
  const orgName = shell.organization.name;
  return (
    <Document title="Cases">
      <AppShell {...shell}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <header class="flex flex-wrap items-start justify-between gap-16">
            <div class="flex flex-col gap-4 min-w-0">
              <h1 class="type-h1">Cases</h1>
              <p class="type-small text-muted wrap-anywhere">Everything {orgName} has checked</p>
            </div>
            <Button variant="primary" href="/upload">
              Check a file
            </Button>
          </header>
          {setup && setup.done < STEP_COUNT && (
            <p class="type-small">
              {setup.hidden ? (
                <a class="underline text-orange-text" href="/welcome">
                  Show setup list
                </a>
              ) : (
                <a class="underline text-orange-text weight-text-strong" href="/welcome">
                  {`Finish setting up (${setup.done} of ${STEP_COUNT} done)`}
                </a>
              )}
            </p>
          )}
          {list.total === 0 ? (
            <FirstRun {...senders} />
          ) : (
            <div class="flex flex-col gap-24" hx-headers={JSON.stringify({ [ORG_HEADER]: shell.organization.id })}>
              <StatsPanel stats={stats} orgId={shell.organization.id} />
              <Filters filters={filters} members={props.members ?? []} />
              <p id="case-count" role="status" class="sr-only">
                {countStatus(list, filters, notices, checkerName)}
              </p>
              <Results
                list={list}
                filters={filters}
                now={now}
                notices={notices}
                {...(checkerName ? { checkerName } : {})}
              />
            </div>
          )}
        </div>
      </AppShell>
    </Document>
  );
}
