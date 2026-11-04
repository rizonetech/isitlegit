import { env } from "cloudflare:test";
import { jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { formatElapsedClock, type ReportCase, ReportDocument } from "../../src/web/pages/report-view";
import { signReportLink } from "../../src/web/report-link";
import { call, signIn } from "../auth/helpers";

const e = env as unknown as Env;
const db = e.DB;

const CASE: ReportCase = {
  id: "01JCASE0000000000000000000",
  status: "done",
  verdict: "malicious",
  sourceKind: "mail",
  channel: "email",
  createdAt: "2026-11-03T10:00:00.000Z",
  originalSubject: "Updated banking details for invoice",
  originalFromName: "Fynbos Billing",
  originalFromAddress: "accounts@fynbos-freight.co.za",
  headersAvailable: true,
};

async function memberCase() {
  const orgId = `org-clock-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(orgId, "Clock Co", orgId, new Date().toISOString())
    .run();
  const email = `clock-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
    .run();
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return { orgId, cookie, id: made.value.id };
}

describe("demo clock overlay (D09 T02 §3)", () => {
  it("formats elapsed seconds into mm:ss.t and seconds", () => {
    expect(formatElapsedClock(0)).toBe("00:00.0 (0.0 s)");
    expect(formatElapsedClock(12.4)).toBe("00:12.4 (12.4 s)");
    expect(formatElapsedClock(75.8)).toBe("01:15.8 (75.8 s)");
  });

  it("renders the demo clock in ReportDocument only when clock is true", () => {
    const withoutClock = String(
      jsx(ReportDocument, {
        stored: CASE,
        verdict: null,
        evidence: [],
        shell: null,
        now: new Date("2026-11-03T10:00:14.200Z"),
      }),
    );
    expect(withoutClock).not.toContain('id="demo-clock"');
    expect(withoutClock).not.toContain("data-demo-clock");

    const withClock = String(
      jsx(ReportDocument, {
        stored: CASE,
        verdict: null,
        evidence: [],
        shell: null,
        clock: true,
        now: new Date("2026-11-03T10:00:14.200Z"),
      }),
    );
    expect(withClock).toContain('id="demo-clock"');
    expect(withClock).toContain("data-demo-clock");
    expect(withClock).toContain('data-created-at="2026-11-03T10:00:00.000Z"');
    expect(withClock).toContain("Elapsed since received: 00:14.2 (14.2 s)");
  });

  it("renders the demo clock on /r/:caseId only when ?clock=1 is passed", async () => {
    const { orgId, cookie, id } = await memberCase();

    const plainRes = await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } });
    expect(plainRes.status).toBe(200);
    const plainHtml = await plainRes.text();
    expect(plainHtml).not.toContain('id="demo-clock"');

    const clockRes = await call(`/r/${id}?clock=1`, { headers: { cookie, accept: "text/html" } });
    expect(clockRes.status).toBe(200);
    const clockHtml = await clockRes.text();
    expect(clockHtml).toContain('id="demo-clock"');
    expect(clockHtml).toContain("Elapsed since received:");

    // Also works on a signed public report link without breaking link verification.
    const signedPath = await signReportLink(e.REPORT_LINK_SECRET, id, orgId);
    const publicClockRes = await call(`${signedPath}&clock=1`, { headers: { accept: "text/html" } });
    expect(publicClockRes.status).toBe(200);
    const publicClockHtml = await publicClockRes.text();
    expect(publicClockHtml).toContain('id="demo-clock"');
  });
});
