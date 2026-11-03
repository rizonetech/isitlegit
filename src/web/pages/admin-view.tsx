// The admin console's pages (D07 T05 §2; design/SPEC.md X1 and X3, boards `Admin-Overview` and `Admin-Invites`): the
// cross-organisation overview with spend bars and the incident panel, and the invite-code page. Server-rendered; every
// number is read from the database by ./admin.tsx, and this file only draws what it is given, so the page test reads
// the exact seeded values back.

import {
  formatDuration,
  type InviteDraft,
  type InviteErrors,
  type InviteRow,
  inviteStatus,
  sastExpiry,
  sastShort,
} from "../../auth/invite-codes";
import { AppShell } from "../components/AppShell";
import { cx, FIELD_FOCUS, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { CHECK_WORDS } from "../components/evidence/check-words";
import { Field } from "../components/Field";
import { Pill } from "../components/Pill";
import { EmptyState } from "../components/States";

export type Shell = { operator: string; feedbackOpen: number };

export type OrgRow = {
  id: string;
  name: string;
  created: string;
  plan: string;
  domainsVerified: number;
  domainsPending: boolean;
  members: number;
  casesWeek: number;
  topCheck: string | null;
  feedbackOpen: number;
  capOverride: number | null;
  capEffective: number | null;
};

export type SpendBar = { label: string; amountUsd: number; capUsd: number; note?: string };

export type IncidentRow = { at: string; kind: string; org: string | null; outcome: string };

export type CapDraft = { orgId: string; cap: string; error?: string };

export type OverviewProps = {
  shell: Shell;
  generatedAt: string;
  organisations: number;
  orgsVerified: number;
  casesToday: number;
  casesTotal: number;
  medianSeconds: number | null;
  p95Seconds: number | null;
  feedbackOpen: number;
  spend: SpendBar[];
  rows: OrgRow[];
  query: string;
  incidents: IncidentRow[];
  capDraft: CapDraft | null;
};

const usd = (n: number): string => `US$${n.toFixed(2)}`;
const percent = (amount: number, cap: number): number =>
  cap <= 0 ? 0 : Math.min(100, Math.round((amount / cap) * 100));

function SpendBars(props: { bars: SpendBar[] }) {
  return (
    <section
      aria-label="Model spend against the caps"
      class="flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large"
    >
      <div class="flex flex-wrap items-baseline justify-between gap-8">
        <h2 class="type-h3">Model spend against the caps</h2>
        <p class="type-small text-muted">Caps are set in code (src/meta/caps.ts)</p>
      </div>
      <div class="grid gap-24 md:grid-cols-2">
        {props.bars.map((b) => (
          <div class="flex flex-col gap-8">
            <div class="flex justify-between gap-8">
              <p class="type-small weight-text-strong">{b.label}</p>
              <p class="type-small">
                <strong>
                  {usd(b.amountUsd)} of {b.capUsd.toFixed(2)}
                </strong>
              </p>
            </div>
            <div
              class="h-10 rounded-full bg-subtle"
              role="img"
              aria-label={`${b.label}: ${usd(b.amountUsd)} of ${usd(b.capUsd)}, ${percent(b.amountUsd, b.capUsd)} percent`}
            >
              <div class="h-10 rounded-full bg-ink" style={`width: ${percent(b.amountUsd, b.capUsd)}%`} />
            </div>
            {b.note && <p class="type-small text-muted">{b.note}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function CapControl(props: { row: OrgRow; query: string; draft: CapDraft | null }) {
  const { row, query, draft } = props;
  const active = draft?.orgId === row.id;
  return (
    <div class="flex flex-col gap-4">
      <span class="type-small">
        {draft && active
          ? "Cap"
          : row.capOverride === null
            ? row.capEffective === null
              ? "Unknown"
              : `Plan's cap (${row.capEffective})`
            : `Override (${row.capOverride})`}
      </span>
      <form method="post" action="/admin/orgs/cap" class="flex items-center gap-8">
        <input type="hidden" name="orgId" value={row.id} />
        <input type="hidden" name="q" value={query} />
        <input
          type="text"
          inputmode="numeric"
          name="cap"
          value={active ? draft.cap : String(row.capOverride ?? row.capEffective ?? "")}
          aria-label={`Daily case cap for ${row.name}`}
          aria-invalid={active && draft.error ? "true" : undefined}
          aria-describedby={active && draft.error ? `cap-error-${row.id}` : undefined}
          class={cx(
            "h-control-small w-80 px-12 border border-control-border rounded-control-small font-text text-14 bg-surface",
            FIELD_FOCUS,
          )}
        />
        <Button type="submit" name="action" value="set" variant="ghost" size="small">
          Set
        </Button>
        {row.capOverride !== null && (
          <Button type="submit" name="action" value="clear" variant="link" size="small">
            Use plan limit
          </Button>
        )}
      </form>
      {active && draft.error && (
        <p id={`cap-error-${row.id}`} role="alert" class="type-small text-mal">
          {draft.error}
        </p>
      )}
    </div>
  );
}

const TH = "px-16 py-12 type-small weight-text-strong";
const TD = "px-16 py-12 type-small align-top";

// A field's error only when there is one: `Field` takes no null or undefined error.
const fieldError = (error: string | undefined) => (error === undefined ? {} : { error });

function OrgTable(props: { rows: OrgRow[]; query: string; draft: CapDraft | null }) {
  const { rows, query, draft } = props;
  const csvHref = query ? `/admin/organisations.csv?q=${encodeURIComponent(query)}` : "/admin/organisations.csv";
  return (
    <section
      id="organisations"
      aria-labelledby="orgs-heading"
      class="bg-surface border border-line rounded-card-large overflow-hidden scroll-mt-16"
    >
      <div class="flex flex-wrap items-center justify-between gap-12 p-16 border-b border-line">
        <h2 id="orgs-heading" class="type-h3 px-8">
          Organisations
        </h2>
        <div class="flex flex-wrap items-center gap-8">
          <search>
            <form method="get" action="/admin" class="flex items-center gap-8">
              <label for="org-search" class="sr-only">
                Search organisations
              </label>
              <input
                id="org-search"
                type="search"
                name="q"
                value={query}
                placeholder="Search organisations"
                maxlength={120}
                class={cx(
                  "h-control-small w-220 px-12 border border-control-border rounded-control-small font-text text-14 bg-surface",
                  FIELD_FOCUS,
                )}
              />
              <Button type="submit" variant="ghost" size="small">
                Search
              </Button>
            </form>
          </search>
          <Button href={csvHref} variant="ghost" size="small">
            Export CSV
          </Button>
          <Button href="/admin/invites" variant="dark" size="small">
            New invite code
          </Button>
        </div>
      </div>
      {rows.length === 0 ? (
        query ? (
          <div class="p-24">
            <EmptyState
              layout="filtered"
              title="No organisations match"
              sentence={`Nothing is named like “${query}”.`}
              action={
                <Button href="/admin" variant="ghost" size="small">
                  Clear search
                </Button>
              }
            />
          </div>
        ) : (
          <p class="p-24 type-small text-muted">
            No organisations yet. The first invite-code signup makes the first one.
          </p>
        )
      ) : (
        <>
          <table aria-labelledby="orgs-heading" class="hidden md:table w-full text-left border-collapse">
            <thead>
              <tr class="type-small text-muted border-b border-line bg-subtle">
                <th scope="col" class={TH}>
                  Organisation
                </th>
                <th scope="col" class={TH}>
                  Created
                </th>
                <th scope="col" class={TH}>
                  Plan
                </th>
                <th scope="col" class={TH}>
                  Domains
                </th>
                <th scope="col" class={TH}>
                  Members
                </th>
                <th scope="col" class={`${TH} text-right`}>
                  Cases this week
                </th>
                <th scope="col" class={TH}>
                  Top threat
                </th>
                <th scope="col" class={`${TH} text-right`}>
                  Feedback
                </th>
                <th scope="col" class={TH}>
                  Daily cap
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr class="border-b border-line last:border-b-0">
                  <td class={cx(TD, "weight-text-strong wrap-anywhere")}>
                    <a href={`/admin/orgs/${r.id}`} class={cx("text-ink underline underline-offset-4", FOCUS)}>
                      {r.name}
                    </a>
                  </td>
                  <td class={cx(TD, "text-muted")}>{sastShort(r.created)}</td>
                  <td class={TD}>
                    <Pill variant={r.plan === "Free" ? "neutral" : "safe"} size="compact">
                      {r.plan}
                    </Pill>
                  </td>
                  <td class={TD}>
                    {r.domainsVerified > 0 ? (
                      `${r.domainsVerified} verified`
                    ) : r.domainsPending ? (
                      <Pill variant="suspicious" size="compact">
                        Pending
                      </Pill>
                    ) : (
                      <span class="text-muted">None</span>
                    )}
                  </td>
                  <td class={cx(TD, "tabular-nums")}>{r.members}</td>
                  <td class={cx(TD, "text-right tabular-nums")}>{r.casesWeek}</td>
                  <td class={cx(TD, "wrap-anywhere")}>
                    {r.topCheck === null ? (
                      <span class="text-muted">None yet</span>
                    ) : (
                      (CHECK_WORDS[r.topCheck] ?? r.topCheck)
                    )}
                  </td>
                  <td class={cx(TD, "text-right tabular-nums")}>{r.feedbackOpen}</td>
                  <td class={TD}>
                    <CapControl row={r} query={query} draft={draft} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul class="md:hidden flex flex-col">
            {rows.map((r) => (
              <li class="flex flex-col gap-8 p-16 border-t border-line first:border-t-0">
                <a href={`/admin/orgs/${r.id}`} class={cx("weight-text-strong text-ink wrap-anywhere", FOCUS)}>
                  {r.name}
                </a>
                <span class="flex flex-wrap items-center gap-8">
                  <Pill variant={r.plan === "Free" ? "neutral" : "safe"} size="compact">
                    {r.plan}
                  </Pill>
                  <span class="type-small text-muted">
                    {sastShort(r.created)} ·{" "}
                    {r.domainsVerified > 0
                      ? `${r.domainsVerified} verified`
                      : r.domainsPending
                        ? "Pending"
                        : "No domains"}{" "}
                    · {r.members} members · {r.casesWeek} this week ·{" "}
                    {r.topCheck === null ? "None yet" : (CHECK_WORDS[r.topCheck] ?? r.topCheck)} · {r.feedbackOpen}{" "}
                    feedback
                  </span>
                </span>
                <CapControl row={r} query={query} draft={draft} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const KIND_WORDS: Record<string, string> = {
  "sign-in-failed": "Sign-in refused",
  "rate-limited": "Rate limited",
};

function IncidentsPanel(props: { incidents: IncidentRow[] }) {
  return (
    <section
      aria-labelledby="incidents-heading"
      class="flex flex-col gap-12 p-24 bg-surface border border-line rounded-card-large"
    >
      <h2 id="incidents-heading" class="type-h3">
        Recent incidents
      </h2>
      {props.incidents.length === 0 ? (
        <p class="type-small text-muted">No refused sign-ins or rate limits recorded.</p>
      ) : (
        <ul class="flex flex-col gap-8">
          {props.incidents.map((i) => (
            <li class="flex flex-wrap items-baseline gap-x-12 gap-y-4 type-small">
              <span class="text-muted">{sastShort(i.at)}</span>
              <strong class="weight-text-strong">{KIND_WORDS[i.kind] ?? i.kind}</strong>
              <span class="wrap-anywhere">{i.org ?? "No organisation"}</span>
              <span class="text-muted wrap-anywhere">{i.outcome}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function OverviewPage(props: OverviewProps) {
  const median = props.medianSeconds === null ? "No verdicts yet" : formatDuration(props.medianSeconds);
  return (
    <Document title="Overview">
      <AppShell variant="admin" active="overview" feedbackOpen={props.feedbackOpen} operator={props.shell.operator}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <header class="flex flex-wrap items-center justify-between gap-12">
            <div>
              <h1 class="type-h1">Overview</h1>
              <p class="type-small text-muted">All organisations · {props.generatedAt}</p>
            </div>
            <div class="flex gap-8">
              <Button
                href={
                  props.query
                    ? `/admin/organisations.csv?q=${encodeURIComponent(props.query)}`
                    : "/admin/organisations.csv"
                }
                variant="ghost"
                size="small"
              >
                Export CSV
              </Button>
              <Button href="/admin/invites" variant="dark" size="small">
                New invite code
              </Button>
            </div>
          </header>
          <section aria-label="Summary" class="grid gap-16 md:grid-cols-4">
            <div class="p-24 bg-surface border border-line rounded-card-large">
              <p class="type-small text-muted">Organisations</p>
              <p class="type-figure">{props.organisations}</p>
              <p class="type-small text-muted">{props.orgsVerified} with a verified domain</p>
            </div>
            <div class="p-24 bg-surface border border-line rounded-card-large">
              <p class="type-small text-muted">Cases today</p>
              <p class="type-figure">{props.casesToday}</p>
              <p class="type-small text-muted">{props.casesTotal} in total</p>
            </div>
            <div class="p-24 bg-surface border border-line rounded-card-large">
              <p class="type-small text-muted">Median time to verdict</p>
              <p class="type-figure">{median}</p>
              <p class="type-small text-muted">
                {props.p95Seconds === null ? "no p95 yet" : `p95 ${formatDuration(props.p95Seconds)}`}
              </p>
            </div>
            <div class="p-24 bg-surface border border-line rounded-card-large">
              <p class="type-small text-muted">Open feedback</p>
              <p class="type-figure">{props.feedbackOpen}</p>
              <p class="type-small">
                <a href="/admin/feedback" class={cx("text-orange-text underline underline-offset-4", FOCUS)}>
                  Review
                </a>
              </p>
            </div>
          </section>
          <SpendBars bars={props.spend} />
          <OrgTable rows={props.rows} query={props.query} draft={props.capDraft} />
          <IncidentsPanel incidents={props.incidents} />
        </div>
      </AppShell>
    </Document>
  );
}

export type InviteItem = InviteRow & { id: string; tag: string; label: string; created: string };
export type CreatedCode = { code: string; label: string };

export type InvitesProps = {
  shell: Shell;
  now: string;
  draft: InviteDraft;
  errors: InviteErrors;
  created: CreatedCode | null;
  notice: string | null;
  creationKey: string;
  items: InviteItem[];
};

const STATUS_PILL = { Active: "safe", "Used up": "neutral", Expired: "neutral", Revoked: "malicious" } as const;

function CreatedPanel(props: { created: CreatedCode }) {
  return (
    <section
      aria-labelledby="created-heading"
      data-copy-group
      class="flex flex-col gap-12 p-24 bg-surface border border-line rounded-card-large"
    >
      <h2 id="created-heading" class="type-h3">
        Code created for {props.created.label}
      </h2>
      <p class="type-small text-muted">
        Shown once: copy it now. No later visit can show it again, because only its hash is stored. If it is lost,
        revoke the code below and make a new one.
      </p>
      <div class="flex flex-wrap items-center gap-12">
        <code data-copy-source class="font-mono weight-text-strong wrap-anywhere">
          {props.created.code}
        </code>
        <Button
          data-copy={props.created.code}
          data-copy-failed="Copy failed: select the code to copy it"
          variant="dark"
          size="small"
        >
          Copy
        </Button>
      </div>
      <p data-copy-status role="status" aria-live="polite" class="type-small text-muted" />
    </section>
  );
}

export function InvitesPage(props: InvitesProps) {
  const { draft, errors } = props;
  return (
    <Document title="Invite codes">
      <AppShell
        variant="admin"
        active="invites"
        feedbackOpen={props.shell.feedbackOpen}
        operator={props.shell.operator}
      >
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <header>
            <h1 class="type-h1">Invite codes</h1>
            <p class="type-small text-muted">
              Signup is by invite during the launch. A code can admit one or more organisations.
            </p>
          </header>
          {props.created && <CreatedPanel created={props.created} />}
          {props.notice && (
            <p role="status" class="p-24 bg-surface border border-line rounded-card-large type-small">
              {props.notice}
            </p>
          )}
          <section
            aria-labelledby="new-code-heading"
            class="flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large"
          >
            <h2 id="new-code-heading" class="type-h3">
              New code
            </h2>
            <form
              method="post"
              action="/admin/invites"
              data-busy
              class="grid gap-16 md:grid-cols-[1.4fr_0.7fr_0.9fr_auto] md:items-end"
            >
              <input type="hidden" name="key" value={props.creationKey} />
              <Field
                id="invite-label"
                name="label"
                label="Label"
                placeholder="Who is it for?"
                value={draft.label}
                maxlength={200}
                {...fieldError(errors.label)}
              />
              <Field
                id="invite-uses"
                name="uses"
                label="Organisations"
                inputmode="numeric"
                value={draft.uses}
                {...fieldError(errors.uses)}
              />
              <Field
                id="invite-expires"
                name="expires"
                label="Expires"
                placeholder="Empty reads Never"
                value={draft.expires}
                maxlength={10}
                hint="A date like 2026-11-13 after today, or empty for never"
                {...fieldError(errors.expires)}
              />
              <Button type="submit" variant="dark" data-busy-label="Creating code…">
                Create code
              </Button>
            </form>
          </section>
          <section
            aria-labelledby="codes-heading"
            class="bg-surface border border-line rounded-card-large overflow-hidden"
          >
            <h2 id="codes-heading" class="type-h3 p-16 border-b border-line px-24">
              Codes
            </h2>
            {props.items.length === 0 ? (
              <p class="p-24 type-small text-muted">No invite codes yet. Make the first one above.</p>
            ) : (
              <>
                <table aria-labelledby="codes-heading" class="hidden md:table w-full text-left border-collapse">
                  <thead>
                    <tr class="type-small text-muted border-b border-line bg-subtle">
                      <th scope="col" class={TH}>
                        Code
                      </th>
                      <th scope="col" class={TH}>
                        Label
                      </th>
                      <th scope="col" class={TH}>
                        Used
                      </th>
                      <th scope="col" class={TH}>
                        Created
                      </th>
                      <th scope="col" class={TH}>
                        Expires
                      </th>
                      <th scope="col" class={TH}>
                        Status
                      </th>
                      <th scope="col" class={TH}>
                        <span class="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.items.map((item) => {
                      const status = inviteStatus(item, props.now);
                      return (
                        <tr class="border-b border-line last:border-b-0">
                          <td
                            class={cx(
                              TD,
                              "font-mono weight-text-strong wrap-anywhere",
                              status === "Revoked" && "line-through text-muted",
                            )}
                          >
                            {item.tag}
                          </td>
                          <td class={cx(TD, "wrap-anywhere", status === "Revoked" && "text-muted")}>{item.label}</td>
                          <td class={cx(TD, "tabular-nums")}>
                            {item.uses} of {item.max_uses}
                          </td>
                          <td class={cx(TD, "text-muted")}>{sastShort(item.created)}</td>
                          <td class={cx(TD, status === "Revoked" && "text-muted")}>{sastExpiry(item.expires_at)}</td>
                          <td class={TD}>
                            <Pill variant={STATUS_PILL[status]} size="compact">
                              {status}
                            </Pill>
                          </td>
                          <td class={cx(TD, "text-right")}>
                            {status === "Active" && (
                              <form method="post" action="/admin/invites/revoke">
                                <input type="hidden" name="id" value={item.id} />
                                <Button
                                  type="submit"
                                  variant="danger"
                                  size="small"
                                  label={`Revoke the code for ${item.label}`}
                                >
                                  Revoke
                                </Button>
                              </form>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <ul class="md:hidden flex flex-col">
                  {props.items.map((item) => {
                    const status = inviteStatus(item, props.now);
                    return (
                      <li class="flex flex-col gap-8 p-16 border-t border-line first:border-t-0">
                        <span class="flex flex-wrap items-center gap-8">
                          <code
                            class={cx(
                              "font-mono weight-text-strong wrap-anywhere",
                              status === "Revoked" && "line-through text-muted",
                            )}
                          >
                            {item.tag}
                          </code>
                          <Pill variant={STATUS_PILL[status]} size="compact">
                            {status}
                          </Pill>
                        </span>
                        <span class={cx("weight-text-strong wrap-anywhere", status === "Revoked" && "text-muted")}>
                          {item.label}
                        </span>
                        <span class="type-small text-muted">
                          {item.uses} of {item.max_uses} · {sastExpiry(item.expires_at)}
                        </span>
                        {status === "Active" && (
                          <form method="post" action="/admin/invites/revoke">
                            <input type="hidden" name="id" value={item.id} />
                            <Button
                              type="submit"
                              variant="danger"
                              size="small"
                              label={`Revoke the code for ${item.label}`}
                            >
                              Revoke
                            </Button>
                          </form>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
          <p class="type-small text-muted">
            Revoking a code stops new signups only; organisations that already joined keep their access.
          </p>
        </div>
      </AppShell>
    </Document>
  );
}
