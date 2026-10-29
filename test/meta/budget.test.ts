import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { costUsd, estimateUsd, markUncertain, reserve, settle } from "../../src/meta/budget";
import { inline, reserveStatement } from "../../src/meta/budget-sql";
import { DAY_CAP_USD, RESERVE_DAYS, RESERVE_USD, TOTAL_CAP_USD, totalLimitFor } from "../../src/meta/caps";
import { sastDay } from "../../src/meta/day";
import { MODELS } from "../../src/meta/models";

// The Meta budget guard (D03 T01 §2): one authority in D1, an atomic reservation, the caps from caps.ts only.
const db = (env as unknown as Env).DB;

beforeEach(async () => {
  await db.prepare("DELETE FROM model_spend").run();
});

const row = (day: string, estimateUsd: number, extra: Partial<{ id: string; caseId: string }> = {}) => ({
  at: `${day}T08:00:00.000Z`,
  day,
  source: "worker" as const,
  caller: "test",
  model: "muse-spark-1.3",
  caseId: extra.caseId ?? null,
  attempt: 1,
  estimateUsd,
  ...(extra.id ? { id: extra.id } : {}),
});

describe("the caps", () => {
  it("are the operator's: US$120 in all, US$15 a day, US$30 held for 3 and 4 November", () => {
    expect([TOTAL_CAP_USD, DAY_CAP_USD, RESERVE_USD]).toEqual([120, 15, 30]);
    expect(RESERVE_DAYS).toEqual(["2026-11-03", "2026-11-04"]);
    expect(totalLimitFor("2026-11-02")).toBe(90);
    expect(totalLimitFor("2026-11-03")).toBe(120);
    expect(totalLimitFor("2026-11-05")).toBe(90);
  });

  it("count the day in South Africa, so 23:30 UTC is already the next day", () => {
    expect(sastDay(new Date("2026-11-02T21:59:59.999Z"))).toBe("2026-11-02");
    expect(sastDay(new Date("2026-11-02T22:00:00.000Z"))).toBe("2026-11-03");
    // The reserve opens at SAST midnight on the 3rd and closes at SAST midnight after the 4th.
    expect(totalLimitFor(sastDay(new Date("2026-11-02T22:00:00.000Z")))).toBe(120);
    expect(totalLimitFor(sastDay(new Date("2026-11-04T21:59:59.999Z")))).toBe(120);
    expect(totalLimitFor(sastDay(new Date("2026-11-04T22:00:00.000Z")))).toBe(90);
  });
});

describe("reserve", () => {
  it("admits a call under both caps and refuses the day cap, the reserve and the total", async () => {
    expect(await reserve(db, row("2026-10-30", 5))).toMatchObject({ ok: true });
    expect(await reserve(db, row("2026-10-30", 9.99))).toMatchObject({ ok: true });
    expect(await reserve(db, row("2026-10-30", 0.02))).toEqual({ ok: false, cap: "day" });
    // US$87 spent before the reserve days: a call that would reach into the held-back US$30 is refused.
    await db.prepare("DELETE FROM model_spend").run();
    for (let d = 1; d <= 6; d++) await reserve(db, row(`2026-10-${String(d + 20).padStart(2, "0")}`, 14.5));
    expect(await reserve(db, row("2026-11-02", 4))).toEqual({ ok: false, cap: "reserve" });
    // On a reserve day it may be spent, within the day cap, up to the total.
    expect(await reserve(db, row("2026-11-03", 15))).toMatchObject({ ok: true });
    expect(await reserve(db, row("2026-11-04", 15))).toMatchObject({ ok: true });
    expect(await reserve(db, row("2026-11-05", 3.5))).toEqual({ ok: false, cap: "total" });
  });

  it("admits exactly what the allowance pays for when twenty reservations race", async () => {
    // Room for seven calls at US$2 under the US$15 day cap (US$14), no more.
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => reserve(db, row("2026-10-31", 2))));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(7);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM model_spend").first<{ n: number }>();
    expect(rows?.n).toBe(7);
  });

  it("counts a lost answer at its estimate, and a settled call at its cost, once", async () => {
    const lost = await reserve(db, row("2026-10-30", 10));
    if (!lost.ok) throw new Error("reserve");
    await markUncertain(db, lost.id);
    expect(await reserve(db, row("2026-10-30", 5.5))).toEqual({ ok: false, cap: "day" });
    const paid = await reserve(db, row("2026-10-30", 4));
    if (!paid.ok) throw new Error("reserve");
    await settle(db, paid.id, 1);
    await settle(db, paid.id, 3.5);
    const settled = await db.prepare("SELECT actual_usd, state FROM model_spend WHERE id = ?").bind(paid.id).first();
    expect(settled).toEqual({ actual_usd: 1, state: "settled" });
    // US$10 uncertain plus US$1 settled: US$4 left today.
    expect(await reserve(db, row("2026-10-30", 4))).toMatchObject({ ok: true });
  });
});

describe("pricing", () => {
  it("bounds a token call by its input bytes and output limit, and needs the limit", () => {
    const price = MODELS["muse-spark-1.3"];
    expect(estimateUsd("muse-spark-1.3", { inputBytes: 1_000_000, maxOutputTokens: 1_000_000 })).toBeCloseTo(
      price.input + price.output,
    );
    expect(() => estimateUsd("muse-wonder-1.0", { inputBytes: 10 })).toThrow(/output limit/);
  });

  it("prices every unit Meta bills from the reported usage, and unreadable usage as unknown", () => {
    const spark = MODELS["muse-spark-1.3"];
    expect(costUsd("muse-spark-1.3", { inputTokens: 1000, cachedTokens: 400, outputTokens: 200 })).toBeCloseTo(
      (600 * spark.input + 400 * spark.cached + 200 * spark.output) / 1_000_000,
    );
    expect(costUsd("sam-3.1", { images: 3 })).toBeCloseTo(3 * MODELS["sam-3.1"].perImage);
    expect(costUsd("muse-image-1.0", { images: 1 })).toBeCloseTo(MODELS["muse-image-1.0"].perImage);
    expect(costUsd("muse-voice-transcribe-1.0", { audioSeconds: 60.2 })).toBeCloseTo(
      61 * MODELS["muse-voice-transcribe-1.0"].perSecond,
    );
    expect(costUsd("muse-spark-1.3", { inputTokens: -1, outputTokens: 2 })).toBeNull();
    expect(costUsd("sam-3.1", {})).toBeNull();
    expect(estimateUsd("muse-voice-transcribe-1.0", { audioSeconds: 60.2 })).toBeCloseTo(
      61 * MODELS["muse-voice-transcribe-1.0"].perSecond,
    );
  });
});

describe("the statement for wrangler", () => {
  it("writes each value in as a literal that cannot end its quotes, and refuses anything else", () => {
    const sql = inline(reserveStatement({ ...row("2026-10-30", 1, { id: "it's-1" }), id: "it's-1" }, 15, 90));
    expect(sql).toContain("'it''s-1'");
    expect(sql).not.toMatch(/\?\d/);
    expect(() => inline({ sql: "SELECT ?1", params: ["x\u0000"] })).toThrow(/printable/);
    expect(() => inline({ sql: "SELECT ?1", params: [Number.NaN] })).toThrow(/finite/);
  });
});

describe("the cap a refusal names (completion review)", () => {
  it("names the longer-lived cap when the day's is spent too, so no one is told to come back tomorrow in vain", async () => {
    const { refusingCap } = await import("../../src/meta/caps");
    // US$15 spent today and US$90 in all before the reserve days: tomorrow is refused too.
    expect(refusingCap(15, 90, 1, "2026-11-01")).toBe("reserve");
    expect(refusingCap(15, 120, 1, "2026-11-03")).toBe("total");
    expect(refusingCap(15, 40, 1, "2026-11-01")).toBe("day");
  });
});
