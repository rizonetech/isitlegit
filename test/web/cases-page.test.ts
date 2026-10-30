import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCases } from "../../src/db/case-list";
import { ulid } from "../../src/db/ulid";
import { fullTime, whenText } from "../../src/web/pages/cases-view";
import { call, signIn, target } from "../auth/helpers";

// The Cases list (D07 T04 §1): the active organisation's cases only, newest first, filtered and paged through the query
// string, each case's real state, who checked it, the first-run and filtered-empty states, and its refusals as pages.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function org(name: string) {
  const id = `org-cases-${++n}-${crypto.randomUUID().slice(0, 6)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(id, name, id, new Date().toISOString())
    .run();
  return id;
}
const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id;
async function join(email: string, orgId: string) {
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'member', ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, await userId(email), new Date().toISOString())
    .run();
}
// A signed-in member of `orgId` with it active, named `name`.
async function member(orgId: string, name = "") {
  const email = `cases-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  await join(email, orgId);
  await db.prepare(`UPDATE "user" SET name = ? WHERE lower(email) = ?`).bind(name, email).run();
  await db
    .prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`)
    .bind(orgId, await userId(email))
    .run();
  return { cookie, email };
}
type Made = {
  ageMs?: number;
  channel?: "email" | "upload";
  sourceKind?: "mail" | "document" | "image" | "audio";
  status?: "received" | "running" | "done" | "partial";
  verdict?: "safe" | "suspicious" | "malicious" | null;
  forwardedBy?: string | null;
};
async function made(orgId: string, c: Made = {}) {
  const id = ulid();
  const at = new Date(Date.now() - (c.ageMs ?? 0)).toISOString();
  const channel = c.channel ?? "email";
  await db
    .prepare(
      `INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at, forwarded_by, source_kind)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      orgId,
      channel,
      c.status ?? "done",
      c.verdict === undefined ? "safe" : c.verdict,
      at,
      at,
      c.forwardedBy === undefined ? (channel === "email" ? "someone@demo.isitlegit.co.za" : null) : c.forwardedBy,
      c.sourceKind ?? (channel === "email" ? "mail" : "document"),
    )
    .run();
  return id;
}
const DAY = 86_400_000;
const get = (path: string, cookie?: string) =>
  call(path, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });
const page = async (path: string, cookie: string) => {
  const res = await get(path, cookie);
  expect(res.status, path).toBe(200);
  return res.text();
};
// The ids of the cases a page lists, in order (each row links its report once in the table and once on a phone).
const listed = (html: string) => [...new Set([...html.matchAll(/href="\/r\/([0-9A-Z]{26})"/g)].map((m) => m[1]))];

describe("the cases list", () => {
  it("sends a visitor with no session to sign in, back to the list after", async () => {
    const res = await get("/cases?verdict=safe");
    expect(res.status).toBe(303);
    expect(target(res)).toBe(`/signin?next=${encodeURIComponent("/cases?verdict=safe")}`);
  });

  it("answers a member with no active organisation, or one just removed, with the 403 page", async () => {
    const a = await org("Karoo Couriers");
    const { cookie, email } = await member(a);
    await db
      .prepare(`DELETE FROM "member" WHERE "userId" = ?`)
      .bind(await userId(email))
      .run();
    const removed = await get("/cases", cookie);
    expect(removed.status).toBe(403);
    const html = await removed.text();
    expect(html).toContain("You&#39;re not a member of this organisation.");
    expect(html).toContain(email);
    expect(html).toContain('action="/auth/sign-out"');
    await db
      .prepare(`UPDATE "session" SET "activeOrganizationId" = NULL WHERE "userId" = ?`)
      .bind(await userId(email))
      .run();
    expect((await get("/cases", cookie)).status).toBe(403);
  });

  it("lists the organisation's cases newest first, each opening its report, and none of another's", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const old = await made(a, { ageMs: 2 * DAY });
    const fresh = await made(a, { ageMs: 1000 });
    const theirs = await made(b);
    const { cookie } = await member(a);
    const res = await get("/cases", cookie);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(listed(html)).toEqual([fresh, old]);
    expect(html).not.toContain(theirs);
    expect(html).toContain("Everything Karoo Couriers has checked");
    expect(html).toContain("Showing 1 to 2 of 2");
  });

  it("filters by verdict, channel and period, alone and together", async () => {
    const a = await org("Karoo Couriers");
    const mal = await made(a, { verdict: "malicious" });
    const sus = await made(a, { verdict: "suspicious", channel: "upload" });
    const safe = await made(a, { verdict: "safe" });
    const oldMal = await made(a, { verdict: "malicious", ageMs: 40 * DAY });
    const { cookie } = await member(a);
    expect(listed(await page("/cases?verdict=malicious", cookie))).toEqual([mal]);
    expect(listed(await page("/cases?channel=upload", cookie))).toEqual([sus]);
    expect(listed(await page("/cases?period=all&verdict=malicious", cookie))).toEqual([mal, oldMal]);
    expect(listed(await page("/cases?channel=email&verdict=safe", cookie))).toEqual([safe]);
    expect(listed(await page("/cases?period=90&channel=email", cookie))).toEqual([safe, mal, oldMal]);
    // The form shows what the address asks for.
    const html = await page("/cases?verdict=suspicious&channel=upload&period=7", cookie);
    expect(html).toMatch(/value="suspicious"[^>]*checked/);
    expect(html).toMatch(/<option value="upload" selected/);
    expect(html).toMatch(/<option value="7" selected/);
  });

  it("answers a bad filter value with its default, never an error", async () => {
    const a = await org("Karoo Couriers");
    const one = await made(a);
    const { cookie } = await member(a);
    expect(listed(await page("/cases?verdict=evil&channel=fax&period=9999&page=-3", cookie))).toEqual([one]);
    expect(listed(await page("/cases?page=abc", cookie))).toEqual([one]);
  });

  it("pages 25 at a time, keeping the filters, clamping a page past the end, disabling the ends", async () => {
    const a = await org("Karoo Couriers");
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await made(a, { verdict: "malicious", ageMs: i * 60_000 }));
    await made(a, { verdict: "safe" });
    const { cookie } = await member(a);
    const first = await page("/cases?verdict=malicious", cookie);
    expect(listed(first)).toEqual(ids.slice(0, 25));
    expect(first).toContain("Showing 1 to 25 of 30");
    expect(first).toContain('href="/cases?verdict=malicious&amp;page=2"');
    expect(first).toMatch(/<button id="case-previous" type="button" disabled[^>]*>Previous<\/button>/);
    const second = await page("/cases?verdict=malicious&page=2", cookie);
    expect(listed(second)).toEqual(ids.slice(25));
    expect(second).toContain("Showing 26 to 30 of 30");
    expect(second).toContain('href="/cases?verdict=malicious"');
    expect(second).toMatch(/<button id="case-next" type="button" disabled[^>]*>Next<\/button>/);
    // Past the end: the last page. A filter change carries no page, so it starts at page 1.
    expect(listed(await page("/cases?verdict=malicious&page=9", cookie))).toEqual(ids.slice(25));
    expect(second).not.toMatch(/<input[^>]*name="page"/);
  });

  it("names who checked each case: the member, a former member's address, an upload's Not recorded", async () => {
    const a = await org("Karoo Couriers");
    const { cookie, email } = await member(a, "Thandi Nkosi");
    const mine = await made(a, { forwardedBy: email });
    const gone = await made(a, { forwardedBy: "left@demo.isitlegit.co.za", ageMs: 1000 });
    const upload = await made(a, { channel: "upload", forwardedBy: null, ageMs: 2000 });
    const read = await listCases(db, a, { verdict: "all", channel: "all", period: "30", page: 1 });
    if (!read.ok) throw new Error(read.error.message);
    const by = Object.fromEntries(read.value.cases.map((c) => [c.id, c.checkedBy]));
    expect(by).toEqual({ [mine]: "Thandi Nkosi", [gone]: "left@demo.isitlegit.co.za", [upload]: null });
    const html = await page("/cases", cookie);
    expect(html).toContain("Thandi Nkosi");
    expect(html).toContain("Not recorded");
  });

  it("draws each case's real state, all of them under All and only verdicts under a verdict", async () => {
    const a = await org("Karoo Couriers");
    const received = await made(a, { status: "received", verdict: null });
    const running = await made(a, { status: "running", verdict: null, ageMs: 1000 });
    const partial = await made(a, { status: "partial", verdict: "suspicious", ageMs: 2000 });
    const failed = await made(a, { status: "partial", verdict: null, ageMs: 3000 });
    const done = await made(a, { status: "done", verdict: "malicious", ageMs: 4000 });
    const { cookie } = await member(a);
    const html = await page("/cases", cookie);
    expect(listed(html)).toEqual([received, running, partial, failed, done]);
    const rows = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>")).split("<tr").slice(1);
    const pills = rows.map((row) => (row.match(/>(Checking|Partial|Malicious|Suspicious|Safe)</) ?? [])[1]);
    expect(pills).toEqual(["Checking", "Checking", "Partial", "Partial", "Malicious"]);
    expect(rows[3]).toContain("Could not be checked");
    expect(rows[2]).not.toContain("Could not be checked");
    expect(listed(await page("/cases?verdict=suspicious", cookie))).toEqual([partial]);
  });

  it("shows a new organisation the first-run state, with the senders it accepts in each of four ways", async () => {
    const domainOnly = await org("Karoo Couriers");
    const now = new Date().toISOString();
    const domain = (o: string, d: string) =>
      db
        .prepare(
          "INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, ?, 'verified', ?)",
        )
        .bind(crypto.randomUUID(), o, d, "t".repeat(20), now)
        .run();
    const address = (o: string, a: string) =>
      db
        .prepare("INSERT INTO org_addresses (id, org_id, address, state, created_at) VALUES (?, ?, ?, 'verified', ?)")
        .bind(crypto.randomUUID(), o, a, now)
        .run();
    const tag = crypto.randomUUID().slice(0, 6);
    await domain(domainOnly, `karoo-${tag}.example`);
    const first = await page("/cases", (await member(domainOnly)).cookie);
    expect(first).toContain("Check your first suspicious email.");
    expect(first).toContain("Copy address");
    expect(first).toContain("Outlook on the web");
    expect(first).toContain("Tick the email in your inbox, then More at the top, Forward as attachment.");
    expect(first).toContain(
      `<strong class="text-ink">karoo-${tag}.example</strong>, your verified domain, is accepted.`,
    );
    expect(first).not.toContain("Showing");

    const addressOnly = await org("Fynbos Freight");
    await address(addressOnly, `owner-${tag}@gmail.example`);
    expect(await page("/cases", (await member(addressOnly)).cookie)).toContain(
      `mail from <strong class="text-ink">owner-${tag}@gmail.example</strong>, your verified address, is accepted.`,
    );

    const both = await org("Outeniqua Paper");
    await domain(both, `outeniqua-${tag}.example`);
    await address(both, `a-${tag}@gmail.example`);
    await address(both, `b-${tag}@gmail.example`);
    const mixed = await page("/cases", (await member(both)).cookie);
    expect(mixed).toContain("your verified domain, and mail from");
    expect(mixed).toContain("your verified addresses, is accepted.");

    const neither = await org("Sasol Tours");
    const none = await page("/cases", (await member(neither)).cookie);
    expect(none).toContain("No mail is accepted yet");
    expect(none).toContain('href="/settings/domains"');
  });

  it("says when filters match nothing, and Clear filters shows every case, older ones too", async () => {
    const a = await org("Karoo Couriers");
    const old = await made(a, { ageMs: 60 * DAY });
    const { cookie } = await member(a);
    const html = await page("/cases?verdict=malicious&period=7", cookie);
    expect(html).toContain("No cases match Malicious, last 7 days.");
    expect(html).toContain("1 case in total. Try a wider date range or another verdict.");
    expect(html).toContain('href="/cases?period=all"');
    // The default (last 30 days) does not reach the old case; Clear filters' address does.
    expect(listed(await page("/cases", cookie))).toEqual([]);
    expect(listed(await page("/cases?period=all", cookie))).toEqual([old]);
  });

  it("answers a read that fails with the 503 page, its reference logged and Try again keeping the filters", async () => {
    const a = await org("Karoo Couriers");
    await made(a);
    const { cookie } = await member(a);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/COUNT\(\*\) AS n FROM cases/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const res = await get("/cases?verdict=safe&period=all", cookie);
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    const html = await res.text();
    const shown = /Reference (500-[0-9A-F]{6})/.exec(html)?.[1];
    expect(lines.map((l) => JSON.parse(l)).find((e) => e.event === "cases")).toMatchObject({ reference: shown });
    expect(html).toContain('href="/cases?verdict=safe&amp;period=all"');
  });

  it("answers a session store it cannot read with the 503 page, Try again keeping the filters", async () => {
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/from "session"/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const res = await get("/cases?verdict=malicious", cookie);
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Sorry, something broke on our side.");
    expect(html).toContain('href="/cases?verdict=malicious"');
    const shown = /Reference (500-[0-9A-F]{6})/.exec(html)?.[1];
    expect(lines.map((l) => JSON.parse(l)).find((e) => e.event === "cases")).toMatchObject({
      reference: shown,
      error: "session",
    });
  });

  it("reloads the whole page for a results request drawn for another organisation than the active one", async () => {
    const a = await org("Karoo Couriers");
    await made(a);
    const { cookie } = await member(a);
    const stale = await call("/cases?verdict=safe", {
      headers: { cookie, "hx-request": "true", "x-cases-org": "org-somewhere-else" },
    });
    expect(stale.status).toBe(204);
    expect(stale.headers.get("hx-redirect")).toMatch(/\/cases\?verdict=safe$/);
    const fresh = await call("/cases?verdict=safe", { headers: { cookie, "hx-request": "true", "x-cases-org": a } });
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toContain(`&quot;x-cases-org&quot;:&quot;${a}&quot;`);
  });

  it("reloads the whole page for a results request once the organisation has no cases left", async () => {
    const a = await org("Karoo Couriers");
    const only = await made(a, { status: "received", verdict: null });
    const { cookie } = await member(a);
    expect(listed(await page("/cases", cookie))).toEqual([only]);
    await db.prepare("DELETE FROM cases WHERE id = ?").bind(only).run();
    const res = await call("/cases?verdict=safe", { headers: { cookie, "hx-request": "true", "x-cases-org": a } });
    expect(res.status).toBe(204);
    expect(res.headers.get("hx-redirect")).toMatch(/\/cases\?verdict=safe$/);
    // The page itself, asked for whole, is the first-run state.
    expect(await page("/cases?verdict=safe", cookie)).toContain("Check your first suspicious email.");
  });
});

describe("when a case arrived", () => {
  // 2026-10-30 is a Friday; SAST is UTC+2.
  const now = new Date("2026-10-30T12:00:00Z");
  it("says Just now, the time today, Yesterday, then the day, in SAST", () => {
    expect(whenText("2026-10-30T11:59:30Z", now)).toBe("Just now");
    expect(whenText("2026-10-30T07:14:00Z", now)).toBe("09:14");
    expect(whenText("2026-10-29T08:00:00Z", now)).toBe("Yesterday");
    expect(whenText("2026-10-24T08:00:00Z", now)).toBe("Sat 24 Oct");
    expect(whenText("2025-10-24T08:00:00Z", now)).toBe("Fri 24 Oct 2025");
    expect(fullTime("2026-10-30T07:14:00Z")).toBe("Fri 30 Oct 2026, 09:14 SAST");
  });
  it("counts days at SAST midnight, not UTC's", () => {
    // 22:30 UTC on the 29th is 00:30 SAST on the 30th: today, not yesterday.
    expect(whenText("2026-10-29T22:30:00Z", now)).toBe("00:30");
    // 21:30 UTC on the 29th is 23:30 SAST on the 29th: yesterday.
    expect(whenText("2026-10-29T21:30:00Z", now)).toBe("Yesterday");
  });
});
