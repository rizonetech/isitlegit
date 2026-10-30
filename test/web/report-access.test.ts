import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { type Case, createCase, setStatus } from "../../src/db/cases";
import { shownState } from "../../src/web/pages/report";
import { signReportLink } from "../../src/web/report-link";
import { call, redeem, requestLink, sessionCookie, signIn, stubSmtp2go, target } from "../auth/helpers";

// The report route (D07 T03 §1): one access order, the case's real state, nothing of another organisation's, every
// failure the same 404 that reveals nothing, an expired link its own 410, an outage a 503.
const db = (env as unknown as Env).DB;
const SECRET = (env as unknown as Env).REPORT_LINK_SECRET;
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function org(name: string) {
  const id = `org-report-${++n}-${crypto.randomUUID().slice(0, 6)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(id, name, id, new Date().toISOString())
    .run();
  return id;
}
async function join(email: string, orgId: string, role = "member") {
  const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, role, new Date().toISOString())
    .run();
}
async function member(orgId: string, active?: string) {
  const email = `reader-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  await join(email, orgId);
  if (active) await join(email, active);
  return { cookie, email };
}
const EVIDENCE = (tag: string) => [
  {
    check: "auth.dmarc",
    severity: "critical" as const,
    summary: `${tag}: the sender's domain fails DMARC`,
    detail: {},
    artefacts: [],
  },
  {
    check: "auth.spf",
    severity: "high" as const,
    summary: `${tag}: a lookalike of the supplier's domain`,
    detail: {},
    artefacts: [],
  },
  {
    check: "auth.dkim",
    severity: "low" as const,
    summary: `${tag}: hidden text in the body`,
    detail: {},
    artefacts: [],
  },
];
async function stored(
  orgId: string,
  tag: string,
  status: Case["status"] = "done",
  verdict: Case["verdict"] = "malicious",
) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  await saveEvidence(db, made.value.id, EVIDENCE(tag));
  await db.prepare("UPDATE cases SET status = ?, verdict = ? WHERE id = ?").bind(status, verdict, made.value.id).run();
  return made.value.id;
}
const get = (path: string, cookie?: string, accept = "text/html") =>
  call(path, { headers: { accept, ...(cookie ? { cookie } : {}) } });
// A 404 page with its own reference line set aside: everything else is the same for every refusal.
const withoutReference = (html: string) => html.replace(/Reference [^<]*/, "Reference");

describe("the report route", () => {
  it("maps every stored status and verdict to a state it can draw, never inventing a verdict", () => {
    expect(shownState({ status: "received", verdict: null })).toEqual({ state: "running", words: "Received" });
    expect(shownState({ status: "running", verdict: null })).toEqual({ state: "running", words: "Checking" });
    expect(shownState({ status: "running", verdict: "safe" })).toEqual({ state: "running", words: "Checking" });
    expect(shownState({ status: "partial", verdict: "suspicious" })).toEqual({
      state: "partial",
      verdict: "suspicious",
      words: "Partly checked",
    });
    expect(shownState({ status: "partial", verdict: null })).toEqual({
      state: "failed",
      words: "Could not be checked",
    });
    expect(shownState({ status: "done", verdict: null })).toEqual({ state: "failed", words: "Could not be checked" });
    expect(shownState({ status: "done", verdict: "malicious" })).toEqual({
      state: "complete",
      verdict: "malicious",
      words: "Checked",
    });
  });

  it("draws each stored state for a member without throwing", async () => {
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a);
    for (const [status, verdict, word, badge] of [
      ["received", null, "Received", "Checking"],
      ["running", null, "Checking", "Checking"],
      ["running", "safe", "Checking", "Checking"],
      ["partial", "suspicious", "Partly checked", "Partial"],
      ["partial", null, "Could not be checked", "Partial"],
      ["done", "malicious", "Checked", "Malicious"],
    ] as const) {
      const id = await stored(a, status, status, verdict);
      const res = await get(`/r/${id}`, cookie);
      expect(res.status, `${status}/${verdict}`).toBe(200);
      const html = await res.text();
      expect(html, `${status}/${verdict}`).toContain(`>${word}<`);
      expect(html, `${status}/${verdict}`).toContain(`>${badge}<`);
    }
  });

  it("opens to a member of the case's organisation with its own evidence in order, and nothing of another's", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Swartberg Transport")];
    const mine = await stored(a, "MINE");
    const theirs = await stored(b, "THEIRS");
    const { cookie } = await member(a);
    const res = await get(`/r/${mine}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    const order = ["MINE: the sender", "MINE: a lookalike", "MINE: hidden text"].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html).not.toContain("THEIRS");
    expect(html).toContain('aria-label="Main"');
    expect(html).toContain(
      "Raw files are deleted after 30 days. This summary stays while your organisation has an account.",
    );
    const other = await get(`/r/${theirs}`, cookie);
    expect(other.status).toBe(404);
  });

  it("opens for a membership in an organisation that is not the active one, and not after the membership is removed", async () => {
    const [a, other] = [await org("Karoo Couriers"), await org("Another")];
    const id = await stored(a, "A");
    const { cookie, email } = await member(other, a);
    expect((await get(`/r/${id}`, cookie)).status).toBe(200);
    await db
      .prepare(
        `DELETE FROM "member" WHERE "organizationId" = ? AND "userId" = (SELECT id FROM "user" WHERE lower(email) = ?)`,
      )
      .bind(a, email)
      .run();
    expect((await get(`/r/${id}`, cookie)).status).toBe(404);
  });

  it("opens a valid signed link without a session, and with a session that is not a member, in the public frame", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const id = await stored(a, "LINKED");
    const link = await signReportLink(SECRET, id, a);
    const anonymous = await get(link);
    expect(anonymous.status).toBe(200);
    const html = await anonymous.text();
    expect(html).toContain("LINKED: the sender");
    expect(html).not.toContain('aria-label="Main"');
    expect(html).toMatch(/Anyone with this link can read this report until \d{1,2} [A-Z][a-z]+ \d{4}\./);
    const { cookie } = await member(b);
    const outsider = await get(link, cookie);
    expect(outsider.status).toBe(200);
    expect(await outsider.text()).not.toContain('aria-label="Main"');
  });

  it("opens for an entitled session even with an expired link, and answers 410 to the link alone", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "OLD");
    const old = await signReportLink(SECRET, id, a, Date.now() - 8 * 86_400_000);
    const gone = await get(old);
    expect(gone.status).toBe(410);
    const html = await gone.text();
    expect(html).toContain("This report link has expired.");
    expect(html).toContain(`href="/signin?next=%2Fr%2F${id}"`);
    const { cookie } = await member(a);
    expect((await get(old, cookie)).status).toBe(200);
  });

  it("sends a visitor with no session and no link to sign in, and back to the report after", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "BACK");
    const res = await get(`/r/${id}`);
    expect(res.status).toBe(303);
    expect(target(res)).toBe(`/signin?next=%2Fr%2F${id}`);
    // Signing in with that return path lands back on the report, which then opens.
    const next = new URL(target(res) ?? "", "http://localhost").searchParams.get("next") ?? "";
    const email = `back-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    await signIn(email);
    await join(email, a);
    const smtp = stubSmtp2go();
    try {
      await requestLink(email, next);
      const landed = await redeem(smtp.sends.at(-1)?.link ?? "");
      expect(target(landed)).toBe(`/r/${id}`);
      const opened = await get(target(landed) ?? "", sessionCookie(landed));
      expect(opened.status).toBe(200);
      expect(await opened.text()).toContain("BACK: the sender");
    } finally {
      smtp.restore();
    }
  });

  it("answers the same 404 for a tampered or malformed link, another organisation's case, a missing one and a non-member", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Swartberg Transport")];
    const id = await stored(a, "A");
    const theirs = await stored(b, "B");
    const link = new URL(await signReportLink(SECRET, id, a), "http://localhost");
    const tampered = new URL(link);
    tampered.searchParams.set("s", `${link.searchParams.get("s")?.slice(0, -2)}AA`);
    const foreign = await signReportLink(SECRET, theirs, a);
    const { cookie } = await member(b);
    const pages = await Promise.all(
      [
        get(`${tampered.pathname}${tampered.search}`),
        get(`/r/${id}?o=${a}&e=12&s=x`),
        get(foreign),
        get(`/r/01JB2Z3Y4X5W6V7T8S9R0Q1P2N`, cookie),
        get(`/r/${id}`, cookie),
      ].map(async (p) => {
        const res = await p;
        expect(res.status).toBe(404);
        return withoutReference(await res.text());
      }),
    );
    for (const page of pages) expect(page).toBe(pages[0]);
    expect(pages[0]).toContain("We can&#39;t show you that page.");
  });

  it("sends the member's address for a case to the report", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "ROUTE");
    const res = await get(`/cases/${id}`);
    expect(res.status).toBe(303);
    expect(target(res)).toBe(`/r/${id}`);
    // Followed: the report for a member, the same 404 for anyone else.
    const { cookie } = await member(a);
    expect((await get(target(await get(`/cases/${id}`, cookie)) ?? "", cookie)).status).toBe(200);
    const outsider = await member(await org("Elsewhere"));
    expect((await get(target(await get(`/cases/${id}`, outsider.cookie)) ?? "", outsider.cookie)).status).toBe(404);
  });

  it("keeps a link holder's link through an outage's Try again, and logs the reference the page shows", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "RETRY");
    const link = await signReportLink(SECRET, id, a);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/from evidence/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const down = await get(link);
    expect(down.status).toBe(503);
    const html = await down.text();
    vi.restoreAllMocks();
    const shown = /Reference (500-[0-9A-F]{6})/.exec(html)?.[1];
    expect(shown).toBeDefined();
    const logged = lines.map((l) => JSON.parse(l)).find((e) => e.event === "report");
    expect(logged).toMatchObject({ outcome: "unavailable", reference: shown });
    const anchor = html.slice(html.lastIndexOf("<a ", html.indexOf(">Try again<")), html.indexOf(">Try again<"));
    const retry = /\shref="([^"]+)"/.exec(anchor)?.[1]?.replace(/&amp;/g, "&") ?? "";
    expect(new URL(retry, "http://localhost").searchParams.get("s")).toBe(
      new URL(link, "http://localhost").searchParams.get("s"),
    );
    const back = await get(retry);
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("RETRY: the sender");
  });

  it("answers an outage as one, with a retry and the privacy headers", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "DOWN");
    const { cookie } = await member(a);
    for (const failing of [/from "session"/i, /join "member"/i, /from cases/i, /from evidence/i]) {
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (failing.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
        return prepare(sql);
      });
      const res = await get(`/r/${id}`, cookie);
      expect(res.status, String(failing)).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(await res.text()).toContain("Sorry, something broke on our side.");
      vi.restoreAllMocks();
    }
  });

  it("reads the case and its evidence with one query each for a signed link", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "COUNT");
    const link = await signReportLink(SECRET, id, a);
    const prepare = db.prepare.bind(db);
    const queries: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      queries.push(sql);
      return prepare(sql);
    });
    expect((await get(link)).status).toBe(200);
    const reads = queries.filter((q) => /from (cases|evidence)\b/i.test(q));
    expect(reads.filter((q) => /from cases\b/i.test(q))).toHaveLength(1);
    expect(reads.filter((q) => /from evidence\b/i.test(q))).toHaveLength(1);
  });

  it("passes a renewed session's cookie through every answer, not only the member view", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const theirs = await stored(a, "RENEW");
    const { cookie, email } = await member(b);
    // A session two days old: Better Auth renews it on the next read (its update age is a day) and sends a new cookie.
    const age = async () =>
      db
        .prepare(`UPDATE "session" SET "expiresAt" = ? WHERE "userId" = (SELECT id FROM "user" WHERE lower(email) = ?)`)
        .bind(new Date(Date.now() + 5 * 86_400_000).toISOString(), email)
        .run();
    await age();
    const viaLink = await get(await signReportLink(SECRET, theirs, a), cookie);
    expect(viaLink.status).toBe(200);
    expect(sessionCookie(viaLink)).toMatch(/session_token=/);
    await age();
    const refused = await get(`/r/${theirs}`, cookie);
    expect(refused.status).toBe(404);
    expect(sessionCookie(refused)).toMatch(/session_token=/);
  });

  it("frames a report from another of the member's organisations with the session's active one as current", async () => {
    const [a, b] = [await org("Alpha Freight"), await org("Bravo Couriers")];
    const id = await stored(b, "OTHER-ORG");
    const { cookie, email } = await member(a, b);
    await db
      .prepare(
        `UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = (SELECT id FROM "user" WHERE lower(email) = ?)`,
      )
      .bind(a, email)
      .run();
    const res = await get(`/r/${id}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("OTHER-ORG: the sender");
    // The switcher's current organisation is the active one, and the report's own is one it can switch to.
    const switcher = /<details[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    expect(switcher.indexOf("Alpha Freight")).toBeGreaterThan(-1);
    expect(switcher.indexOf("Alpha Freight")).toBeLessThan(switcher.indexOf("Bravo Couriers"));
  });

  it("puts the privacy headers on its redirects too", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "REDIRECTS");
    for (const res of [await get(`/cases/${id}`), await get(`/r/${id}`)]) {
      expect(res.status).toBe(303);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    }
  });

  it("sends private, unindexed headers and keeps the link's query to itself", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "HEADERS");
    const res = await get(await signReportLink(SECRET, id, a));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(sessionCookie(res)).toBe("");
    void setStatus;
  });
});
