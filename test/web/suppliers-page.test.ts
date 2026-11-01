import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlan } from "../../src/auth/plans";
import { createCase } from "../../src/db/cases";
import { addSupplier, addSupplierAccount, listSuppliers } from "../../src/invoice/ledger";
import { bankKeys } from "../../src/trust/bank";
import { authEnv, call, signIn, target } from "../auth/helpers";
import { makeOrg } from "../trust/helpers";

// The supplier ledger page (D06 T01 §4): an owner or admin adds, edits, searches, imports, changes an account and
// removes through the page's own forms, each change read back on a fresh GET; a member reads it with no forms; and every
// refusal (a member, a foreign site, a form drawn for another organisation, another organisation's supplier, no
// session, a plan without the check, a bad file) changes nothing and says so in plain words, never echoing an account
// number.
const db = env.DB;
const NUMBER = "62004417731";

afterEach(() => {
  vi.restoreAllMocks();
});

let n = 0;
const tag = () => `${++n}${crypto.randomUUID().slice(0, 6)}`;
const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id;
async function person(orgId: string, role = "owner", name?: string) {
  const email = `sup-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  vi.restoreAllMocks();
  const id = await userId(email);
  if (name) await db.prepare(`UPDATE "user" SET name = ? WHERE id = ?`).bind(name, id).run();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, id, role, new Date().toISOString())
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, id).run();
  return { cookie, email, id: id as string };
}

const HTML = { accept: "text/html" };
const get = (cookie: string | undefined, path = "/suppliers") =>
  call(path, { headers: { ...HTML, ...(cookie ? { cookie } : {}) } }, authEnv);
type Fields = Record<string, string | File>;
async function post(cookie: string | undefined, fields: Fields, origin = new URL(authEnv.APP_URL).origin) {
  const multipart = Object.values(fields).some((v) => typeof v !== "string");
  const headers: Record<string, string> = { ...HTML, ...(cookie ? { cookie } : {}), origin };
  let body: BodyInit;
  if (multipart) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    body = form;
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(fields as Record<string, string>).toString();
  }
  return call("/suppliers", { method: "POST", headers, body }, authEnv);
}
// Post a form and follow its redirect back to the page, as a browser does.
// HTML entities decoded, so assertions read the words a person reads.
const words = (html: string) =>
  html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
async function act(cookie: string, fields: Fields) {
  const res = await post(cookie, fields);
  expect(res.status, JSON.stringify(fields.action)).toBe(303);
  const location = res.headers.get("location") ?? "";
  const landed = await get(cookie, target(res) ?? "");
  return { to: location, status: landed.status, html: words(await landed.text()) };
}

const ADD = (org: string, over: Fields = {}): Fields => ({
  action: "add",
  org,
  name: "Fynbos Freight (Pty) Ltd",
  domain: "fynbosfreight.example",
  bank: "Kestrel Bank",
  branchCode: "250 655",
  accountNumber: "6200 4417-731",
  phone: "044 873 0192",
  ...over,
});
const csvFile = (text: string, name = "suppliers.csv") => new File([text], name, { type: "text/csv" });
const HEADER = "name,domain,bank,branch_code,account_number,phone";

async function world(role: "owner" | "admin" | "member" = "owner") {
  const org = await makeOrg(`Karoo Couriers ${tag()}`);
  const owner = await person(org, "owner", "Thandi Nkosi");
  const viewer = role === "owner" ? owner : await person(org, role);
  return { org, owner, viewer };
}
const ledger = (org: string) => listSuppliers(db, org);
const snapshot = async (org: string) =>
  JSON.stringify({
    suppliers: await ledger(org),
    events: (
      await db.prepare("SELECT COUNT(*) AS n FROM ledger_events WHERE org_id = ?").bind(org).first<{ n: number }>()
    )?.n,
  });

describe("an owner's ledger", () => {
  it("adds a supplier with its account, shown masked with where it came from, and its row anchored", async () => {
    const { org, owner } = await world();
    const { to, html } = await act(owner.cookie, ADD(org));
    const [supplier] = await ledger(org);
    expect(supplier?.accounts.map((a) => [a.last3, a.source, a.holder])).toEqual([
      ["731", "hand", "Fynbos Freight (Pty) Ltd"],
    ]);
    expect(to).not.toContain("#");
    expect(html).toContain("The supplier is added.");
    expect(html).toContain("Fynbos Freight (Pty) Ltd");
    expect(html).toContain("fynbosfreight.example");
    expect(html).toContain("•••• 731");
    expect(html).toContain("044 873 0192");
    expect(html).toContain("Verified");
    expect(html).toMatch(/Added by hand by Thandi Nkosi, \d{1,2} [A-Z][a-z]{2} 20\d\d/);
    expect(html).toContain(`id="${supplier?.id}" data-anchor-row="${supplier?.id}" tabindex="-1"`);
    // One element carries the id: the supplier's one row, its card on a narrow screen and its table row on a wide one.
    expect(html.split(`id="${supplier?.id}"`)).toHaveLength(2);
    expect(html).toContain("Suppliers (1, 1 verified)");
    expect(html).not.toContain(NUMBER);
  });

  it("adds a supplier without bank details as not yet verified", async () => {
    const { org, owner } = await world();
    const { html } = await act(owner.cookie, ADD(org, { bank: "", branchCode: "", accountNumber: "" }));
    expect((await ledger(org))[0]?.accounts).toEqual([]);
    expect(html).toContain("No account yet");
    expect(html).toContain("Suppliers (1, 0 verified)");
  });

  it("keeps what was typed and puts each refusal on its field, never echoing the number", async () => {
    const { org, owner } = await world();
    const cases: [Fields, number, RegExp][] = [
      [ADD(org, { domain: "" }), 422, /Enter the domain the supplier sends mail from/],
      [ADD(org, { domain: "gmail.com" }), 422, /gmail\.com is a free mail service anyone can sign up to/],
      [ADD(org, { domain: "not a domain" }), 422, /Enter a domain such as supplier\.co\.za/],
      [ADD(org, { branchCode: "" }), 422, /Enter the branch code, or leave the bank details empty/],
      [ADD(org, { accountNumber: "123" }), 422, /An account number is 7 to 11 digits/],
      [ADD(org, { branchCode: "12345" }), 422, /A branch code is 6 digits/],
      [ADD(org, { phone: "call me" }), 422, /A phone number is 7 to 15 digits/],
    ];
    for (const [fields, status, words] of cases) {
      const res = await post(owner.cookie, fields);
      const html = await res.text();
      expect(res.status, String(words)).toBe(status);
      expect(html, String(words)).toMatch(words);
      expect(html).toContain('value="Fynbos Freight (Pty) Ltd"');
      expect(html).toContain("data-unsaved-retained");
      expect(html).not.toContain("6200 4417-731");
      expect(html).not.toContain(NUMBER);
    }
    expect(await ledger(org)).toEqual([]);
    await act(owner.cookie, ADD(org));
    const twice = await post(owner.cookie, ADD(org, { accountNumber: "1234567890" }));
    expect(twice.status).toBe(422);
    expect(await twice.text()).toContain("A supplier of that name is already in the ledger.");
  });

  it("edits a supplier's name, domains and phone, read back on a fresh page", async () => {
    const { org, owner } = await world();
    await act(owner.cookie, ADD(org));
    const [s] = await ledger(org);
    const page = await (await get(owner.cookie, `/suppliers?edit=${s?.id}`)).text();
    expect(page).toContain("Edit Fynbos Freight (Pty) Ltd");
    const { html } = await act(owner.cookie, {
      action: "update",
      org,
      supplierId: s?.id as string,
      name: "Fynbos Freight",
      domains: "fynbosfreight.example\nfynbos-logistics.example",
      phone: "+27 44 873 0192",
    });
    expect(html).toContain("The supplier is saved.");
    const [after] = await ledger(org);
    expect([after?.name, after?.domains, after?.phone]).toEqual([
      "Fynbos Freight",
      ["fynbosfreight.example", "fynbos-logistics.example"],
      "+27 44 873 0192",
    ]);
    const refused = await post(owner.cookie, {
      action: "update",
      org,
      supplierId: s?.id as string,
      name: "X",
      domains: "outlook.com",
      phone: "",
    });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("outlook.com is a free mail service");
  });

  it("keeps another member's change to a field this form left alone (completion review)", async () => {
    const { org, owner } = await world();
    await act(owner.cookie, ADD(org));
    const [s] = await ledger(org);
    const drawn = { drawnName: s?.name as string, drawnDomains: "fynbosfreight.example", drawnPhone: "044 873 0192" };
    const base = { action: "update", org, supplierId: s?.id as string, ...drawn };
    // Two forms drawn from the same supplier: the first changes the phone, the second (drawn before it) the name.
    await act(owner.cookie, {
      ...base,
      name: s?.name as string,
      domains: "fynbosfreight.example",
      phone: "+27 44 000 1111",
    });
    await act(owner.cookie, {
      ...base,
      name: "Fynbos Freight",
      domains: "fynbosfreight.example",
      phone: "044 873 0192",
    });
    const [after] = await ledger(org);
    expect([after?.name, after?.phone]).toEqual(["Fynbos Freight", "+27 44 000 1111"]);
    // The edit form carries what it drew.
    const form = await (await get(owner.cookie, `/suppliers?edit=${s?.id}`)).text();
    expect(form).toContain('name="drawnPhone" value="+27 44 000 1111"');
  });

  it("searches by name, domain or an account's last three digits, and recovers from no match", async () => {
    const { org, owner } = await world();
    await act(owner.cookie, ADD(org));
    await act(
      owner.cookie,
      ADD(org, { name: "Outeniqua Paper", domain: "outeniquapaper.example", accountNumber: "1234567890" }),
    );
    const names = async (q: string) => {
      const html = await (await get(owner.cookie, `/suppliers?q=${encodeURIComponent(q)}`)).text();
      return ["Fynbos Freight (Pty) Ltd", "Outeniqua Paper"].filter((name) => html.includes(`>${name}<`));
    };
    expect(await names("fynbos")).toEqual(["Fynbos Freight (Pty) Ltd"]);
    expect(await names("outeniquapaper")).toEqual(["Outeniqua Paper"]);
    expect(await names("890")).toEqual(["Outeniqua Paper"]);
    expect(await names("")).toEqual(["Fynbos Freight (Pty) Ltd", "Outeniqua Paper"]);
    const none = await (await get(owner.cookie, "/suppliers?q=nobody")).text();
    expect(none).toContain("No supplier matches");
    expect(none).toContain(">Show all suppliers<");
  });

  it("removes a supplier only after confirming, and a cancelled removal changes nothing", async () => {
    const { org, owner } = await world();
    await act(owner.cookie, ADD(org));
    const [s] = await ledger(org);
    const ask = await post(owner.cookie, { action: "remove", org, supplierId: s?.id as string });
    const askHtml = await ask.text();
    expect(ask.status).toBe(200);
    expect(askHtml).toContain("Remove Fynbos Freight (Pty) Ltd?");
    expect(askHtml).toMatch(/<a [^>]*(href="\/suppliers"[^>]*data-discard|data-discard[^>]*href="\/suppliers")/);
    expect(await ledger(org)).toHaveLength(1);
    const { html } = await act(owner.cookie, { action: "confirm-remove", org, supplierId: s?.id as string });
    expect(html).toContain("The supplier and its accounts are removed");
    expect(await ledger(org)).toEqual([]);
    const again = await act(owner.cookie, { action: "confirm-remove", org, supplierId: s?.id as string });
    expect(again.html).toContain("That was already removed.");
  });

  it("removes one account after confirming, and adds another from the edit panel", async () => {
    const { org, owner } = await world();
    await act(owner.cookie, ADD(org));
    const [s] = await ledger(org);
    const old = s?.accounts[0];
    const added = await act(owner.cookie, {
      action: "add-account",
      org,
      supplierId: s?.id as string,
      bank: "Protea Mutual",
      branchCode: "198765",
      accountNumber: "1234567890",
    });
    expect(added.html).toContain("The account is added.");
    const ask = words(
      await (
        await post(owner.cookie, {
          action: "remove-account",
          org,
          supplierId: s?.id as string,
          accountId: old?.id as string,
        })
      ).text(),
    );
    expect(ask).toContain("Remove Fynbos Freight (Pty) Ltd's account ending 731?");
    await act(owner.cookie, {
      action: "confirm-remove-account",
      org,
      supplierId: s?.id as string,
      accountId: old?.id as string,
    });
    expect((await ledger(org))[0]?.accounts.map((a) => a.last3)).toEqual(["890"]);
  });

  it("changes an account from its row: the form prefilled, the confirmation required, the old one gone", async () => {
    const { org, owner } = await world();
    await act(owner.cookie, ADD(org));
    const [s] = await ledger(org);
    const account = s?.accounts[0];
    const page = await (await get(owner.cookie)).text();
    expect(page).toContain(`href="/suppliers?change=${account?.id}"`);
    const form = words(await (await get(owner.cookie, `/suppliers?change=${account?.id}`)).text());
    expect(form).toContain("Change Fynbos Freight (Pty) Ltd's account ending 731");
    expect(form).toContain('value="Kestrel Bank"');
    expect(form).toContain('value="250655"');
    const fields = {
      action: "change-account",
      org,
      supplierId: s?.id as string,
      accountId: account?.id as string,
      bank: "Protea Mutual",
      branchCode: "198765",
      accountNumber: "1234567890",
    };
    const unconfirmed = await post(owner.cookie, fields);
    expect(unconfirmed.status).toBe(422);
    expect(await unconfirmed.text()).toContain("Tick this to remove the account ending 731");
    expect((await ledger(org))[0]?.accounts.map((a) => a.id)).toEqual([account?.id]);
    const { html } = await act(owner.cookie, { ...fields, confirm: "on" });
    expect(html).toContain("The account is changed");
    expect((await ledger(org))[0]?.accounts.map((a) => [a.last3, a.bankName])).toEqual([["890", "Protea Mutual"]]);
  });

  it("shows where each account came from: by hand, from CSV, from a case, and from a case since deleted", async () => {
    const { org, owner } = await world();
    const keys = await bankKeys(env);
    const { id } = await addSupplier(db, org, owner.id, { name: "Karoo Parts", domains: ["karooparts.example"] });
    await addSupplierAccount(db, keys, org, owner.id, id, {
      number: "11111111",
      branchCode: "250655",
      bankName: "Kestrel Bank",
      holder: "Karoo Parts",
    });
    await addSupplierAccount(
      db,
      keys,
      org,
      owner.id,
      id,
      { number: "22222222", branchCode: "250655", bankName: "Kestrel Bank", holder: "Karoo Parts" },
      { source: "csv" },
    );
    const live = await createCase(db, { orgId: org, channel: "email", headersAvailable: true });
    const gone = await createCase(db, { orgId: org, channel: "email", headersAvailable: true });
    if (!live.ok || !gone.ok) throw new Error("no case");
    await addSupplierAccount(
      db,
      keys,
      org,
      owner.id,
      id,
      { number: "33333333", branchCode: "250655", bankName: "Kestrel Bank", holder: "Karoo Parts" },
      { verifiedFromCaseId: live.value.id },
    );
    await addSupplierAccount(
      db,
      keys,
      org,
      owner.id,
      id,
      { number: "44444444", branchCode: "250655", bankName: "Kestrel Bank", holder: "Karoo Parts" },
      { verifiedFromCaseId: gone.value.id },
    );
    await db.prepare("DELETE FROM cases WHERE id = ?").bind(gone.value.id).run();
    const html = await (await get(owner.cookie, `/suppliers?edit=${id}`)).text();
    expect(html).toContain("Added by hand by Thandi Nkosi");
    expect(html).toContain("Imported from CSV by Thandi Nkosi");
    expect(html).toContain(`href="/cases/${live.value.id}"`);
    expect(html).toContain("Verified from a case no longer available, by Thandi Nkosi");
  });
});

describe("importing a CSV", () => {
  const THREE = [
    HEADER,
    "Fynbos Freight (Pty) Ltd,fynbosfreight.example,Kestrel Bank,250655,62004417731,044 873 0192",
    "Outeniqua Paper,outeniquapaper.example,Protea Mutual,198765,1234567890,044 382 5521",
    "Garden Route Tyres,grtyres.example,Kestrel Bank,250655,0620 0441-773,",
  ].join("\r\n");

  it("imports nothing from a file with one bad row, listing the row", async () => {
    const { org, owner } = await world();
    const bad = `${THREE}\r\nFree Mail,gmail.com,Kestrel Bank,250655,62004417731,`;
    const res = await post(owner.cookie, { action: "import", org, file: csvFile(bad, "suppliers-oct.csv") });
    const html = await res.text();
    expect(res.status).toBe(422);
    expect(html).toContain("Nothing imported");
    expect(html).toContain("suppliers-oct.csv · 4 rows.");
    expect(html).toMatch(/<td[^>]*>4<\/td>\s*<td[^>]*>domain &quot;gmail.com&quot; is a free mail service/);
    expect(html).not.toContain(NUMBER);
    expect(await ledger(org)).toEqual([]);
  });

  it("imports three suppliers in one go, and the same file again changes nothing", async () => {
    const { org, owner } = await world();
    const first = await act(owner.cookie, { action: "import", org, file: csvFile(THREE) });
    expect(first.html).toContain("The file is imported: 3 suppliers added, 0 suppliers updated, 3 accounts added.");
    expect((await ledger(org)).flatMap((s) => s.accounts.map((a) => a.source))).toEqual(["csv", "csv", "csv"]);
    const before = await snapshot(org);
    const second = await act(owner.cookie, { action: "import", org, file: csvFile(THREE) });
    expect(second.html).toContain("3 accounts were already in the ledger.");
    expect(await snapshot(org)).toBe(before);
  });

  it("imports nothing from an unchanged template or a field with characters after its closing quote", async () => {
    const { org, owner } = await world();
    const template = await (await get(owner.cookie, "/suppliers/template.csv")).text();
    const empty = await post(owner.cookie, { action: "import", org, file: csvFile(template) });
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("The file has no suppliers under its header, so nothing was imported");
    const quoted = await post(owner.cookie, {
      action: "import",
      org,
      file: csvFile(`${HEADER}\r\nKaroo Parts,karooparts.example,Kestrel Bank,250655,"6200"4417731,`),
    });
    expect(quoted.status).toBe(422);
    expect(await quoted.text()).toContain("Row 1 has characters after a closing quote.");
    expect(await ledger(org)).toEqual([]);
  });

  it("says an import's outcome is unknown when the write fails, never that nothing was imported", async () => {
    const { org, owner } = await world();
    await db.exec(
      "CREATE TRIGGER fail_suppliers BEFORE INSERT ON suppliers BEGIN SELECT RAISE(ABORT, 'storage down'); END",
    );
    try {
      const res = await post(owner.cookie, { action: "import", org, file: csvFile(THREE) });
      const html = await res.text();
      expect(res.status).toBe(503);
      expect(html).toContain("Outcome unknown");
      expect(html).toContain(
        "We could not confirm whether this file was imported. Reload the page and check the ledger",
      );
      expect(html).not.toContain("Nothing imported");
    } finally {
      await db.exec("DROP TRIGGER IF EXISTS fail_suppliers");
    }
  });

  it("names a whole-file problem, and gives a template", async () => {
    const { org, owner } = await world();
    const wrong = await post(owner.cookie, { action: "import", org, file: csvFile("supplier,bank\nA,B") });
    expect(wrong.status).toBe(422);
    expect(await wrong.text()).toContain(
      "The first row must be the columns name,domain,bank,branch_code,account_number,phone.",
    );
    const empty = await post(owner.cookie, { action: "import", org, file: csvFile("") });
    expect(await empty.text()).toContain("Choose a CSV file first.");
    const template = await get(owner.cookie, "/suppliers/template.csv");
    expect(template.status).toBe(200);
    expect(template.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(template.headers.get("content-disposition")).toContain("attachment");
    expect((await template.text()).startsWith(HEADER)).toBe(true);
  });
});

describe("states and refusals", () => {
  it("shows a first-run state with the forms to an owner, and a member sees the ledger without them", async () => {
    const { org, owner, viewer } = await world("member");
    const empty = await (await get(owner.cookie)).text();
    expect(empty).toContain("No suppliers yet");
    expect(empty).toContain('id="add-supplier"');
    expect(empty).toContain('id="import"');
    await act(owner.cookie, ADD(org));
    const member = await (await get(viewer.cookie)).text();
    expect(member).toContain("Fynbos Freight (Pty) Ltd");
    expect(member).not.toContain('id="add-supplier"');
    expect(member).not.toContain(">Edit<");
    expect(member).not.toContain("?change=");
    const before = await snapshot(org);
    const refused = await post(viewer.cookie, ADD(org, { name: "Member Supplier" }));
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Only an owner or admin changes your suppliers.");
    expect(await snapshot(org)).toBe(before);
  });

  it("refuses a foreign site, a form for another organisation, another organisation's supplier and no session", async () => {
    const { org, owner } = await world();
    const other = await world();
    await act(other.owner.cookie, ADD(other.org));
    const [foreign] = await ledger(other.org);
    const mine = await snapshot(org);
    const theirs = await snapshot(other.org);
    expect((await post(owner.cookie, ADD(org), "https://evil.example")).status).toBe(403);
    const switched = await act(owner.cookie, ADD(other.org));
    expect(switched.html).toContain("Your organisation changed in another tab, so nothing was done.");
    const remove = await act(owner.cookie, { action: "confirm-remove", org, supplierId: foreign?.id as string });
    expect(remove.html).toContain("That was already removed. Nothing else changed.");
    const change = await act(owner.cookie, {
      action: "change-account",
      org,
      supplierId: foreign?.id as string,
      accountId: foreign?.accounts[0]?.id as string,
      bank: "B",
      branchCode: "198765",
      accountNumber: "1234567890",
      confirm: "on",
    });
    expect(change.html).toContain("That was already removed.");
    expect(await snapshot(org)).toBe(mine);
    expect(await snapshot(other.org)).toBe(theirs);
    const anonymous = await get(undefined);
    expect([302, 303]).toContain(anonymous.status);
  });

  it("refuses an organisation whose plan lacks the bank-change check, page and post alike", async () => {
    const { org, owner } = await world();
    await setPlan(db, org, "free");
    const page = await get(owner.cookie);
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("The supplier ledger is part of the Protect plan.");
    expect((await post(owner.cookie, ADD(org))).status).toBe(403);
    expect(await ledger(org)).toEqual([]);
  });
});
