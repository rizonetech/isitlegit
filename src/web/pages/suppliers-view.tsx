// The supplier ledger page (D06 T01 §4; design/SPEC.md M4, board `Suppliers`): who the business really pays and how.
// Members read it; an owner or admin adds, edits, imports, changes an account and removes. Every part is drawn from
// what is stored, so a reload shows what an action did; what an action just did comes back in a signed address
// (./suppliers.tsx). Accounts show their last three digits only, with where each came from. The board's "Changed on
// invoice" status and its Undo toast belong to D06 T01 §6 (design/SPEC.md M4 deviations).
import { IMPORT_COLUMNS, IMPORT_EXAMPLE, MAX_IMPORT_ROWS, type RowProblem } from "../../invoice/import-format";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { Document } from "../components/Document";
import { Field, INLINE_INPUT } from "../components/Field";
import { Pill } from "../components/Pill";
import { EmptyState, ErrorState, referenceLine } from "../components/States";

type Shell = Omit<MemberShellProps, "children">;

// What the page reads of the ledger (src/invoice/ledger.ts `LedgerEntry` and `ImportResult` satisfy these), declared
// here so the view draws in Node too (the browser tests) without the Worker's types.
export type MaskedSupplierAccount = {
  id: string;
  bankName: string;
  branchCode: string;
  holder: string;
  last3: string;
  verifiedFromCaseId: string | null;
  source: "hand" | "csv" | "case";
  addedBy: string | null;
  addedAt: string;
};
export type LedgerEntry = {
  id: string;
  name: string;
  domains: string[];
  phone: string | null;
  accounts: MaskedSupplierAccount[];
};
export type ImportResult = {
  suppliersAdded: number;
  suppliersUpdated: number;
  accountsAdded: number;
  alreadyThere: number;
};

export const RESULTS = [
  "added",
  "updated",
  "removed",
  "account-added",
  "account-changed",
  "account-removed",
  "imported",
  "gone",
  "unavailable",
  "switched",
] as const;
export type Result = (typeof RESULTS)[number];

// What a refused form sent back, drawn again (never an account number), and the refusal on each field.
export type SupplierValues = { name: string; domain: string; bank: string; branchCode: string; phone: string };
export type EditValues = { name: string; domains: string; phone: string };
export type AccountValues = { bank: string; branchCode: string };
export type FieldErrors = Partial<
  Record<"name" | "domain" | "domains" | "bank" | "branchCode" | "number" | "phone" | "confirm" | "general", string>
>;
// What an import's refusal says: a file problem or the rows' problems, nothing written; or, `uncertain`, a failure
// whose outcome is not known (the batch may have committed before it), which asks for a read-back, never a fix.
export type ImportReport = {
  fileName: string;
  rows: number;
  file: string | null;
  problems: RowProblem[];
  uncertain?: boolean;
};

export type SuppliersView = {
  shell: Shell;
  canEdit: boolean;
  suppliers: LedgerEntry[];
  query: string;
  bankAvailable: boolean;
  // The supplier being edited, or the account being changed (from the address, `?edit=` or `?change=`).
  edit?: LedgerEntry | null;
  change?: { supplier: LedgerEntry; account: MaskedSupplierAccount } | null;
  confirm?: { supplier: LedgerEntry; account?: MaskedSupplierAccount } | null;
  add?: SupplierValues;
  addErrors?: FieldErrors;
  editValues?: EditValues;
  // The supplier's details as the edit form was first drawn, carried back so only the fields a member changed are
  // saved, and another member's edit to a field left alone is kept (completion review).
  editDrawn?: EditValues;
  editErrors?: FieldErrors;
  accountValues?: AccountValues;
  accountErrors?: FieldErrors;
  changeValues?: AccountValues;
  changeErrors?: FieldErrors;
  importReport?: ImportReport;
  result?: Result | null;
  counts?: ImportResult | null;
};

export const UNCERTAIN_WORDS =
  "We could not confirm that your change was saved. Reload the page to see what is stored, then try again if needed.";

const LINK = cx("text-orange-text underline underline-offset-4", FOCUS);
const CARD = "flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large min-w-0";
const when = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const PATH = "/suppliers";

// A notice takes focus when the page opens (the app script, `data-announce`), so what happened is read out.
function Notice(props: { tone: "info" | "error"; id?: string; announce?: boolean; children: unknown }) {
  const announce = props.announce ?? props.tone === "error";
  return (
    <p
      id={props.id}
      role={props.tone === "error" ? "alert" : "status"}
      {...(announce ? { tabindex: -1, "data-announce": "" } : {})}
      class={cx("type-small wrap-anywhere", props.tone === "error" ? "text-mal weight-text-strong" : "text-ink")}
    >
      {props.children as never}
    </p>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function resultWords(
  result: Result,
  counts: ImportResult | null | undefined,
): { tone: "info" | "error"; words: string } {
  switch (result) {
    case "added":
      return { tone: "info", words: "The supplier is added." };
    case "updated":
      return { tone: "info", words: "The supplier is saved." };
    case "removed":
      return { tone: "info", words: "The supplier and its accounts are removed, and the removal is logged." };
    case "account-added":
      return { tone: "info", words: "The account is added." };
    case "account-changed":
      return {
        tone: "info",
        words: "The account is changed: the new one is saved and the old one removed, both logged.",
      };
    case "account-removed":
      return { tone: "info", words: "The account is removed, and the removal is logged." };
    case "imported": {
      const c = counts ?? { suppliersAdded: 0, suppliersUpdated: 0, accountsAdded: 0, alreadyThere: 0 };
      const parts = [
        count(c.suppliersAdded, "supplier added", "suppliers added"),
        count(c.suppliersUpdated, "supplier updated", "suppliers updated"),
        count(c.accountsAdded, "account added", "accounts added"),
      ];
      const there = c.alreadyThere
        ? ` ${count(c.alreadyThere, "account was", "accounts were")} already in the ledger.`
        : "";
      return { tone: "info", words: `The file is imported: ${parts.join(", ")}.${there}` };
    }
    case "gone":
      return { tone: "info", words: "That was already removed. Nothing else changed." };
    case "unavailable":
      return { tone: "error", words: UNCERTAIN_WORDS };
    case "switched":
      return { tone: "info", words: "" };
  }
}

// Where an account came from, who recorded it and when (D06 T01 §4, corrections 4 and 12).
function Provenance(props: { account: MaskedSupplierAccount }) {
  const a = props.account;
  const who = a.addedBy ?? "a former member";
  const at = when.format(Date.parse(a.addedAt));
  if (a.source === "csv")
    return (
      <span>
        Imported from CSV by {who}, {at}
      </span>
    );
  if (a.source === "case")
    return a.verifiedFromCaseId ? (
      <span>
        Verified from{" "}
        <a href={`/cases/${encodeURIComponent(a.verifiedFromCaseId)}`} class={LINK}>
          case
        </a>{" "}
        by {who}, {at}
      </span>
    ) : (
      <span>
        Verified from a case no longer available, by {who}, {at}
      </span>
    );
  return (
    <span>
      Added by hand by {who}, {at}
    </span>
  );
}

const latest = (s: LedgerEntry) => s.accounts[s.accounts.length - 1] ?? null;

function Status(props: { supplier: LedgerEntry }) {
  const last = latest(props.supplier);
  return last ? (
    <div class="flex flex-col items-start gap-4">
      <Pill variant="safe">Verified</Pill>
      <span class="type-tiny text-muted wrap-anywhere">
        <Provenance account={last} />
      </span>
    </div>
  ) : (
    <div class="flex flex-col items-start gap-4">
      <Pill variant="neutral">No account yet</Pill>
      <span class="type-tiny text-muted">Invoices cannot be checked against an account.</span>
    </div>
  );
}

function AccountLine(props: { view: SuppliersView; supplier: LedgerEntry; account: MaskedSupplierAccount }) {
  const { view, supplier, account } = props;
  return (
    <span class="inline-flex flex-wrap items-center gap-8">
      <span class="wrap-anywhere">{account.bankName}</span>
      <span class="font-mono">•••• {account.last3}</span>
      {view.canEdit && view.bankAvailable && (
        <a
          href={`${PATH}?change=${encodeURIComponent(account.id)}`}
          class={cx(LINK, "type-tiny")}
          aria-label={`Change the ${account.bankName} account ending ${account.last3} for ${supplier.name}`}
        >
          Change
        </a>
      )}
    </span>
  );
}

function EditLink(props: { supplier: LedgerEntry }) {
  return (
    <Button
      variant="ghost"
      size="small"
      href={`${PATH}?edit=${encodeURIComponent(props.supplier.id)}`}
      aria-label={`Edit ${props.supplier.name}`}
    >
      Edit
    </Button>
  );
}

function Table(props: { view: SuppliersView; shown: LedgerEntry[] }) {
  const { view, shown } = props;
  const verified = view.suppliers.filter((s) => s.accounts.length > 0).length;
  const caption = `Suppliers (${view.suppliers.length}, ${verified} verified)`;
  // One row per supplier at every width, so `/suppliers#<id>` lands on an element that is shown and focusable whether
  // or not the script runs (D06 T01 §6's report links): on a narrow screen the table lays out as a stack of cards, each
  // row showing only its card cell; from `md` it is the table, the card cell hidden. Two copies of each row, one hidden
  // by width, left the address's target hidden on one screen, and Chrome clears the focus for a target it cannot focus
  // (main run 41249601967).
  const cell = "hidden md:table-cell px-16 py-12";
  return (
    <table class="block md:table w-full text-left border-collapse md:border md:border-line md:bg-surface">
      <caption class="sr-only">{caption}</caption>
      <thead class="hidden md:table-header-group">
        <tr class="bg-subtle">
          <th scope="col" class="px-16 py-12 type-small weight-text-strong">
            Supplier{" "}
            <span class="weight-text text-muted">
              ({view.suppliers.length}, {verified} verified)
            </span>
          </th>
          <th scope="col" class="px-16 py-12 type-small weight-text-strong">
            Domain
          </th>
          <th scope="col" class="px-16 py-12 type-small weight-text-strong">
            Bank account
          </th>
          <th scope="col" class="px-16 py-12 type-small weight-text-strong">
            Phone
          </th>
          <th scope="col" class="px-16 py-12 type-small weight-text-strong">
            Status
          </th>
          <th scope="col" class="px-16 py-12">
            <span class="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody class="flex flex-col gap-12 md:table-row-group">
        {shown.map((s) => (
          <tr
            id={s.id}
            data-anchor-row={s.id}
            tabindex={-1}
            class={cx(
              "block md:table-row align-top border border-line rounded-card bg-surface md:border-0 md:border-t md:rounded-none md:bg-transparent",
              "[content-visibility:auto] [contain-intrinsic-size:auto_160px] md:[content-visibility:visible]",
              FOCUS,
            )}
          >
            <td class="flex flex-col gap-8 p-16 md:hidden">
              <p class="weight-text-strong wrap-anywhere">{s.name}</p>
              <p class="font-mono text-14 wrap-anywhere">{s.domains.join(", ") || "No domain"}</p>
              {s.accounts.map((a) => (
                <p class="text-14">
                  <AccountLine view={view} supplier={s} account={a} />
                </p>
              ))}
              {s.phone && <p class="text-14">{s.phone}</p>}
              <Status supplier={s} />
              {view.canEdit && <EditLink supplier={s} />}
            </td>
            <th scope="row" class={cx(cell, "weight-text-strong wrap-anywhere text-left")}>
              {s.name}
            </th>
            <td class={cx(cell, "font-mono text-14 wrap-anywhere")}>{s.domains.join(", ") || "None"}</td>
            <td class={cx(cell, "text-14")}>
              {s.accounts.length ? (
                <ul class="flex flex-col gap-4">
                  {s.accounts.map((a) => (
                    <li>
                      <AccountLine view={view} supplier={s} account={a} />
                    </li>
                  ))}
                </ul>
              ) : (
                <span class="text-muted">None</span>
              )}
            </td>
            <td class={cx(cell, "text-14 wrap-anywhere")}>{s.phone ?? <span class="text-muted">None</span>}</td>
            <td class={cell}>
              <Status supplier={s} />
            </td>
            <td class={cell}>{view.canEdit && <EditLink supplier={s} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Hidden(props: { view: SuppliersView; action: string; extra?: Record<string, string> }) {
  return (
    <>
      <input type="hidden" name="org" value={props.view.shell.organization.id} />
      <input type="hidden" name="action" value={props.action} />
      {Object.entries(props.extra ?? {}).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

const NUMBER_HINT = "7 to 11 digits. Only its last three digits are ever shown.";

function AddCard(props: { view: SuppliersView }) {
  const { view } = props;
  const v = view.add ?? { name: "", domain: "", bank: "", branchCode: "", phone: "" };
  const e = view.addErrors ?? {};
  return (
    <section id="add-supplier" aria-labelledby="add-heading" class={CARD} tabindex={-1}>
      <h2 id="add-heading" class="type-h3">
        Add supplier
      </h2>
      <form
        method="post"
        class="flex flex-col gap-16"
        data-busy
        data-unsaved-guard="the new supplier"
        {...(view.add ? { "data-unsaved-retained": "" } : {})}
      >
        <Hidden view={view} action="add" />
        <div class="grid gap-16 md:grid-cols-2">
          <Field
            id="add-name"
            name="name"
            label="Name"
            value={v.name}
            maxlength={120}
            required
            {...(e.name ? { error: e.name } : {})}
          />
          <Field
            id="add-domain"
            name="domain"
            label="Email domain"
            value={v.domain}
            placeholder="supplier.co.za"
            autocomplete="off"
            maxlength={253}
            required
            {...(e.domain ? { error: e.domain } : {})}
          />
          <Field
            id="add-bank"
            name="bank"
            label="Bank"
            value={v.bank}
            maxlength={120}
            {...(e.bank ? { error: e.bank } : {})}
          />
          <Field
            id="add-branch"
            name="branchCode"
            label="Branch code"
            value={v.branchCode}
            inputmode="numeric"
            autocomplete="off"
            maxlength={12}
            {...(e.branchCode ? { error: e.branchCode } : {})}
          />
          <Field
            id="add-number"
            name="accountNumber"
            label="Account number"
            hint={NUMBER_HINT}
            inputmode="numeric"
            autocomplete="off"
            maxlength={24}
            {...(e.number ? { error: e.number } : {})}
          />
          <Field
            id="add-phone"
            name="phone"
            type="tel"
            label="Phone number you already trust"
            value={v.phone}
            hint="From your own records, never from an invoice. This is the number we tell you to call."
            maxlength={30}
            {...(e.phone ? { error: e.phone } : {})}
          />
        </div>
        <p class="text-13 text-muted">
          The bank details are optional; give all of them or none. Without an account, invoices from this supplier
          cannot be checked against one.
        </p>
        {e.general && <Notice tone="error">{e.general}</Notice>}
        <div class="flex flex-wrap gap-12">
          <Button type="submit" variant="dark" data-busy-label="Saving">
            Save supplier
          </Button>
          <Button variant="ghost" href={PATH} data-discard="">
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}

function ImportCard(props: { view: SuppliersView }) {
  const { view } = props;
  const report = view.importReport;
  return (
    <section id="import" aria-labelledby="import-heading" class={CARD} tabindex={-1}>
      <div class="flex flex-wrap items-center justify-between gap-12">
        <h2 id="import-heading" class="type-h3">
          Import CSV
        </h2>
        {report &&
          (report.uncertain ? (
            <Pill variant="suspicious">Outcome unknown</Pill>
          ) : (
            <Pill variant="malicious">Nothing imported</Pill>
          ))}
      </div>
      {report && (
        <div class="flex flex-col gap-12" role="alert" tabindex={-1} data-announce="">
          <p class="type-small wrap-anywhere">
            {report.fileName
              ? `${report.fileName}${report.rows ? ` · ${count(report.rows, "row", "rows")}` : ""}. `
              : ""}
            {report.uncertain
              ? "We could not confirm whether this file was imported. Reload the page and check the ledger before importing it again; importing a file twice adds nothing twice."
              : `We import a file only when every row is valid, so fix ${report.problems.length === 1 || report.file ? "this" : "these"} and upload again.`}
          </p>
          {report.file ? (
            <p class="type-small text-mal weight-text-strong wrap-anywhere">
              {report.file.charAt(0).toUpperCase() + report.file.slice(1)}.
            </p>
          ) : (
            <table class="w-full text-left border-collapse border border-line">
              <caption class="sr-only">Rows to fix</caption>
              <thead>
                <tr class="bg-subtle">
                  <th scope="col" class="px-16 py-12 type-small weight-text-strong">
                    Row
                  </th>
                  <th scope="col" class="px-16 py-12 type-small weight-text-strong">
                    Problem
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.problems.map((p) => (
                  <tr class="border-t border-line align-top">
                    <td class="px-16 py-12 font-mono text-14">{p.row}</td>
                    <td class="px-16 py-12 text-14 wrap-anywhere">{p.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <form method="post" enctype="multipart/form-data" class="flex flex-col gap-12" data-busy>
        <Hidden view={view} action="import" />
        <div class="flex flex-col gap-8">
          <label for="import-file" class="text-14 weight-text-strong">
            CSV file
          </label>
          <input
            id="import-file"
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            class={cx("text-14 max-w-full", FOCUS)}
            aria-describedby="import-help"
          />
        </div>
        <Button type="submit" variant="ghost" size="small" class="self-start" data-busy-label="Importing">
          Import file
        </Button>
      </form>
      <p id="import-help" class="type-tiny text-muted">
        Up to 1 MiB and {MAX_IMPORT_ROWS.toString().replace(/\B(?=(\d{3})+$)/g, ",")} suppliers. Row 1 is the first
        supplier under the header. Columns: <code class="font-mono wrap-anywhere">{IMPORT_COLUMNS.join(",")}</code>. A
        row looks like <code class="font-mono wrap-anywhere">{IMPORT_EXAMPLE}</code>.{" "}
        <a href={`${PATH}/template.csv`} class={LINK} download>
          Download a template
        </a>
      </p>
    </section>
  );
}

function EditCard(props: { view: SuppliersView; supplier: LedgerEntry }) {
  const { view, supplier } = props;
  const drawn: EditValues = { name: supplier.name, domains: supplier.domains.join("\n"), phone: supplier.phone ?? "" };
  const v = view.editValues ?? drawn;
  const e = view.editErrors ?? {};
  const av = view.accountValues ?? { bank: "", branchCode: "" };
  const ae = view.accountErrors ?? {};
  return (
    <section id="edit" aria-labelledby="edit-heading" class={CARD}>
      <h2 id="edit-heading" class="type-h3 wrap-anywhere" tabindex={-1} data-announce="">
        Edit {supplier.name}
      </h2>
      <form
        method="post"
        class="flex flex-col gap-16"
        data-busy
        data-unsaved-guard="the supplier's details"
        {...(view.editValues ? { "data-unsaved-retained": "" } : {})}
      >
        <Hidden
          view={view}
          action="update"
          extra={{
            supplierId: supplier.id,
            drawnName: (view.editDrawn ?? drawn).name,
            drawnDomains: (view.editDrawn ?? drawn).domains,
            drawnPhone: (view.editDrawn ?? drawn).phone,
          }}
        />
        <div class="grid gap-16 md:grid-cols-2">
          <Field
            id="edit-name"
            name="name"
            label="Name"
            value={v.name}
            maxlength={120}
            required
            {...(e.name ? { error: e.name } : {})}
          />
          <Field
            id="edit-phone"
            name="phone"
            type="tel"
            label="Phone number you already trust"
            value={v.phone}
            maxlength={30}
            {...(e.phone ? { error: e.phone } : {})}
          />
        </div>
        <Field
          id="edit-domains"
          name="domains"
          label="Email domains"
          value={v.domains}
          hint="One per line."
          rows={3}
          maxlength={6000}
          autocomplete="off"
          {...(e.domains ? { error: e.domains } : {})}
        />
        {e.general && <Notice tone="error">{e.general}</Notice>}
        <div class="flex flex-wrap gap-12">
          <Button type="submit" variant="dark" data-busy-label="Saving">
            Save changes
          </Button>
          <Button variant="ghost" href={PATH} data-discard="">
            Cancel
          </Button>
        </div>
      </form>
      <div class="flex flex-col gap-12">
        <h3 class="type-h4">Accounts</h3>
        {supplier.accounts.length === 0 ? (
          <p class="text-muted">No account yet.</p>
        ) : (
          <ul class="flex flex-col gap-8">
            {supplier.accounts.map((a) => (
              <li class="flex flex-wrap items-center justify-between gap-12 px-16 py-12 rounded-card bg-subtle">
                <span class="text-14">
                  <AccountLine view={view} supplier={supplier} account={a} />
                  <span class="block type-tiny text-muted">
                    <Provenance account={a} />
                  </span>
                </span>
                <form method="post" data-busy>
                  <Hidden view={view} action="remove-account" extra={{ supplierId: supplier.id, accountId: a.id }} />
                  <Button
                    type="submit"
                    variant="danger"
                    size="small"
                    aria-label={`Remove the ${a.bankName} account ending ${a.last3}`}
                    data-busy-label="Opening"
                  >
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {view.bankAvailable ? (
          <form
            method="post"
            class="flex flex-col gap-16"
            aria-label={`Add an account for ${supplier.name}`}
            data-busy
            data-unsaved-guard="the new account"
            {...(view.accountValues ? { "data-unsaved-retained": "" } : {})}
          >
            <Hidden view={view} action="add-account" extra={{ supplierId: supplier.id }} />
            <div class="grid gap-16 md:grid-cols-3">
              <Field
                id="account-bank"
                name="bank"
                label="Bank"
                value={av.bank}
                maxlength={120}
                required
                {...(ae.bank ? { error: ae.bank } : {})}
              />
              <Field
                id="account-branch"
                name="branchCode"
                label="Branch code"
                value={av.branchCode}
                inputmode="numeric"
                autocomplete="off"
                maxlength={12}
                required
                {...(ae.branchCode ? { error: ae.branchCode } : {})}
              />
              <Field
                id="account-number"
                name="accountNumber"
                label="Account number"
                hint={NUMBER_HINT}
                inputmode="numeric"
                autocomplete="off"
                maxlength={24}
                required
                {...(ae.number ? { error: ae.number } : {})}
              />
            </div>
            {ae.general && <Notice tone="error">{ae.general}</Notice>}
            <Button type="submit" variant="ghost" size="small" class="self-start" data-busy-label="Adding">
              Add account
            </Button>
          </form>
        ) : (
          <Notice tone="info">
            Bank accounts are unavailable just now, so none can be added or changed. The rest of this page still works.
          </Notice>
        )}
      </div>
      <form method="post" data-busy>
        <Hidden view={view} action="remove" extra={{ supplierId: supplier.id }} />
        <Button type="submit" variant="danger" size="small" data-busy-label="Opening">
          Remove supplier
        </Button>
      </form>
    </section>
  );
}

function ChangeCard(props: { view: SuppliersView; supplier: LedgerEntry; account: MaskedSupplierAccount }) {
  const { view, supplier, account } = props;
  const v = view.changeValues ?? { bank: account.bankName, branchCode: account.branchCode };
  const e = view.changeErrors ?? {};
  return (
    <section id="change" aria-labelledby="change-heading" class={CARD}>
      <h2 id="change-heading" class="type-h3 wrap-anywhere" tabindex={-1} data-announce="">
        Change {supplier.name}'s account ending {account.last3}
      </h2>
      <p class="text-muted wrap-anywhere">
        Use this when {supplier.name} has really changed banks. Confirm it on the number in your records first, never
        one from an invoice.
      </p>
      <form
        method="post"
        class="flex flex-col gap-16"
        data-busy
        data-unsaved-guard="the new account"
        {...(view.changeValues ? { "data-unsaved-retained": "" } : {})}
      >
        <Hidden view={view} action="change-account" extra={{ supplierId: supplier.id, accountId: account.id }} />
        <div class="grid gap-16 md:grid-cols-3">
          <Field
            id="change-bank"
            name="bank"
            label="Bank"
            value={v.bank}
            maxlength={120}
            required
            {...(e.bank ? { error: e.bank } : {})}
          />
          <Field
            id="change-branch"
            name="branchCode"
            label="Branch code"
            value={v.branchCode}
            inputmode="numeric"
            autocomplete="off"
            maxlength={12}
            required
            {...(e.branchCode ? { error: e.branchCode } : {})}
          />
          <Field
            id="change-number"
            name="accountNumber"
            label="New account number"
            hint={NUMBER_HINT}
            inputmode="numeric"
            autocomplete="off"
            maxlength={24}
            required
            {...(e.number ? { error: e.number } : {})}
          />
        </div>
        <Checkbox name="confirm" required {...(e.confirm ? { "aria-describedby": "change-confirm-error" } : {})}>
          Remove the {account.bankName} account ending {account.last3} when the new one is saved
        </Checkbox>
        {e.confirm && (
          <Notice tone="error" id="change-confirm-error">
            {e.confirm}
          </Notice>
        )}
        {e.general && <Notice tone="error">{e.general}</Notice>}
        <div class="flex flex-wrap gap-12">
          <Button type="submit" variant="dark" data-busy-label="Changing">
            Save new account
          </Button>
          <Button variant="ghost" href={PATH} data-discard="">
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}

function ConfirmRemoval(props: {
  view: SuppliersView;
  supplier: LedgerEntry;
  account?: MaskedSupplierAccount | undefined;
}) {
  const { view, supplier, account } = props;
  return (
    <section aria-labelledby="confirm-heading" class={cx(CARD, "border-mal")}>
      <h2 id="confirm-heading" class="type-h3 wrap-anywhere" tabindex={-1} data-announce="">
        {account ? `Remove ${supplier.name}'s account ending ${account.last3}?` : `Remove ${supplier.name}?`}
      </h2>
      <p class="text-muted wrap-anywhere">
        {account
          ? `${account.bankName} · ${account.branchCode}. Once it is removed, an invoice with this account no longer matches ${supplier.name}. The removal is logged.`
          : `${supplier.name} and ${count(supplier.accounts.length, "account", "accounts")} leave the ledger, so its invoices are no longer checked against them. The removal is logged.`}
      </p>
      <div class="flex flex-wrap items-center gap-12">
        <form method="post" data-busy>
          <Hidden
            view={view}
            action={account ? "confirm-remove-account" : "confirm-remove"}
            extra={account ? { supplierId: supplier.id, accountId: account.id } : { supplierId: supplier.id }}
          />
          <Button type="submit" variant="danger" data-busy-label="Removing">
            Confirm removal
          </Button>
        </form>
        <Button variant="ghost" href={PATH} data-discard="">
          Cancel
        </Button>
      </div>
    </section>
  );
}

// The suppliers a search shows: a name or domain holding the words, or an account ending in the digits typed.
export function matching(suppliers: LedgerEntry[], query: string): LedgerEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return suppliers;
  const digits = q.replace(/[\s•*]/g, "");
  return suppliers.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.domains.some((d) => d.includes(q)) ||
      (/^\d{1,3}$/.test(digits) && s.accounts.some((a) => a.last3.endsWith(digits))),
  );
}

export function SuppliersPage(props: SuppliersView) {
  const view = props;
  const org = view.shell.organization.name;
  const shown = matching(view.suppliers, view.query);
  const result = view.result && view.result !== "switched" ? resultWords(view.result, view.counts) : null;
  return (
    <Document title="Suppliers">
      <AppShell {...view.shell}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40" data-announce-scope>
          <header class="flex flex-col gap-16 lg:flex-row lg:items-start lg:justify-between">
            <div class="flex flex-col gap-8 min-w-0">
              <h1 class="type-h1">Suppliers</h1>
              <p class="text-muted wrap-anywhere">
                Who {org} really pays, and how. Every invoice is checked against it.
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-12">
              <search class="w-full md:w-auto">
                <form method="get" action={PATH} class="flex w-full items-center gap-8 md:w-auto">
                  <label for="supplier-search" class="sr-only">
                    Search suppliers
                  </label>
                  <input
                    id="supplier-search"
                    type="search"
                    name="q"
                    value={view.query}
                    placeholder="Search name, domain or last 3 digits"
                    maxlength={120}
                    class={cx(INLINE_INPUT, "w-full min-w-0 placeholder:text-muted")}
                  />
                  <Button type="submit" variant="ghost" size="small">
                    Search
                  </Button>
                </form>
              </search>
              {view.canEdit && (
                <>
                  <Button variant="ghost" href="#import">
                    Import CSV
                  </Button>
                  <Button variant="primary" href="#add-supplier">
                    Add supplier
                  </Button>
                </>
              )}
            </div>
          </header>
          {view.result === "switched" ? (
            <Notice tone="info" announce>
              Your organisation changed in another tab, so nothing was done. This page is now for {org}.
            </Notice>
          ) : (
            result && (
              <Notice tone={result.tone} announce>
                {result.words}
              </Notice>
            )
          )}
          {view.confirm && view.canEdit && (
            <ConfirmRemoval view={view} supplier={view.confirm.supplier} account={view.confirm.account} />
          )}
          {view.change && view.canEdit && (
            <ChangeCard view={view} supplier={view.change.supplier} account={view.change.account} />
          )}
          {view.edit && view.canEdit && <EditCard view={view} supplier={view.edit} />}
          {view.suppliers.length === 0 ? (
            <EmptyState
              layout="first-run"
              eyebrow="Supplier ledger"
              title="No suppliers yet"
              sentence={
                view.canEdit
                  ? "Add the suppliers you pay, with the account each is paid into, or import them from a CSV. Every invoice is then checked against them."
                  : "An owner or admin adds the suppliers you pay. Every invoice is then checked against them."
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState
              layout="filtered"
              title="No supplier matches"
              sentence={`Nothing in the ledger matches "${view.query.slice(0, 60)}". Search by name, domain or an account's last three digits.`}
              action={
                <Button variant="ghost" href={PATH}>
                  Show all suppliers
                </Button>
              }
            />
          ) : (
            <Table view={view} shown={shown} />
          )}
          {view.canEdit && (
            <div class="grid gap-24 lg:grid-cols-2 items-start">
              <AddCard view={view} />
              <ImportCard view={view} />
            </div>
          )}
          <p class="type-tiny text-muted">Members can view this page; owners and admins can change it.</p>
        </div>
      </AppShell>
    </Document>
  );
}

// The organisation's plan does not include invoice checks against a ledger (free or lapsed trial).
export function SuppliersPlanRefusal(props: { shell: Shell; reference: string; now: Date }) {
  return (
    <Document title="Suppliers">
      <AppShell {...props.shell}>
        <div class="px-16 py-24 md:px-56 md:py-40">
          <ErrorState
            code={403}
            title="The supplier ledger is part of the Protect plan."
            actions={[
              <Button variant="dark" href="/settings/plan?from=/suppliers">
                See plans
              </Button>,
              <Button variant="ghost" href="/cases">
                Go to your cases
              </Button>,
            ]}
            footer={referenceLine(props.reference, props.now)}
          >
            {props.shell.organization.name} is on a plan without invoice checks against your suppliers, so nothing here
            can be seen or changed. Your checks and cases are not affected.
          </ErrorState>
        </div>
      </AppShell>
    </Document>
  );
}

// A member who is not an owner or admin tries to change the ledger.
export function SuppliersRoleRefusal(props: { shell: Shell; reference: string; now: Date }) {
  return (
    <Document title="No access">
      <AppShell {...props.shell}>
        <div class="px-16 py-24 md:px-56 md:py-40">
          <ErrorState
            code={403}
            title="Only an owner or admin changes your suppliers."
            actions={[
              <Button variant="dark" href={PATH}>
                View the page
              </Button>,
            ]}
            footer={referenceLine(props.reference, props.now)}
          >
            Members can view this page. Ask an owner or admin of {props.shell.organization.name} to make the change.
          </ErrorState>
        </div>
      </AppShell>
    </Document>
  );
}
