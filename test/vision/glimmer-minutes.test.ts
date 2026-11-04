import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  allowanceMinutes,
  DAILY_MINUTES,
  DEPLOYED_GPU,
  dayLimitMinutes,
  FIREWORKS_DAY_CAP_USD,
  FIREWORKS_TOTAL_CAP_USD,
  hourlyRateUsd,
  MAX_WARMUP_SECONDS,
  PRICE_PER_HOUR_USD,
  SCALE_TO_ZERO_SECONDS,
  TAIL_MINUTES,
  totalLimitMinutes,
  WARMUP_MARGIN_SECONDS,
} from "../../src/vision/glimmer-caps";
import {
  burstMinutes,
  d1Exec,
  dayMinutes,
  type Exec,
  findBurst,
  ledgerStatus,
  mayCall,
  minutesByDay,
  minutesUsed,
  reserveBurst,
  settleBurst,
  usedMinutes,
} from "../../src/vision/glimmer-minutes";

// Loupe's runtime ledger (D03 T04 §14) on the real schema: a reservation counts at its reserve until settled, the
// admission is atomic, a repeated id is never charged twice, and a ledger that cannot be written refuses.
const db = (env as unknown as Env).DB;
const exec = d1Exec(db);

beforeEach(async () => {
  await db.prepare("DELETE FROM glimmer_runtime").run();
});

// 00:00 SAST on 2026-11-01, and 23:55 SAST the night before.
const MORNING = new Date("2026-10-31T22:00:00Z");
const LATE = new Date("2026-10-31T21:55:00Z");
const reservation = (id: string, minutes: number, at = MORNING, source: "worker" | "local" = "worker") => ({
  id,
  at,
  source,
  caller: "test",
  purpose: "monitor",
  minutes,
});

describe("caps", () => {
  it("raises cumulative usage headroom while retaining individual execution limits", () => {
    expect([FIREWORKS_DAY_CAP_USD, FIREWORKS_TOTAL_CAP_USD]).toEqual([50, 250]);
    expect([DAILY_MINUTES, SCALE_TO_ZERO_SECONDS, TAIL_MINUTES, MAX_WARMUP_SECONDS, WARMUP_MARGIN_SECONDS]).toEqual([
      60, 300, 6, 195, 60,
    ]);
    expect(totalLimitMinutes()).toBe(1875);
    expect(dayLimitMinutes()).toBe(60);
  });
  it("prices the deployed GPU and refuses one it has no price for", () => {
    expect(hourlyRateUsd()).toBe(8);
    expect(PRICE_PER_HOUR_USD[DEPLOYED_GPU]).toBe(8);
    expect(() => hourlyRateUsd("NVIDIA_B200_180GB")).toThrow(/no checked price/);
  });
  it("keeps 60 minutes a day under the day's money cap, so the minutes bind first", () => {
    expect((DAILY_MINUTES * hourlyRateUsd()) / 60).toBeLessThan(FIREWORKS_DAY_CAP_USD);
    expect(dayLimitMinutes()).toBe(DAILY_MINUTES);
    // A pricier GPU would make the money cap bind: at US$130 an hour, US$50 is 23.1 minutes.
    expect(dayLimitMinutes(130)).toBeCloseTo((50 / 130) * 60, 6);
  });
  it("charges the measured tail, not the 300 s setting", () => {
    expect(TAIL_MINUTES * 60).toBeGreaterThanOrEqual(335);
  });
});

describe("minutesByDay and minutesUsed", () => {
  it("splits a burst at SAST midnight", () => {
    expect(minutesByDay(LATE, 15)).toEqual([
      { day: "2026-10-31", minutes: 5 },
      { day: "2026-11-01", minutes: 10 },
    ]);
  });
  it("counts two recorded bursts exactly, an unsettled one at its reserve", () => {
    const rows = [
      { day: "2026-11-01", reserved_minutes: 12, used_minutes: 9.5 },
      { day: "2026-11-01", reserved_minutes: 10.25, used_minutes: null },
      { day: "2026-10-31", reserved_minutes: 30, used_minutes: 30 },
    ];
    expect(minutesUsed(rows, "2026-11-01")).toBe(19.75);
  });
  it("reserves warm-up, its margin, the calls and the tail", () => {
    expect(burstMinutes(10, 6)).toBeCloseTo((MAX_WARMUP_SECONDS + WARMUP_MARGIN_SECONDS) / 60 + 1 + TAIL_MINUTES, 9);
    expect(burstMinutes(10, 6, false)).toBeCloseTo(1 + TAIL_MINUTES, 9);
  });
  it("uses from the wake to the later of the last answer and the last deadline, plus the tail", () => {
    const wake = MORNING;
    const answer = new Date(wake.getTime() + 4 * 60_000);
    const deadline = new Date(wake.getTime() + 5 * 60_000);
    expect(usedMinutes(wake, { lastAnswerAt: answer, lastDeadlineAt: deadline })).toBe(5 + TAIL_MINUTES);
    expect(usedMinutes(wake, { lastAnswerAt: answer })).toBe(4 + TAIL_MINUTES);
    expect(usedMinutes(wake, {})).toBe(0);
  });
});

// Judging allowance: 60 minutes a day on average since 2026-10-31, one day borrowed ahead. Through 2026-10-31 the ledger may hold
// 120 minutes; through 2026-11-01, 180.
describe("the averaged allowance", () => {
  it("allows 60 a day times the days so far, plus one day ahead", () => {
    expect(allowanceMinutes("2026-10-31")).toBe(120);
    expect(allowanceMinutes("2026-11-01")).toBe(180);
    expect(allowanceMinutes("2026-11-07")).toBe(540);
    // The strict rule is the same function with no day borrowed and its own first day.
    expect(allowanceMinutes("2026-11-01", { from: "2026-11-01", borrow: 0 })).toBe(60);
  });
});

describe("mayCall", () => {
  it("refuses at the running allowance's edge, earlier days counted, and allows just under it", () => {
    const ledger = { days: { "2026-10-31": 110, "2026-11-01": 60 }, total: 170 };
    expect(mayCall(ledger, MORNING, 10).ok).toBe(true);
    expect(mayCall(ledger, MORNING, 10.01)).toMatchObject({ ok: false, reason: "average-minutes", day: "2026-11-01" });
  });
  it("lets a day pass 60 by borrowing ahead, and lets unused days roll over", () => {
    // 2026-10-31 alone may reach 120: a busy first day borrows the next one's 60.
    expect(mayCall({ days: { "2026-10-31": 116 }, total: 116 }, LATE, 4).ok).toBe(true);
    // A day after a quiet one may reach past 120: 2026-10-31 used 10, so 2026-11-01 may take 170.
    expect(mayCall({ days: { "2026-10-31": 10 }, total: 10 }, MORNING, 170).ok).toBe(true);
    expect(mayCall({ days: { "2026-10-31": 10 }, total: 10 }, MORNING, 170.01).ok).toBe(false);
  });
  it("checks a burst across midnight through each day it touches", () => {
    // 5 minutes on 2026-10-31 and 10 on 2026-11-01.
    expect(mayCall({ days: { "2026-10-31": 116 }, total: 116 }, LATE, 15)).toMatchObject({
      reason: "average-minutes",
      day: "2026-10-31",
    });
    expect(mayCall({ days: { "2026-10-31": 110, "2026-11-01": 61 }, total: 171 }, LATE, 15)).toMatchObject({
      reason: "average-minutes",
      day: "2026-11-01",
    });
  });
  it("refuses at the total cap with minutes left in the allowance", () => {
    const total = totalLimitMinutes();
    expect(mayCall({ days: {}, total: total - 5 }, MORNING, 5).ok).toBe(true);
    expect(mayCall({ days: {}, total: total - 5 }, MORNING, 5.01)).toMatchObject({ ok: false, reason: "total-usd" });
  });
  it("refuses the day's money at a pricier GPU before the minutes", () => {
    // At US$130 an hour US$50 is 23.1 minutes a day: 69.2 through 2026-11-01.
    expect(mayCall({ days: {}, total: 0 }, MORNING, 70, 130)).toMatchObject({ ok: false, reason: "average-minutes" });
  });
});

describe("reserveBurst on D1", () => {
  it("reserves just under the running allowance and refuses past it", async () => {
    expect(await reserveBurst(exec, reservation("a", 120))).toMatchObject({ ok: true, repeated: false });
    expect(await reserveBurst(exec, reservation("b", 60.01))).toMatchObject({ ok: false, reason: "average-minutes" });
    expect(await reserveBurst(exec, reservation("c", 60))).toMatchObject({ ok: true });
    expect(await dayMinutes(exec, "2026-11-01")).toBe(180);
  });
  it("counts the days before, and checks a burst across midnight through each day it touches", async () => {
    await db
      .prepare(
        "INSERT INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, settled_at) VALUES ('x:2026-10-31', 'x', '2026-10-31', 'local', 't', 'warm-up', '2026-10-31T06:00:00Z', 116, 116, '2026-10-31T06:30:00Z')",
      )
      .run();
    expect(await reserveBurst(exec, reservation("late", 15, LATE))).toMatchObject({ ok: false, day: "2026-10-31" });
    expect(await reserveBurst(exec, reservation("late", 4, LATE))).toMatchObject({ ok: true });
    expect(await dayMinutes(exec, "2026-10-31")).toBe(120);
    // The next day: 120 already used through 2026-10-31, so 2026-11-01 may add only 60 more, though it has none yet.
    expect(await reserveBurst(exec, reservation("next", 60.01))).toMatchObject({
      ok: false,
      reason: "average-minutes",
    });
    expect(await reserveBurst(exec, reservation("next", 60))).toMatchObject({ ok: true });
  });
  // §34 plan review gap 1: a refusal caused by earlier days' minutes is named with the figures that refused it.
  it("names a refusal from every day's minutes through the reservation's day", async () => {
    await db
      .prepare(
        "INSERT INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, settled_at) VALUES ('y:2026-10-31', 'y', '2026-10-31', 'local', 't', 'warm-up', '2026-10-31T06:00:00Z', 120, 120, '2026-10-31T06:30:00Z')",
      )
      .run();
    expect(await reserveBurst(exec, reservation("next", 61))).toEqual({
      ok: false,
      reason: "average-minutes",
      day: "2026-11-01",
      detail:
        "through 2026-11-01 the deployment would hold 181 of its 180 minutes (60 a day on average since 2026-10-31, 1 day ahead)",
    });
  });
  it("answers a repeated id from its first rows and never charges it twice", async () => {
    const first = await reserveBurst(exec, reservation("run-1", 12));
    const again = await reserveBurst(exec, reservation("run-1", 12, new Date(MORNING.getTime() + 60_000)));
    expect(first).toMatchObject({ ok: true, repeated: false });
    expect(again).toMatchObject({ ok: true, repeated: true, wakeAt: MORNING.toISOString() });
    expect(await dayMinutes(exec, "2026-11-01")).toBe(12);
  });
  it("gives the last minutes to one of two concurrent reservations", async () => {
    await reserveBurst(exec, reservation("held", 168));
    const both = await Promise.all([
      reserveBurst(exec, reservation("p", 12)),
      reserveBurst(exec, reservation("q", 12)),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await dayMinutes(exec, "2026-11-01")).toBe(180);
  });
  it("refuses at the total cap with minutes left in the allowance", async () => {
    // A later day's minutes count toward the total, not toward 2026-11-01's allowance.
    await db
      .prepare(
        "INSERT INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, settled_at) VALUES ('old:2026-11-02', 'old', '2026-11-02', 'import', 't', 'settled bill', '2026-11-02T08:00:00Z', 0, ?1, '2026-11-02T08:00:00Z')",
      )
      .bind(totalLimitMinutes() - 5)
      .run();
    expect(await reserveBurst(exec, reservation("over", 6))).toMatchObject({ ok: false, reason: "total-usd" });
    expect(await reserveBurst(exec, reservation("fits", 5))).toMatchObject({ ok: true });
  });
  it("refuses with nothing reserved when the ledger cannot be written", async () => {
    const broken: Exec = async () => {
      throw new Error("D1 unavailable");
    };
    expect(await reserveBurst(broken, reservation("z", 5))).toMatchObject({ ok: false, reason: "ledger-unavailable" });
  });
  it("reads back a write whose answer was lost", async () => {
    const lost: Exec = async (s) => {
      const answer = await exec(s);
      if (s.sql.startsWith("WITH parts")) throw new Error("connection reset after the write");
      return answer;
    };
    expect(await reserveBurst(lost, reservation("lost", 5))).toMatchObject({ ok: true, id: "lost" });
  });
});

describe("settleBurst on D1", () => {
  it("settles at what was used, once, and frees the rest of the reserve", async () => {
    await reserveBurst(exec, reservation("s", 20));
    const answer = new Date(MORNING.getTime() + 3 * 60_000);
    expect(await settleBurst(exec, "s", { lastAnswerAt: answer })).toMatchObject({ ok: true, used: 3 + TAIL_MINUTES });
    expect(await dayMinutes(exec, "2026-11-01")).toBe(3 + TAIL_MINUTES);
    expect(await settleBurst(exec, "s", { lastAnswerAt: new Date(MORNING.getTime() + 20 * 60_000) })).toMatchObject({
      ok: true,
      used: 3 + TAIL_MINUTES,
    });
    expect((await findBurst(exec, "s"))?.settled).toBe(true);
  });
  it("charges a timed-out request to its deadline", async () => {
    await reserveBurst(exec, reservation("t", 20));
    const deadline = new Date(MORNING.getTime() + 8 * 60_000);
    await settleBurst(exec, "t", { lastAnswerAt: new Date(MORNING.getTime() + 60_000), lastDeadlineAt: deadline });
    expect(await dayMinutes(exec, "2026-11-01")).toBe(8 + TAIL_MINUTES);
  });
  it("charges a burst that ran past its reserve across midnight to the next day too", async () => {
    await reserveBurst(exec, reservation("m", 4, LATE));
    await settleBurst(exec, "m", { lastAnswerAt: new Date(LATE.getTime() + 6 * 60_000) });
    expect(await dayMinutes(exec, "2026-10-31")).toBe(5);
    expect(await dayMinutes(exec, "2026-11-01")).toBe(1 + TAIL_MINUTES);
  });
  it("keeps the reserve counted when the settlement cannot be written", async () => {
    await reserveBurst(exec, reservation("u", 20));
    const failing: Exec = async (s) => {
      if (s.sql.includes("ON CONFLICT")) throw new Error("D1 unavailable");
      return exec(s);
    };
    expect(await settleBurst(failing, "u", { lastAnswerAt: MORNING })).toMatchObject({
      ok: false,
      reason: "ledger-unavailable",
    });
    expect(await dayMinutes(exec, "2026-11-01")).toBe(20);
  });

  // Completion review G1: settlement is one statement, so a failure leaves every day at its reserve, never one settled.
  it("lands a settlement across midnight whole or not at all", async () => {
    await reserveBurst(exec, reservation("w", 4, LATE));
    const once: Exec = async (s) => {
      if (s.sql.includes("ON CONFLICT")) throw new Error("D1 unavailable");
      return exec(s);
    };
    const answer = { lastAnswerAt: new Date(LATE.getTime() + 6 * 60_000) };
    expect(await settleBurst(once, "w", answer)).toMatchObject({ ok: false, reason: "ledger-unavailable" });
    expect((await findBurst(exec, "w"))?.settled).toBe(false);
    expect(await dayMinutes(exec, "2026-10-31")).toBe(4);
    expect(await settleBurst(exec, "w", answer)).toMatchObject({ ok: true });
    expect(await dayMinutes(exec, "2026-10-31")).toBe(5);
    expect(await dayMinutes(exec, "2026-11-01")).toBe(1 + TAIL_MINUTES);
  });
});

// Completion review G4: two bursts that ran at the same time are charged their union once settled, never twice.
describe("shared runtime", () => {
  it("charges a burst only for the time outside one already settled", async () => {
    const at = (minutes: number) => new Date(MORNING.getTime() + minutes * 60_000);
    await reserveBurst(exec, reservation("a", 15, at(0)));
    await reserveBurst(exec, reservation("b", 15, at(2)));
    // While both are open, both count at their reserve.
    expect(await dayMinutes(exec, "2026-11-01")).toBe(30);
    // a: 0 to 4 plus the tail, so to 10; b: 2 to 8 plus the tail, so to 14. Together 0 to 14.
    expect(await settleBurst(exec, "a", { lastAnswerAt: at(4) })).toMatchObject({ ok: true, used: 4 + TAIL_MINUTES });
    expect(await settleBurst(exec, "b", { lastAnswerAt: at(8) })).toMatchObject({ ok: true, used: 4 });
    expect(await dayMinutes(exec, "2026-11-01")).toBeCloseTo(14, 9);
  });

  // Round 2, finding 1: an interrupted reconciliation leaves the whole interval charged, and the next reservation (or
  // a retried settlement) reconciles it.
  it("reconciles a settlement whose second step failed at the next reservation", async () => {
    const at = (minutes: number) => new Date(MORNING.getTime() + minutes * 60_000);
    await reserveBurst(exec, reservation("a", 15, at(0)));
    await reserveBurst(exec, reservation("b", 15, at(2)));
    await settleBurst(exec, "a", { lastAnswerAt: at(4) });
    const flaky: Exec = async (s) => {
      if (s.sql.startsWith("SELECT min(wake_at)")) throw new Error("wrangler d1 execute did not succeed");
      return exec(s);
    };
    expect(await settleBurst(flaky, "b", { lastAnswerAt: at(8) })).toMatchObject({ ok: true, reconciled: false });
    expect(await dayMinutes(exec, "2026-11-01")).toBeCloseTo(22, 9);
    expect(await settleBurst(flaky, "b", { lastAnswerAt: at(8) })).toMatchObject({ reconciled: false });
    // The next reservation reconciles first: 14 used, so 16 left, and a 10-minute burst fits.
    expect(await reserveBurst(exec, reservation("c", 10, at(30)))).toMatchObject({ ok: true });
    expect(await dayMinutes(exec, "2026-11-01")).toBeCloseTo(24, 9);
  });

  // Round 2, finding 2: settlement order is a number the database hands out, so ties cannot drop the shared time.
  it("charges the union in every interleaving of two settlements", async () => {
    const at = (minutes: number) => new Date(MORNING.getTime() + minutes * 60_000);
    for (const [x, y] of [
      ["a", "z"],
      ["z", "a"],
    ] as const) {
      await db.prepare("DELETE FROM glimmer_runtime").run();
      await reserveBurst(exec, reservation(x, 15, at(0)));
      await reserveBurst(exec, reservation(y, 15, at(2)));
      await Promise.all([settleBurst(exec, y, { lastAnswerAt: at(8) }), settleBurst(exec, x, { lastAnswerAt: at(4) })]);
      expect(await dayMinutes(exec, "2026-11-01")).toBeCloseTo(14, 9);
    }
  });

  // Round 1, finding 1: two settlements at once still charge the union, whichever lands first.
  it("charges the union when two overlapping bursts settle at the same time", async () => {
    const at = (minutes: number) => new Date(MORNING.getTime() + minutes * 60_000);
    await reserveBurst(exec, reservation("a", 15, at(0)));
    await reserveBurst(exec, reservation("b", 15, at(2)));
    const both = await Promise.all([
      settleBurst(exec, "a", { lastAnswerAt: at(4) }),
      settleBurst(exec, "b", { lastAnswerAt: at(8) }),
    ]);
    expect(both.every((r) => r.ok)).toBe(true);
    expect(await dayMinutes(exec, "2026-11-01")).toBeCloseTo(14, 9);
  });
});

// Completion review G5: the operator's status tells settled minutes from outstanding reservations.
describe("ledgerStatus", () => {
  // §34 completion review gap 1: earlier days' minutes reduce today's remaining allowance.
  it("counts every earlier day against today's allowance, and reads the same after the ledger is reopened", async () => {
    await db
      .prepare(
        "INSERT INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, settled_at) VALUES ('p:2026-10-31', 'p', '2026-10-31', 'local', 't', 'warm-up', '2026-10-31T06:00:00Z', 41.7, 41.7, '2026-10-31T06:30:00Z')",
      )
      .run();
    await reserveBurst(exec, reservation("held", 8));
    const first = await ledgerStatus(exec, new Date(MORNING.getTime() + 60_000));
    expect(first).toMatchObject({
      day: "2026-11-01",
      allowance_through_today: 180,
      used_through_today: 49.7,
      held_today: 8,
      day_left: 130.3,
    });
    // A fresh executor on the same database reads the same figures: nothing is kept in memory.
    expect(await ledgerStatus(d1Exec(db), new Date(MORNING.getTime() + 60_000))).toEqual(first);
  });
  it("lists outstanding reservations with their age, apart from settled minutes, and the headroom left", async () => {
    await reserveBurst(exec, reservation("done", 10));
    await settleBurst(exec, "done", { lastAnswerAt: new Date(MORNING.getTime() + 60_000) });
    await reserveBurst(exec, reservation("open", 8, new Date(MORNING.getTime() + 2 * 60_000), "local"));
    const status = await ledgerStatus(exec, new Date(MORNING.getTime() + 20 * 60_000));
    expect(status).toMatchObject({
      day: "2026-11-01",
      settled: 1 + TAIL_MINUTES,
      allowance_through_today: 180,
      used_through_today: 7 + 8,
      held_today: 8,
      day_left: 180 - 7 - 8,
    });
    expect(status.outstanding).toEqual([
      { id: "open", purpose: "monitor", source: "local", day: "2026-11-01", reserved: 8, age_minutes: 18 },
    ]);
    expect(status.total_usd).toBe(2);
    expect(status.total_left_usd).toBe(FIREWORKS_TOTAL_CAP_USD - 2);
  });
});
