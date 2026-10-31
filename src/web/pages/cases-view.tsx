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
} from "../../db/case-filters";
import { AppShell, CHECK_ADDRESS, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button, buttonClass } from "../components/Button";
import { Document } from "../components/Document";
// The board draws the search box's glass with the Monitor link's glyph.
import { MonitorIcon as SearchIcon } from "../components/icons";
import { EmptyState } from "../components/States";
import { VerdictBadge } from "../components/Verdict";
import { shownState } from "./report-view";

const VERDICT_WORDS = { all: "All", malicious: "Malicious", suspicious: "Suspicious", safe: "Safe" } as const;
const CHANNEL_WORDS = { all: "All channels", email: "Email", upload: "Upload" } as const;
const PERIOD_WORDS = { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days", all: "All time" } as const;
const TYPE_WORDS: Record<ListedCase["sourceKind"], string> = {
  mail: "Email",
  document: "Document",
  image: "Image",
  audio: "Voice note",
};

// The query string for a set of filters, defaults left out so the plain list is plain `/cases`.
export function casesHref(filters: CaseFilters): string {
  const query = new URLSearchParams();
  for (const name of ["verdict", "channel", "period"] as const)
    if (filters[name] !== DEFAULT_FILTERS[name]) query.set(name, filters[name]);
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

function CaseCell(props: { item: ListedCase; class?: string }) {
  const { title, detail } = caseLines(props.item);
  return (
    <span class={cx("flex flex-col gap-2 min-w-0", props.class)}>
      <a href={`/r/${props.item.id}`} class={ROW_LINK}>
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
  "hx-select-oob": "#case-count",
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

function Rows(props: { list: CasePage; now: Date }) {
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
                <CaseCell item={item} />
              </td>
              <td class="px-16 py-16 align-middle">{TYPE_WORDS[item.sourceKind]}</td>
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
            <CaseCell item={item} class="[&>a]:self-start [&>a]:inline-flex [&>a]:items-center [&>a]:min-h-24" />
            <p class="type-small text-muted">
              {TYPE_WORDS[item.sourceKind]}, checked by <CheckedBy item={item} />
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

function countLine(list: CasePage): string {
  if (list.matching === 0) return "No cases match";
  const first = (list.page - 1) * PAGE_SIZE + 1;
  const last = first + list.cases.length - 1;
  return `Showing ${first} to ${last} of ${list.matching}`;
}

// The filters in words, for the filtered-empty heading ('No cases match Malicious, email, last 7 days.').
function filterWords(f: CaseFilters): string {
  const parts: string[] = [];
  if (f.q) parts.push(`"${f.q}"`);
  if (f.verdict !== "all") parts.push(VERDICT_WORDS[f.verdict]);
  if (f.channel !== "all") parts.push(f.channel === "email" ? "email" : "uploads");
  parts.push(PERIOD_WORDS[f.period].toLowerCase());
  return parts.join(", ");
}

function Results(props: { list: CasePage; filters: CaseFilters; now: Date }) {
  const { list, filters, now } = props;
  if (list.matching === 0)
    return (
      <div id="case-results">
        <EmptyState
          layout="filtered"
          level={2}
          title={`No cases match ${filterWords(filters)}.`}
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
      <Rows list={list} now={now} />
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

function Filters(props: { filters: CaseFilters }) {
  const { filters } = props;
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
      <div class="relative flex-1 basis-full md:basis-[320px] min-w-0">
        <label for="case-search" class="sr-only">
          Search cases
        </label>
        <SearchIcon class="absolute left-12 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input
          id="case-search"
          type="search"
          name="q"
          value={filters.q}
          maxlength={SEARCH_LIMIT}
          placeholder="Search by sender or subject"
          autocomplete="off"
          enterkeyhint="search"
          hx-get="/cases"
          hx-trigger="input changed delay:300ms"
          hx-include="#case-filters"
          {...RESULTS}
          class={SEARCH}
        />
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
      <label for="case-period" class="sr-only">
        Period
      </label>
      <select id="case-period" name="period" class={SELECT}>
        {(Object.keys(PERIOD_WORDS) as (keyof typeof PERIOD_WORDS)[]).map((v) => (
          <option value={v} selected={filters.period === v}>
            {PERIOD_WORDS[v]}
          </option>
        ))}
      </select>
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

export function CasesPage(props: {
  shell: Omit<MemberShellProps, "children">;
  list: CasePage;
  filters: CaseFilters;
  senders: { domains: string[]; addresses: string[] };
  now: Date;
}) {
  const { shell, list, filters, senders, now } = props;
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
          {list.total === 0 ? (
            <FirstRun {...senders} />
          ) : (
            <div class="flex flex-col gap-24" hx-headers={JSON.stringify({ [ORG_HEADER]: shell.organization.id })}>
              <Filters filters={filters} />
              <p id="case-count" role="status" class="sr-only">
                {list.matching === 0 ? `No cases match ${filterWords(filters)}.` : countLine(list)}
              </p>
              <Results list={list} filters={filters} now={now} />
            </div>
          )}
        </div>
      </AppShell>
    </Document>
  );
}
