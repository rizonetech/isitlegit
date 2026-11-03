// The supplier ledger page's routes (D06 T01 §4): `GET /suppliers` draws the active organisation's ledger for any
// member (an owner or admin gets the forms; `?q=` searches, `?edit=` opens a supplier, `?change=` an account), `GET
// /suppliers/template.csv` gives the import template, and `POST /suppliers` runs one action named by its `action`
// field through the ledger's own functions (src/invoice/ledger.ts). The gate is the protected identity page's (./
// identity.tsx): the app's own origin, the active membership, an owner or admin to change anything, and a plan with
// `bank-change`, the check the ledger exists for. A refusal with typed values draws the page again with the refusal on
// its field; any other outcome is a 303 back with what happened in the address, signed for the organisation and ten
// minutes. An account number is read, handed to the ledger and dropped: no answer carries it.
import { Hono } from "hono";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { hasFeature } from "../../auth/plans";
import { ImportConflict, SupplierRefused } from "../../invoice/errors";
import {
  addSupplier,
  addSupplierAccount,
  type ImportResult,
  importSuppliers,
  type LedgerEntry,
  listSuppliers,
  removeSupplier,
  removeSupplierAccount,
  replaceSupplierAccount,
  siteOf,
  updateSupplier,
} from "../../invoice/ledger";
import { checkImport, IMPORT_TEMPLATE, MAX_IMPORT_BYTES } from "../../invoice/ledger-csv";
import { isConsumerMailbox } from "../../invoice/mailboxes";
import { bankKeys } from "../../trust/bank";
import { AccountRefused, BankKeysMissing, KeyMismatch } from "../../trust/errors";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import {
  type AccountValues,
  type EditValues,
  type FieldErrors,
  RESULTS,
  type Result,
  SuppliersPage,
  SuppliersPlanRefusal,
  SuppliersRoleRefusal,
  type SuppliersView,
  type SupplierValues,
  UNCERTAIN_WORDS,
} from "./suppliers-view";

export const supplierRoutes = new Hono<GateEnv>();

const PATH = "/suppliers";
// The largest honest body: an import at its limit plus the form's other parts.
const MAX_BODY = MAX_IMPORT_BYTES + 64 * 1024;

function outage(request: Request, why: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "suppliers-page", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: new URL(request.url).pathname });
}
const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });

// An action's result as the redirect carries it, an import's counts with it: signed with the auth secret over the
// organisation, the result, the counts and the moment, so the page shows only what an action of this organisation did
// here in the last ten minutes.
const RESULT_TTL_MS = 10 * 60_000;
const encoder = new TextEncoder();
async function sign(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`suppliers-result\n${text}`)));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
const signed = (orgId: string, r: string, n: string, at: number) => [orgId, r, n, String(at)].join("\n");
const countsText = (c: ImportResult) =>
  [c.suppliersAdded, c.suppliersUpdated, c.accountsAdded, c.alreadyThere].join(".");
async function back(secret: string, orgId: string, r: Result, counts?: ImportResult) {
  const at = Date.now();
  const n = counts ? countsText(counts) : "";
  const query = new URLSearchParams({
    r,
    ...(n ? { n } : {}),
    t: String(at),
    s: await sign(secret, signed(orgId, r, n, at)),
  });
  return new Response(null, { status: 303, headers: { ...HEADERS, location: `${PATH}?${query}` } });
}
async function resultOf(
  secret: string,
  orgId: string,
  url: URL,
): Promise<{ result: Result; counts: ImportResult | null } | null> {
  const q = url.searchParams;
  const r = q.get("r");
  const n = q.get("n") ?? "";
  const at = Number(q.get("t"));
  if (!r || !(RESULTS as readonly string[]).includes(r) || !Number.isFinite(at)) return null;
  if (Date.now() - at > RESULT_TTL_MS || at > Date.now() + 60_000) return null;
  if (q.get("s") !== (await sign(secret, signed(orgId, r, n, at)))) return null;
  const parts = n ? n.split(".").map(Number) : [];
  const counts =
    parts.length === 4 && parts.every((x) => Number.isInteger(x) && x >= 0)
      ? {
          suppliersAdded: parts[0] as number,
          suppliersUpdated: parts[1] as number,
          accountsAdded: parts[2] as number,
          alreadyThere: parts[3] as number,
        }
      : null;
  return { result: r as Result, counts };
}

type Org = { id: string; role: string };
type Gate = { refused: Response } | { org: Org; canEdit: boolean };

// The signed-in member of the active organisation whose plan includes the ledger's check, or the page that refuses
// them. A change also needs an owner or admin.
async function gate(env: Env, signedIn: SignedIn, request: Request, change: boolean): Promise<Gate> {
  const membership = await activeMembership(env, signedIn);
  if (!membership.ok)
    return membership.reason === "unavailable"
      ? { refused: outage(request, "membership") }
      : { refused: errorPage(403, "", { email: signedIn.user.email, closed: membership.reason === "closed" }) };
  const org = membership.org;
  const canEdit = ["owner", "admin"].includes(org.role);
  const refusal = async (draw: (shell: Awaited<ReturnType<typeof memberShell>>) => unknown, status: number) => {
    try {
      return { refused: html(draw(await memberShell(env.DB, signedIn.user, org.id, "suppliers")), status) };
    } catch (error) {
      return { refused: outage(request, (error as Error).name) };
    }
  };
  if (change && !canEdit)
    return refusal((shell) => <SuppliersRoleRefusal shell={shell} reference={reference(403)} now={new Date()} />, 403);
  let included: boolean;
  try {
    included = await hasFeature(env.DB, org.id, "bank-change");
  } catch (error) {
    return { refused: outage(request, (error as Error).name) };
  }
  if (!included)
    return refusal((shell) => <SuppliersPlanRefusal shell={shell} reference={reference(403)} now={new Date()} />, 403);
  return { org, canEdit };
}

// Everything the page draws, read fresh. A read that fails is an outage the caller answers, never a guessed page.
async function load(env: Env, signedIn: SignedIn, org: Org, canEdit: boolean, url: URL) {
  const [shell, suppliers, bankAvailable] = await Promise.all([
    memberShell(env.DB, signedIn.user, org.id, "suppliers"),
    listSuppliers(env.DB, org.id),
    bankKeys(env).then(
      () => true,
      (error) => {
        if (error instanceof BankKeysMissing) return false;
        throw error;
      },
    ),
  ]);
  const editId = url.searchParams.get("edit");
  const changeId = url.searchParams.get("change");
  const edit = editId ? (suppliers.find((s) => s.id === editId) ?? null) : null;
  let change: SuppliersView["change"] = null;
  if (changeId)
    for (const supplier of suppliers) {
      const account = supplier.accounts.find((a) => a.id === changeId);
      if (account) change = { supplier, account };
    }
  return {
    shell,
    canEdit,
    suppliers,
    bankAvailable,
    query: (url.searchParams.get("q") ?? "").slice(0, 120),
    edit,
    change,
  } satisfies SuppliersView;
}

supplierRoutes.get(
  PATH,
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await gate(c.env, signedIn, c.req.raw, false);
    if ("refused" in who) return who.refused;
    const url = new URL(c.req.url);
    try {
      const [base, done] = await Promise.all([
        load(c.env, signedIn, who.org, who.canEdit, url),
        resultOf(c.env.BETTER_AUTH_SECRET ?? "", who.org.id, url),
      ]);
      return html(<SuppliersPage {...base} result={done?.result ?? null} counts={done?.counts ?? null} />);
    } catch (error) {
      return outage(c.req.raw, (error as Error).name);
    }
  },
);

// The import template, to the organisation's members: the header and one fictional row.
supplierRoutes.get(
  `${PATH}/template.csv`,
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const who = await gate(c.env, c.get("signedIn"), c.req.raw, false);
    if ("refused" in who) return who.refused;
    return new Response(IMPORT_TEMPLATE, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="suppliers-template.csv"',
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  },
);

// The post's body, read with a running count so one without a Content-Length is bounded too; null is a body that is
// not a form, "big" one over the import's limit.
async function readForm(request: Request): Promise<FormData | "big" | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return "big";
  const chunks: Uint8Array[] = [];
  if (request.body) {
    const reader = request.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        return "big";
      }
      chunks.push(value);
    }
  }
  const type = request.headers.get("content-type") ?? "";
  try {
    return await new Response(new Blob(chunks), { headers: { "content-type": type } }).formData();
  } catch {
    return null;
  }
}

// The words for an account refusal on the field it is about.
function accountErrors(error: AccountRefused | KeyMismatch): FieldErrors {
  if (error instanceof KeyMismatch)
    return {
      general:
        "Bank accounts are being moved to a new key, so none can be saved right now. Try again in a few minutes.",
    };
  const reason = error.message;
  if (/already recorded/.test(reason)) return { number: "This account is already recorded for the supplier." };
  if (/7 to 11 digits/.test(reason)) return { number: "An account number is 7 to 11 digits." };
  if (/6 digits/.test(reason)) return { branchCode: "A branch code is 6 digits." };
  if (/no such account/.test(reason)) return { general: "That account was removed meanwhile. Nothing was changed." };
  return { general: "Fill in every account field." };
}
// The words for a supplier refusal on the field it is about.
function supplierErrors(reason: string, domainField: "domain" | "domains"): FieldErrors {
  if (/already in the ledger/.test(reason)) return { name: "A supplier of that name is already in the ledger." };
  if (/domain/.test(reason)) return { [domainField]: "Each domain needs to be a domain such as supplier.co.za." };
  if (/phone/.test(reason)) return { phone: "A phone number is 7 to 15 digits, with an optional leading +." };
  if (/name/.test(reason)) return { name: "A supplier needs a name of 1 to 120 characters." };
  return { general: "Check the supplier's details." };
}
const MAILBOX_WORDS = (domain: string) =>
  `${domain.slice(0, 60)} is a free mail service anyone can sign up to, not a supplier domain. Use the supplier's own domain.`;

supplierRoutes.post(
  PATH,
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    // Only the app's own pages post here: a form on another site changes nothing.
    if (c.req.header("origin") !== new URL(c.env.APP_URL).origin)
      return new Response("Forbidden", { status: 403, headers: HEADERS });
    const signedIn = c.get("signedIn");
    const who = await gate(c.env, signedIn, c.req.raw, true);
    if ("refused" in who) return who.refused;
    const { org } = who;
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    const to = (result: Result, counts?: ImportResult) => back(secret, org.id, result, counts);
    const actor = signedIn.user.id;
    const url = new URL(c.req.url);
    const form = await readForm(c.req.raw);
    // The page again, with what the refusal is about and what was typed (never an account number).
    const draw = async (extra: Partial<SuppliersView>, status: number) => {
      try {
        return html(<SuppliersPage {...(await load(c.env, signedIn, org, true, url))} {...extra} />, status);
      } catch (error) {
        return outage(c.req.raw, (error as Error).name);
      }
    };
    if (form === null) return new Response("Bad request", { status: 400, headers: HEADERS });
    if (form === "big")
      return draw(
        { importReport: { fileName: "", rows: 0, file: "the file is larger than 1 MiB", problems: [] } },
        413,
      );
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    // Drawn for another organisation than the active one (switched in another tab): nothing is done.
    if (field("org") !== org.id) return to("switched");
    const action = field("action");
    const unavailable = (error: unknown) => {
      console.log(
        JSON.stringify({ event: "suppliers-page", action, outcome: "unavailable", error: (error as Error).name }),
      );
    };
    const keysOr = async () => {
      try {
        return await bankKeys(c.env);
      } catch (error) {
        if (error instanceof BankKeysMissing) return null;
        throw error;
      }
    };
    let supplier: LedgerEntry | undefined;
    const findSupplier = async () => {
      supplier = (await listSuppliers(c.env.DB, org.id)).find((s) => s.id === field("supplierId"));
      return supplier;
    };
    try {
      if (action === "add") {
        const add: SupplierValues = {
          name: field("name").trim(),
          domain: field("domain").trim(),
          bank: field("bank").trim(),
          branchCode: field("branchCode").trim(),
          phone: field("phone").trim(),
        };
        const number = field("accountNumber");
        const withAccount = Boolean(add.bank || add.branchCode || number.trim());
        const errors: FieldErrors = {
          ...(add.name ? {} : { name: "Enter the supplier's name." }),
          ...(add.domain ? {} : { domain: "Enter the domain the supplier sends mail from." }),
          ...(withAccount && !add.bank ? { bank: "Enter the bank, or leave the bank details empty." } : {}),
          ...(withAccount && !add.branchCode
            ? { branchCode: "Enter the branch code, or leave the bank details empty." }
            : {}),
          ...(withAccount && !number.trim()
            ? { number: "Enter the account number, or leave the bank details empty." }
            : {}),
        };
        const site = add.domain ? siteOf(add.domain) : null;
        if (add.domain && !site) errors.domain = "Enter a domain such as supplier.co.za.";
        else if (site && isConsumerMailbox(site)) errors.domain = MAILBOX_WORDS(site);
        if (Object.keys(errors).length) return draw({ add, addErrors: errors }, 422);
        let account: { keys: Awaited<ReturnType<typeof bankKeys>>; input: unknown } | undefined;
        if (withAccount) {
          const keys = await keysOr();
          if (!keys)
            return draw(
              {
                add,
                addErrors: {
                  general:
                    "Bank accounts are unavailable just now. Add the supplier without its bank details, or try again later.",
                },
              },
              503,
            );
          account = { keys, input: { number, branchCode: add.branchCode, bankName: add.bank, holder: add.name } };
        }
        try {
          await addSupplier(
            c.env.DB,
            org.id,
            actor,
            { name: add.name, domains: [add.domain], phone: add.phone || null },
            new Date(),
            account,
          );
        } catch (error) {
          if (error instanceof SupplierRefused)
            return draw({ add, addErrors: supplierErrors(error.message, "domain") }, 422);
          if (error instanceof AccountRefused || error instanceof KeyMismatch)
            return draw({ add, addErrors: accountErrors(error) }, error instanceof KeyMismatch ? 409 : 422);
          unavailable(error);
          return draw({ add, addErrors: { general: UNCERTAIN_WORDS } }, 503);
        }
        return to("added");
      }
      if (action === "update") {
        if (!(await findSupplier()) || !supplier) return to("gone");
        const editValues: EditValues = {
          name: field("name").trim(),
          domains: field("domains"),
          phone: field("phone").trim(),
        };
        const domains = editValues.domains
          .split(/\r\n|\r|\n|,/)
          .map((d) => d.trim())
          .filter(Boolean);
        const mailbox = domains.map((d) => siteOf(d)).find((s) => s && isConsumerMailbox(s));
        if (!editValues.name)
          return draw({ edit: supplier, editValues, editErrors: { name: "Enter the supplier's name." } }, 422);
        // Only what the member changed from the form as drawn is saved, so another member's change to a field left
        // alone is kept (completion review); a form without its drawn values saves every field, as before.
        const drawn: EditValues | null =
          form.has("drawnName") && form.has("drawnDomains") && form.has("drawnPhone")
            ? { name: field("drawnName"), domains: field("drawnDomains"), phone: field("drawnPhone") }
            : null;
        const listOf = (text: string) =>
          text
            .split(/\r\n|\r|\n|,/)
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean)
            .join("\n");
        const patch: { name?: string; domains?: string[]; phone?: string | null } = {};
        if (!drawn || editValues.name !== drawn.name.trim()) patch.name = editValues.name;
        if (!drawn || listOf(editValues.domains) !== listOf(drawn.domains)) patch.domains = domains;
        if (!drawn || editValues.phone !== drawn.phone.trim()) patch.phone = editValues.phone || null;
        const again = { edit: supplier, editValues, ...(drawn ? { editDrawn: drawn } : {}) };
        if (mailbox) return draw({ ...again, editErrors: { domains: MAILBOX_WORDS(mailbox) } }, 422);
        if (Object.keys(patch).length === 0) return to("updated");
        try {
          await updateSupplier(c.env.DB, org.id, actor, supplier.id, patch);
        } catch (error) {
          if (error instanceof SupplierRefused) {
            if (/no such supplier/.test(error.message)) return to("gone");
            return draw({ ...again, editErrors: supplierErrors(error.message, "domains") }, 422);
          }
          unavailable(error);
          return draw({ ...again, editErrors: { general: UNCERTAIN_WORDS } }, 503);
        }
        return to("updated");
      }
      if (action === "remove") {
        if (!(await findSupplier()) || !supplier) return to("gone");
        return draw({ confirm: { supplier } }, 200);
      }
      if (action === "confirm-remove") {
        try {
          await removeSupplier(c.env.DB, org.id, actor, field("supplierId"));
        } catch (error) {
          if (error instanceof SupplierRefused) return to("gone");
          unavailable(error);
          return to("unavailable");
        }
        return to("removed");
      }
      if (action === "add-account") {
        if (!(await findSupplier()) || !supplier) return to("gone");
        const accountValues: AccountValues = { bank: field("bank").trim(), branchCode: field("branchCode").trim() };
        const number = field("accountNumber");
        const missing: FieldErrors = {
          ...(accountValues.bank ? {} : { bank: "Enter the bank." }),
          ...(accountValues.branchCode ? {} : { branchCode: "Enter the branch code." }),
          ...(number.trim() ? {} : { number: "Enter the account number." }),
        };
        if (Object.keys(missing).length) return draw({ edit: supplier, accountValues, accountErrors: missing }, 422);
        const keys = await keysOr();
        if (!keys) return draw({ edit: supplier, accountValues }, 503);
        try {
          await addSupplierAccount(c.env.DB, keys, org.id, actor, supplier.id, {
            number,
            branchCode: accountValues.branchCode,
            bankName: accountValues.bank,
            holder: supplier.name,
          });
        } catch (error) {
          if (error instanceof AccountRefused || error instanceof KeyMismatch)
            return draw(
              { edit: supplier, accountValues, accountErrors: accountErrors(error) },
              error instanceof KeyMismatch ? 409 : 422,
            );
          if (error instanceof SupplierRefused) return to("gone");
          unavailable(error);
          return draw({ edit: supplier, accountValues, accountErrors: { general: UNCERTAIN_WORDS } }, 503);
        }
        return to("account-added");
      }
      if (action === "remove-account") {
        if (!(await findSupplier()) || !supplier) return to("gone");
        const account = supplier.accounts.find((a) => a.id === field("accountId"));
        if (!account) return to("gone");
        return draw({ confirm: { supplier, account } }, 200);
      }
      if (action === "confirm-remove-account") {
        if (!(await findSupplier()) || !supplier?.accounts.some((a) => a.id === field("accountId"))) return to("gone");
        try {
          await removeSupplierAccount(c.env.DB, org.id, actor, field("accountId"));
        } catch (error) {
          if (error instanceof AccountRefused) return to("gone");
          unavailable(error);
          return to("unavailable");
        }
        return to("account-removed");
      }
      if (action === "change-account") {
        if (!(await findSupplier()) || !supplier) return to("gone");
        const account = supplier.accounts.find((a) => a.id === field("accountId"));
        if (!account) return to("gone");
        const changeValues: AccountValues = { bank: field("bank").trim(), branchCode: field("branchCode").trim() };
        const number = field("accountNumber");
        const change = { supplier, account };
        const missing: FieldErrors = {
          ...(changeValues.bank ? {} : { bank: "Enter the bank." }),
          ...(changeValues.branchCode ? {} : { branchCode: "Enter the branch code." }),
          ...(number.trim() ? {} : { number: "Enter the new account number." }),
          ...(field("confirm")
            ? {}
            : { confirm: `Tick this to remove the account ending ${account.last3} when the new one is saved.` }),
        };
        if (Object.keys(missing).length) return draw({ change, changeValues, changeErrors: missing }, 422);
        const keys = await keysOr();
        if (!keys)
          return draw(
            {
              change,
              changeValues,
              changeErrors: {
                general: "Bank accounts are unavailable just now, so nothing was changed. Try again later.",
              },
            },
            503,
          );
        try {
          await replaceSupplierAccount(c.env.DB, keys, org.id, actor, supplier.id, account.id, {
            number,
            branchCode: changeValues.branchCode,
            bankName: changeValues.bank,
            holder: supplier.name,
          });
        } catch (error) {
          if (error instanceof AccountRefused || error instanceof KeyMismatch)
            return draw(
              { change, changeValues, changeErrors: accountErrors(error) },
              error instanceof KeyMismatch ? 409 : 422,
            );
          unavailable(error);
          return draw({ change, changeValues, changeErrors: { general: UNCERTAIN_WORDS } }, 503);
        }
        return to("account-changed");
      }
      if (action === "import") {
        const file = form.get("file");
        const report = (fileName: string, rows: number, words: string) =>
          draw({ importReport: { fileName, rows, file: words, problems: [] } }, 422);
        if (!(file instanceof File) || file.size === 0) return report("", 0, "choose a CSV file first");
        const fileName = file.name.slice(0, 120);
        const text = new TextDecoder().decode(await file.arrayBuffer());
        const checked = checkImport(file.size, text, siteOf);
        if (!checked.ok) {
          const rows = Math.max(0, text.split(/\r\n|\r|\n/).filter((l) => l.trim()).length - 1);
          return draw({ importReport: { fileName, rows, file: checked.file, problems: checked.problems } }, 422);
        }
        // The header alone (the unchanged template) is a valid import of nothing: said so, nothing written.
        if (checked.rows.length === 0)
          return draw(
            {
              importReport: {
                fileName,
                rows: 0,
                file: "the file has no suppliers under its header, so nothing was imported; add one row per supplier",
                problems: [],
              },
            },
            200,
          );
        const keys = await keysOr();
        if (!keys)
          return report(
            fileName,
            checked.rows.length,
            "bank accounts are unavailable just now, so nothing was imported; try again later",
          );
        let counts: ImportResult;
        try {
          counts = await importSuppliers(c.env.DB, keys, org.id, actor, checked.rows);
        } catch (error) {
          if (error instanceof ImportConflict)
            return report(
              fileName,
              checked.rows.length,
              "the ledger changed while importing, so nothing was imported; import the file again",
            );
          if (error instanceof SupplierRefused)
            return report(fileName, checked.rows.length, `${error.message}, so nothing was imported`);
          if (error instanceof KeyMismatch)
            return report(
              fileName,
              checked.rows.length,
              "bank accounts are being moved to a new key, so nothing was imported; try again in a few minutes",
            );
          // The batch may have committed before the failure: the outcome is unknown, so the page asks for a read-back
          // and never says nothing was imported (completion review).
          unavailable(error);
          return draw(
            { importReport: { fileName, rows: checked.rows.length, file: null, problems: [], uncertain: true } },
            503,
          );
        }
        return to("imported", counts);
      }
      return to("unavailable");
    } catch (error) {
      unavailable(error);
      return to("unavailable");
    }
  },
);
