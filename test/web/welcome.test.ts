import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { setPlan } from "../../src/auth/plans";
import { hiddenIn } from "../../src/web/pages/welcome-steps";
import { doneCount, planCard } from "../../src/web/pages/welcome-view";
import { authEnv, call, ORIGIN, signIn, target } from "../auth/helpers";

// The onboarding checklist (D07 T08 §2; board `Welcome`): five steps that tick themselves from the organisation's own
// stored state, the check address and the plan, the list hidden and shown in this browser, the way to it from Cases, and
// the judges' banner for a flagged organisation.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

const tag = () => crypto.randomUUID().slice(0, 8);
async function person(name: string) {
  const email = `welcome-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const id = (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())
    ?.id as string;
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
const verifiedDomain = (orgId: string, name: string) => {
  const domain = `${tag()}-${name}`;
  return insertDomain(orgId, domain);
};
const insertDomain = (orgId: string, domain: string) =>
  db
    .prepare(
      `INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)`,
    )
    .bind(`d-${tag()}`, orgId, domain, `token-${tag()}${tag()}`, new Date().toISOString(), new Date().toISOString())
    .run();
const emailedCase = (orgId: string, channel: "email" | "upload" = "email") => {
  const at = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO cases (id, org_id, channel, status, headers_available, created_at, updated_at, forwarded_by, source_kind) VALUES (?, ?, ?, 'done', 1, ?, ?, 'a@b.example', ?)`,
    )
    .bind(`c-${tag()}${tag()}`, orgId, channel, at, at, channel === "email" ? "mail" : "document")
    .run();
};
const supplier = (orgId: string, name: string) => {
  const at = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO suppliers (id, org_id, name, name_key, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'test', ?, ?)`,
    )
    .bind(`s-${tag()}`, orgId, name, name.toLowerCase(), at, at)
    .run();
};
const protectIdentity = (orgId: string) =>
  db
    .prepare(`INSERT INTO identities (org_id, protected, updated_at, updated_by) VALUES (?, 1, ?, 'test')`)
    .bind(orgId, new Date().toISOString())
    .run();
const page = async (cookie: string, path = "/welcome") => {
  const res = await call(path, { headers: { cookie, accept: "text/html" } });
  return { res, html: await res.text() };
};
const post = (cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) => {
  const headers = new Headers({ cookie, "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
  headers.set("origin", origin ?? "");
  return call("/welcome", { method: "POST", headers, body: new URLSearchParams(fields).toString() });
};
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
// A step's list item, by its title.
const step = (html: string, title: string) => {
  const at = html.indexOf(`>${title}`);
  const start = html.lastIndexOf("<li", at);
  return html.slice(start, html.indexOf("</li>", at));
};

describe("the words", () => {
  it("counts the done steps and words the trial card for every plan", () => {
    const none = { domain: null, members: 1, emailed: false, suppliers: 0, protectedIdentity: false };
    expect(doneCount(none)).toBe(0);
    expect(doneCount({ ...none, members: 2 })).toBe(1);
    expect(doneCount({ domain: "a.example", members: 3, emailed: true, suppliers: 1, protectedIdentity: true })).toBe(
      5,
    );
    expect(planCard({ plan: "trial", daysLeft: 14 }).text).toBe(
      "Everything in Protect for 14 days, free. No card needed.",
    );
    expect(planCard({ plan: "trial", daysLeft: 2 }).text).toBe(
      "Everything in Protect for 2 days, free. No card needed.",
    );
    expect(planCard({ plan: "trial", daysLeft: 1 }).text).toContain("ends today");
    expect(planCard({ plan: "free", trialEnded: true }).text).toContain("Your trial has ended");
    expect(planCard({ plan: "free", trialEnded: false }).text).not.toContain("trial");
    expect(planCard({ plan: "protect" }).text).toBe("You are on the Protect plan.");
    expect(planCard({ plan: "msp" }).text).toBe("You are on the MSP plan.");
  });
  it("reads only well-formed organisation ids from the cookie", () => {
    expect(hiddenIn(undefined)).toEqual([]);
    expect(hiddenIn("org-a,org_b")).toEqual(["org-a", "org_b"]);
    expect(hiddenIn("org-a,<script>,,a b,x".replace("x", "ok"))).toEqual(["org-a", "ok"]);
    expect(hiddenIn(Array.from({ length: 40 }, (_, i) => `o${i}`).join(",")).length).toBe(20);
  });
});

describe("GET /welcome", () => {
  it("draws an empty organisation's five steps, none done, each with its action, for an owner", async () => {
    const owner = await person("Thandi Nkosi");
    await organisation(owner);
    const { res, html } = await page(owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const t = text(html);
    expect(t).toContain("Welcome, Thandi");
    expect(t).toContain("Five steps to a business that is hard to fool");
    expect(t).toContain("0 of 5 done");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="0"/);
    for (const [title, label, href] of [
      ["Verify your domain", "Verify a domain", "/settings/domains"],
      ["Invite your team", "Invite people", "/team"],
      ["Forward your first email", "Show me how", "/settings/domains#forwarding-heading"],
      ["Add your suppliers", "Add suppliers", "/suppliers"],
      ["Protect your business", "Protect Karoo Couriers", "/protect"],
    ] as const) {
      const item = step(html, title);
      expect(text(item)).toContain(label);
      expect(item).toContain(`href="${href}"`);
      expect(text(item)).not.toContain("Done");
    }
    // The check address, with its Copy address, and the trial card.
    expect(t).toContain("check@isitlegit.co.za");
    expect(html).toMatch(/<button[^>]*data-copy="check@isitlegit.co.za"/);
    expect(t).toContain("Everything in Protect for 14 days, free. No card needed.");
    expect(html).toContain('href="/settings/plan?from=%2Fwelcome"');
    // No banner for an ordinary organisation.
    expect(t).not.toContain("Welcome, judges");
  });

  it("ticks each step from the stored record that matches it, one at a time, with the board's words", async () => {
    const owner = await person("Thandi Nkosi");
    const orgId = await organisation(owner);
    await verifiedDomain(orgId, "karoocouriers.example");
    let html = (await page(owner.cookie)).html;
    expect(text(html)).toContain("1 of 5 done");
    expect(text(step(html, "Verify your domain"))).toContain(
      "karoocouriers.example is verified, so your team's mail is accepted at check@.",
    );
    expect(text(step(html, "Verify your domain"))).toContain("Done");
    const a = await person("Ayesha");
    const b = await person("Sipho");
    await join(orgId, a, "admin");
    await join(orgId, b, "member");
    html = (await page(owner.cookie)).html;
    expect(text(step(html, "Invite your team"))).toContain("3 people joined.");
    expect(text(html)).toContain("2 of 5 done");
    // An upload is not a forwarded email; an email is.
    await emailedCase(orgId, "upload");
    expect(text((await page(owner.cookie)).html)).toContain("2 of 5 done");
    await emailedCase(orgId, "email");
    html = (await page(owner.cookie)).html;
    expect(text(step(html, "Forward your first email"))).toContain("Done");
    await supplier(orgId, "Boland Packaging");
    await supplier(orgId, "Cape Pallets");
    html = (await page(owner.cookie)).html;
    expect(text(step(html, "Add your suppliers"))).toContain("2 suppliers added");
    await protectIdentity(orgId);
    html = (await page(owner.cookie)).html;
    expect(text(html)).toContain("5 of 5 done");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="5"/);
    expect(text(step(html, "Protect your business"))).toContain("Done");
  });

  it("counts none of another organisation's records", async () => {
    const mine = await person("Mine");
    await organisation(mine);
    const other = await person("Other");
    const otherOrg = await organisation(other, "Other Couriers");
    await verifiedDomain(otherOrg, "other.example");
    await emailedCase(otherOrg);
    await supplier(otherOrg, "Their Supplier");
    await protectIdentity(otherOrg);
    await join(otherOrg, await person("Third"), "member");
    expect(text((await page(mine.cookie)).html)).toContain("0 of 5 done");
  });

  it("gives a member who cannot set up the owner words in place of the domain button, and an admin the buttons", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Clerk");
    await join(orgId, clerk, "member");
    const admin = await person("Admin");
    await join(orgId, admin, "admin");
    const { html } = await page(clerk.cookie);
    const domain = text(step(html, "Verify your domain"));
    expect(domain).toContain("An owner or admin does this");
    expect(domain).not.toContain("Done");
    expect(step(html, "Verify your domain")).not.toContain('href="/settings/domains"');
    // The team has people in it (the member is one), so that step is done and has no button to give.
    expect(text(step(html, "Invite your team"))).toContain("Done");
    // The other steps keep their actions.
    expect(text(step(html, "Add your suppliers"))).toContain("Add suppliers");
    // An admin gets the button.
    const adminHtml = (await page(admin.cookie)).html;
    expect(text(step(adminHtml, "Verify your domain"))).toContain("Verify a domain");
    expect(step(adminHtml, "Verify your domain")).toContain('href="/settings/domains"');
  });

  it("words the trial card truthfully for each plan, the last day and a lapsed trial included", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const words = async () => text((await page(owner.cookie)).html);
    expect(await words()).toContain("Everything in Protect for 14 days, free.");
    const made = (daysAgo: number) =>
      db
        .prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`)
        .bind(new Date(Date.now() - daysAgo * 86_400_000).toISOString(), orgId)
        .run();
    // Thirteen and a half days in: the trial ends today.
    await made(13.5);
    expect(await words()).toContain("Your trial ends today.");
    // Twenty days in: lapsed, on the Free plan.
    await made(20);
    expect(await words()).toContain("Your trial has ended and you are on the Free plan.");
    await setPlan(db, orgId, "protect");
    expect(await words()).toContain("You are on the Protect plan.");
    await setPlan(db, orgId, "msp");
    expect(await words()).toContain("You are on the MSP plan.");
    expect(await words()).not.toContain("No card needed");
  });

  it("sends the signed-out to sign-in, gives a member of no organisation the 403 page, and an unreadable state the retryable outage", async () => {
    const anon = await call("/welcome", { headers: { accept: "text/html" } });
    expect(target(anon)).toBe(`/signin?next=${encodeURIComponent("/welcome")}`);
    const loner = await person("Loner");
    const none = await page(loner.cookie);
    expect(none.res.status).toBe(403);
    const owner = await person("Owner");
    await organisation(owner);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("FROM org_domains")) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const down = await page(owner.cookie);
    vi.restoreAllMocks();
    expect(down.res.status).toBe(503);
    expect(down.html).toContain('href="/welcome"');
    expect(text(down.html)).not.toContain("0 of 5 done");
  });
});

describe("the judges' banner", () => {
  const sentences = [
    "Welcome, judges. This organisation is ready to explore.",
    "a phishing email, an invoice with changed bank details, a voice note and a safe statement",
    "Forward your own test email to check@isitlegit.co.za to see a live check.",
    "Sample data on a fictional company.",
  ];
  it("shows every sentence and the link for a flagged organisation, and nothing for any other", async () => {
    const owner = await person("Judge Owner");
    const orgId = await organisation(owner);
    const flag = (metadata: string | null) =>
      db.prepare(`UPDATE "organization" SET metadata = ? WHERE id = ?`).bind(metadata, orgId).run();
    await flag(JSON.stringify({ demo: true, judge: true }));
    const { html } = await page(owner.cookie);
    for (const sentence of sentences) expect(text(html)).toContain(sentence);
    expect(html).toMatch(/<a[^>]*href="\/cases"[^>]*>\s*Open the sample cases/);
    for (const other of [
      null,
      JSON.stringify({ demo: true }),
      "not json",
      JSON.stringify({ judge: "yes" }),
      "null",
      "[true]",
    ]) {
      await flag(other);
      expect(text((await page(owner.cookie)).html), String(other)).not.toContain("Welcome, judges");
    }
  });
});

describe("hiding and showing the list", () => {
  const cookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("welcome_hidden=")) ?? "";
  it("hides it for this organisation in this browser, reachable again from Cases and from the page, then restores it", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    // Not hidden: Cases offers Finish setting up with the count.
    let cases = (await page(owner.cookie, "/cases")).html;
    expect(text(cases)).toContain("Finish setting up (0 of 5 done)");
    expect(cases).toContain('href="/welcome"');
    // Hide: a 303 to Cases and a cookie for this organisation only.
    const hid = await post(owner.cookie, { action: "hide" });
    expect(hid.status).toBe(303);
    expect(target(hid)).toBe("/cases");
    const cookie = cookieOf(hid);
    expect(cookie).toContain(`welcome_hidden=${orgId}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=31536000/i);
    const hidden = `${owner.cookie}; welcome_hidden=${orgId}`;
    // Navigate away and back with no URL typed: Cases says Show setup list.
    cases = (await page(hidden, "/cases")).html;
    expect(text(cases)).toContain("Show setup list");
    expect(text(cases)).not.toContain("Finish setting up");
    // The page itself still draws, and offers to show the list again.
    const again = (await page(hidden)).html;
    expect(text(again)).toContain("Show this list again");
    expect(text(again)).not.toContain("Hide this list");
    // Restore: the cookie is cleared, back on the list.
    const shown = await post(hidden, { action: "show" });
    expect(shown.status).toBe(303);
    expect(target(shown)).toBe("/welcome");
    expect(cookieOf(shown)).toMatch(/Max-Age=0/i);
    cases = (await page(owner.cookie, "/cases")).html;
    expect(text(cases)).toContain("Finish setting up");
    expect(text((await page(owner.cookie)).html)).toContain("Hide this list");
  });

  it("keeps another organisation's list as it was, ignores a malformed cookie and refuses a post from another origin", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    // Hidden elsewhere only: this organisation's list is not hidden.
    const elsewhere = `${owner.cookie}; welcome_hidden=org-elsewhere`;
    expect(text((await page(elsewhere, "/cases")).html)).toContain("Finish setting up");
    // Hiding keeps the other organisation's entry.
    const hid = await post(elsewhere, { action: "hide" });
    const value = (hid.headers.getSetCookie().find((c) => c.startsWith("welcome_hidden=")) ?? "").split(";")[0] ?? "";
    expect(value).toBe(`welcome_hidden=org-elsewhere,${orgId}`);
    // A malformed cookie hides nothing.
    expect(text((await page(`${owner.cookie}; welcome_hidden=<x>`, "/cases")).html)).toContain("Finish setting up");
    // Another origin and an unknown action change nothing.
    const foreign = await post(owner.cookie, { action: "hide" }, "https://evil.example");
    expect(foreign.status).toBe(403);
    expect(foreign.headers.getSetCookie().some((c) => c.startsWith("welcome_hidden="))).toBe(false);
    expect((await post(owner.cookie, { action: "explode" })).status).toBe(400);
  });
});

describe("the way from Cases", () => {
  it("shows the link until the fifth step is done, and never blocks the list when the steps cannot be read", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    expect(text((await page(owner.cookie, "/cases")).html)).toContain("Finish setting up (0 of 5 done)");
    await verifiedDomain(orgId, "karoocouriers.example");
    expect(text((await page(owner.cookie, "/cases")).html)).toContain("Finish setting up (1 of 5 done)");
    await join(orgId, await person("B"), "member");
    await emailedCase(orgId);
    await supplier(orgId, "Boland");
    await protectIdentity(orgId);
    const finished = (await page(owner.cookie, "/cases")).html;
    expect(text(finished)).not.toContain("Finish setting up");
    expect(text(finished)).not.toContain("Show setup list");
    // The steps cannot be read: the Cases page still draws, without the link.
    await db.prepare(`DELETE FROM identities WHERE org_id = ?`).bind(orgId).run();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("FROM org_domains WHERE org_id = ?1")) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const cases = await page(owner.cookie, "/cases");
    vi.restoreAllMocks();
    expect(cases.res.status).toBe(200);
    expect(text(cases.html)).toContain("Cases");
    expect(text(cases.html)).not.toContain("Finish setting up");
  });
});
