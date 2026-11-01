// The daily re-screen of live candidates (D05 T04 §8): every live host is captured and screened again each day, so a
// lookalike that turns into a lure is flagged the day it flips. The 50 captures a day are shared, so the wait for the
// unchanged hosts is bounded however many hosts are live or churning; a lure that changed today is never behind a backlog
// of screenings; and a host that failed its capture five times is probed once a day, not forgotten.
import { describe, expect, it } from "vitest";
import { MAX_CAPTURE_FAILURES, MAX_CAPTURES_PER_RUN, monitorOrg, OWED_SLOTS } from "../../src/monitor/run";
import { MAX_SCREENS_PER_RUN } from "../../src/monitor/screen";
import { business, DAY_MS, db, host, live, runRow, START, world } from "./world";

const rows = async (orgId: string, domain: string) =>
  (
    await db
      .prepare("SELECT * FROM monitor_screens WHERE org_id = ? AND domain = ? ORDER BY screened_at")
      .bind(orgId, domain)
      .all<Record<string, unknown>>()
  ).results;
const SALE = "kestrelfreight.example. This domain is for sale. Sedo domain parking. Make an offer today.";

describe("the daily re-screen", () => {
  it("captures and screens an unchanged live page again each day, and leaves one that is not yet a day old alone", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.1"));
    await monitorOrg(w.deps, b.orgId, "d1");
    // An hour later it is not due.
    w.calls.length = 0;
    w.later(60 * 60_000);
    expect(await monitorOrg(w.deps, b.orgId, "d1b")).toMatchObject({ captured: 0, screened: 0 });
    expect(w.captures()).toEqual([]);
    // The next days it is captured and screened again, unchanged as it is.
    for (const day of [2, 3]) {
      w.calls.length = 0;
      w.later(DAY_MS);
      expect(await monitorOrg(w.deps, b.orgId, `d${day}`), `day ${day}`).toMatchObject({
        captured: 1,
        screened: 1,
        outcome: "completed",
      });
      expect(w.captures(), `day ${day}`).toEqual([site]);
      expect(w.screens(), `day ${day}`).toEqual([site]);
    }
    expect(await rows(b.orgId, site)).toHaveLength(3);
  });

  it("flags a page the day it flips to a lure, reading its history from the screenings", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.2"));
    const first = await monitorOrg(w.deps, b.orgId, "f1");
    expect(first).toMatchObject({ screened: 1, lures: 0 });
    // Nothing about the address changes; the page does.
    w.lures.add(site);
    w.later(DAY_MS);
    const second = await monitorOrg(w.deps, b.orgId, "f2");
    expect(second).toMatchObject({ captured: 1, screened: 1, lures: 1 });
    const history = await rows(b.orgId, site);
    expect(history.map((r) => [r.outcome, r.lure, r.screener])).toEqual([
      ["screened", 0, "glimmer"],
      ["screened", 1, "glimmer"],
    ]);
    // Each carries its day, the second a day after the first.
    const days = history.map((r) => Date.parse(r.screened_at as string));
    expect(days[1] as number).toBeGreaterThanOrEqual((days[0] as number) + DAY_MS);
  });

  it("fetches a parked page each day without a model, and screens and flags it the day it stops being parked", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.3"));
    w.text.set(site, SALE);
    await monitorOrg(w.deps, b.orgId, "p1");
    expect(await host(b.orgId, site)).toMatchObject({ status: "parked" });
    // Day two: fetched again (that is what shows it flipping), parked again, no model asked.
    w.calls.length = 0;
    w.later(DAY_MS);
    const second = await monitorOrg(w.deps, b.orgId, "p2");
    expect(w.captures()).toEqual([site]);
    expect(w.screens()).toEqual([]);
    expect(second).toMatchObject({ captured: 1, parked: 1, screened: 0 });
    expect(await host(b.orgId, site)).toMatchObject({ status: "parked" });
    // Day three: the same address now serves a lure, which the rules no longer park, and the models flag.
    w.text.delete(site);
    w.lures.add(site);
    w.later(DAY_MS);
    const third = await monitorOrg(w.deps, b.orgId, "p3");
    expect(third).toMatchObject({ captured: 1, parked: 0, screened: 1, lures: 1 });
    expect(await host(b.orgId, site)).toMatchObject({ status: "watching" });
    expect((await rows(b.orgId, site)).map((r) => r.outcome)).toEqual(["parked", "parked", "screened"]);
  });

  it("captures the new and the changed first and the longest-unscreened of the rest next, counting what the cap leaves", async () => {
    const b = await business();
    const w = world(START);
    const fifty = b.candidates.slice(0, 50);
    for (const site of fifty) w.answers.set(site, live("192.0.2.10"));
    await monitorOrg(w.deps, b.orgId, "c1");
    expect(w.captures()).toHaveLength(MAX_CAPTURES_PER_RUN);
    // Day two: two new hosts, one changed one, and 49 unchanged ones that are due: 52 for 50 places.
    const [fresh1, fresh2] = b.candidates.slice(50, 52) as [string, string];
    for (const site of [fresh1, fresh2]) w.answers.set(site, live("192.0.2.11"));
    const changed = fifty[10] as string;
    w.answers.set(changed, live("198.51.100.10"));
    w.calls.length = 0;
    w.later(DAY_MS);
    const second = await monitorOrg(w.deps, b.orgId, "c2");
    const taken = w.captures();
    expect(taken).toHaveLength(MAX_CAPTURES_PER_RUN);
    // The new and the changed are in, first.
    expect(taken.slice(0, 3).sort()).toEqual([fresh1, fresh2, changed].sort());
    // The two unchanged hosts the cap left out are counted, and the run is partial.
    const leftOut = fifty.filter((site) => !taken.includes(site));
    expect(leftOut).toHaveLength(2);
    expect(second.deferred).toBe(2);
    expect(second.outcome).toBe("partial");
    // Day three: those two are now the longest-unscreened, so they go first of the unchanged ones.
    w.calls.length = 0;
    w.later(DAY_MS);
    await monitorOrg(w.deps, b.orgId, "c3");
    const third = w.captures();
    expect(third.slice(0, 2).sort()).toEqual([...leftOut].sort());
  });

  // With more live hosts than a day holds the wait is bounded, never indefinite. A host's waits are the differences between
  // its consecutive capture days (completion review G4: an age measured after each day's capture would pass a four-day wait
  // for a three-day bound).
  const waits = (days: number[]) => days.slice(1).map((d, i) => d - (days[i] as number));
  const firstSeen = (days: number[] | undefined) => days?.[0] ?? Number.POSITIVE_INFINITY;
  async function runDays(w: ReturnType<typeof world>, orgId: string, count: number, before?: (day: number) => void) {
    const capturedOn = new Map<string, number[]>();
    const perDay: string[][] = [];
    for (let day = 1; day <= count; day++) {
      before?.(day);
      w.calls.length = 0;
      await monitorOrg(w.deps, orgId, `d${day}-${crypto.randomUUID().slice(0, 4)}`);
      perDay.push(w.captures());
      for (const site of w.captures()) capturedOn.set(site, [...(capturedOn.get(site) ?? []), day]);
      w.later(DAY_MS);
    }
    return { capturedOn, perDay };
  }

  it("reaches 120 new hosts within ceil(120 / 30) days and then waits each at most ceil(120 / 50) days between captures", async () => {
    const b = await business();
    const w = world(START);
    const hosts = b.candidates.slice(0, 120);
    for (const site of hosts) w.answers.set(site, live("192.0.2.20"));
    const { capturedOn } = await runDays(w, b.orgId, 12);
    for (const site of hosts)
      expect(firstSeen(capturedOn.get(site)), site).toBeLessThanOrEqual(Math.ceil(120 / OWED_SLOTS));
    // Once all are known, 120 due hosts take 50 a day, longest-waiting first: no wait between two captures above 3 days.
    const longest = Math.max(...hosts.flatMap((site) => waits((capturedOn.get(site) ?? []).filter((d) => d >= 4))));
    expect(longest).toBeLessThanOrEqual(Math.ceil(120 / MAX_CAPTURES_PER_RUN));
  }, 180_000);

  it("keeps reaching 100 unchanged hosts every ceil(100 / 20) days at most while 50 others change their DNS every day", async () => {
    const b = await business();
    const w = world(START);
    const churning = b.candidates.slice(0, 50);
    const steady = b.candidates.slice(50, 150);
    for (const site of steady) w.answers.set(site, live("192.0.2.30"));
    const { capturedOn, perDay } = await runDays(w, b.orgId, 14, (day) => {
      // Every churning host answers from a new address each day, so each is owed a capture each day.
      for (const [i, site] of churning.entries()) w.answers.set(site, live(`203.0.${day}.${i + 1}`));
    });
    // The class shares hold on every day the unchanged hosts are due: no more than 30 of the 50 go to the churning ones.
    for (const [i, taken] of perDay.entries()) {
      if (i < 3) continue;
      expect(taken.filter((s) => churning.includes(s)).length, `day ${i + 1}`).toBeLessThanOrEqual(OWED_SLOTS);
      expect(taken.filter((s) => steady.includes(s)).length, `day ${i + 1}`).toBeGreaterThanOrEqual(
        MAX_CAPTURES_PER_RUN - OWED_SLOTS,
      );
    }
    // The unchanged hosts wait at most ceil(100 / 20) = 5 days between captures, and the churning ones at most ceil(50 / 30).
    const steadyWaits = steady.flatMap((site) => waits((capturedOn.get(site) ?? []).filter((d) => d >= 4)));
    expect(Math.max(...steadyWaits)).toBeLessThanOrEqual(Math.ceil(100 / (MAX_CAPTURES_PER_RUN - OWED_SLOTS)));
    const churnWaits = churning.flatMap((site) => waits((capturedOn.get(site) ?? []).filter((d) => d >= 4)));
    expect(Math.max(...churnWaits)).toBeLessThanOrEqual(Math.ceil(50 / OWED_SLOTS));
  }, 240_000);

  it("gives a recovered retry its turn though 30 other hosts change their DNS every day (completion review G1)", async () => {
    const b = await business();
    const w = world(START);
    const [retry] = b.candidates.slice(0, 1) as [string];
    const churning = b.candidates.slice(1, 31);
    const steady = b.candidates.slice(31, 51);
    for (const site of steady) w.answers.set(site, live("192.0.2.60"));
    w.answers.set(retry, live("192.0.2.61"));
    w.failing.set(retry, new Error("HTTP 503"));
    // Day 0: the steady hosts are captured and the retry fails once.
    await monitorOrg(w.deps, b.orgId, "g0");
    w.failing.clear();
    w.later(DAY_MS);
    const { capturedOn } = await runDays(w, b.orgId, 5, (day) => {
      for (const [i, site] of churning.entries()) w.answers.set(site, live(`203.1.${day}.${i + 1}`));
    });
    // The retry has waited longest by the second day and takes a slot; the old order starved it for ever.
    expect(firstSeen(capturedOn.get(retry))).toBeLessThanOrEqual(3);
    expect(await host(b.orgId, retry)).toMatchObject({ capture_failures: 0 });
  }, 120_000);

  it("keeps a failure-limit probe inside the owed slots, so the 20 held for unchanged hosts are all taken (completion review G2)", async () => {
    const b = await business();
    const w = world(START);
    const [stuck] = b.candidates.slice(0, 1) as [string];
    const steady = b.candidates.slice(1, 21);
    const churning = b.candidates.slice(21, 51);
    for (const site of steady) w.answers.set(site, live("192.0.2.70"));
    w.answers.set(stuck, live("192.0.2.71"));
    w.failing.set(stuck, new Error("HTTP 503"));
    for (let day = 1; day <= MAX_CAPTURE_FAILURES; day++) {
      await monitorOrg(w.deps, b.orgId, `q${day}`);
      w.later(DAY_MS);
    }
    expect(await host(b.orgId, stuck)).toMatchObject({ capture_failures: MAX_CAPTURE_FAILURES });
    // Thirty changed hosts, twenty unchanged ones due and the probe overdue: 51 for 50 places.
    for (const site of churning) w.answers.set(site, live("198.51.100.70"));
    w.calls.length = 0;
    await monitorOrg(w.deps, b.orgId, "q-day");
    const taken = w.captures();
    expect(taken).toHaveLength(MAX_CAPTURES_PER_RUN);
    expect(taken.filter((s) => steady.includes(s))).toHaveLength(MAX_CAPTURES_PER_RUN - OWED_SLOTS);
    expect(taken.filter((s) => s === stuck || churning.includes(s))).toHaveLength(OWED_SLOTS);
  }, 120_000);

  it("screens each page as soon as it is captured, so the first verdict never waits for the slow hosts after it (completion review E1)", async () => {
    const b = await business();
    const w = world(START);
    const sites = b.candidates.slice(0, 10);
    for (const site of sites) w.answers.set(site, live("192.0.2.80"));
    w.lures.add(sites[0] as string);
    w.screenedAt.length = 0;
    const run = await monitorOrg(w.deps, b.orgId, "e1");
    expect(run).toMatchObject({ captured: 10, screened: 10, lures: 1 });
    // Every capture is followed by its own screening before the next capture starts.
    const log = w.calls.filter((c) => c.startsWith("capture:") || c.startsWith("screen:"));
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i]).toMatch(/^capture:/);
      expect(log[i + 1], `after ${log[i]}`).toBe(`screen:${(log[i] as string).slice("capture:".length)}`);
    }
    // On the world's clock, the first verdict is one capture (30 s) in, not ten (300 s).
    const first = (w.screenedAt[0] as number) - START.getTime();
    expect(first).toBeLessThan(60_000);
    expect((w.screenedAt[9] as number) - START.getTime()).toBeGreaterThanOrEqual(9 * 30_000);
  });

  it("screens a lure that changed today in the same run as a full backlog, the backlog taking only its share first", async () => {
    const b = await business();
    const w = world(START);
    const fifty = b.candidates.slice(0, 50);
    for (const site of fifty) {
      w.answers.set(site, live("192.0.2.40"));
      w.failScreen.add(site);
    }
    await monitorOrg(w.deps, b.orgId, "g1");
    // Fifty pages are owed a screening. A new lure turns up a few hours later, when none of the fifty is yet due.
    w.failScreen.clear();
    const lure = b.candidates[50] as string;
    w.answers.set(lure, live("192.0.2.41"));
    w.lures.add(lure);
    w.calls.length = 0;
    w.later(3 * 60 * 60_000);
    const second = await monitorOrg(w.deps, b.orgId, "g2");
    // The lure is captured and flagged that day, though fifty before it were owed a screening.
    expect(w.captures()).toEqual([lure]);
    expect(second.lures).toBe(1);
    expect(await rows(b.orgId, lure)).toMatchObject([{ outcome: "screened", lure: 1 }]);
    // The backlog went first, but only 25, and finished after the lure with what was left: 49 of the 50, 1 left over.
    const order = w.screens();
    expect(order.slice(0, 25).every((s) => fifty.includes(s))).toBe(true);
    expect(order[25]).toBe(lure);
    expect(second).toMatchObject({ screened: MAX_SCREENS_PER_RUN, screenDeferred: 1, outcome: "partial" });
  });

  it("sees a host again when it recovers from five failed captures on an unchanged address", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.50"));
    w.failing.set(site, new Error("HTTP 503"));
    for (let day = 1; day <= MAX_CAPTURE_FAILURES; day++) {
      await monitorOrg(w.deps, b.orgId, `r${day}`);
      w.later(DAY_MS);
    }
    expect(await host(b.orgId, site)).toMatchObject({ capture_failures: MAX_CAPTURE_FAILURES });
    // The site is back, on the same address: the next day's probe captures it and the run is complete again.
    w.failing.clear();
    w.calls.length = 0;
    const back = await monitorOrg(w.deps, b.orgId, "r6");
    // The probe's success is in the run's own state: nothing is blocked once it ends.
    expect(back).toMatchObject({ captureBlocked: 0, outcome: "completed" });
    expect(w.captures()).toEqual([site]);
    expect(await host(b.orgId, site)).toMatchObject({ capture_failures: 0 });
    expect(await runRow(b.orgId)).toMatchObject({ captured: 1, screened: 1 });
    w.later(DAY_MS);
    expect(await monitorOrg(w.deps, b.orgId, "r7")).toMatchObject({ captureBlocked: 0, outcome: "completed" });
  });
});
