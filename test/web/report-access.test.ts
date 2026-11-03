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
    // A running case draws its running state and a failed one its failed state (D07 T03 §4); a finished case whose
    // verdict row is missing keeps its stored state line.
    for (const [status, verdict, word, badge] of [
      ["received", null, "We are investigating this message.", "Step 1 of 7"],
      ["running", null, "We are investigating this message.", "Step 1 of 7"],
      ["running", "safe", "We are investigating this message.", "Step 1 of 7"],
      ["partial", "suspicious", "Partly checked", "Partial"],
      ["partial", null, "We could not finish checking this message.", "Upload it instead"],
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

  // D07 T03 §13: the link and walkthrough cards through the real report route, for a member and for a link holder.
  it("draws a stored followed link and a stored walk for a member and for a link holder, screenshots by the same access rule", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "CARDS");
    const shot = `art/${id}/render/${"e".repeat(64)}-landing-1.png`;
    const walkShot = `art/${id}/render/${"f".repeat(64)}-walk-2.png`;
    await saveEvidence(db, id, [
      {
        check: "link.credential_form",
        severity: "high",
        summary: "A page asks for a password.",
        detail: {
          link: "https://t.example/1",
          page: "https://login.evil.example/in",
          frame: false,
          passwordFields: 1,
          sends: [],
          shotKey: shot,
        },
        artefacts: [shot],
      },
      {
        check: "walkthrough.credential_target",
        severity: "critical",
        summary: "The test credentials would go to thief.example.",
        detail: {
          url: "https://thief.example/post",
          domain: "thief.example",
          method: "POST",
          fields: ["username", "password"],
          state: "delivered",
          outcome: "unknown",
          brand: null,
          brandEvidence: null,
        },
        artefacts: [walkShot],
      },
    ]);
    const { cookie } = await member(a);
    const link = await signReportLink(SECRET, id, a);
    for (const [who, answer] of [
      ["member", await get(`/r/${id}`, cookie)],
      ["link holder", await get(link)],
    ] as const) {
      expect(answer.status, who).toBe(200);
      const html = await answer.text();
      expect(html, who).toContain("Where the test credentials would go");
      expect(html, who).toContain("thief.example");
      expect(html, who).toContain("It was delivered");
      expect(html, who).toContain("A page that asks for a password");
      const images = html.match(/<img data-evidence-image="true" src="[^"]*"/g) ?? [];
      expect(images, who).toHaveLength(2);
      for (const img of images) expect(img, who).toContain("inline=1");
      // A link holder's screenshots carry the link's own signature parameters, so the artefact route verifies them as one.
      for (const img of images)
        if (who === "link holder") expect(img).toMatch(/\?o=[^&"]+&amp;e=\d+&amp;s=[\w-]+&amp;inline=1"/);
        else expect(img).not.toMatch(/[?&](o|e|s)=/);
    }
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

  it("shows one attempt's evidence and coverage though a retry starts between their reads (D01 T01 §19)", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "RUN");
    await saveEvidence(db, id, EVIDENCE("RUN"), undefined, undefined, [
      { check: "auth.spf", outcome: "ran", reason: null, findings: 1 },
    ]);
    const link = await signReportLink(SECRET, id, a);
    const prepare = db.prepare.bind(db);
    let outcomes: unknown[] | null = null;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (/^SELECT id, "check"/.test(sql))
        // Once the evidence is read, a retry moves the case to a new run.
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              all: async () => {
                const read = await bound.all();
                await prepare("UPDATE cases SET run_id = ? WHERE id = ?").bind(`${id}RB`, id).run();
                return read;
              },
            };
          },
        } as unknown as D1PreparedStatement;
      if (/FROM check_outcomes/.test(sql))
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              all: async () => {
                const read = await bound.all();
                outcomes = read.results;
                return read;
              },
            };
          },
        } as unknown as D1PreparedStatement;
      return statement;
    });
    expect((await get(link)).status).toBe(200);
    vi.restoreAllMocks();
    // The coverage read is the first run's, as the evidence was, not the new run's, which has none.
    // `revision`, `summary`, the data triple and `examined` null: these rows were stored with none of
    // them (D02 T01 §4, §6, §7, §8); the outcome reader omits an examined set that was never stored.
    expect(outcomes).toEqual([
      {
        check_name: "auth.spf",
        outcome: "ran",
        reason: null,
        findings: 1,
        revision: null,
        summary: null,
        data_revision: null,
        data_id: null,
        data_source: null,
        examined: null,
      },
    ]);
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
    // Each statement counted by its own table, its first FROM: the evidence read names the case's current run in a
    // subselect (D01 T01 §19), which is no second read of the case.
    const tableOf = (q: string) => /\bfrom\s+(\w+)/i.exec(q)?.[1]?.toLowerCase();
    expect(queries.filter((q) => tableOf(q) === "cases")).toHaveLength(1);
    expect(queries.filter((q) => tableOf(q) === "evidence")).toHaveLength(1);
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

// The report's header (D07 T03 §9): the stored subject and sender, who forwarded or uploaded it, named only to a member
// and only from the case's own organisation, every missing part said truthfully, hostile words kept as text.
describe("the report header", () => {
  async function named(orgId: string, name: string) {
    const who = await member(orgId);
    await db.prepare(`UPDATE "user" SET name = ? WHERE lower(email) = ?`).bind(name, who.email).run();
    const row = await db
      .prepare(`SELECT id FROM "user" WHERE lower(email) = ?`)
      .bind(who.email)
      .first<{ id: string }>();
    return { ...who, id: row?.id as string };
  }
  async function header(
    orgId: string,
    fields: {
      subject?: string | null;
      fromName?: string | null;
      fromAddress?: string | null;
      channel?: "email" | "upload";
      headersAvailable?: boolean;
      forwardedBy?: string | null;
      uploadedBy?: string | null;
    },
  ) {
    const id = await stored(orgId, "HEAD");
    await db
      .prepare(
        "UPDATE cases SET original_subject = ?, original_from_name = ?, original_from_address = ?, channel = ?, headers_available = ?, forwarded_by = ?, uploaded_by = ? WHERE id = ?",
      )
      .bind(
        fields.subject ?? null,
        fields.fromName ?? null,
        fields.fromAddress ?? null,
        fields.channel ?? "email",
        fields.headersAvailable === false ? 0 : 1,
        fields.forwardedBy ?? null,
        fields.uploadedBy ?? null,
        id,
      )
      .run();
    return id;
  }
  // The header's own markup: from the breadcrumb or title to the band.
  const top = (html: string) => html.slice(html.indexOf('id="report-header"'), html.indexOf('id="report-live"'));

  it("names the subject, the sender and the member who forwarded it as an attachment, with Copy link and Download PDF", async () => {
    const a = await org("Karoo Couriers");
    const thandi = await named(a, "Thandi Nkosi");
    const id = await header(a, {
      subject: "Your NimbusMail password expires today",
      fromName: "NimbusMail Security",
      fromAddress: "no-reply@nimbusmai1-login.example",
      forwardedBy: thandi.email,
    });
    const html = top(await (await get(`/r/${id}`, thandi.cookie)).text());
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain(
      '<span aria-current="page" class="min-w-0 truncate">Your NimbusMail password expires today</span>',
    );
    expect(html).toMatch(/<h1[^>]*>Your NimbusMail password expires today<\/h1>/);
    expect(html).toContain("NimbusMail Security &lt;no-reply@nimbusmai1-login.example&gt;");
    expect(html).toMatch(
      /Forwarded as an attachment by Thandi Nkosi · [A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} SAST/,
    );
    expect(html).toContain(`data-copy="http://localhost/r/${id}"`);
    expect(html).toMatch(
      /<span data-print-control="" class="hidden \[\[data-script\]_&amp;\]:inline-flex">[\s\S]*Download PDF/,
    );
    // The phone's line under the band.
    expect(await (await get(`/r/${id}`, thandi.cookie)).text()).toMatch(
      /Your NimbusMail password expires today · from no-reply@nimbusmai1-login\.example · /,
    );
  });

  it("says an inline forward, a forwarder who is no member by address, and an upload by its member", async () => {
    const a = await org("Karoo Couriers");
    const thandi = await named(a, "Thandi Nkosi");
    const inline = await header(a, {
      subject: "Invoice 77",
      headersAvailable: false,
      forwardedBy: "someone@else.example",
    });
    expect(top(await (await get(`/r/${inline}`, thandi.cookie)).text())).toContain(
      "Forwarded by someone@else.example · ",
    );
    const upload = await header(a, { subject: "scan.pdf", channel: "upload", uploadedBy: thandi.id });
    expect(top(await (await get(`/r/${upload}`, thandi.cookie)).text())).toContain("Uploaded by Thandi Nkosi · ");
  });

  // D07 T03 §42: the header says who uploaded it by the Cases list's own rule (D07 T04 §7): a blank name by the member's
  // email, a member who left or a user of another organisation as a former member, an unknown uploader as no one.
  it("says an upload's uploader by the list's rule: unknown, left, no name, or of another organisation", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const reader = await named(a, "Reader");
    const outsider = await named(b, "Outsider Person");
    const blank = await named(a, "   ");
    const leaver = await named(a, "Gone Member");
    await db.prepare(`DELETE FROM "member" WHERE "userId" = ? AND "organizationId" = ?`).bind(leaver.id, a).run();
    const said: [string | null, RegExp][] = [
      [null, />Uploaded · [A-Z]/],
      [leaver.id, />Uploaded by a former member · [A-Z]/],
      [blank.id, new RegExp(`>Uploaded by ${blank.email.replace(/[.+]/g, "\\$&")} · [A-Z]`)],
      [outsider.id, />Uploaded by a former member · [A-Z]/],
    ];
    for (const [uploadedBy, words] of said) {
      const id = await header(a, { subject: "scan.pdf", channel: "upload", uploadedBy });
      const html = top(await (await get(`/r/${id}`, reader.cookie)).text());
      expect(html, String(uploadedBy)).toMatch(words);
      expect(html).not.toContain("Outsider Person");
      expect(html).not.toContain("Gone Member");
    }
  });

  it("says what is missing truthfully: no subject, a name only, no sender", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    const none = await get(`/r/${await header(a, {})}`, reader.cookie);
    const html = await none.text();
    expect(top(html)).toMatch(/<h1[^>]*>No subject<\/h1>/);
    expect(top(html)).not.toContain("From ");
    expect(html).toMatch(/No subject · [A-Z][a-z]{2}, /);
    const nameOnly = await (
      await get(`/r/${await header(a, { subject: "Hi", fromName: "Bob" })}`, reader.cookie)
    ).text();
    expect(top(nameOnly)).toContain('From <strong class="text-ink weight-text-strong">Bob</strong>');
    expect(nameOnly).toContain("Hi · from Bob · ");
  });

  it("keeps a hostile subject of the longest stored length as text that wraps", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    // The longest subject intake stores (300 characters, the column's own check).
    const hostile = `<img src=x onerror=alert(1)>${"W".repeat(272)}`;
    const html = await (await get(`/r/${await header(a, { subject: hostile })}`, reader.cookie)).text();
    expect(html).not.toContain("<img src=x");
    expect(top(html)).toMatch(/<h1 class="[^"]*wrap-anywhere[^"]*">&lt;img src=x/);
  });

  it("shows a link holder the subject and sender but not who forwarded it, and copies the signed link", async () => {
    const a = await org("Karoo Couriers");
    const thandi = await named(a, "Thandi Nkosi");
    const id = await header(a, {
      subject: "Your NimbusMail password expires today",
      fromName: "NimbusMail Security",
      fromAddress: "no-reply@nimbusmai1-login.example",
      forwardedBy: thandi.email,
    });
    const link = await signReportLink(SECRET, id, a);
    const html = top(await (await get(link)).text());
    expect(html).toMatch(/<h1[^>]*>Your NimbusMail password expires today<\/h1>/);
    expect(html).toContain("no-reply@nimbusmai1-login.example");
    expect(html).not.toContain("Thandi");
    expect(html).not.toContain(thandi.email);
    expect(html).not.toContain("Forwarded");
    expect(html).not.toContain('aria-label="Breadcrumb"');
    expect(html).toContain(`data-copy="http://localhost${link.replaceAll("&", "&amp;")}"`);
  });

  // D07 T03 §12: producer-shaped reputation evidence read back through the report, for a member and a link holder.
  it("draws stored reputation cards for a member and for a link holder", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "REP");
    // Stored as the producer will write them once its checks register (D02 T06 §4, checks lane): the read path
    // draws what is stored, so the rows go in as stored rows.
    const repItems: [string, string, string, Record<string, unknown>][] = [
      [
        "E91",
        "reputation.listing",
        "Web Risk lists the sender's address.",
        {
          provider: "Web Risk",
          listed: "nimbusmai1-login.example/reset",
          granularity: "url",
          delist_url: "https://webrisk.example/review",
          corroborated: true,
          cap: "suspicious",
          listed_at: "2026-10-20T00:00:00Z",
        },
      ],
      [
        "E92",
        "reputation.counter_signal",
        "The domain is well known.",
        { provider: "majestic-million", domain: "karoo.example" },
      ],
    ];
    for (const [eid, check, summary, detail] of repItems)
      await db
        .prepare(
          `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at, producer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '2026-11-05T08:00:00.000Z', 'checks')`,
        )
        .bind(
          id,
          id,
          eid,
          eid === "E91" ? 91 : 92,
          check,
          check === "reputation.listing" ? "high" : "info",
          summary,
          JSON.stringify(detail),
        )
        .run();
    const member_ = await named(a, "Member Reader");
    for (const html of [
      await (await get(`/r/${id}`, member_.cookie)).text(),
      await (await get(await signReportLink(SECRET, id, a))).text(),
    ]) {
      expect(html).toContain("Listed by a reputation provider");
      expect(html).toContain("Web Risk");
      expect(html).toContain("nimbusmai1-login.example/reset");
      expect(html).toContain("20 October 2026");
      expect(html).toContain('href="https://webrisk.example/review"');
      expect(html).toContain("What speaks for this sender");
    }
  });

  // D07 T03 §16: a stored voice lure read back through the report, for a member and a link holder.
  it("draws a stored voice lure for a member and for a link holder", async () => {
    const a = await org("Karoo Couriers");
    const id = await stored(a, "LURE");
    await db
      .prepare(
        `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at, producer) VALUES (?, ?, 'E93', 93, 'voice.lure', 'medium', ?, ?, '[]', '2026-11-05T08:00:00.000Z', 'checks')`,
      )
      .bind(
        id,
        id,
        "An attachment claims to be a voice note and carries a player.",
        JSON.stringify({ filename: "voicenote.mp3", player: true, linked: false }),
      )
      .run();
    const member_ = await named(a, "Member Reader");
    for (const html of [
      await (await get(`/r/${id}`, member_.cookie)).text(),
      await (await get(await signReportLink(SECRET, id, a))).text(),
    ]) {
      expect(html).toContain("What the attachment claims to be");
      expect(html).toContain("voicenote.mp3");
      expect(html).toContain("A player in the message");
    }
  });

  // D07 T03 §42: an upload's attribution, in every form the member view gives it, never reaches a link holder: not the
  // name, not the email shown for a blank name, not the former-member words, on the page or in a status answer.
  it("shows a link holder no uploader, in any form, on the page or in the status answer", async () => {
    const a = await org("Karoo Couriers");
    const thandi = await named(a, "Thandi Nkosi");
    const blank = await named(a, "   ");
    const leaver = await named(a, "Gone Member");
    await db.prepare(`DELETE FROM "member" WHERE "userId" = ? AND "organizationId" = ?`).bind(leaver.id, a).run();
    for (const who of [thandi, blank, leaver]) {
      const id = await header(a, { subject: "scan.pdf", channel: "upload", uploadedBy: who.id });
      await db.prepare("UPDATE cases SET status = 'running', verdict = NULL WHERE id = ?").bind(id).run();
      const link = await signReportLink(SECRET, id, a);
      const page = await (await get(link)).text();
      const status = await (
        await get(`/r/${id}/status${link.slice(link.indexOf("?"))}&h=stale`, undefined, "text/html")
      ).text();
      // The status answer carries the header (its fingerprint is stale), so its absence is what is proven.
      expect(status).toMatch(/<div id="report-header"[^>]*hx-swap-oob="true"/);
      for (const html of [page, status]) {
        expect(html, who.email).not.toContain("Uploaded by");
        expect(html).not.toContain("former member");
        expect(html).not.toContain(who.email);
        expect(html).not.toContain("Thandi");
        expect(html).not.toContain("Gone Member");
      }
    }
  });

  it("sends the header out of band with each status answer, so a report opened before parsing catches up", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    const id = await header(a, {});
    await db.prepare("UPDATE cases SET status = 'running', verdict = NULL WHERE id = ?").bind(id).run();
    await db.prepare("UPDATE cases SET original_subject = 'Parsed at last' WHERE id = ?").bind(id).run();
    const status = await (await get(`/r/${id}/status`, reader.cookie, "text/html")).text();
    expect(status).toMatch(/<div id="report-header"[^>]*hx-swap-oob="true"/);
    expect(status).toMatch(/<h1[^>]*>Parsed at last<\/h1>/);
    expect(status).toContain("Parsed at last · ");
  });

  it("leaves the page's header alone when a poll holds the current one, for a member and a signed link", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    const id = await header(a, { subject: "Settled subject" });
    await db.prepare("UPDATE cases SET status = 'running', verdict = NULL WHERE id = ?").bind(id).run();
    const page = await (await get(`/r/${id}`, reader.cookie)).text();
    const key = /id="report-header" data-key="([^"]+)"/.exec(page)?.[1] ?? "";
    expect(key).not.toBe("");
    // The live region names the same key in the poll's values.
    expect(page).toContain(`hx-vals="{&quot;h&quot;:&quot;${key}&quot;}"`);
    const same = await (await get(`/r/${id}/status?h=${key}`, reader.cookie)).text();
    expect(same).toContain('id="report-live"');
    expect(same).not.toContain('id="report-header"');
    const stale = await (await get(`/r/${id}/status?h=stale`, reader.cookie)).text();
    expect(stale).toMatch(/<div id="report-header"[^>]*hx-swap-oob="true"/);
    // A signed link's poll carries the key beside its three signed parameters and still opens.
    const link = await signReportLink(SECRET, id, a);
    const publicPage = await (await get(link)).text();
    const publicKey = /id="report-header" data-key="([^"]+)"/.exec(publicPage)?.[1] ?? "";
    const polled = await get(`/r/${id}/status${link.slice(link.indexOf("?"))}&h=${publicKey}`);
    expect(polled.status).toBe(200);
    const body = await polled.text();
    expect(body).toContain('id="report-live"');
    expect(body).not.toContain('id="report-header"');
  });

  it("shows Copy link only where the app script runs, and the address to select by hand without it", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    const id = await header(a, { subject: "Share me" });
    const html = top(await (await get(`/r/${id}`, reader.cookie)).text());
    expect(html).toMatch(
      /<span data-copy-control="" class="hidden \[\[data-script\]_&amp;\]:inline-flex">[\s\S]*Copy link/,
    );
    expect(html).toMatch(
      /data-copy-reveal=""[^>]*>Link to this report: <span data-copy-source[^>]*>http:\/\/localhost\/r\//,
    );
  });

  it("gives a link holder a header key that says nothing of who forwarded it", async () => {
    const a = await org("Karoo Couriers");
    const [one, two] = [await named(a, "First Member"), await named(a, "Second Member")];
    const keyOf = async (forwardedBy: string) => {
      const id = await header(a, { subject: "Same", fromAddress: "x@sender.example", forwardedBy });
      const page = await (await get(await signReportLink(SECRET, id, a))).text();
      return /id="report-header" data-key="([^"]+)"/.exec(page)?.[1] ?? "";
    };
    const keys = [await keyOf(one.email), await keyOf(two.email), await keyOf("outsider@else.example")];
    expect(keys[0]).not.toBe("");
    expect(new Set(keys).size).toBe(1);
  });

  it("replaces a member's header when only the attachment wording changes", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    const id = await header(a, { headersAvailable: false, forwardedBy: "someone@else.example" });
    await db.prepare("UPDATE cases SET status = 'running', verdict = NULL WHERE id = ?").bind(id).run();
    const page = await (await get(`/r/${id}`, reader.cookie)).text();
    const key = /id="report-header" data-key="([^"]+)"/.exec(page)?.[1] ?? "";
    expect(top(page)).toContain("Forwarded by someone@else.example");
    // Parsing found the forward carried the original as an attachment, with no subject or sender.
    await db.prepare("UPDATE cases SET headers_available = 1 WHERE id = ?").bind(id).run();
    const status = await (await get(`/r/${id}/status?h=${key}`, reader.cookie)).text();
    expect(status).toMatch(/<div id="report-header"[^>]*hx-swap-oob="true"/);
    expect(status).toContain("Forwarded as an attachment by someone@else.example");
  });

  it("titles an upload by its file's name, labelled, and an uploaded email by its subject with its file named", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    for (const name of ["invoice.pdf", "pop.png", "voicemail.ogg"]) {
      const id = await header(a, { channel: "upload", uploadedBy: reader.id });
      await db.prepare("UPDATE cases SET upload_name = ? WHERE id = ?").bind(name, id).run();
      const html = top(await (await get(`/r/${id}`, reader.cookie)).text());
      expect(html, name).toMatch(
        new RegExp(`<h1[^>]*><span class="sr-only">Uploaded file: </span>${name.replace(".", "\\.")}</h1>`),
      );
      expect(html, name).not.toContain("No subject");
      expect(html, name).toMatch(new RegExp(`md:hidden[^>]*>Uploaded file ${name.replace(".", "\\.")} · `));
    }
    const mail = await header(a, { channel: "upload", uploadedBy: reader.id, subject: "Your account is locked" });
    await db.prepare("UPDATE cases SET upload_name = 'saved.eml' WHERE id = ?").bind(mail).run();
    const html = top(await (await get(`/r/${mail}`, reader.cookie)).text());
    expect(html).toMatch(/<h1[^>]*>Your account is locked<\/h1>/);
    expect(html).toContain('Uploaded file <strong class="text-ink weight-text-strong">saved.eml</strong>');
  });

  it("titles an uploaded email by its file until parsing stores its subject, then the poll swaps the title", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    const id = await header(a, { channel: "upload", uploadedBy: reader.id });
    await db
      .prepare("UPDATE cases SET upload_name = 'saved.eml', status = 'running', verdict = NULL WHERE id = ?")
      .bind(id)
      .run();
    const page = await (await get(`/r/${id}`, reader.cookie)).text();
    expect(top(page)).toContain("saved.eml</h1>");
    const key = /id="report-header" data-key="([^"]+)"/.exec(page)?.[1] ?? "";
    await db.prepare("UPDATE cases SET original_subject = 'Parsed subject' WHERE id = ?").bind(id).run();
    const status = await (await get(`/r/${id}/status?h=${key}`, reader.cookie)).text();
    expect(status).toMatch(/<div id="report-header"[^>]*hx-swap-oob="true"/);
    expect(status).toMatch(/<h1[^>]*>Parsed subject<\/h1>/);
    expect(status).toContain("Uploaded file <strong");
    // The phone's line, in the live region the poll redraws, names both after parsing.
    expect(status).toMatch(/md:hidden[^>]*>Parsed subject · Uploaded file saved\.eml · /);
  });

  it("keeps a hostile file name as text in the title, the line beside it and the phone's line", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    const hostile = `<img src=x onerror=alert(1)>${"W".repeat(200)}.pdf`;
    for (const subject of [undefined, "Your account is locked"]) {
      const id = await header(a, { channel: "upload", uploadedBy: reader.id, ...(subject ? { subject } : {}) });
      await db.prepare("UPDATE cases SET upload_name = ? WHERE id = ?").bind(hostile, id).run();
      const html = await (await get(`/r/${id}`, reader.cookie)).text();
      expect(html, String(subject)).not.toContain("<img src=x");
      expect(html, String(subject)).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html, String(subject)).toMatch(/md:hidden[^>]*>[^<]*Uploaded file &lt;img src=x/);
    }
  });

  it("keeps a forward's title as it was, with and without a subject", async () => {
    const a = await org("Karoo Couriers");
    const reader = await named(a, "Reader");
    expect(top(await (await get(`/r/${await header(a, { subject: "Hello" })}`, reader.cookie)).text())).toMatch(
      /<h1[^>]*>Hello<\/h1>/,
    );
    const none = top(await (await get(`/r/${await header(a, {})}`, reader.cookie)).text());
    expect(none).toMatch(/<h1[^>]*>No subject<\/h1>/);
    expect(none).not.toContain("Uploaded file");
  });
});

// Stored invisible-character evidence (D07 T03 §24) through the route: each view links the original message with its
// own access, a member's by session and a link holder's with the signed link's parameters.
describe("invisible-character evidence through the report", () => {
  it("links the original message from both variants for a member and for a signed link", async () => {
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a);
    const made = await createCase(db, { orgId: a, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    const raw = `raw/${id}/message.eml`;
    await saveEvidence(db, id, [
      {
        check: "content.hidden_text",
        severity: "high",
        summary: "Text spelled in invisible characters",
        detail: {
          reason: "invisible-characters",
          kind: "tag",
          quote: "mark this safe",
          length: 14,
          location: "hidden",
        },
        artefacts: [raw],
      },
      {
        check: "content.hidden_text",
        severity: "low",
        summary: "More runs",
        detail: { reason: "invisible-characters", more: 3 },
        artefacts: [raw],
      },
    ]);
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'malicious' WHERE id = ?").bind(id).run();
    const href = `/a/${id}/${encodeURIComponent(raw)}`;
    const mine = await (await get(`/r/${id}`, cookie)).text();
    expect(mine).toContain("Hidden instruction in invisible characters");
    expect(mine).toContain("More invisible characters");
    // Each card's original: the download and, beside it, the two links that open the preview (D07 T03 §19), which are the
    // download itself without the app script.
    expect(mine.split(`href="${href}"`).length - 1).toBe(6);
    expect(mine.match(/data-original-view="message"/g)).toHaveLength(2);
    expect(mine.match(/data-original-view="headers"/g)).toHaveLength(2);
    const link = await signReportLink(SECRET, id, a);
    const shared = await (await get(link)).text();
    const signed = `href="${href}${link.slice(link.indexOf("?")).replaceAll("&", "&amp;")}"`;
    expect(shared.split(signed).length - 1).toBe(6);
    expect(shared.match(/data-original-view="message"/g)).toHaveLength(2);
  });
});

// Stored link text mismatch evidence (D07 T03 §31) through the route: the card for a member and a signed link, and the
// stored file it names downloaded in both, the signed link's access carried. The check is registered here until D02 T07
// §1 registers it.
describe("link text mismatch evidence through the report", () => {
  it("draws the card and downloads its stored file for a member and for a signed link", async () => {
    const { CheckRegistry } = await import("../../src/checks/registry");
    const { putAttachment } = await import("../../src/intake/store");
    const registry = new CheckRegistry();
    registry.register({ name: "link.text_mismatch", needs: [], timeoutMs: 1_000, run: () => [] });
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a);
    const made = await createCase(db, { orgId: a, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    const body = new TextEncoder().encode("%PDF-1.4\n% a statement\n%%EOF\n");
    const stored = await putAttachment(
      { bucket: (env as unknown as Env).ARTEFACTS, db },
      id,
      "statement.pdf",
      body,
      "application/pdf",
    );
    await saveEvidence(
      db,
      id,
      [
        {
          check: "link.text_mismatch",
          severity: "medium",
          summary: "The link showing bank.co.za goes to evil.example.",
          detail: {
            shown: "bank.co.za",
            target: "evil.example",
            href: "https://evil.example/x",
            kind: "pdf",
            part: stored.key,
          },
          artefacts: [stored.key],
        },
      ],
      registry,
    );
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'malicious' WHERE id = ?").bind(id).run();
    const href = `/a/${id}/${encodeURIComponent(stored.key)}`;
    const mine = await (await get(`/r/${id}`, cookie)).text();
    expect(mine).toContain("A link that shows one address and goes to another");
    expect(mine).toContain(`href="${href}"`);
    const file = await get(href, cookie, "*/*");
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(body);
    const link = await signReportLink(SECRET, id, a);
    const query = link.slice(link.indexOf("?"));
    const shared = await (await get(link)).text();
    expect(shared).toContain("A link that shows one address and goes to another");
    expect(shared).toContain(`href="${href}${query.replaceAll("&", "&amp;")}"`);
    const signed = await get(`${href}${query}`, undefined, "*/*");
    expect(signed.status).toBe(200);
    expect(new Uint8Array(await signed.arrayBuffer())).toEqual(body);
  });
});

// Stored document forensics evidence (D07 T03 §30) through the route: the card for a member and a signed link, and the
// PDF downloaded in both, the signed link's access carried. The checks are registered here until D06 T02 §3 does.
describe("document forensics evidence through the report", () => {
  it("draws the card and downloads its PDF for a member and for a signed link", async () => {
    const { CheckRegistry } = await import("../../src/checks/registry");
    const { putAttachment } = await import("../../src/intake/store");
    const registry = new CheckRegistry();
    for (const kind of ["revisions", "producer", "dates", "fonts", "overlay"])
      registry.register({ name: `document.forensics.${kind}`, needs: [], timeoutMs: 1_000, run: () => [] });
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a);
    const made = await createCase(db, { orgId: a, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    const body = new TextEncoder().encode("%PDF-1.4\n% a proof of payment\n%%EOF\n");
    const stored = await putAttachment(
      { bucket: (env as unknown as Env).ARTEFACTS, db },
      id,
      "pop.pdf",
      body,
      "application/pdf",
    );
    await saveEvidence(
      db,
      id,
      [
        {
          check: "document.forensics.revisions",
          severity: "medium",
          summary: "pop.pdf was changed after it was first saved: a later save changed what its pages show.",
          detail: {
            filename: "pop.pdf",
            issuer: "bank",
            revisions: 2,
            edits: 1,
            afterSignature: false,
            updates: ["content"],
            linearizedLengthChanged: false,
            limits: "Shows the file was saved again with what its pages show changed.",
          },
          artefacts: [stored.key],
        },
        ...(
          [
            ["producer", { tool: "Microsoft Word", producer: "Microsoft Word 2019" }],
            ["dates", { created: "2026-10-20", modified: "2026-10-28", paymentDate: "2026-10-25" }],
            [
              "fonts",
              { page: 1, line: "Amount R 48 500.00", font: "Arial-BoldMT", otherFont: "Helvetica", rule: "subset" },
            ],
            ["overlay", { page: 2, covered: "62000123456", line: "Account 62000123456", onAmountOrAccountLine: true }],
          ] as const
        ).map(([kind, detail]) => ({
          check: `document.forensics.${kind}`,
          severity: "high" as const,
          summary: `pop.pdf has a ${kind} finding.`,
          detail: { filename: "pop.pdf", issuer: "bank", ...detail, limits: `The ${kind} limits.` },
          artefacts: [stored.key],
        })),
      ],
      registry,
    );
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'malicious' WHERE id = ?").bind(id).run();
    const href = `/a/${id}/${encodeURIComponent(stored.key)}`;
    const mine = await (await get(`/r/${id}`, cookie)).text();
    const titles = [
      "Changed after it was first saved",
      "Made or saved with an editing program",
      "Dates that do not fit the payment",
      "A line set from a second copy of its typeface",
      "An image placed over its text",
    ];
    for (const title of titles) expect(mine, title).toContain(title);
    expect(mine).toContain(`href="${href}"`);
    const file = await get(href, cookie, "*/*");
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(body);
    const link = await signReportLink(SECRET, id, a);
    const query = link.slice(link.indexOf("?"));
    const shared = await (await get(link)).text();
    for (const title of titles) expect(shared, title).toContain(title);
    expect(shared).toContain(`href="${href}${query.replaceAll("&", "&amp;")}"`);
    const signed = await get(`${href}${query}`, undefined, "*/*");
    expect(signed.status).toBe(200);
    expect(new Uint8Array(await signed.arrayBuffer())).toEqual(body);
  });
});

// A signed link's report invites its reader to sign in and come back (D07 T03 §26): to the report's own path, so a
// member of its organisation opens the member view (with "This verdict is wrong" once there is a verdict) and anyone
// else §1's 404; the words say what signing in gives in each state.
describe("signing in from a signed link", () => {
  it("invites a link holder to sign in and back, in words for the report's state, and never a member", async () => {
    const a = await org("Karoo Couriers");
    const done = await stored(a, "DONE");
    const doneHtml = await (await get(await signReportLink(SECRET, done, a))).text();
    expect(doneHtml).toContain(`href="/signin?next=%2Fr%2F${done}%3Fdispute%3D1`);
    expect(doneHtml).toContain("Is this your organisation&#39;s report? ");
    expect(doneHtml).toContain("to tell us if we got it wrong.");
    for (const status of ["running", "partial"] as const) {
      const id = await stored(a, status.toUpperCase(), status, null);
      const html = await (await get(await signReportLink(SECRET, id, a))).text();
      expect(html, status).toContain(`href="/signin?next=%2Fr%2F${id}"`);
      expect(html, status).toContain("to see it with your organisation&#39;s cases.");
      expect(html, status).not.toContain("to tell us if we got it wrong.");
    }
    const { cookie } = await member(a);
    expect(await (await get(`/r/${done}`, cookie)).text()).not.toContain("Is this your organisation");
  });

  it("brings a member who signs in from the link back to the member view with the dispute open (D07 T03 §22)", async () => {
    const { storeVerdict } = await import("../../src/db/verdicts");
    const a = await org("Karoo Couriers");
    const id = await stored(a, "ROUND", "running", null);
    const view = {
      verdict: "malicious" as const,
      headline: "A lookalike bank asks for a new account.",
      confidence: 0.9,
      reasons: [],
      actions: ["Do not pay."],
      source: "rules" as const,
    };
    expect((await storeVerdict(db, a, id, view)).ok).toBe(true);
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'malicious' WHERE id = ?").bind(id).run();
    const shared = await (await get(await signReportLink(SECRET, id, a))).text();
    const next = new URL(/href="(\/signin\?next=[^"]+)"/.exec(shared)?.[1] ?? "", "http://localhost").searchParams.get(
      "next",
    );
    expect(next).toBe(`/r/${id}?dispute=1`);
    const email = `round-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    await signIn(email);
    await join(email, a);
    const smtp = stubSmtp2go();
    try {
      await requestLink(email, next ?? "");
      const landed = await redeem(smtp.sends.at(-1)?.link ?? "");
      expect(target(landed)).toBe(`/r/${id}?dispute=1`);
      const opened = await get(target(landed) ?? "", sessionCookie(landed));
      expect(opened.status).toBe(200);
      const html = await opened.text();
      expect(html).toContain('aria-label="Main"');
      expect(html).toContain("You came here from the email to say this verdict is wrong.");
      expect(html).toContain("data-focus-on-load");
      expect(html).toContain("I think this is safe");
      // A member already signed in lands on the same focused control from the email's dispute link.
      const direct = await (await get(`/r/${id}?dispute=1`, sessionCookie(landed))).text();
      expect(direct).toContain("data-focus-on-load");
    } finally {
      smtp.restore();
    }
  });

  it("sends someone outside the organisation who signs in from the link to the 404, not the public view", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const id = await stored(a, "OUTSIDE");
    const email = `outside-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    await signIn(email);
    await join(email, b);
    const smtp = stubSmtp2go();
    try {
      await requestLink(email, `/r/${id}`);
      const landed = await redeem(smtp.sends.at(-1)?.link ?? "");
      const opened = await get(target(landed) ?? "", sessionCookie(landed));
      expect(opened.status).toBe(404);
      expect(await opened.text()).not.toContain("OUTSIDE: the sender");
    } finally {
      smtp.restore();
    }
  });
});
