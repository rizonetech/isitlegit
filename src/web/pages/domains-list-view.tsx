// The Domains and addresses page (D07 T04 §4; design/SPEC.md M8, board `Domains`): the domains and single addresses an
// organisation accepts mail from, each with its state, the forwarding help, and for an owner or admin Add a domain and
// Remove (confirmed on a page of its own). A member reads the same lists with no controls. What a change did comes
// back signed in the address and is drawn over the stored state (./domains-list.tsx). The claim page of one domain is
// D07 T02 §15 (./domains-view.tsx); the address claim page is D07 T04 §27.
import type { Checker } from "../../db/checker";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx } from "../components/attrs";
import { Button, buttonClass } from "../components/Button";
import { Document } from "../components/Document";
import { Field } from "../components/Field";
import { Pill } from "../components/Pill";

export type Challenge = { codeExpiresAt: string | null; lockedUntil: string | null; nextCodeAt: string | null };
export type DomainRow = {
  domain: string;
  state: "pending" | "verified";
  method: "dns" | "email" | null;
  verifiedAt: string | null;
  verifiedBy: Checker;
  // Read for owners and admins only (the JSON route's gate): a pending claim's wait, null for a member.
  challenge: Challenge | null;
  // Yes, Not set up, or After verifying.
  protectedIdentity: string;
};
export type AddressRow = {
  // A verified domain's "Anyone @domain", or one single address.
  kind: "domain" | "single";
  label: string;
  state: "pending" | "verified";
  verifiedAt: string | null;
  verifiedBy: Checker;
  casesThisMonth: number;
};

// "Karoo Couriers'" and "Fynbos Freight's", as the board writes the first.
const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

export const OUTCOMES = ["added", "removed", "gone", "switched", "no-permission", "kept", "failed", "refused"] as const;
export type Outcome = { r: (typeof OUTCOMES)[number]; what?: string };

const SAST_OFFSET_MS = 2 * 60 * 60_000;
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const sastDate = (iso: string) => dateFormat.format(Date.parse(iso));
export const sastTime = (iso: string) => `${timeFormat.format(Date.parse(iso))} SAST`;
// The first moment of this month in SAST, as an ISO instant (what "this month" counts from).
export function monthStart(now: Date): string {
  const local = new Date(now.getTime() + SAST_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - SAST_OFFSET_MS).toISOString();
}

// Who proved a claim, as the board writes it (D07 T04 §28): a named member as "Thandi N." (first name and the
// initial of the last, as the Team page writes who sent an invite), an unnamed member by their email's local part,
// a departed member as "a former member", and no one recorded as nothing. The name is drawn as text, so a hostile
// stored name is escaped by the page, never markup.
export function byline(who: Checker): string {
  if (!who) return "";
  if (who.kind === "former") return " by a former member";
  if (who.name.includes("@")) return ` by ${who.name.split("@")[0] ?? who.name}`;
  const parts = who.name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return parts.length === 1 ? ` by ${parts[0]}` : ` by ${parts[0]} ${(parts.at(-1) as string).charAt(0)}.`;
}

// How a domain was proved: the method, the date and who proved it, never which mailbox (the recipient is not stored).
export function provedText(row: DomainRow): string {
  if (row.state === "verified") {
    const how = row.method === "dns" ? "DNS TXT record" : "A code mailed to the domain's admin@ or postmaster@ address";
    return row.verifiedAt
      ? `${how}, ${sastDate(row.verifiedAt)}${byline(row.verifiedBy)}`
      : `${how}${byline(row.verifiedBy)}`;
  }
  const wait = row.challenge;
  if (wait?.lockedUntil) return `Locked after wrong codes until ${sastTime(wait.lockedUntil)}`;
  if (wait?.codeExpiresAt) return `Code sent, valid until ${sastTime(wait.codeExpiresAt)}`;
  if (wait?.nextCodeAt) return `Waiting for the TXT record. The next code can be sent at ${sastTime(wait.nextCodeAt)}`;
  return "Waiting for the TXT record";
}

function outcomeText(o: Outcome): { text: string; tone: "done" | "refused" } {
  const what = o.what ?? "That claim";
  switch (o.r) {
    case "added":
      return { text: `${what} was added. Prove you own it to start accepting its mail.`, tone: "done" };
    case "removed":
      return { text: `${what} was removed.`, tone: "done" };
    case "gone":
      return { text: `${what} is no longer on the list.`, tone: "refused" };
    case "switched":
      return {
        text: "Nothing was changed: this page was opened for another organisation. Check the lists below.",
        tone: "refused",
      };
    case "no-permission":
      return { text: "Only an owner or admin can change what mail is accepted.", tone: "refused" };
    case "kept":
      return {
        text: "Nothing was removed: this organisation is kept for testing, so its domains and addresses stay.",
        tone: "refused",
      };
    case "failed":
      return {
        text: `The change to ${what} could not be confirmed. The lists below are as stored now; try again if they are not what you asked.`,
        tone: "refused",
      };
    default:
      return { text: "Nothing was changed: that request is not one this page sends.", tone: "refused" };
  }
}

const HOW_TO = [
  ["Outlook desktop", "Select the email, then Home, More, Forward as attachment. Send it to check@isitlegit.co.za."],
  ["Outlook on the web", "Open the email, choose More actions, Forward as attachment."],
  ["Gmail", "Tick the email in your inbox, then More at the top, Forward as attachment."],
] as const;

const TH = "px-16 py-12 weight-text-strong";
const TD = "px-16 py-16 align-middle";

function AddDomain(props: { orgId: string; value: string; error: string | null; open: boolean }) {
  const { orgId, value, error, open } = props;
  return (
    <details open={open || undefined} class="group" id="add-domain">
      <summary class={cx(buttonClass("primary", "default"), "list-none cursor-pointer")}>Add a domain</summary>
      <form method="post" action="/settings/domains" class="flex flex-col gap-12 mt-16 max-w-[520px]" data-busy>
        <input type="hidden" name="action" value="add" />
        <input type="hidden" name="org" value={orgId} />
        <Field
          id="add-domain-name"
          name="domain"
          label="Domain"
          hint="The domain your business mail comes from, such as karoocouriers.example."
          value={value}
          {...(error ? { error } : {})}
          autocomplete="off"
          required
        />
        <Button type="submit" variant="dark" data-busy-label="Adding…">
          Add domain
        </Button>
      </form>
    </details>
  );
}

function AddAddress(props: { orgId: string; value: string; error: string | null; open: boolean }) {
  const { orgId, value, error, open } = props;
  return (
    <details open={open || undefined} class="group" id="add-address">
      <summary class={cx(buttonClass("ghost", "default"), "list-none cursor-pointer")}>Add a single address</summary>
      <form
        method="post"
        action="/settings/domains"
        class="flex flex-col gap-12 mt-16 max-w-[520px]"
        data-busy
        data-busy-check="/settings/domains"
      >
        <input type="hidden" name="action" value="add-address" />
        <input type="hidden" name="org" value={orgId} />
        <Field
          id="add-address-email"
          name="address"
          label="Address"
          hint="One address that should be allowed to forward mail, such as accounts@karoocouriers.example. We email it a code."
          value={value}
          {...(error ? { error } : {})}
          autocomplete="off"
          inputmode="email"
          required
        />
        <Button type="submit" variant="dark" data-busy-label="Adding…">
          Add address
        </Button>
      </form>
    </details>
  );
}

function DomainsTable(props: { rows: DomainRow[]; manage: boolean }) {
  const { rows, manage } = props;
  // An organisation that accepts only single addresses has no domain rows: say so, not a table of headers alone.
  if (rows.length === 0)
    return (
      <section
        aria-labelledby="domains-heading"
        class="bg-surface border border-line rounded-card-large overflow-hidden"
      >
        <h2 id="domains-heading" class="type-h3 px-24 py-16">
          Domains
        </h2>
        <p class="px-24 pb-16 text-muted">
          No domain yet. Mail from a whole domain is accepted once you add one and prove you own it.
        </p>
      </section>
    );
  return (
    <section aria-labelledby="domains-heading" class="bg-surface border border-line rounded-card-large overflow-hidden">
      <h2 id="domains-heading" class="type-h3 px-24 py-16">
        Domains
      </h2>
      <table aria-labelledby="domains-heading" class="hidden md:table w-full text-left border-collapse">
        <thead>
          <tr class="type-small text-muted border-y border-line bg-subtle">
            <th scope="col" class={TH}>
              Domain
            </th>
            <th scope="col" class={TH}>
              Status
            </th>
            <th scope="col" class={TH}>
              How it was proved
            </th>
            <th scope="col" class={TH}>
              Protected identity
            </th>
            <th scope="col" class={TH}>
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr class="border-b border-line last:border-b-0">
              <td class={cx(TD, "font-mono weight-text-strong wrap-anywhere")}>{r.domain}</td>
              <td class={TD}>
                <Pill variant={r.state === "verified" ? "safe" : "suspicious"} size="compact">
                  {r.state === "verified" ? "Verified" : "Pending"}
                </Pill>
              </td>
              <td class={TD}>{provedText(r)}</td>
              <td class={cx(TD, r.state === "pending" && "text-muted")}>{r.protectedIdentity}</td>
              <td class={cx(TD, "text-right")}>{manage && <DomainActions row={r} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul class="md:hidden flex flex-col">
        {rows.map((r) => (
          <li class="flex flex-col gap-8 p-16 border-t border-line">
            <span class="font-mono weight-text-strong wrap-anywhere">{r.domain}</span>
            <span class="flex items-center gap-8">
              <Pill variant={r.state === "verified" ? "safe" : "suspicious"} size="compact">
                {r.state === "verified" ? "Verified" : "Pending"}
              </Pill>
              <span class="type-small text-muted">Protected identity: {r.protectedIdentity}</span>
            </span>
            <span class="type-small text-muted">{provedText(r)}</span>
            {manage && (
              <span class="flex gap-8">
                <DomainActions row={r} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DomainActions(props: { row: DomainRow }) {
  const { row } = props;
  return (
    <span class="inline-flex gap-8">
      {row.state === "pending" && (
        <a
          href={`/settings/domains/${encodeURIComponent(row.domain)}`}
          class={buttonClass("ghost", "small")}
          aria-label={`Continue verifying ${row.domain}`}
        >
          Continue
        </a>
      )}
      <a
        href={`/settings/domains/remove/${encodeURIComponent(row.domain)}`}
        class={buttonClass("danger", "small")}
        aria-label={`Remove ${row.domain}`}
      >
        Remove
      </a>
    </span>
  );
}

function AddressesTable(props: {
  rows: AddressRow[];
  manage: boolean;
  orgName: string;
  orgId: string;
  addAddress?: { value: string; error: string | null } | undefined;
}) {
  const { rows, manage, orgName } = props;
  const why = (r: AddressRow) =>
    r.kind === "domain"
      ? "The whole domain is verified"
      : r.state === "pending"
        ? "Waiting for the code"
        : `Single address, confirmed by a code${r.verifiedAt ? ` on ${sastDate(r.verifiedAt)}` : ""}${byline(r.verifiedBy)}`;
  return (
    <section
      aria-labelledby="addresses-heading"
      class="bg-surface border border-line rounded-card-large overflow-hidden"
    >
      <div class="flex flex-wrap items-start justify-between gap-12 px-24 py-16">
        <h2 id="addresses-heading" class="type-h3">
          Addresses that can forward to check@
        </h2>
        {manage && (
          <AddAddress
            orgId={props.orgId}
            value={props.addAddress?.value ?? ""}
            error={props.addAddress?.error ?? null}
            open={Boolean(props.addAddress?.error || props.addAddress?.value)}
          />
        )}
      </div>
      <table aria-labelledby="addresses-heading" class="hidden md:table w-full text-left border-collapse">
        <thead>
          <tr class="type-small text-muted border-y border-line bg-subtle">
            <th scope="col" class={TH}>
              Address
            </th>
            <th scope="col" class={TH}>
              Why it is allowed
            </th>
            <th scope="col" class={TH}>
              Cases this month
            </th>
            <th scope="col" class={TH}>
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr class="border-b border-line last:border-b-0">
              <td class={cx(TD, "font-mono wrap-anywhere")}>{r.label}</td>
              <td class={TD}>{why(r)}</td>
              <td class={TD}>{r.casesThisMonth}</td>
              <td class={cx(TD, "text-right")}>{manage && r.kind === "single" && <AddressRemove row={r} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul class="md:hidden flex flex-col">
        {rows.map((r) => (
          <li class="flex flex-col gap-8 p-16 border-t border-line">
            <span class="font-mono wrap-anywhere">{r.label}</span>
            <span class="type-small text-muted">{why(r)}</span>
            <span class="type-small text-muted">Cases this month: {r.casesThisMonth}</span>
            {manage && r.kind === "single" && (
              <span class="flex gap-8">
                <AddressRemove row={r} />
              </span>
            )}
          </li>
        ))}
      </ul>
      <p class="px-24 py-16 border-t border-line bg-subtle type-small text-muted">
        Mail from any other address never joins {possessive(orgName)} cases. It is handled as a public check, which only
        compares the mail with businesses registered as Protected.
      </p>
    </section>
  );
}

function AddressRemove(props: { row: AddressRow }) {
  return (
    <span class="inline-flex flex-wrap items-center gap-8">
      {props.row.state === "pending" && (
        <a
          href={`/settings/addresses/${encodeURIComponent(props.row.label)}`}
          class={buttonClass("ghost", "small")}
          aria-label={`Continue verifying ${props.row.label}`}
        >
          Continue
        </a>
      )}
      <a
        href={`/settings/addresses/remove/${encodeURIComponent(props.row.label)}`}
        class={buttonClass("danger", "small")}
        aria-label={`Remove ${props.row.label}`}
      >
        Remove
      </a>
    </span>
  );
}

function ForwardingHelp() {
  return (
    <section
      aria-labelledby="forwarding-heading"
      class="bg-surface border border-line rounded-card-large p-24 flex flex-col gap-16"
    >
      <div class="flex flex-col gap-4">
        <h2 id="forwarding-heading" class="type-h3">
          How to forward an email for checking
        </h2>
        <p class="type-small text-muted">
          Forward it as an attachment, so the original sender details come with it. A normal forward loses them.
        </p>
      </div>
      <ul class="grid gap-12 md:grid-cols-3">
        {HOW_TO.map(([title, steps]) => (
          <li class="flex flex-col gap-4 p-16 border border-line rounded-card bg-subtle">
            <span class="text-14 weight-heading">{title}</span>
            <span class="text-13 text-muted">{steps}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DomainsListPage(props: {
  shell: Omit<MemberShellProps, "children">;
  domains: DomainRow[];
  addresses: AddressRow[];
  manage: boolean;
  outcome: Outcome | null;
  // The add form as the member left it, after a refusal: the typed domain and why it was refused.
  add?: { value: string; error: string | null };
  // The same for the single-address form.
  addAddress?: { value: string; error: string | null };
}) {
  const { shell, domains, addresses, manage, outcome, add, addAddress } = props;
  const orgName = shell.organization.name;
  const said = outcome ? outcomeText(outcome) : null;
  const empty = domains.length === 0 && addresses.length === 0;
  return (
    <Document title="Domains and addresses">
      <AppShell {...shell}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <header class="flex flex-wrap items-start justify-between gap-16">
            <div class="flex flex-col gap-4 min-w-0">
              <h1 class="type-h1">Domains and addresses</h1>
              <p class="type-small text-muted wrap-anywhere">
                We accept mail at check@isitlegit.co.za only from addresses {orgName} has proved it owns.
              </p>
            </div>
            {manage && !empty && (
              <AddDomain
                orgId={shell.organization.id}
                value={add?.value ?? ""}
                error={add?.error ?? null}
                open={Boolean(add?.error || add?.value)}
              />
            )}
          </header>
          <p id="domains-outcome" role="status" class={cx("type-small", said ? "" : "sr-only")}>
            {said && (
              <span class={said.tone === "refused" ? "text-mal weight-text-strong" : "text-ink"}>{said.text}</span>
            )}
          </p>
          {empty ? (
            <section class="bg-surface border border-line rounded-card-large p-24 flex flex-col gap-16">
              <h2 class="type-h3">No mail is accepted yet</h2>
              <p class="text-muted">
                Add the domain your business mail comes from and prove you own it. Until then, mail forwarded to
                check@isitlegit.co.za is handled as a public check.
              </p>
              {manage ? (
                <div class="flex flex-col gap-16">
                  <AddDomain
                    orgId={shell.organization.id}
                    value={add?.value ?? ""}
                    error={add?.error ?? null}
                    open={!addAddress?.value && !addAddress?.error}
                  />
                  <AddAddress
                    orgId={shell.organization.id}
                    value={addAddress?.value ?? ""}
                    error={addAddress?.error ?? null}
                    open={Boolean(addAddress?.error || addAddress?.value)}
                  />
                </div>
              ) : (
                <p class="type-small text-muted">An owner or admin can add a domain or a single address.</p>
              )}
            </section>
          ) : (
            <>
              <DomainsTable rows={domains} manage={manage} />
              <AddressesTable
                rows={addresses}
                manage={manage}
                orgName={orgName}
                orgId={shell.organization.id}
                addAddress={addAddress}
              />
            </>
          )}
          <ForwardingHelp />
        </div>
      </AppShell>
    </Document>
  );
}

// The confirmation a removal asks first: what it really changes, then Remove and Cancel.
export function RemoveConfirm(props: {
  shell: Omit<MemberShellProps, "children">;
  kind: "domain" | "address";
  name: string;
  // The consequences in words, each true of this claim and this organisation.
  consequences: string[];
}) {
  const { shell, kind, name, consequences } = props;
  return (
    <Document title={`Remove a ${kind}`}>
      <AppShell {...shell}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40 max-w-[640px]">
          <h1 class="type-h1 wrap-anywhere">Remove {name}?</h1>
          <ul class="flex flex-col gap-8 text-16">
            {consequences.map((line) => (
              <li>{line}</li>
            ))}
          </ul>
          <form method="post" action="/settings/domains" class="flex flex-wrap gap-12" data-busy>
            <input type="hidden" name="action" value={kind === "domain" ? "remove-domain" : "remove-address"} />
            <input type="hidden" name="org" value={shell.organization.id} />
            <input type="hidden" name="target" value={name} />
            <Button type="submit" variant="danger" data-busy-label={`Removing ${name}`}>
              Remove {name}
            </Button>
            <Button variant="ghost" href="/settings/domains">
              Cancel
            </Button>
          </form>
        </div>
      </AppShell>
    </Document>
  );
}
