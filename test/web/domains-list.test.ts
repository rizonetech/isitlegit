import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { memberOfSender } from "../../src/auth/senders";
import { getIdentity } from "../../src/trust/identity";
import { monthStart, provedText } from "../../src/web/pages/domains-list-view";
import { authEnv, call, ORIGIN, signIn, target } from "../auth/helpers";

// The Domains and addresses page (D07 T04 §4; board `Domains`): the organisation's two lists for every role, add and
// remove through the JSON routes in process, what a removal really changes read back, and every other answer of a change
// drawn from the stored state.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

const tag = () => crypto.randomUUID().slice(0, 8);
const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id as string;
async function person(name: string) {
  const email = `dom-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const id = await userId(email);
  await db.prepare(`UPDATE "user" SET name = ? WHERE id = ?`).bind(name, id).run();
  return { cookie, email, id, name };
}
async function organisation(owner: { id: string }, name = "Karoo Couriers") {
  const made = (await createAuth(authEnv).api.createOrganization({
    body: { name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${tag()}`, userId: owner.id },
  })) as { id: string };
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(made.id, owner.id).run();
  return made.id;
}
async function join(orgId: string, who: { id: string }, role: "owner" | "admin" | "member") {
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${tag()}${tag()}`, orgId, who.id, role, new Date().toISOString())
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, who.id).run();
}
const now = () => new Date().toISOString();
const verifiedDomain = (
  orgId: string,
  domain: string,
  method: "dns" | "email" = "dns",
  at = "2026-10-12T08:00:00.000Z",
) =>
  db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, 'tttttttttttttttt', 'verified', ?, ?, ?)",
    )
    .bind(`d-${tag()}`, orgId, domain, method, at, now())
    .run();
const pendingDomain = (orgId: string, domain: string) =>
  db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, 'tttttttttttttttt', 'pending', ?)",
    )
    .bind(`d-${tag()}`, orgId, domain, now())
    .run();
const address = (orgId: string, addr: string, state: "pending" | "verified" = "verified") =>
  db
    .prepare(
      "INSERT INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(`a-${tag()}`, orgId, addr, state, state === "verified" ? "2026-10-14T08:00:00.000Z" : null, now())
    .run();
const caseFrom = (orgId: string, from: string, at = new Date().toISOString()) =>
  db
    .prepare(
      "INSERT INTO cases (id, org_id, channel, status, headers_available, created_at, updated_at, forwarded_by, source_kind) VALUES (?, ?, 'email', 'done', 1, ?, ?, ?, 'mail')",
    )
    .bind(`c-${tag()}${tag()}`, orgId, at, at, from)
    .run();
const protectIdentity = (orgId: string, contact: string) =>
  db
    .prepare(
      "INSERT INTO identities (org_id, display_names_json, finance_contact_email, protected, version, updated_at, updated_by) VALUES (?, '[]', ?, 1, 1, ?, 'test')",
    )
    .bind(orgId, contact, now())
    .run();
const count = async (sql: string, ...binds: unknown[]) =>
  ((
    await db
      .prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0) as number;

const page = async (cookie: string, path = "/settings/domains") => {
  const res = await call(path, { headers: { cookie, accept: "text/html" } });
  return { res, html: await res.text() };
};
const post = (cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) => {
  const headers = new Headers({ cookie, "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
  headers.set("origin", origin ?? "");
  return call("/settings/domains", { method: "POST", headers, body: new URLSearchParams(fields).toString() });
};
const landed = async (cookie: string, res: Response) => {
  expect(res.status).toBe(303);
  return (await page(cookie, target(res) ?? "/settings/domains")).html;
};
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

describe("the lists", () => {
  it("draws both tables, each state's words, the month's cases, and none of another organisation's", async () => {
    const owner = await person("Thandi Nkosi");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "karoocouriers.example", "dns");
    await verifiedDomain(orgId, "mailco.example", "email");
    await pendingDomain(orgId, "kcexpress.example");
    await address(orgId, "karoo.dispatch@mailhost.example");
    await address(orgId, "aaa-waiting@mailhost.example", "pending");
    await caseFrom(orgId, "ayesha@karoocouriers.example");
    await caseFrom(orgId, "sipho@sub.karoocouriers.example");
    await caseFrom(orgId, "KAROO.DISPATCH@mailhost.example");
    // Last month's case and another organisation's case are not counted.
    await caseFrom(orgId, "ayesha@karoocouriers.example", "2020-01-05T10:00:00.000Z");
    const stranger = await person("Not Ours");
    const other = await organisation(stranger, "Elsewhere");
    await verifiedDomain(other, "elsewhere.example");
    await caseFrom(other, "x@karoocouriers.example");
    const { res, html } = await page(owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const t = text(html);
    expect(t).toContain(
      "We accept mail at check@isitlegit.co.za only from addresses Karoo Couriers has proved it owns.",
    );
    expect(t).toContain("karoocouriers.example Verified DNS TXT record, 12 Oct 2026");
    expect(t).toContain(
      "mailco.example Verified A code mailed to the domain's admin@ or postmaster@ address, 12 Oct 2026",
    );
    expect(t).toContain("kcexpress.example Pending Waiting for the TXT record After verifying");
    expect(t).toContain("Anyone @karoocouriers.example The whole domain is verified 2");
    expect(t).toContain("karoo.dispatch@mailhost.example Single address, confirmed by a code on 14 Oct 2026 1");
    expect(t).toContain("aaa-waiting@mailhost.example Waiting for the code 0");
    expect(t).toContain("Mail from any other address never joins Karoo Couriers' cases.");
    expect(t).not.toContain("elsewhere.example");
    expect(t.indexOf("mailco.example Verified")).toBeLessThan(t.indexOf("kcexpress.example Pending"));
    expect(t.indexOf("karoo.dispatch@mailhost.example Single address")).toBeLessThan(
      t.indexOf("aaa-waiting@mailhost.example Waiting"),
    );
    expect(html).toContain('href="/settings/domains/kcexpress.example"');
    expect(html).toContain('href="/settings/domains/remove/karoocouriers.example"');
    expect(html).toContain('aria-current="page"');
    // The forwarding help.
    for (const card of ["Outlook desktop", "Outlook on the web", "Gmail"]) expect(t).toContain(card);
    expect(t).toContain("A normal forward loses them.");
  });

  it("says Protected identity by whether protection holds", async () => {
    const on = await person("On Owner");
    const onOrg = await organisation(on);
    await verifiedDomain(onOrg, "protected.example");
    await address(onOrg, "finance@protected.example");
    await protectIdentity(onOrg, "finance@protected.example");
    expect(text((await page(on.cookie)).html)).toContain("protected.example Verified DNS TXT record, 12 Oct 2026 Yes");
    const off = await person("Off Owner");
    const offOrg = await organisation(off);
    await verifiedDomain(offOrg, "plain.example");
    expect(text((await page(off.cookie)).html)).toContain(
      "plain.example Verified DNS TXT record, 12 Oct 2026 Not set up",
    );
  });

  it("states a pending claim's wait from the read alone, for an owner and an admin, never for a member", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await pendingDomain(orgId, "locked.example");
    const claim = (
      await db.prepare("SELECT id FROM org_domains WHERE domain = 'locked.example'").first<{ id: string }>()
    )?.id;
    const until = new Date(Date.now() + 40 * 60_000).toISOString();
    await db
      .prepare(
        "INSERT INTO verification_codes (claim_id, org_id, code_id, code_hash, expires_at, attempts, locked_until) VALUES (?, ?, 'code-1', ?, ?, 3, ?)",
      )
      .bind(claim, orgId, "h".repeat(64), new Date(Date.now() + 20 * 60_000).toISOString(), until)
      .run();
    const admin = await person("Admin");
    await join(orgId, admin, "admin");
    const member = await person("Member");
    await join(orgId, member, "member");
    for (const who of [owner, admin])
      expect(text((await page(who.cookie)).html)).toMatch(/Locked after wrong codes until \d\d:\d\d SAST/);
    const asMember = text((await page(member.cookie)).html);
    expect(asMember).toContain("locked.example Pending Waiting for the TXT record");
    expect(asMember).not.toContain("Locked after wrong codes");
  });

  it("gives an owner, an admin and a member each their own controls, a member reading both tables", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "karoo.example");
    await address(orgId, "single@mail.example");
    const admin = await person("Admin");
    await join(orgId, admin, "admin");
    const member = await person("Member");
    await join(orgId, member, "member");
    for (const who of [owner, admin]) {
      const h = (await page(who.cookie)).html;
      expect(h).toContain("Add a domain");
      expect(h).toContain('href="/settings/domains/remove/karoo.example"');
      expect(h).toContain('href="/settings/addresses/remove/single%40mail.example"');
    }
    const h = (await page(member.cookie)).html;
    expect(text(h)).toContain("karoo.example Verified");
    expect(text(h)).toContain("single@mail.example");
    expect(h).not.toContain("Add a domain");
    expect(h).not.toContain("/settings/domains/remove/");
    expect(h).not.toContain("/settings/addresses/remove/");
  });

  it("shows an organisation with nothing the empty state, with only the action that works", async () => {
    const owner = await person("Owner");
    await organisation(owner);
    const html = (await page(owner.cookie)).html;
    expect(text(html)).toContain("No mail is accepted yet");
    expect(html).toContain('id="add-domain"');
    expect(html).not.toContain("Add a single address");
    const member = await person("Member");
    await join(
      (await db
        .prepare(`SELECT "organizationId" AS o FROM "member" WHERE "userId" = ?`)
        .bind(owner.id)
        .first<{ o: string }>())!.o,
      member,
      "member",
    );
    const asMember = text((await page(member.cookie)).html);
    expect(asMember).toContain("An owner or admin can add a domain.");
  });

  it("answers no session, no active organisation and a failed read as the Cases list does", async () => {
    const anon = await call("/settings/domains", { headers: { accept: "text/html" } });
    expect(anon.status).toBe(303);
    expect(target(anon)).toBe(`/signin?next=${encodeURIComponent("/settings/domains")}`);
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = NULL WHERE "userId" = ?`).bind(owner.id).run();
    expect((await page(owner.cookie)).res.status).toBe(403);
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, owner.id).run();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("FROM org_domains WHERE org_id = ? ORDER BY state")) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const failed = await page(owner.cookie);
    vi.restoreAllMocks();
    expect(failed.res.status).toBe(503);
    expect(failed.html).toContain('href="/settings/domains"');
  });

  it("words the verification method and counts from the first of the month in SAST", () => {
    expect(
      provedText({
        domain: "x.example",
        state: "verified",
        method: "email",
        verifiedAt: "2026-10-12T08:00:00Z",
        challenge: null,
        protectedIdentity: "Yes",
      }),
    ).toBe("A code mailed to the domain's admin@ or postmaster@ address, 12 Oct 2026");
    // 22:30 UTC on 31 Oct is 00:30 SAST on 1 Nov: November's.
    expect(monthStart(new Date("2026-10-31T22:30:00Z"))).toBe("2026-10-31T22:00:00.000Z");
    expect(monthStart(new Date("2026-10-15T10:00:00Z"))).toBe("2026-09-30T22:00:00.000Z");
  });
});

describe("adding a domain", () => {
  it("adds through the JSON route and lands on the claim page, refusing what cannot be claimed under the field", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const added = await post(owner.cookie, { action: "add", org: orgId, domain: "Mail.NewCo.co.za" });
    expect(added.status).toBe(303);
    expect(target(added)).toBe("/settings/domains/newco.co.za");
    expect(
      await count("SELECT COUNT(*) AS n FROM org_domains WHERE org_id = ? AND domain = 'newco.co.za'", orgId),
    ).toBe(1);
    const bad = await post(owner.cookie, { action: "add", org: orgId, domain: "not a domain" });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(text(badHtml)).toContain("that is not a domain an organisation can claim");
    expect(badHtml).toContain('value="not a domain"');
    // Verified by another organisation: a 409 under the field, what was typed kept.
    const stranger = await person("Other");
    const other = await organisation(stranger, "Other Org");
    await verifiedDomain(other, "taken.co.za");
    const taken = await post(owner.cookie, { action: "add", org: orgId, domain: "taken.co.za" });
    expect(taken.status).toBe(409);
    const takenHtml = await taken.text();
    expect(text(takenHtml)).toContain("that domain is verified by another organisation");
    expect(takenHtml).toContain('value="taken.co.za"');
    expect(await count("SELECT COUNT(*) AS n FROM org_domains WHERE org_id = ?", orgId)).toBe(1);
  });

  it("changes nothing from another origin, none, another organisation's page, or a member's post", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    expect(
      (await post(owner.cookie, { action: "add", org: orgId, domain: "evil.co.za" }, "https://evil.example")).status,
    ).toBe(403);
    expect((await post(owner.cookie, { action: "add", org: orgId, domain: "evil.co.za" }, null)).status).toBe(403);
    const switched = await post(owner.cookie, { action: "add", org: "org-other", domain: "switched.co.za" });
    expect(text(await landed(owner.cookie, switched))).toContain("this page was opened for another organisation");
    const odd = await post(owner.cookie, { action: "promote", org: orgId });
    expect(text(await landed(owner.cookie, odd))).toContain("that request is not one this page sends");
    const big = await call("/settings/domains", {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        origin: ORIGIN,
      },
      body: new URLSearchParams({ action: "add", org: orgId, domain: "big.co.za", pad: "x".repeat(20_000) }).toString(),
    });
    expect(text(await landed(owner.cookie, big))).toContain("that request is not one this page sends");
    const member = await person("Member");
    await join(orgId, member, "member");
    const refused = await post(member.cookie, { action: "add", org: orgId, domain: "member.co.za" });
    expect(refused.status).toBe(403);
    expect(text(await refused.text())).toContain("Only an owner or admin can change what mail is accepted.");
    expect(await count("SELECT COUNT(*) AS n FROM org_domains WHERE org_id = ?", orgId)).toBe(0);
  });

  it("keeps what was typed and says the change could not be confirmed when the JSON route fails, never as added", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "existing.example");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("INSERT INTO org_domains")) throw new Error("D1_ERROR: write lost");
      return prepare(sql);
    });
    const res = await post(owner.cookie, { action: "add", org: orgId, domain: "lost.co.za" });
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(text(html)).toContain("The change to lost.co.za could not be confirmed.");
    expect(text(html)).not.toContain("was added");
    expect(html).toContain('value="lost.co.za"');
    expect(html).toMatch(/<details(?=[^>]*id="add-domain")(?=[^>]*\bopen(?:=|\s|>))[^>]*>/);
    expect(await count("SELECT COUNT(*) AS n FROM org_domains WHERE org_id = ?", orgId)).toBe(1);
  });
});

describe("removing a domain", () => {
  it("asks first, says what really changes, then removes through the JSON route: claim and receivers gone, audited", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "keep.example");
    await verifiedDomain(orgId, "gone.example");
    await address(orgId, "boss@gone.example");
    const claim = (await db.prepare("SELECT id FROM org_domains WHERE domain = 'gone.example'").first<{ id: string }>())
      ?.id;
    await db
      .prepare(
        "INSERT INTO org_receivers (claim_id, org_id, domain, kind, pattern, learned_at) VALUES (?, ?, 'gone.example', 'google', 'google.com', ?)",
      )
      .bind(claim, orgId, now())
      .run();
    const asked = await page(owner.cookie, "/settings/domains/remove/gone.example");
    expect(asked.res.status).toBe(200);
    expect(text(asked.html)).toContain("Remove gone.example?");
    expect(text(asked.html)).toContain("except from an address you proved separately");
    expect(text(asked.html)).not.toContain("only verified domain");
    expect(asked.html).toContain('href="/settings/domains"');
    // Mail from an address under it is accepted before; after, only the separately verified address still is.
    expect((await memberOfSender(db, "anyone@gone.example"))?.orgId).toBe(orgId);
    const res = await post(owner.cookie, { action: "remove-domain", org: orgId, target: "gone.example" });
    expect(text(await landed(owner.cookie, res))).toContain("gone.example was removed.");
    expect(await count("SELECT COUNT(*) AS n FROM org_domains WHERE domain = 'gone.example'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM org_receivers WHERE claim_id = ?", claim)).toBe(0);
    expect(await memberOfSender(db, "anyone@gone.example")).toBeNull();
    expect((await memberOfSender(db, "boss@gone.example"))?.by).toBe("address");
    const event = await db
      .prepare("SELECT target_id, actor_id FROM auth_events WHERE org_id = ? AND kind = 'remove-domain'")
      .bind(orgId)
      .first<{ target_id: string; actor_id: string }>();
    expect(event).toEqual({ target_id: claim, actor_id: owner.id });
  });

  it("says removing the last verified domain ends Protected identity, and reads it back", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "only.example");
    await address(orgId, "finance@elsewhere.example");
    await protectIdentity(orgId, "finance@elsewhere.example");
    expect((await getIdentity(db, orgId))?.effective).toEqual({ on: true });
    const asked = await page(owner.cookie, "/settings/domains/remove/only.example");
    expect(text(asked.html)).toContain("It is your only verified domain, so protection of your identity ends");
    await post(owner.cookie, { action: "remove-domain", org: orgId, target: "only.example" });
    expect((await getIdentity(db, orgId))?.effective).toMatchObject({ on: false });
  });

  it("changes nothing on Cancel, from another origin, for another organisation's claim, or after an organisation switch", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "mine.example");
    const stranger = await person("Other");
    const other = await organisation(stranger, "Elsewhere");
    await verifiedDomain(other, "theirs.example");
    expect(
      (
        await post(
          owner.cookie,
          { action: "remove-domain", org: orgId, target: "mine.example" },
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    const foreign = await post(owner.cookie, { action: "remove-domain", org: orgId, target: "theirs.example" });
    expect(text(await landed(owner.cookie, foreign))).toContain("theirs.example is no longer on the list.");
    expect(await count("SELECT COUNT(*) AS n FROM org_domains WHERE domain = 'theirs.example'")).toBe(1);
    const switched = await post(owner.cookie, {
      action: "remove-domain",
      org: "org-somewhere",
      target: "mine.example",
    });
    expect(text(await landed(owner.cookie, switched))).toContain("this page was opened for another organisation");
    expect(await count("SELECT COUNT(*) AS n FROM org_domains WHERE domain = 'mine.example'")).toBe(1);
    // The confirm page for a claim that is not this organisation's: back to the list, saying so.
    const gone = await call("/settings/domains/remove/theirs.example", {
      headers: { cookie: owner.cookie, accept: "text/html" },
    });
    expect(gone.status).toBe(303);
    expect(text(await landed(owner.cookie, gone))).toContain("theirs.example is no longer on the list.");
  });

  it("says a claim already removed in another tab is gone, and never shows a failed removal as done", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "twice.example");
    await db.prepare("DELETE FROM org_domains WHERE domain = 'twice.example'").run();
    const again = await post(owner.cookie, { action: "remove-domain", org: orgId, target: "twice.example" });
    expect(text(await landed(owner.cookie, again))).toContain("twice.example is no longer on the list.");
    await verifiedDomain(orgId, "fails.example");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "batch").mockImplementation(() => Promise.reject(new Error("D1_ERROR: lost")));
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => prepare(sql));
    const failed = await post(owner.cookie, { action: "remove-domain", org: orgId, target: "fails.example" });
    vi.restoreAllMocks();
    const said = text(await landed(owner.cookie, failed));
    expect(said).toContain("The change to fails.example could not be confirmed.");
    expect(said).not.toContain("fails.example was removed");
    expect(await count("SELECT COUNT(*) AS n FROM org_domains WHERE domain = 'fails.example'")).toBe(1);
  });

  it("offers no removal to a member, even by a typed address", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "guarded.example");
    const member = await person("Member");
    await join(orgId, member, "member");
    const res = await call("/settings/domains/remove/guarded.example", {
      headers: { cookie: member.cookie, accept: "text/html" },
    });
    expect(res.status).toBe(303);
    expect(text(await landed(member.cookie, res))).toContain(
      "Only an owner or admin can change what mail is accepted.",
    );
  });
});

describe("removing a single address", () => {
  it("handles a malformed percent sequence in a typed removal URL", async () => {
    const owner = await person("Owner");
    await organisation(owner);
    const res = await call("/settings/addresses/remove/bad%25zz@example.com", { headers: { cookie: owner.cookie } });
    expect(res.status).toBe(303);
    expect(text(await landed(owner.cookie, res))).toContain("is no longer on the list");
  });

  it("keeps mail its verified domain admits, ends protection for the finance contact, and is audited", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "kfinance.example");
    await address(orgId, "finance@kfinance.example");
    await address(orgId, "elsewhere@gmail.example");
    await protectIdentity(orgId, "finance@kfinance.example");
    const asked = await page(owner.cookie, "/settings/addresses/remove/finance%40kfinance.example");
    expect(text(asked.html)).toContain(
      "Mail from finance@kfinance.example is still accepted, because kfinance.example is a verified domain",
    );
    expect(text(asked.html)).toContain("It is your identity's finance contact, so protection of your identity ends");
    const plain = await page(owner.cookie, "/settings/addresses/remove/elsewhere%40gmail.example");
    expect(text(plain.html)).toContain("Mail from elsewhere@gmail.example will no longer be accepted");
    expect(text(plain.html)).not.toContain("finance contact");
    expect((await getIdentity(db, orgId))?.effective).toEqual({ on: true });
    const claim = (
      await db
        .prepare("SELECT id FROM org_addresses WHERE address = 'finance@kfinance.example'")
        .first<{ id: string }>()
    )?.id;
    const res = await post(owner.cookie, { action: "remove-address", org: orgId, target: "finance@kfinance.example" });
    expect(text(await landed(owner.cookie, res))).toContain("finance@kfinance.example was removed.");
    expect((await memberOfSender(db, "finance@kfinance.example"))?.by).toBe("domain");
    expect((await getIdentity(db, orgId))?.effective).toMatchObject({ on: false });
    const event = await db
      .prepare("SELECT target_id FROM auth_events WHERE org_id = ? AND kind = 'remove-address'")
      .bind(orgId)
      .first<{ target_id: string }>();
    expect(event?.target_id).toBe(claim);
    // The other address is untouched by Cancel (never posted).
    expect(await count("SELECT COUNT(*) AS n FROM org_addresses WHERE address = 'elsewhere@gmail.example'")).toBe(1);
  });
});
