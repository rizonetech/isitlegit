// The feedback queue page (D07 T08 §5; design/SPEC.md X4, board `Admin-Feedback`): the New, Triaged and Closed tabs
// with counts, the queue table with case links, organisation, verdicts, attribution and time, and the detail panel
// with the member's quote, what drove the verdict, the triage note and the Close and Reopen actions ("Add to eval
// set" and "File a TODO" wait on §20 and §21). Server-rendered; every number and row comes from the database in the
// routes, and this file only draws what it is given.
import type { Triage } from "../../db/feedback-triage";
import { AppShell } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Field } from "../components/Field";
import { Pill } from "../components/Pill";
import { EmptyState } from "../components/States";
import type { Shell } from "./admin-view";

export type QueueItem = {
  id: string;
  caseTitle: string;
  caseHref: string;
  orgName: string;
  verdict: "Safe" | "Suspicious" | "Malicious";
  theySay: "Safe" | "Unsafe";
  decidedBy: string;
  when: string;
};

export type OrgFeedbackItem = {
  id: string;
  caseTitle: string;
  caseHref: string;
  verdict: "Safe" | "Suspicious" | "Malicious";
  theySay: "Safe" | "Unsafe";
  status: "New" | "Triaged" | "Closed";
};

export type QueueDetail = {
  id: string;
  title: string;
  caseHref: string | null;
  status: Triage;
  quoteName: string | null;
  quote: string | null;
  drivers: string[];
  note: string;
  updatedAt: string;
  withdrawn: boolean;
  notice: string | null;
  error: string | null;
};

export type FeedbackQueueProps = {
  shell: Shell;
  generatedAt: string;
  tabs: Record<Triage, number>;
  tab: Triage;
  items: QueueItem[];
  page: number;
  pages: number;
  detail: QueueDetail | null;
};

const verdictPill = (verdict: QueueItem["verdict"]) =>
  verdict === "Safe" ? "safe" : verdict === "Suspicious" ? "suspicious" : ("malicious" as const);

function Tabs(props: { tabs: Record<Triage, number>; tab: Triage }) {
  const tabs: { key: Triage; label: string }[] = [
    { key: "new", label: "New" },
    { key: "triaged", label: "Triaged" },
    { key: "closed", label: "Closed" },
  ];
  return (
    <nav aria-label="Status" class="flex border border-line rounded-card overflow-hidden">
      {tabs.map((t) => (
        <a
          href={`/admin/feedback?triage=${t.key}`}
          aria-current={props.tab === t.key ? "page" : undefined}
          class={cx(
            "btn btn-sm no-underline",
            props.tab === t.key ? "bg-dark text-on-dark" : "bg-surface text-ink",
            FOCUS,
          )}
        >
          {t.label} {props.tabs[t.key]}
        </a>
      ))}
    </nav>
  );
}

function QueueTable(props: { items: QueueItem[]; tab: Triage; selected: string | null; page: number }) {
  if (props.items.length === 0) {
    return (
      <EmptyState
        layout="filtered"
        title={`No ${props.tab} reports`}
        sentence="Every report in this state will appear here with its case link."
      />
    );
  }
  return (
    <section class="card overflow-x-auto min-w-0" tabindex={0} aria-label="Feedback reports">
      <table class="table min-w-[640px] w-full">
        <thead>
          <tr>
            <th class="sticky left-0 bg-surface w-evidence-figure max-w-evidence-figure md:w-sidebar md:max-w-sidebar">
              Case
            </th>
            <th>Organisation</th>
            <th>Our verdict</th>
            <th>They say</th>
            <th>Decided by</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => (
            <tr class={item.id === props.selected ? "bg-subtle" : undefined}>
              <td
                class={cx(
                  "sticky left-0 w-evidence-figure max-w-evidence-figure md:w-sidebar md:max-w-sidebar",
                  item.id === props.selected ? "bg-subtle" : "bg-surface",
                )}
              >
                <a
                  href={`/admin/feedback?triage=${props.tab}&page=${props.page}&selected=${item.id}`}
                  title={item.caseTitle}
                  class="block max-w-evidence-figure md:max-w-sidebar truncate weight-text-strong"
                >
                  {item.caseTitle}
                </a>
              </td>
              <td class="small">{item.orgName}</td>
              <td>
                <Pill variant={verdictPill(item.verdict)}>{item.verdict}</Pill>
              </td>
              <td>
                {item.theySay === "Safe" ? <Pill variant="safe">Safe</Pill> : <Pill variant="neutral">Unsafe</Pill>}
              </td>
              <td class="small">{item.decidedBy}</td>
              <td class="small muted">{item.when}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function DetailPanel(props: { detail: QueueDetail; tab: Triage; page: number }) {
  const { detail } = props;
  if (detail.withdrawn) {
    return (
      <section class="card card-pad flex flex-col gap-16" aria-label="Selected report">
        <EmptyState
          layout="filtered"
          title="Report withdrawn"
          sentence="The member took this feedback back, so there is nothing to triage."
        />
      </section>
    );
  }
  return (
    <section class="card card-pad flex flex-col gap-16" aria-label="Selected report">
      <div class="flex justify-between items-center gap-8">
        <h3>{detail.title}</h3>
        <Pill variant={detail.status === "new" ? "running" : detail.status === "triaged" ? "suspicious" : "neutral"}>
          {detail.status === "new" ? "New" : detail.status === "triaged" ? "Triaged" : "Closed"}
        </Pill>
      </div>
      {detail.notice && (
        <p role="status" class="type-small weight-text-strong text-safe">
          {detail.notice}
        </p>
      )}
      {detail.quote && (
        <div class="panel p-16 flex flex-col gap-6">
          {detail.quoteName && <p class="tiny muted">{detail.quoteName} wrote</p>}
          <p class="small">“{detail.quote}”</p>
        </div>
      )}
      {detail.drivers.length > 0 && (
        <div class="flex flex-col gap-8">
          <p class="small weight-text-strong">What drove our verdict</p>
          <ul class="small pl-20 flex flex-col gap-4">
            {detail.drivers.map((driver) => (
              <li>{driver}</li>
            ))}
          </ul>
        </div>
      )}
      {detail.caseHref && (
        <p>
          <a href={detail.caseHref} class={cx("small text-orange-text underline", FOCUS)}>
            Open the case report
          </a>
        </p>
      )}
      <form method="post" action="/admin/feedback/action" class="flex flex-col gap-8">
        <input type="hidden" name="id" value={detail.id} />
        <input type="hidden" name="updatedAt" value={detail.updatedAt} />
        <input type="hidden" name="triage" value={props.tab} />
        <input type="hidden" name="page" value={String(props.page)} />
        <Field
          id="triage-note"
          label="Triage note"
          name="note"
          rows={4}
          value={detail.note}
          maxlength={1000}
          {...(detail.error ? { error: detail.error } : {})}
        />
        <div class="flex gap-8 flex-wrap items-center">
          <Button type="submit" variant="dark" size="small" name="action" value="note">
            {detail.status === "closed" ? "Save note" : "Save note and triage"}
          </Button>
          {detail.status !== "closed" ? (
            <Button type="submit" variant="ghost" size="small" name="action" value="close">
              Close: verdict was right
            </Button>
          ) : (
            <Button type="submit" variant="ghost" size="small" name="action" value="reopen">
              Reopen
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

export function FeedbackQueuePage(props: FeedbackQueueProps) {
  const selected = props.detail?.id ?? null;
  return (
    <Document title="Feedback · IsItLegit admin">
      <AppShell
        variant="admin"
        active="feedback"
        feedbackOpen={props.shell.feedbackOpen}
        operator={props.shell.operator}
      >
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <div class="flex justify-between items-center gap-16 flex-wrap">
            <div>
              <h1 class="type-h1">Feedback</h1>
              <p class="small muted">
                “This verdict is wrong” reports, with the check or model that drove each verdict
              </p>
            </div>
            <Tabs tabs={props.tabs} tab={props.tab} />
          </div>
          <div class="grid gap-24 md:grid-cols-[1fr_440px] items-start">
            <QueueTable items={props.items} tab={props.tab} selected={selected} page={props.page} />
            {props.detail && <DetailPanel detail={props.detail} tab={props.tab} page={props.page} />}
          </div>
          {props.pages > 1 && (
            <nav aria-label="Queue pages" class="flex gap-8 items-center">
              {props.page > 0 && (
                <a
                  href={`/admin/feedback?triage=${props.tab}&page=${props.page - 1}${selected ? `&selected=${selected}` : ""}`}
                  class={cx("btn btn-ghost btn-sm no-underline", FOCUS)}
                >
                  Previous
                </a>
              )}
              <p class="small muted">
                Page {props.page + 1} of {props.pages}
              </p>
              {props.page + 1 < props.pages && (
                <a
                  href={`/admin/feedback?triage=${props.tab}&page=${props.page + 1}${selected ? `&selected=${selected}` : ""}`}
                  class={cx("btn btn-ghost btn-sm no-underline", FOCUS)}
                >
                  Next
                </a>
              )}
            </nav>
          )}
        </div>
      </AppShell>
    </Document>
  );
}
