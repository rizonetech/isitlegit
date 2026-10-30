import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { admitCase, sastDayStart } from "../../src/db/cases";

// D07 T02 §4: the daily case cap, applied in the statement that creates the case.
const db = (env as unknown as Env).DB;
const newCase = (orgId: string) => ({
  orgId,
  channel: "upload" as const,
  headersAvailable: false,
  uploadedBy: "user-cap",
});
// 10:00 SAST on 28 October 2026 (08:00 UTC).
const MORNING = new Date("2026-10-28T08:00:00Z");

async function fill(orgId: string, count: number, at = MORNING) {
  for (let i = 0; i < count; i++) {
    const admitted = await admitCase(db, newCase(orgId), at);
    if (!admitted.ok) throw new Error(`case ${i + 1} refused: ${admitted.error.message}`);
  }
}
const casesOf = async (orgId: string) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM cases WHERE org_id = ?").bind(orgId).first<{ n: number }>())?.n;

describe("admitCase", () => {
  it("admits 50 cases a day and refuses the 51st, creating nothing", async () => {
    await fill("org-cap", 50);
    const refused = await admitCase(db, newCase("org-cap"), MORNING);
    expect(refused).toEqual({
      ok: false,
      error: { code: "capped", message: expect.stringMatching(/daily case limit/) },
    });
    expect(await casesOf("org-cap")).toBe(50);
  });

  it("starts the count again at midnight SAST, not UTC", async () => {
    // 23:59 SAST on the 28th is 21:59 UTC; 00:00 SAST on the 29th is 22:00 UTC on the 28th.
    const lastMinute = new Date("2026-10-28T21:59:00Z");
    const midnight = new Date("2026-10-28T22:00:00Z");
    expect(sastDayStart(lastMinute)).toBe("2026-10-27T22:00:00.000Z");
    expect(sastDayStart(midnight)).toBe("2026-10-28T22:00:00.000Z");
    await fill("org-midnight", 50, lastMinute);
    expect((await admitCase(db, newCase("org-midnight"), lastMinute)).ok).toBe(false);
    expect((await admitCase(db, newCase("org-midnight"), midnight)).ok).toBe(true);
  });

  it("honours an organisation's own lower limit", async () => {
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases) VALUES ('org-small', 3)").run();
    await fill("org-small", 3);
    expect((await admitCase(db, newCase("org-small"), MORNING)).ok).toBe(false);
    // Another organisation is not held back by it.
    expect((await admitCase(db, newCase("org-other"), MORNING)).ok).toBe(true);
  });

  it("of two cases arriving together for the last slot, admits exactly one", async () => {
    await fill("org-race", 49);
    const both = await Promise.all([
      admitCase(db, newCase("org-race"), MORNING),
      admitCase(db, newCase("org-race"), MORNING),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok && r.error.code === "capped")).toHaveLength(1);
    expect(await casesOf("org-race")).toBe(50);
  });
});
