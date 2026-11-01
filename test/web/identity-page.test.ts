import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPlan } from "../../src/auth/plans";
import { addAccount, bankKeys, maskedAccounts } from "../../src/trust/bank";
import { findIdentityByClaim, getIdentity, setIdentity } from "../../src/trust/identity";
import { storeLogo } from "../../src/trust/logo";
import { STALE_WORDS, UNCERTAIN_WORDS } from "../../src/web/pages/identity-view";
import { authEnv, call, signIn, target } from "../auth/helpers";
import { addAddress, addDomain, events, makeOrg } from "../trust/helpers";

// The protected identity page (D05 T01 §3): an owner or admin registers and changes the identity through the page's
// own forms, every change read back on a fresh GET; a member reads it with no forms; and every refusal (a member, a
// foreign site, a form drawn for another organisation, a foreign account, no session, an unreadable or insufficient
// plan, a lost race, a failing store) changes nothing and says so in plain words, never echoing an account number.
const db = env.DB;
const NUMBER = "06200441773";
const FORMATTED = "0620 0441-773";

afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await db.exec("DROP TRIGGER IF EXISTS fail_events");
  await db.exec("DROP TRIGGER IF EXISTS lose_race");
});

let n = 0;
const tag = () => `${++n}${crypto.randomUUID().slice(0, 6)}`;

// A PNG of one grey row, every CRC computed: what a browser would upload.
const crcTable = Array.from({ length: 256 }, (_, k) => {
  let c = k;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const chunk = (type: string, data: Uint8Array) => {
  const typed = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)).concat([...data]));
  return [...be32(data.length), ...typed, ...be32(crc(typed))];
};
async function png(width = 8, height = 4): Promise<Uint8Array> {
  const raw = new Uint8Array((1 + width) * height);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());
  const ihdr = Uint8Array.from([...be32(width), ...be32(height), 8, 0, 0, 0, 0]);
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", new Uint8Array()),
  ]);
}
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><path d="M0 0 L100 0 L100 40 Z" fill="#000"/></svg>';
const file = (bytes: Uint8Array | string, name: string, type: string) => new File([bytes], name, { type });

async function org(name: string, createdAt?: string) {
  const id = await makeOrg(name);
  if (createdAt) await db.prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`).bind(createdAt, id).run();
  return id;
}
const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id;
async function person(orgId: string, role = "owner") {
  const email = `idp-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  vi.restoreAllMocks();
  const id = await userId(email);
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, id, role, new Date().toISOString())
    .run();
  await activate(email, orgId);
  return { cookie, email };
}
const activate = async (email: string, orgId: string) =>
  db
    .prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`)
    .bind(orgId, await userId(email))
    .run();

const HTML = { accept: "text/html" };
const get = (cookie: string | undefined, path = "/protect", workerEnv: Env = authEnv) =>
  call(path, { headers: { ...HTML, ...(cookie ? { cookie } : {}) } }, workerEnv);
type Fields = Record<string, string | File>;
// A post as a browser makes it: urlencoded, or multipart when a file is sent. A form that changes the identity or its
// logo carries the revision it was drawn from, so one is added (the stored one) unless the test names its own;
// `version: OMIT` sends none.
const OMIT = "\u0000omit";
const VERSIONED = new Set(["save", "logo", "remove-logo"]);
async function post(
  cookie: string | undefined,
  fields: Fields,
  options: { origin?: string; workerEnv?: Env } = {},
): Promise<Response> {
  if (fields.version === OMIT) {
    const { version: _omitted, ...rest } = fields;
    fields = rest;
  } else if (typeof fields.action === "string" && VERSIONED.has(fields.action) && fields.version === undefined) {
    const orgId = typeof fields.org === "string" ? fields.org : "";
    fields = { ...fields, version: String((await getIdentity(db, orgId).catch(() => null))?.version ?? 0) };
  }
  const multipart = Object.values(fields).some((v) => typeof v !== "string");
  const headers: Record<string, string> = { ...HTML, ...(cookie ? { cookie } : {}) };
  if (options.origin) headers.origin = options.origin;
  let body: BodyInit;
  if (multipart) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    body = form;
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(fields as Record<string, string>).toString();
  }
  return call("/protect", { method: "POST", headers, body }, options.workerEnv);
}
// Post a form and follow its redirect back to the page, as a browser does.
async function act(cookie: string, fields: Fields) {
  const res = await post(cookie, fields);
  expect(res.status, JSON.stringify(Object.keys(fields))).toBe(303);
  const to = target(res) ?? "";
  const landed = await get(cookie, to);
  return { to, status: landed.status, html: await landed.text() };
}

const SAVE = (orgId: string, over: Fields = {}): Fields => ({
  action: "save",
  org: orgId,
  tradingNames: "",
  contact: "",
  ...over,
});
const ACCOUNT = (orgId: string, over: Fields = {}): Fields => ({
  action: "add-account",
  org: orgId,
  bankName: "Kestrel Bank",
  branchCode: "250655",
  accountNumber: FORMATTED,
  holder: "Karoo Couriers (Pty) Ltd",
  ...over,
});

// An organisation ready to be protected: a verified domain and two verified sending addresses, one pending domain.
async function world(name = "Karoo Couriers (Pty) Ltd") {
  const orgId = await org(name);
  const domain = `kc-${tag()}.example`;
  const pending = `pending-${tag()}.example`;
  await addDomain(orgId, domain);
  await addDomain(orgId, pending, "pending");
  await addAddress(orgId, `accounts@${domain}`);
  await addAddress(orgId, `finance@${domain}`);
  const owner = await person(orgId, "owner");
  return { orgId, domain, pending, owner, contact: `accounts@${domain}`, other: `finance@${domain}` };
}
async function registered(role: "owner" | "admin" | "member" = "owner") {
  const w = await world();
  await setIdentity(db, w.orgId, "owner", {
    displayNames: ["Karoo Couriers (Pty) Ltd", "KC Express"],
    financeContact: w.contact,
    protected: true,
  });
  const keys = await bankKeys(env);
  await addAccount(db, keys, w.orgId, "owner", {
    number: FORMATTED,
    branchCode: "250655",
    bankName: "Kestrel Bank",
    holder: "Karoo Couriers (Pty) Ltd",
  });
  const viewer = role === "owner" ? w.owner : await person(w.orgId, role);
  return { ...w, viewer };
}

const snapshot = async (orgId: string) => {
  const identity = await db
    .prepare(
      "SELECT display_names_json, finance_contact_email, logo_r2_key, logo_media_type, protected, version FROM identities WHERE org_id = ?",
    )
    .bind(orgId)
    .first();
  const accounts = (
    await db.prepare("SELECT id FROM bank_accounts WHERE org_id = ? ORDER BY id").bind(orgId).all<{ id: string }>()
  ).results.map((a) => a.id);
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM trust_events WHERE org_id = ?")
    .bind(orgId)
    .first<{ n: number }>();
  const objects = (await env.ARTEFACTS.list({ prefix: `ident/${orgId}/` })).objects.map((o) => o.key);
  return JSON.stringify({ identity, accounts, events: count?.n, objects });
};
const failEvents = () =>
  db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON trust_events BEGIN SELECT RAISE(ABORT, 'audit down'); END");
// A lost race on the identity: its conditional update finds nothing to change.
const loseRace = () => db.exec("CREATE TRIGGER lose_race BEFORE UPDATE ON identities BEGIN SELECT RAISE(IGNORE); END");
const noDigits = (html: string) => {
  expect(html).not.toContain(NUMBER);
  expect(html).not.toContain(FORMATTED);
  expect(html).not.toContain("06200441");
};
// The matches of a name that belong to this organisation (the file's other organisations hold names of their own).
const matches = async (orgId: string, displayName: string) =>
  (await findIdentityByClaim(db, { displayName })).filter((m) => m.orgId === orgId);
const since = (html: string) => /Protected since ([^<]+)</.exec(html)?.[1];
const today = () =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date());

describe("what the page shows", () => {
  it("draws each region of the board for an owner: names, domains with their pills and links, logo, contact, accounts, switch", async () => {
    const w = await registered();
    const res = await get(w.viewer.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain("Protect Karoo Couriers (Pty) Ltd");
    expect(html).toContain("Tell us who you really are, so mail pretending to be you gets caught.");
    expect(html).toMatch(/Protected since [^<]+</);
    expect(html).toContain(`Anyone can now check mail that claims to be Karoo Couriers (Pty) Ltd.`);
    // Names: the registered name read-only, the trading names editable.
    expect(html).toContain("Registered name");
    expect(html).toMatch(/<label[^>]*for="trading-names"[^>]*>Trading names<\/label>/);
    expect(html).toMatch(/<textarea[^>]*name="tradingNames"[^>]*>KC Express<\/textarea>/);
    // Domains: verified and pending with their pills, the pending one linked to its page, Manage domains.
    expect(html).toContain(w.domain);
    expect(html).toContain(">Verified<");
    expect(html).toContain(">Pending<");
    expect(html).toContain(`href="/settings/domains/${w.pending}"`);
    expect(html).toContain('href="/settings/domains"');
    expect(html).toContain("Manage domains");
    // Logo, finance contact (a radio per verified address), bank accounts (masked), the switch.
    expect(html).toContain("No logo yet");
    expect(html).toContain("Add logo");
    expect(html).toContain("Finance contact");
    expect(html).toMatch(
      new RegExp(`name="contact"[^>]*value="${w.contact}"[^>]*checked|checked[^>]*value="${w.contact}"`),
    );
    expect(html).toContain(`value="${w.other}"`);
    expect(html).toContain("Bank accounts");
    expect(html).toContain("Kestrel Bank · 250655");
    expect(html).toContain("•••• 773");
    expect(html).toContain("Add account");
    expect(html).toContain("Remove");
    expect(html).toMatch(
      /<input[^>]*type="checkbox"[^>]*name="protected"[^>]*checked|<input[^>]*checked[^>]*name="protected"/,
    );
    expect(html).toContain("Members can view this page; owners and admins can change it.");
    noDigits(html);
    // The regions of the board come in its order.
    const order = [
      "<h1",
      'id="names-heading"',
      'id="domains-heading"',
      'id="logo-heading"',
      'id="contact-heading"',
      'id="bank-heading"',
    ].map((t) => html.indexOf(t));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("shows the registration form on a first visit: the registered name, nothing chosen, Protected off, the logo form waiting", async () => {
    const w = await world();
    expect(await getIdentity(db, w.orgId)).toBeNull();
    const html = await (await get(w.owner.cookie)).text();
    expect(html).toContain("Not protected");
    expect(html).toContain("Register your identity below");
    expect(html).toContain("Karoo Couriers (Pty) Ltd");
    expect(html).not.toMatch(/name="protected"[^>]*checked|checked[^>]*name="protected"/);
    // Nothing is chosen: only "No finance contact" is ticked, and no address is.
    expect(html).toMatch(/id="contact-none"[^>]*checked|checked[^>]*id="contact-none"/);
    expect(html).not.toMatch(new RegExp(`value="${w.contact}"[^>]*checked|checked[^>]*value="${w.contact}"`));
    expect(html).toContain("No bank accounts yet");
    expect(html).toContain("Save your identity first, then add your logo");
    expect(html).toMatch(/<button[^>]*id="logo-upload"[^>]*disabled/);
    expect(html).toContain(w.contact);
    expect(html).not.toContain("Protected since");
  });

  it("says to verify a sending address first when there is none", async () => {
    const orgId = await org("Hadeda Couriers");
    await addDomain(orgId, `h-${tag()}.example`);
    const owner = await person(orgId);
    const html = await (await get(owner.cookie)).text();
    expect(html).toContain("No verified sending address yet. Verify a sending address first");
    expect(html).not.toContain('name="contact"');
  });

  it("shows a member the same page with no form and no control", async () => {
    const w = await registered("member");
    const res = await get(w.viewer.cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Kestrel Bank · 250655");
    expect(html).toContain("•••• 773");
    expect(html).toContain("KC Express");
    expect(html).toContain(w.contact);
    expect(html).toContain("Members can view this page; owners and admins can change it.");
    for (const gone of [
      'name="action"',
      'name="tradingNames"',
      'name="protected"',
      'name="contact"',
      'name="accountNumber"',
      'name="logo"',
      "Manage domains",
      "Replace logo",
      "Add account",
      "Save identity",
      `href="/settings/domains/${w.pending}"`,
    ])
      expect(html, gone).not.toContain(gone);
    expect(html).not.toContain(">Remove<");
    noDigits(html);
  });
});

describe("saving the identity", () => {
  it("registers a fresh organisation with one save, then shows it protected and matches by its registered name alone", async () => {
    const w = await world("Hadeda Freight (Pty) Ltd");
    const done = await act(w.owner.cookie, SAVE(w.orgId, { contact: w.contact, protected: "on" }));
    expect(done.status).toBe(200);
    expect(done.html).toContain("Your identity is saved.");
    expect(done.html).toMatch(/Protected since [^<]+</);
    const fresh = await (await get(w.owner.cookie)).text();
    expect(fresh).toContain(`Protected since ${today()}`);
    expect(fresh).not.toContain("Your identity is saved.");
    const stored = await getIdentity(db, w.orgId);
    expect(stored).toMatchObject({
      displayNames: ["Hadeda Freight (Pty) Ltd"],
      financeContact: w.contact,
      protected: true,
      effective: { on: true },
    });
    expect(await matches(w.orgId, "hadeda  freight pty ltd")).toEqual([
      { orgId: w.orgId, name: "Hadeda Freight (Pty) Ltd", matchedBy: "name" },
    ]);
    expect((await events(w.orgId)).map((e) => e.kind)).toEqual(["identity.set"]);
  });

  it("adds and removes a trading name, changes the contact, and switches protection off and on, each read back", async () => {
    const w = await world();
    const { cookie } = w.owner;
    await act(cookie, SAVE(w.orgId, { contact: w.contact, protected: "on" }));
    // Backdate the switching on, to see which saves move "Protected since".
    await db
      .prepare(
        `UPDATE trust_events SET created_at = '2026-10-12T08:00:00.000Z' WHERE org_id = ? AND kind = 'identity.set'`,
      )
      .bind(w.orgId)
      .run();
    expect(since(await (await get(cookie)).text())).toBe("12 Oct 2026");

    let html = (
      await act(
        cookie,
        SAVE(w.orgId, { tradingNames: "KC Express\r\nKaroo Express", contact: w.contact, protected: "on" }),
      )
    ).html;
    expect((await getIdentity(db, w.orgId))?.displayNames).toEqual([
      "Karoo Couriers (Pty) Ltd",
      "KC Express",
      "Karoo Express",
    ]);
    expect(html).toContain("KC Express\nKaroo Express</textarea>");
    expect(await matches(w.orgId, "karoo express")).toHaveLength(1);

    html = (await act(cookie, SAVE(w.orgId, { tradingNames: "Karoo Express", contact: w.contact, protected: "on" })))
      .html;
    expect((await getIdentity(db, w.orgId))?.displayNames).toEqual(["Karoo Couriers (Pty) Ltd", "Karoo Express"]);
    expect(await matches(w.orgId, "kc express")).toEqual([]);
    // The registered name still matches with every trading name gone.
    await act(cookie, SAVE(w.orgId, { contact: w.contact, protected: "on" }));
    expect(await matches(w.orgId, "karoo couriers pty ltd")).toHaveLength(1);

    html = (await act(cookie, SAVE(w.orgId, { contact: w.other, protected: "on" }))).html;
    expect((await getIdentity(db, w.orgId))?.financeContact).toBe(w.other);
    expect(html).toMatch(new RegExp(`value="${w.other}"[^>]*checked|checked[^>]*value="${w.other}"`));
    // None of those moved the date.
    expect(since(html)).toBe("12 Oct 2026");

    html = (await act(cookie, SAVE(w.orgId, { contact: w.other }))).html;
    expect(html).toContain("Not protected");
    expect(html).not.toContain("Protected since");
    expect((await getIdentity(db, w.orgId))?.protected).toBe(false);
    html = (await act(cookie, SAVE(w.orgId, { contact: w.other, protected: "on" }))).html;
    expect(since(html)).toBe(today());
  });

  it("refuses a malformed name, an unverified contact and protection without a domain, keeping what was typed and changing nothing", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    const before = await snapshot(w.orgId);
    const pendingAddress = `late@${w.domain}`;
    await addAddress(w.orgId, pendingAddress, "pending");

    let res = await post(
      cookie,
      SAVE(w.orgId, { tradingNames: "!!!\nKC Express", contact: w.contact, protected: "on" }),
    );
    expect(res.status).toBe(422);
    let html = await res.text();
    expect(html).toContain("Each name needs letters or digits.");
    expect(namesIn(html)).toBe("!!!\nKC Express");
    expect(html).toMatch(/id="trading-names-error"[^>]*role="alert"|role="alert"[^>]*id="trading-names-error"/);

    res = await post(cookie, SAVE(w.orgId, { tradingNames: "x".repeat(121), contact: w.contact, protected: "on" }));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("up to 120 characters");

    res = await post(
      cookie,
      SAVE(w.orgId, { tradingNames: Array.from({ length: 10 }, (_, i) => `Name ${i}`).join("\n"), contact: w.contact }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Ten names at most");

    res = await post(cookie, SAVE(w.orgId, { tradingNames: "Typed Name", contact: pendingAddress, protected: "on" }));
    expect(res.status).toBe(422);
    html = await res.text();
    expect(html).toContain("Choose one of your verified sending addresses.");
    expect(namesIn(html)).toBe("Typed Name");

    res = await post(cookie, SAVE(w.orgId, { tradingNames: "Typed Name", contact: "not-an-address", protected: "on" }));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Choose one of your verified sending addresses.");

    // Protection without a verified domain and a contact, on an organisation with neither.
    const bare = await org("Bare Freight");
    const owner = await person(bare);
    res = await post(owner.cookie, SAVE(bare, { tradingNames: "Bare Co", protected: "on" }));
    expect(res.status).toBe(422);
    html = await res.text();
    expect(html).toContain("Protection needs a verified domain and a finance contact.");
    expect(namesIn(html)).toBe("Bare Co");
    expect(html).toMatch(/name="protected"[^>]*checked|checked[^>]*name="protected"/);
    expect(await getIdentity(db, bare)).toBeNull();

    expect(await snapshot(w.orgId)).toBe(before);
  });
});

describe("showing protection as it is", () => {
  it("says why protection is paused, where to fix it, and drops the date, until it is repaired or switched off", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    expect(since(await (await get(cookie)).text())).toBe(today());

    // The last verified domain stops being verified.
    await db
      .prepare("UPDATE org_domains SET state = 'pending' WHERE org_id = ? AND domain = ?")
      .bind(w.orgId, w.domain)
      .run();
    let html = await (await get(cookie)).text();
    expect(html).toContain("Protection is paused");
    expect(html).toContain("none of your domains is verified.");
    expect(html).not.toContain("Protected since");
    expect(html).not.toContain("Anyone can now check mail");
    expect(html).toMatch(/href="\/settings\/domains\/[^"]+"[^>]*>Verify [^<]+</);
    expect(await matches(w.orgId, "karoo couriers pty ltd")).toEqual([]);
    await db
      .prepare("UPDATE org_domains SET state = 'verified' WHERE org_id = ? AND domain = ?")
      .bind(w.orgId, w.domain)
      .run();
    html = await (await get(cookie)).text();
    expect(html).not.toContain("Protection is paused");
    expect(since(html)).toBe(today());

    // The finance address stops being verified.
    await db
      .prepare("UPDATE org_addresses SET state = 'pending' WHERE org_id = ? AND address = ?")
      .bind(w.orgId, w.contact)
      .run();
    html = await (await get(cookie)).text();
    expect(html).toContain("Protection is paused");
    expect(html).toContain(`${w.contact} is no longer a verified address.`);
    expect(html).toContain("Verify a sending address");
    expect(html).toContain(`${w.contact} (not verified)`);
    expect(html).not.toContain("Protected since");
    await db
      .prepare("UPDATE org_addresses SET state = 'verified' WHERE org_id = ? AND address = ?")
      .bind(w.orgId, w.contact)
      .run();
    expect(since(await (await get(cookie)).text())).toBe(today());

    // Switched off, it says so.
    html = (await act(cookie, SAVE(w.orgId, { tradingNames: "KC Express", contact: w.contact }))).html;
    expect(html).toContain("Not protected");
    expect(html).not.toContain("Protection is paused");
  });

  it("names a missing finance contact and a plain paused member view", async () => {
    const w = await registered("member");
    await db.prepare("UPDATE org_addresses SET state = 'pending' WHERE org_id = ?").bind(w.orgId).run();
    const html = await (await get(w.viewer.cookie)).text();
    expect(html).toContain("Protection is paused");
    expect(html).toContain("is no longer a verified address.");
  });
});

describe("the logo", () => {
  it("uploads a PNG and an SVG, serves each to members with its type and a sandbox, and refuses a JPEG and an oversize file", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    let landed = await act(cookie, { action: "logo", org: w.orgId, logo: file(await png(), "logo.png", "image/png") });
    expect(landed.html).toContain("Your logo is saved.");
    expect(landed.html).toMatch(/<img[^>]*src="\/protect\/logo\?v=/);
    expect(landed.html).toContain("Replace logo");
    expect(landed.html).toContain("Remove logo");
    let served = await get(cookie, "/protect/logo");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await served.arrayBuffer()).slice(0, 4)).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));

    landed = await act(cookie, { action: "logo", org: w.orgId, logo: file(SVG, "logo.svg", "image/svg+xml") });
    expect(landed.html).toContain("Your logo is saved.");
    served = await get(cookie, "/protect/logo");
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(await served.text()).toContain("<path");
    // The PNG it replaced is gone from storage.
    expect((await env.ARTEFACTS.list({ prefix: `ident/${w.orgId}/` })).objects).toHaveLength(1);

    const before = await snapshot(w.orgId);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    let res = await post(cookie, { action: "logo", org: w.orgId, logo: file(jpeg, "logo.jpg", "image/jpeg") });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("The logo must be a PNG or SVG image.");
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    res = await post(cookie, { action: "logo", org: w.orgId, logo: file(big, "big.png", "image/png") });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("The logo is larger than 2 MiB.");
    res = await post(cookie, {
      action: "logo",
      org: w.orgId,
      logo: file(new Uint8Array(3 * 1024 * 1024), "huge.png", "image/png"),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("The logo is larger than 2 MiB.");
    res = await post(cookie, {
      action: "logo",
      org: w.orgId,
      logo: file(new Uint8Array(0), "", "application/octet-stream"),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Choose a PNG or SVG file first.");
    expect(await snapshot(w.orgId)).toBe(before);

    // Removing it leaves none, and says so.
    landed = await act(cookie, { action: "remove-logo", org: w.orgId });
    expect(landed.html).toContain("Your logo is removed.");
    expect(landed.html).toContain("No logo yet");
    expect((await get(cookie, "/protect/logo")).status).toBe(404);
    expect((await events(w.orgId)).map((e) => e.kind)).toEqual(
      expect.arrayContaining(["identity.logo_stored", "identity.logo_removed"]),
    );
    expect((await env.ARTEFACTS.list({ prefix: `ident/${w.orgId}/` })).objects).toHaveLength(0);
  });

  it("gives another organisation's member 404 for the logo, and an anonymous request the sign-in page", async () => {
    const w = await registered();
    await storeLogo(env.ARTEFACTS, db, w.orgId, "owner", await png(), "image/png");
    expect((await get(w.viewer.cookie, "/protect/logo")).status).toBe(200);
    const member = await person(w.orgId, "member");
    expect((await get(member.cookie, "/protect/logo")).status).toBe(200);
    const other = await org("Another Freight");
    const stranger = await person(other);
    expect((await get(stranger.cookie, "/protect/logo")).status).toBe(404);
    const anonymous = await get(undefined, "/protect/logo");
    expect(anonymous.status).toBe(303);
    expect(target(anonymous)).toMatch(/^\/signin/);
  });

  it("waits for the first save before taking a logo", async () => {
    const w = await world();
    const res = await post(w.owner.cookie, {
      action: "logo",
      org: w.orgId,
      logo: file(await png(), "logo.png", "image/png"),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Save your identity first, then add your logo.");
  });
});

describe("bank accounts", () => {
  it("adds an account and shows it masked, and re-renders a refused one without the digits typed", async () => {
    const w = await world();
    const { cookie } = w.owner;
    await act(cookie, SAVE(w.orgId, { contact: w.contact, protected: "on" }));
    let res = await post(cookie, ACCOUNT(w.orgId, { accountNumber: "12345" }));
    expect(res.status).toBe(422);
    let html = await res.text();
    expect(html).toContain("An account number is 7 to 11 digits.");
    expect(html).not.toContain("12345");
    expect(html).toContain('value="Kestrel Bank"');
    expect(html).toContain('value="250655"');
    expect(await maskedAccounts(db, w.orgId)).toEqual([]);

    res = await post(cookie, ACCOUNT(w.orgId, { branchCode: "25" }));
    expect(res.status).toBe(422);
    html = await res.text();
    expect(html).toContain("A branch code is 6 digits.");
    noDigits(html);

    res = await post(cookie, ACCOUNT(w.orgId, { holder: "", bankName: " " }));
    expect(res.status).toBe(422);
    html = await res.text();
    expect(html).toContain("Enter the account holder.");
    expect(html).toContain("Enter the bank.");
    noDigits(html);

    const landed = await act(cookie, ACCOUNT(w.orgId));
    expect(landed.html).toContain("The account is added.");
    expect(landed.html).toContain("•••• 773");
    expect(landed.html).toContain("Kestrel Bank · 250655");
    noDigits(landed.html);
    expect((await events(w.orgId)).filter((e) => e.kind === "bank.added")).toHaveLength(1);
  });

  it("draws the rest of the page and says bank accounts are unavailable in a Worker without BANK_KEY", async () => {
    const w = await registered();
    const keyless = { ...authEnv, BANK_KEY: undefined } as unknown as Env;
    const res = await get(w.viewer.cookie, "/protect", keyless);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Bank accounts are unavailable just now");
    expect(html).not.toContain('name="accountNumber"');
    expect(html).toContain("Names");
    expect(html).toContain("Domains");
    expect(html).toContain("Save identity");
    expect(html).toContain("•••• 773");
    const before = await snapshot(w.orgId);
    const posted = await post(w.viewer.cookie, ACCOUNT(w.orgId, { accountNumber: "9988776655" }), {
      workerEnv: keyless,
    });
    expect(posted.status).toBe(503);
    const text = await posted.text();
    expect(text).not.toContain("9988776655");
    expect(await snapshot(w.orgId)).toBe(before);
  });

  it("removes an account only through its confirmation: the first post removes nothing, Cancel keeps it, the removal is logged", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    const [account] = await maskedAccounts(db, w.orgId);
    const id = account?.id ?? "";
    const before = await snapshot(w.orgId);
    const first = await post(cookie, { action: "remove-account", org: w.orgId, accountId: id });
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain("Remove the account ending 773?");
    expect(html).toContain("Confirm removal");
    expect(html).toMatch(/<a[^>]*href="\/protect"[^>]*>\s*Cancel/);
    expect(html).toContain('value="confirm-remove-account"');
    noDigits(html);
    expect(await snapshot(w.orgId)).toBe(before);
    // Cancel is the page itself.
    expect(await (await get(cookie)).text()).toContain("•••• 773");
    expect(await snapshot(w.orgId)).toBe(before);

    const landed = await act(cookie, { action: "confirm-remove-account", org: w.orgId, accountId: id });
    expect(landed.html).toContain("The account is removed, and the removal is logged.");
    expect(landed.html).toContain("No bank accounts yet");
    expect(await maskedAccounts(db, w.orgId)).toEqual([]);
    const removed = (await events(w.orgId)).filter((e) => e.kind === "bank.removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.detail).toMatchObject({ accountId: id, last3: "773" });
    expect(removed[0]?.actor).not.toBe("");
  });

  it("states the privacy promise beside the bank fields", async () => {
    const w = await registered();
    const html = await (await get(w.viewer.cookie)).text();
    expect(html).toContain(
      "We never show your account number to anyone checking a payment. They only see whether it matches.",
    );
    expect(html).toContain("Removing an account asks you to confirm and is logged.");
  });
});

// The identity form's revision, and the stored names it shows, as a browser would send them back.
const versionOf = (html: string) => /name="version" value="(\d+)"/.exec(html)?.[1] ?? "";
// The revision the identity form itself carries (the logo form's comes first on the page and follows the store).
const savedFrom = (html: string) => /id="identity-form"[\s\S]*?name="version" value="(\d+)"/.exec(html)?.[1] ?? "";
const namesIn = (html: string) =>
  (/<textarea[^>]*name="tradingNames"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("two tabs on one identity", () => {
  it("keeps the drawn revision through a refusal, so correcting it cannot overwrite another tab's change (round 1)", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    const a = await (await get(cookie)).text();
    // Tab B changes the contact.
    await act(cookie, SAVE(w.orgId, { tradingNames: "KC Express", contact: w.other, protected: "on" }));
    // Tab A, drawn before, sends a malformed name: refused on its field, under the revision A was drawn from.
    let res = await post(
      cookie,
      SAVE(w.orgId, { tradingNames: "!!!", contact: w.contact, protected: "on", version: versionOf(a) }),
    );
    expect(res.status).toBe(422);
    const refused = await res.text();
    expect(savedFrom(refused)).toBe(savedFrom(a));
    expect(refused).toContain("data-unsaved-retained");
    // A corrects the name and saves from that page: a conflict, and B's contact stays.
    res = await post(
      cookie,
      SAVE(w.orgId, { tradingNames: "KC Express", contact: w.contact, protected: "on", version: savedFrom(refused) }),
    );
    expect(res.status).toBe(409);
    expect((await getIdentity(db, w.orgId))?.financeContact).toBe(w.other);
  });

  it("refuses a change that names no revision, or a malformed one, as stale (round 1)", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    await storeLogo(env.ARTEFACTS, db, w.orgId, "owner", await png(), "image/png");
    const before = await snapshot(w.orgId);
    for (const version of [OMIT, "", "abc", "-1"]) {
      for (const fields of [
        SAVE(w.orgId, { tradingNames: "Renamed", contact: w.contact, protected: "on", version }),
        { action: "logo", org: w.orgId, logo: file(SVG, "logo.svg", "image/svg+xml"), version },
        { action: "remove-logo", org: w.orgId, version },
      ]) {
        const res = await post(cookie, fields);
        expect(res.status, `${fields.action} ${JSON.stringify(version)}`).toBe(409);
      }
    }
    expect(await snapshot(w.orgId)).toBe(before);
  });

  it("refuses a save drawn from an old revision, keeping what was typed, after a contact change, a protection switch and a first registration elsewhere", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    const a = await (await get(cookie)).text();
    const b = await (await get(cookie)).text();
    expect(versionOf(a)).toBe(versionOf(b));
    // Tab B changes the contact; tab A, still showing the old one, saves a rename.
    // Tab B's form carries its own names, as the page drew them.
    await act(
      cookie,
      SAVE(w.orgId, { tradingNames: "KC Express", contact: w.other, protected: "on", version: versionOf(b) }),
    );
    const res = await post(
      cookie,
      SAVE(w.orgId, { tradingNames: "Typed In A", contact: w.contact, protected: "on", version: versionOf(a) }),
    );
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain(STALE_WORDS);
    expect(namesIn(html)).toBe("Typed In A");
    // The page shows what is stored now (the contact B chose is not overwritten) under a revision that now saves.
    expect((await getIdentity(db, w.orgId))?.financeContact).toBe(w.other);
    expect((await getIdentity(db, w.orgId))?.displayNames).toEqual(["Karoo Couriers (Pty) Ltd", "KC Express"]);
    expect(versionOf(html)).not.toBe(versionOf(a));
    // Tab B switches protection off; the old tab A cannot switch it back on over that.
    const c = await (await get(cookie)).text();
    await act(cookie, SAVE(w.orgId, { contact: w.other, version: versionOf(c) }));
    const again = await post(cookie, SAVE(w.orgId, { contact: w.other, protected: "on", version: versionOf(c) }));
    expect(again.status).toBe(409);
    expect(await again.text()).toContain(STALE_WORDS);
    expect((await getIdentity(db, w.orgId))?.protected).toBe(false);
    // A save that carries the revision the page now shows goes through.
    const fresh = versionOf(await (await get(cookie)).text());
    expect((await post(cookie, SAVE(w.orgId, { contact: w.other, protected: "on", version: fresh }))).status).toBe(303);
    expect((await getIdentity(db, w.orgId))?.protected).toBe(true);
  });

  it("refuses a first registration from a tab drawn before another tab registered", async () => {
    const w = await world();
    const { cookie } = w.owner;
    const a = await (await get(cookie)).text();
    const b = await (await get(cookie)).text();
    expect(versionOf(a)).toBe("0");
    await act(cookie, SAVE(w.orgId, { tradingNames: "From B", contact: w.contact, version: versionOf(b) }));
    const res = await post(cookie, SAVE(w.orgId, { tradingNames: "From A", contact: w.other, version: versionOf(a) }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(STALE_WORDS);
    expect(await getIdentity(db, w.orgId)).toMatchObject({
      displayNames: ["Karoo Couriers (Pty) Ltd", "From B"],
      financeContact: w.contact,
    });
  });

  it("refuses removing or replacing a logo from a tab drawn before the logo was replaced in another", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    await storeLogo(env.ARTEFACTS, db, w.orgId, "owner", await png(), "image/png");
    const a = await (await get(cookie)).text();
    const b = await (await get(cookie)).text();
    // Tab B replaces the logo with an SVG.
    const replaced = await post(cookie, {
      action: "logo",
      org: w.orgId,
      version: versionOf(b),
      logo: file(SVG, "logo.svg", "image/svg+xml"),
    });
    expect(replaced.status).toBe(303);
    const keep = (await getIdentity(db, w.orgId))?.logo;
    expect(keep?.mediaType).toBe("image/svg+xml");
    // Tab A, still showing the PNG, removes it, and replaces it: both refused, the SVG stays.
    let res = await post(cookie, { action: "remove-logo", org: w.orgId, version: versionOf(a) });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(STALE_WORDS);
    res = await post(cookie, {
      action: "logo",
      org: w.orgId,
      version: versionOf(a),
      logo: file(await png(), "logo.png", "image/png"),
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(STALE_WORDS);
    expect((await getIdentity(db, w.orgId))?.logo).toEqual(keep);
    expect((await env.ARTEFACTS.list({ prefix: `ident/${w.orgId}/` })).objects).toHaveLength(1);
    // The same tab with the revision it now shows removes it.
    const fresh = versionOf(await (await get(cookie)).text());
    expect((await post(cookie, { action: "remove-logo", org: w.orgId, version: fresh })).status).toBe(303);
    expect((await getIdentity(db, w.orgId))?.logo).toBeNull();
  });
});

describe("clearing the finance contact", () => {
  it("offers 'No finance contact', clears a saved contact with protection off and reads it back, and lets the service refuse it with protection on", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    const html = await (await get(cookie)).text();
    expect(html).toContain("No finance contact");
    expect(html).toMatch(/<input[^>]*id="contact-none"[^>]*value=""/);
    // With protection still on, clearing is refused by the service, on the protection field, and nothing changes.
    const refused = await post(cookie, SAVE(w.orgId, { contact: "", protected: "on" }));
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("Protection needs a finance contact");
    expect((await getIdentity(db, w.orgId))?.financeContact).toBe(w.contact);
    // Switched off, it clears and the fresh page ticks "No finance contact".
    const done = await act(cookie, SAVE(w.orgId, { contact: "" }));
    expect((await getIdentity(db, w.orgId))?.financeContact).toBeNull();
    expect(done.html).toMatch(/id="contact-none"[^>]*checked|checked[^>]*id="contact-none"/);
    expect(done.html).not.toMatch(new RegExp(`value="${w.contact}"[^>]*checked|checked[^>]*value="${w.contact}"`));
    expect(done.html).toContain("Not protected");
  });
});

describe("trading names, one per line", () => {
  it("stores a name with a comma whole and reads it back, and keeps a stored comma name through an unrelated save", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    const typed = "Smith, Jones & Partners\r\nKC Express\r\n\r\n  Karoo Express  ";
    const done = await act(cookie, SAVE(w.orgId, { tradingNames: typed, contact: w.contact, protected: "on" }));
    expect((await getIdentity(db, w.orgId))?.displayNames).toEqual([
      "Karoo Couriers (Pty) Ltd",
      "Smith, Jones & Partners",
      "KC Express",
      "Karoo Express",
    ]);
    expect(namesIn(done.html)).toBe("Smith, Jones & Partners\nKC Express\nKaroo Express");
    expect(done.html).toContain("One name per line");
    expect(await matches(w.orgId, "smith, jones & partners")).toHaveLength(1);
    // An unrelated save, sent exactly as the page shows its names, changes none of them.
    const html = await (await get(cookie)).text();
    await act(cookie, SAVE(w.orgId, { tradingNames: namesIn(html), contact: w.other, protected: "on" }));
    expect((await getIdentity(db, w.orgId))?.displayNames).toEqual([
      "Karoo Couriers (Pty) Ltd",
      "Smith, Jones & Partners",
      "KC Express",
      "Karoo Express",
    ]);
  });

  it("keeps a comma name stored through the service when the page saves something else", async () => {
    const w = await world();
    await setIdentity(db, w.orgId, "owner", {
      displayNames: ["Karoo Couriers (Pty) Ltd", "Karoo, Cape & Co"],
      financeContact: w.contact,
      protected: false,
    });
    const html = await (await get(w.owner.cookie)).text();
    expect(namesIn(html)).toBe("Karoo, Cape & Co");
    await act(w.owner.cookie, SAVE(w.orgId, { tradingNames: namesIn(html), contact: w.contact, protected: "on" }));
    expect(await getIdentity(db, w.orgId)).toMatchObject({
      displayNames: ["Karoo Couriers (Pty) Ltd", "Karoo, Cape & Co"],
      protected: true,
    });
  });

  it("shows a member the trading names one to a line item", async () => {
    const w = await registered("member");
    const html = await (await get(w.viewer.cookie)).text();
    expect(html).toContain("<li");
    expect(html).toContain("KC Express");
  });
});

describe("an outcome that cannot be known", () => {
  it("says the save could not be confirmed, not that nothing changed, when the read after its commit fails, and the stored state is the new one", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    // The second read of the identity row in this request is setIdentity's read after its batch has committed. The
    // revision is named first, so the helper's own read is not counted.
    const version = String((await getIdentity(db, w.orgId))?.version ?? 0);
    const real = db.prepare.bind(db);
    let reads = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/^SELECT \* FROM identities WHERE org_id/.test(sql) && ++reads === 2) throw new Error("read-back down");
      return real(sql);
    });
    const res = await post(
      cookie,
      SAVE(w.orgId, { tradingNames: "Committed Name", contact: w.contact, protected: "on", version }),
    );
    vi.restoreAllMocks();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain(UNCERTAIN_WORDS);
    expect(html.toLowerCase()).not.toContain("nothing was changed");
    expect(namesIn(html)).toBe("Committed Name");
    expect((await getIdentity(db, w.orgId))?.displayNames).toEqual(["Karoo Couriers (Pty) Ltd", "Committed Name"]);
    expect((await events(w.orgId)).map((e) => e.kind)).toContain("identity.set");
  });
});

describe("the registered-name hint and the protection band follow the state", () => {
  const hint = (html: string) =>
    /This is your organisation&#39;s name\.[^<]*/.exec(html)?.[0] ??
    /This is your organisation's name\.[^<]*/.exec(html)?.[0] ??
    "";

  it("says the name is protected only while protection is effective, and that it will be once protection is on otherwise", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    expect(hint(await (await get(cookie)).text())).toMatch(/It is protected\./);
    expect(hint(await (await get(cookie)).text())).not.toMatch(/will be/);
    // Switched off.
    await act(cookie, SAVE(w.orgId, { contact: w.contact }));
    expect(hint(await (await get(cookie)).text())).toMatch(/It will be protected once protection is on\./);
    // Paused: switched on but the contact's address is no longer verified.
    await act(cookie, SAVE(w.orgId, { contact: w.contact, protected: "on" }));
    await db.prepare("DELETE FROM org_addresses WHERE org_id = ? AND address = ?").bind(w.orgId, w.contact).run();
    const paused = await (await get(cookie)).text();
    expect(paused).toContain("Protection is paused");
    expect(hint(paused)).toMatch(/It will be protected once protection is on\./);
    expect(hint(paused)).not.toMatch(/It is protected/);
    // A first visit.
    const fresh = await world();
    expect(hint(await (await get(fresh.owner.cookie)).text())).toMatch(/It will be protected once protection is on\./);
  });

  it("draws the band in the board's colours with the identity-status mark: safe when protected, suspicious when paused, plain when off", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    const band = (html: string) => /<section aria-label="Protection status"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    const on = band(await (await get(cookie)).text());
    expect(on).toContain("bg-safe-band");
    expect(on).toContain("text-on-band");
    expect(on).toContain("bg-on-band");
    expect(on).toMatch(/<img src="\/static\/brand\/motion\/safe\.[0-9a-f]+\.svg" alt=""/);
    expect(on).not.toContain("safe-wash");
    await db.prepare("DELETE FROM org_addresses WHERE org_id = ? AND address = ?").bind(w.orgId, w.contact).run();
    const paused = band(await (await get(cookie)).text());
    expect(paused).toContain("bg-sus-band");
    expect(paused).toMatch(/motion\/suspicious\.[0-9a-f]+\.svg/);
    await act(cookie, SAVE(w.orgId, { contact: w.other }));
    const off = band(await (await get(cookie)).text());
    expect(off).toContain("Not protected");
    expect(off).not.toContain("-band ");
  });
});

describe("every action ends in a plain outcome", () => {
  it("refuses a duplicate account, an account under other keys, and an account gone before its confirmation, never echoing a number", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    const before = await snapshot(w.orgId);
    let res = await post(cookie, ACCOUNT(w.orgId, { accountNumber: NUMBER }));
    expect(res.status).toBe(422);
    let html = await res.text();
    expect(html).toContain("This account is already registered.");
    noDigits(html);
    expect(await snapshot(w.orgId)).toBe(before);

    // An account kept under other keys: adding is refused until the registry is moved.
    const other = await org("Other Keys Freight");
    const rekeyed = await bankKeys({
      BANK_KEY: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i + 9) & 255))),
      BANK_MATCH_KEY: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 5 + 9) & 255))),
    });
    await db.exec("DELETE FROM bank_accounts");
    await db.exec("DELETE FROM bank_key_epoch");
    await addAccount(db, rekeyed, other, "owner", {
      number: "1234567890",
      branchCode: "250655",
      bankName: "Elsewhere",
      holder: "Other",
    });
    try {
      res = await post(cookie, ACCOUNT(w.orgId, { accountNumber: "7766554433" }));
      html = await res.text();
      expect(res.status).toBe(409);
      expect(html).toContain("being moved to a new key");
      expect(html).not.toContain("7766554433");
      expect(await maskedAccounts(db, w.orgId)).toEqual([]);
    } finally {
      await db.exec("DELETE FROM bank_accounts");
      await db.exec("DELETE FROM bank_key_epoch");
    }
  });

  it("says an account is already gone when it was removed before its confirmation", async () => {
    const w = await registered();
    const [account] = await maskedAccounts(db, w.orgId);
    const id = account?.id ?? "";
    const first = await post(w.viewer.cookie, { action: "remove-account", org: w.orgId, accountId: id });
    expect(first.status).toBe(200);
    await db.prepare("DELETE FROM bank_accounts WHERE id = ?").bind(id).run();
    const eventsBefore = (await events(w.orgId)).length;
    const landed = await act(w.viewer.cookie, { action: "confirm-remove-account", org: w.orgId, accountId: id });
    expect(landed.html).toContain("That account was already removed. Nothing else changed.");
    expect(landed.html).not.toContain("the removal is logged");
    expect((await events(w.orgId)).length).toBe(eventsBefore);
    const again = await act(w.viewer.cookie, { action: "remove-account", org: w.orgId, accountId: id });
    expect(again.html).toContain("already removed");
  });

  it("says an identity or logo changed meanwhile, keeping what was typed and changing nothing", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    await storeLogo(env.ARTEFACTS, db, w.orgId, "owner", await png(), "image/png");
    const before = await snapshot(w.orgId);
    await loseRace();
    let res = await post(cookie, SAVE(w.orgId, { tradingNames: "Typed Name", contact: w.contact, protected: "on" }));
    expect(res.status).toBe(409);
    let html = await res.text();
    expect(html).toContain("Your identity was changed while you were editing, so nothing was saved.");
    expect(namesIn(html)).toBe("Typed Name");
    res = await post(cookie, { action: "logo", org: w.orgId, logo: file(SVG, "logo.svg", "image/svg+xml") });
    expect(res.status).toBe(409);
    html = await res.text();
    expect(html).toContain("The logo was changed while you were here, so nothing was saved.");
    res = await post(cookie, { action: "remove-logo", org: w.orgId });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("so nothing was removed");
    await db.exec("DROP TRIGGER lose_race");
    expect(await snapshot(w.orgId)).toBe(before);
  });

  it("answers a failing database with its own message and a way to retry, changing nothing", async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    await storeLogo(env.ARTEFACTS, db, w.orgId, "owner", await png(), "image/png");
    const before = await snapshot(w.orgId);
    await failEvents();
    let res = await post(cookie, SAVE(w.orgId, { tradingNames: "Typed Name", contact: w.contact, protected: "on" }));
    expect(res.status).toBe(503);
    let html = await res.text();
    expect(html).toContain(UNCERTAIN_WORDS);
    expect(namesIn(html)).toBe("Typed Name");
    expect(html).not.toContain("Your identity is saved.");

    res = await post(cookie, ACCOUNT(w.orgId, { accountNumber: "5544332211", holder: "Typed Holder" }));
    expect(res.status).toBe(503);
    html = await res.text();
    expect(html).toContain(UNCERTAIN_WORDS);
    expect(html).toContain('value="Typed Holder"');
    expect(html).not.toContain("5544332211");

    res = await post(cookie, { action: "logo", org: w.orgId, logo: file(SVG, "logo.svg", "image/svg+xml") });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(UNCERTAIN_WORDS);

    const [account] = await maskedAccounts(db, w.orgId);
    res = await post(cookie, { action: "confirm-remove-account", org: w.orgId, accountId: account?.id ?? "" });
    expect(res.status).toBe(303);
    expect(target(res)).toContain("r=unavailable");
    const landed = await (await get(cookie, target(res) ?? "")).text();
    expect(landed).toContain(UNCERTAIN_WORDS);
    expect(landed).toContain("•••• 773");

    res = await post(cookie, { action: "remove-logo", org: w.orgId });
    expect(res.status).toBe(303);
    expect(target(res)).toContain("r=unavailable");
    expect(await snapshot(w.orgId)).toBe(before);
  });

  it("answers a failing logo store with its own message and leaves no object behind", async () => {
    const w = await registered();
    const before = await snapshot(w.orgId);
    vi.spyOn(env.ARTEFACTS, "put").mockRejectedValue(new Error("r2 down"));
    const res = await post(w.viewer.cookie, {
      action: "logo",
      org: w.orgId,
      logo: file(SVG, "logo.svg", "image/svg+xml"),
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(UNCERTAIN_WORDS);
    vi.restoreAllMocks();
    expect(await snapshot(w.orgId)).toBe(before);
  });

  it("answers a logo that cannot be read from storage as an outage, not an empty image", async () => {
    const w = await registered();
    await storeLogo(env.ARTEFACTS, db, w.orgId, "owner", await png(), "image/png");
    vi.spyOn(env.ARTEFACTS, "get").mockRejectedValue(new Error("r2 down"));
    const res = await get(w.viewer.cookie, "/protect/logo");
    expect(res.status).toBe(503);
    vi.restoreAllMocks();
    // A reference to an object that is missing is a 404.
    await env.ARTEFACTS.delete((await getIdentity(db, w.orgId))?.logo?.key ?? "");
    expect((await get(w.viewer.cookie, "/protect/logo")).status).toBe(404);
  });
});

type Case = {
  action: string;
  fields: (w: Awaited<ReturnType<typeof registered>>, accountId: string) => Fields;
  account?: true;
};
const CASES: Case[] = [
  {
    action: "save",
    fields: (w) => SAVE(w.orgId, { tradingNames: "Matrix Name", contact: w.contact, protected: "on" }),
  },
  { action: "logo", fields: (w) => ({ action: "logo", org: w.orgId, logo: file(SVG, "logo.svg", "image/svg+xml") }) },
  { action: "remove-logo", fields: (w) => ({ action: "remove-logo", org: w.orgId }) },
  { action: "add-account", fields: (w) => ACCOUNT(w.orgId, { accountNumber: "9900112233" }) },
  {
    action: "remove-account",
    account: true,
    fields: (w, id) => ({ action: "remove-account", org: w.orgId, accountId: id }),
  },
  {
    action: "confirm-remove-account",
    account: true,
    fields: (w, id) => ({ action: "confirm-remove-account", org: w.orgId, accountId: id }),
  },
];

describe("the guards of every mutation", () => {
  for (const c of CASES)
    it(`${c.action}: refused for a member, a foreign site, a stale organisation, a foreign account, no session, an unreadable plan and a plan without it, changing nothing; done for an owner and an admin`, async () => {
      const w = await registered();
      await storeLogo(env.ARTEFACTS, db, w.orgId, "owner", await png(), "image/png");
      const admin = await person(w.orgId, "admin");
      const member = await person(w.orgId, "member");
      const [account] = await maskedAccounts(db, w.orgId);
      const id = account?.id ?? "";
      const fields = c.fields(w, id);
      const before = await snapshot(w.orgId);
      const unchanged = async (label: string) => expect(await snapshot(w.orgId), label).toBe(before);

      let res = await post(member.cookie, fields);
      expect(res.status, "member").toBe(403);
      expect(await res.text()).toContain("Only an owner or admin changes your identity.");
      await unchanged("member");

      res = await post(w.owner.cookie, fields, { origin: "https://evil.example" });
      expect(res.status, "foreign origin").toBe(403);
      await unchanged("foreign origin");

      // The form was drawn for this organisation, then the owner switched to another.
      const elsewhere = await org("Elsewhere Freight");
      const switcher = await person(elsewhere, "owner");
      await db
        .prepare(
          `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'owner', ?)`,
        )
        .bind(`m-${crypto.randomUUID()}`, w.orgId, await userId(switcher.email), new Date().toISOString())
        .run();
      const otherBefore = await snapshot(elsewhere);
      res = await post(switcher.cookie, fields);
      expect(res.status, "stale organisation").toBe(303);
      expect(target(res)).toContain("r=switched");
      expect(await (await get(switcher.cookie, target(res) ?? "")).text()).toContain(
        "Your organisation changed in another tab",
      );
      await unchanged("stale organisation");
      expect(await snapshot(elsewhere)).toBe(otherBefore);

      if (c.account) {
        const foreign = await org("Foreign Accounts");
        const foreignAccount = await addAccount(db, await bankKeys(env), foreign, "owner", {
          number: "5566778899",
          branchCode: "250655",
          bankName: "Foreign Bank",
          holder: "Foreign",
        });
        const foreignBefore = await snapshot(foreign);
        res = await post(w.owner.cookie, { ...fields, accountId: foreignAccount.id });
        expect(res.status, "foreign account").toBe(303);
        expect(target(res)).toContain("r=account-gone");
        await unchanged("foreign account");
        expect(await snapshot(foreign)).toBe(foreignBefore);
      }

      res = await post(undefined, fields);
      expect(res.status, "anonymous").toBe(303);
      expect(target(res)).toMatch(/^\/signin/);
      await unchanged("anonymous");

      await db.prepare(`UPDATE "organization" SET "createdAt" = 'not a date' WHERE id = ?`).bind(w.orgId).run();
      res = await post(w.owner.cookie, fields);
      expect(res.status, "unreadable plan").toBe(503);
      await unchanged("unreadable plan");
      await db
        .prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`)
        .bind(new Date().toISOString(), w.orgId)
        .run();

      await setPlan(db, w.orgId, "free");
      res = await post(w.owner.cookie, fields);
      expect(res.status, "free plan").toBe(403);
      expect(await res.text()).toContain("part of the Protect plan");
      await unchanged("free plan");
      await setPlan(db, w.orgId, "protect");

      // An admin and then the owner succeed.
      for (const who of [admin, w.owner]) {
        res = await post(
          who.cookie,
          c.action === "add-account" && who === w.owner ? ACCOUNT(w.orgId, { accountNumber: "9900112244" }) : fields,
        );
        expect(res.status, `${who.email} succeeds`).toBe(c.action === "remove-account" ? 200 : 303);
        if (res.status === 303) expect(target(res)).not.toMatch(/r=(unavailable|switched)/);
      }
      if (c.action !== "remove-account") expect(await snapshot(w.orgId)).not.toBe(before);
    });

  it("answers 400 to a body that is not a form, changing nothing", async () => {
    const w = await registered();
    const before = await snapshot(w.orgId);
    const res = await call("/protect", {
      method: "POST",
      headers: { ...HTML, cookie: w.viewer.cookie, "content-type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(400);
    expect(await snapshot(w.orgId)).toBe(before);
  });
});

describe("the plan gate", () => {
  it("gives a free and an expired organisation the plan refusal on the page and every post, and a trial and a Protect organisation the page", async () => {
    const free = await registered();
    await setPlan(db, free.orgId, "free");
    const expired = await registered();
    await db
      .prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 40 * 86_400_000).toISOString(), expired.orgId)
      .run();
    for (const w of [free, expired]) {
      const before = await snapshot(w.orgId);
      const res = await get(w.viewer.cookie);
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("A protected identity is part of the Protect plan.");
      expect(html).not.toContain('name="tradingNames"');
      const posted = await post(
        w.viewer.cookie,
        SAVE(w.orgId, { tradingNames: "Nope", contact: w.contact, protected: "on" }),
      );
      expect(posted.status).toBe(403);
      expect(await snapshot(w.orgId)).toBe(before);
    }
    const trial = await world();
    expect((await get(trial.owner.cookie)).status).toBe(200);
    expect((await act(trial.owner.cookie, SAVE(trial.orgId, { contact: trial.contact, protected: "on" }))).status).toBe(
      200,
    );
    const paid = await world();
    await setPlan(db, paid.orgId, "protect");
    expect((await get(paid.owner.cookie)).status).toBe(200);
    await setPlan(db, paid.orgId, "msp");
    expect((await get(paid.owner.cookie)).status).toBe(200);
  });

  it("answers an unreadable plan with the outage page on the page itself", async () => {
    const w = await registered();
    await db.prepare(`UPDATE "organization" SET "createdAt" = 'not a date' WHERE id = ?`).bind(w.orgId).run();
    const res = await get(w.viewer.cookie);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Sorry, something broke on our side.");
  });

  it("sends an anonymous visitor to sign in and a visitor with no organisation to the not-a-member page", async () => {
    const res = await get(undefined);
    expect(res.status).toBe(303);
    expect(target(res)).toBe("/signin?next=%2Fprotect");
    const { cookie } = await signIn(`idp-${tag()}@demo.isitlegit.co.za`);
    vi.restoreAllMocks();
    const none = await get(cookie);
    expect(none.status).toBe(403);
  });
});

// Latency of the page's paths (completion review E4), behind IDENTITY_BENCH:
// `IDENTITY_BENCH=1 pnpm exec vitest run test/web/identity-page.test.ts -t timings --silent=false --reporter=verbose`.
// Local workerd and D1, not a phone; the targets are the review's: p95 usable render and save confirmation under 2 s.
describe.skipIf(!(env as unknown as { IDENTITY_BENCH?: string }).IDENTITY_BENCH)("identity page timings", () => {
  const pct = (values: number[], p: number) =>
    Math.round(
      [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1)
      ] as number,
    );
  // A grey PNG of random pixels, so it compresses to about its raw size: near the 2 MiB limit.
  async function bigPng(side: number): Promise<Uint8Array> {
    const raw = new Uint8Array((1 + side) * side);
    for (let i = 0; i < raw.length; i += 65536)
      crypto.getRandomValues(raw.subarray(i, Math.min(raw.length, i + 65536)));
    for (let row = 0; row < side; row++) raw[row * (side + 1)] = 0;
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
    const idat = new Uint8Array(await new Response(stream).arrayBuffer());
    const ihdr = Uint8Array.from([...be32(side), ...be32(side), 8, 0, 0, 0, 0]);
    return Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...chunk("IHDR", ihdr),
      ...chunk("IDAT", idat),
      ...chunk("IEND", new Uint8Array()),
    ]);
  }
  it("times render, save and the largest logo", { timeout: 300_000 }, async () => {
    const w = await registered();
    const { cookie } = w.viewer;
    const time = async (run: () => Promise<Response>, status: number) => {
      const started = performance.now();
      const res = await run();
      await res.arrayBuffer();
      const ms = performance.now() - started;
      expect(res.status).toBe(status);
      return ms;
    };
    const render: number[] = [];
    const save: number[] = [];
    for (let i = 0; i < 30; i++) render.push(await time(() => get(cookie), 200));
    for (let i = 0; i < 30; i++)
      save.push(
        await time(
          () => post(cookie, SAVE(w.orgId, { tradingNames: `KC Express ${i}`, contact: w.contact, protected: "on" })),
          303,
        ),
      );
    const big = await bigPng(1400);
    expect(big.length).toBeGreaterThan(1_900_000);
    expect(big.length).toBeLessThan(2 * 1024 * 1024);
    const logo: number[] = [];
    for (let i = 0; i < 5; i++)
      logo.push(
        await time(() => post(cookie, { action: "logo", org: w.orgId, logo: file(big, "big.png", "image/png") }), 303),
      );
    const damaged = big.slice();
    damaged.fill(0xff, 40, 4000);
    const refused: number[] = [];
    for (let i = 0; i < 5; i++)
      refused.push(
        await time(
          () => post(cookie, { action: "logo", org: w.orgId, logo: file(damaged, "bad.png", "image/png") }),
          422,
        ),
      );
    const report = {
      renderMs: { p50: pct(render, 50), p95: pct(render, 95) },
      saveMs: { p50: pct(save, 50), p95: pct(save, 95) },
      logoBytes: big.length,
      logoAcceptedMs: { p50: pct(logo, 50), p95: pct(logo, 95) },
      logoRefusedMs: { p50: pct(refused, 50), p95: pct(refused, 95) },
    };
    console.log(`IDENTITY_BENCH ${JSON.stringify(report)}`);
    expect(report.renderMs.p95).toBeLessThan(2500);
    expect(report.saveMs.p95).toBeLessThan(2000);
  });
});

describe("the public page address (D05 T02 §6)", () => {
  const slugOf = async (orgId: string) =>
    (await db.prepare("SELECT public_slug, public_slug_changed FROM identities WHERE org_id = ?").bind(orgId).first<{
      public_slug: string | null;
      public_slug_changed: number;
    }>()) ?? { public_slug: null, public_slug_changed: 0 };

  it("shows the address, changes it once with its warning, refuses a taken one keeping the allowance, and then a second", async () => {
    const w = await registered();
    const other = await registered();
    const before = await slugOf(w.orgId);
    const page = await (await get(w.owner.cookie)).text();
    expect(page).toContain(`https://isitlegit.co.za/v/${before.public_slug}`);
    expect(page).toContain("You can change this once. Links to the old address stop working");
    const taken = await post(w.owner.cookie, {
      action: "change-slug",
      org: w.orgId,
      slug: (await slugOf(other.orgId)).public_slug as string,
    });
    expect(taken.status).toBe(422);
    expect(await taken.text()).toContain("That address is taken. Choose another.");
    expect((await slugOf(w.orgId)).public_slug_changed).toBe(0);
    const wanted = `kc-${tag()}`;
    const done = await act(w.owner.cookie, { action: "change-slug", org: w.orgId, slug: wanted });
    expect(done.html).toContain("Your public page address is changed.");
    expect(done.html).toContain(`https://isitlegit.co.za/v/${wanted}`);
    expect(done.html).toContain("This address has already been changed once, so it stays as it is.");
    expect((await call(`/v/${before.public_slug}`, { headers: HTML }, authEnv)).status).toBe(404);
    const again = await post(w.owner.cookie, { action: "change-slug", org: w.orgId, slug: `kc2-${tag()}` });
    expect(again.status).toBe(422);
    expect(await again.text()).toContain("has already been changed once");
    expect((await slugOf(w.orgId)).public_slug).toBe(wanted);
  });

  it("says an unchanged address changed nothing, and that a protected identity's address is being prepared", async () => {
    const w = await registered();
    const current = (await slugOf(w.orgId)).public_slug as string;
    const same = await act(w.owner.cookie, { action: "change-slug", org: w.orgId, slug: current });
    expect(same.html).toContain("Your public page address is unchanged");
    expect((await slugOf(w.orgId)).public_slug_changed).toBe(0);
    await db.prepare("UPDATE identities SET public_slug = NULL WHERE org_id = ?").bind(w.orgId).run();
    expect(await (await get(w.owner.cookie)).text()).toContain("Your public page address is being prepared");
  });

  it("lets one of two concurrent changes through, and refuses a member", async () => {
    const w = await registered();
    const results = await Promise.all([
      post(w.owner.cookie, { action: "change-slug", org: w.orgId, slug: `one-${tag()}` }),
      post(w.owner.cookie, { action: "change-slug", org: w.orgId, slug: `two-${tag()}` }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([303, 422]);
    const m = await registered("member");
    const refused = await post(m.viewer.cookie, { action: "change-slug", org: m.orgId, slug: `three-${tag()}` });
    expect(refused.status).toBe(403);
    expect((await slugOf(m.orgId)).public_slug_changed).toBe(0);
  });
});
