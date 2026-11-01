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

  // With more live hosts than a day holds the wait is bounded, never indefinite: the longest any host goes unseen.
  const longestGap = async (
    orgId: string,
    hosts: string[],
    from: number,
    to: number,
    capturedOn: Map<string, number[]>,
  ) => {
    let longest = 0;
    for (const site of hosts) {
      const days = capturedOn.get(site) ?? [];
      for (let day = from; day <= to; day++) {
        const last = Math.max(0, ...days.filter((d) => d <= day));
        longest = Math.max(longest, last === 0 ? Number.POSITIVE_INFINITY : day - last);
      }
    }
    expect(orgId).toBeTruthy();
    return longest;
  };

  it("reaches 120 new hosts within ceil(120 / 30) days and then sees each at least every ceil(120 / 50) days", async () => {
    const b = await business();
    const w = world(START);
    const hosts = b.candidates.slice(0, 120);
    for (const site of hosts) w.answers.set(site, live("192.0.2.20"));
    const capturedOn = new Map<string, number[]>();
    for (let day = 1; day <= 9; day++) {
      w.calls.length = 0;
      await monitorOrg(w.deps, b.orgId, `b${day}`);
      for (const site of w.captures()) capturedOn.set(site, [...(capturedOn.get(site) ?? []), day]);
      w.later(DAY_MS);
    }
    // New hosts share the 30 slots of the owed class with the due ones holding 20: all seen within four days. Once all
    // are known, 120 due hosts take 50 a day, oldest first, so none waits longer than three days.
    expect(await longestGap(b.orgId, hosts, 4, 4, capturedOn)).toBeLessThanOrEqual(Math.ceil(120 / OWED_SLOTS));
    expect(await longestGap(b.orgId, hosts, 7, 9, capturedOn)).toBeLessThanOrEqual(
      Math.ceil(120 / MAX_CAPTURES_PER_RUN),
    );
  }, 180_000);

  it("keeps reaching 100 unchanged hosts within ceil(100 / 20) days while 50 others change their DNS every day", async () => {
    const b = await business();
    const w = world(START);
    const churning = b.candidates.slice(0, 50);
    const steady = b.candidates.slice(50, 150);
    for (const site of steady) w.answers.set(site, live("192.0.2.30"));
    const capturedOn = new Map<string, number[]>();
    const days = 12;
    for (let day = 1; day <= days; day++) {
      // Every churning host answers from a new address each day, so each is owed a capture each day.
      for (const [i, site] of churning.entries()) w.answers.set(site, live(`203.0.${day}.${i + 1}`));
      w.calls.length = 0;
      await monitorOrg(w.deps, b.orgId, `n${day}`);
      for (const site of w.captures()) capturedOn.set(site, [...(capturedOn.get(site) ?? []), day]);
      w.later(DAY_MS);
    }
    // The unchanged hosts are never starved: after the first days, none waits more than ceil(100 / 20) = 5 days, and
    // the shared slots hold: never more than 30 of a day's 50 go to the churning ones while unchanged hosts are due.
    expect(await longestGap(b.orgId, steady, 8, days, capturedOn)).toBeLessThanOrEqual(
      Math.ceil(100 / (MAX_CAPTURES_PER_RUN - OWED_SLOTS)),
    );
    // And the churning ones are still seen every other day at the most (50 of them, 30 slots a day).
    expect(await longestGap(b.orgId, churning, 8, days, capturedOn)).toBeLessThanOrEqual(Math.ceil(50 / OWED_SLOTS));
  }, 240_000);

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
    expect(back.captureBlocked).toBe(1);
    expect(w.captures()).toEqual([site]);
    expect(await host(b.orgId, site)).toMatchObject({ capture_failures: 0 });
    expect(await runRow(b.orgId)).toMatchObject({ captured: 1, screened: 1 });
    w.later(DAY_MS);
    expect(await monitorOrg(w.deps, b.orgId, "r7")).toMatchObject({ captureBlocked: 0, outcome: "completed" });
  });
});
