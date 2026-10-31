import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DAILY_MINUTES,
  DEPLOYED_GPU,
  dayLimitMinutes,
  FIREWORKS_DAY_CAP_USD,
  hourlyRateUsd,
  MAX_WARMUP_SECONDS,
  PRICE_PER_HOUR_USD,
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

// 10:00 SAST on 2026-11-01, and 23:55 SAST the night before.
const MORNING = new Date("2026-11-01T08:00:00Z");
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
  it("prices the deployed GPU and refuses one it has no price for", () => {
    expect(hourlyRateUsd()).toBe(8);
    expect(PRICE_PER_HOUR_USD[DEPLOYED_GPU]).toBe(8);
    expect(() => hourlyRateUsd("NVIDIA_B200_180GB")).toThrow(/no checked price/);
  });
  it("keeps 30 minutes a day under the day's money cap, so the minutes bind first", () => {
    expect((DAILY_MINUTES * hourlyRateUsd()) / 60).toBeLessThan(FIREWORKS_DAY_CAP_USD);
    expect(dayLimitMinutes()).toBe(DAILY_MINUTES);
    // A pricier GPU would make the money cap bind: at US$13 an hour, US$5 is 23.1 minutes.
    expect(dayLimitMinutes(13)).toBeCloseTo((5 / 13) * 60, 6);
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

describe("mayCall", () => {
  it("refuses at the day's edge and allows just under it", () => {
    expect(mayCall({ days: { "2026-11-01": 20 }, total: 20 }, MORNING, 10).ok).toBe(true);
    expect(mayCall({ days: { "2026-11-01": 20 }, total: 20 }, MORNING, 10.01)).toMatchObject({
      ok: false,
      reason: "day-minutes",
      day: "2026-11-01",
    });
  });
  it("refuses a burst whose second day is full though its first is empty", () => {
    expect(mayCall({ days: { "2026-11-01": 25 }, total: 25 }, LATE, 15)).toMatchObject({
      reason: "day-minutes",
      day: "2026-11-01",
    });
  });
  it("refuses at the total cap with minutes left in the day", () => {
    const total = totalLimitMinutes();
    expect(mayCall({ days: {}, total: total - 5 }, MORNING, 5).ok).toBe(true);
    expect(mayCall({ days: {}, total: total - 5 }, MORNING, 5.01)).toMatchObject({ ok: false, reason: "total-usd" });
  });
  it("refuses the day's money at a pricier GPU before the minutes", () => {
    expect(mayCall({ days: {}, total: 0 }, MORNING, 24, 13)).toMatchObject({ ok: false, reason: "day-minutes" });
  });
});

describe("reserveBurst on D1", () => {
  it("reserves just under the day's limit and refuses past it", async () => {
    expect(await reserveBurst(exec, reservation("a", 20))).toMatchObject({ ok: true, repeated: false });
    expect(await reserveBurst(exec, reservation("b", 10.01))).toMatchObject({ ok: false, reason: "day-minutes" });
    expect(await reserveBurst(exec, reservation("c", 10))).toMatchObject({ ok: true });
    expect(await dayMinutes(exec, "2026-11-01")).toBe(30);
  });
  it("counts both days of a burst across midnight and refuses when the second is full", async () => {
    await db
      .prepare(
        "INSERT INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, settled_at) VALUES ('x:2026-11-01', 'x', '2026-11-01', 'local', 't', 'warm-up', '2026-11-01T06:00:00Z', 25, 25, '2026-11-01T06:30:00Z')",
      )
      .run();
    expect(await reserveBurst(exec, reservation("late", 15, LATE))).toMatchObject({ ok: false, day: "2026-11-01" });
    expect(await reserveBurst(exec, reservation("late", 10, LATE))).toMatchObject({ ok: true });
    expect(await dayMinutes(exec, "2026-10-31")).toBe(5);
    expect(await dayMinutes(exec, "2026-11-01")).toBe(30);
  });
  it("answers a repeated id from its first rows and never charges it twice", async () => {
    const first = await reserveBurst(exec, reservation("run-1", 12));
    const again = await reserveBurst(exec, reservation("run-1", 12, new Date(MORNING.getTime() + 60_000)));
    expect(first).toMatchObject({ ok: true, repeated: false });
    expect(again).toMatchObject({ ok: true, repeated: true, wakeAt: MORNING.toISOString() });
    expect(await dayMinutes(exec, "2026-11-01")).toBe(12);
  });
  it("gives the last minutes to one of two concurrent reservations", async () => {
    await reserveBurst(exec, reservation("held", 18));
    const both = await Promise.all([
      reserveBurst(exec, reservation("p", 12)),
      reserveBurst(exec, reservation("q", 12)),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await dayMinutes(exec, "2026-11-01")).toBe(30);
  });
  it("refuses at the total cap with minutes left in the day", async () => {
    await db
      .prepare(
        "INSERT INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, settled_at) VALUES ('old:2026-10-20', 'old', '2026-10-20', 'import', 't', 'settled bill', '2026-10-20T08:00:00Z', 0, ?1, '2026-10-20T08:00:00Z')",
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
    expect(await settleBurst(exec, "s", { lastAnswerAt: answer })).toEqual({ ok: true, used: 3 + TAIL_MINUTES });
    expect(await dayMinutes(exec, "2026-11-01")).toBe(3 + TAIL_MINUTES);
    expect(await settleBurst(exec, "s", { lastAnswerAt: new Date(MORNING.getTime() + 20 * 60_000) })).toEqual({
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
      if (s.sql.startsWith("UPDATE")) throw new Error("D1 unavailable");
      return exec(s);
    };
    expect(await settleBurst(failing, "u", { lastAnswerAt: MORNING })).toMatchObject({
      ok: false,
      reason: "ledger-unavailable",
    });
    expect(await dayMinutes(exec, "2026-11-01")).toBe(20);
  });
});
