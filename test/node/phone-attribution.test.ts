import { describe, expect, it } from "vitest";
import { median, type Observation, summarise } from "../../eval/phone-attribution";

// D07 T09 §4: the phone-attribution measurement's analysis, proven on known inputs. The scripted readers
// themselves run under eval/ (`node eval/phone-attribution.ts`).
const obs = (over: Partial<Observation>): Observation => ({
  case: "forwarded",
  shape: "shipped",
  run: 0,
  scrolls: 0,
  openedDetails: false,
  firstIdentity: "submitter",
  identified: true,
  confused: false,
  ms: 100,
  ...over,
});

describe("phone attribution analysis", () => {
  it("takes the median of odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(() => median([])).toThrow();
  });

  it("summarises per shape, counting confusion", () => {
    const out = summarise([
      obs({ scrolls: 0, ms: 90 }),
      obs({ scrolls: 0, ms: 110, run: 1 }),
      obs({ shape: "benchmark", scrolls: 4, ms: 300, confused: true, firstIdentity: "sender" }),
      obs({ shape: "benchmark", scrolls: 6, ms: 500, confused: true, firstIdentity: "sender", run: 1 }),
    ]);
    expect(out.shipped).toMatchObject({ cases: 1, runs: 2, medianScrolls: 0, medianMs: 100, confused: 0 });
    expect(out.benchmark).toMatchObject({ cases: 1, runs: 2, medianScrolls: 5, medianMs: 400, confused: 2 });
  });

  it("rejects invalid numbers and incomplete paired trials", () => {
    const pair = [obs({}), obs({ shape: "benchmark" })];
    expect(() => summarise([...pair, obs({ run: 1, scrolls: -1 }), obs({ shape: "benchmark", run: 1 })])).toThrow(
      /invalid observation/,
    );
    expect(() => summarise([...pair, obs({ run: 1, ms: Number.NaN }), obs({ shape: "benchmark", run: 1 })])).toThrow(
      /invalid observation/,
    );
    expect(() => summarise([obs({}), obs({})])).toThrow(/duplicate|no observations/);
    expect(() => summarise([obs({}), obs({ shape: "benchmark" }), obs({ run: 1 })])).toThrow(/incomplete paired/);
  });

  it("rejects a missing shape and an invalid observation", () => {
    expect(() => summarise([obs({})])).toThrow(/incomplete paired|no observations/);
    expect(() => summarise([obs({}), obs({ shape: "benchmark" }), { ...obs({}), ms: -1 }])).toThrow(
      /invalid observation/,
    );
    expect(() =>
      summarise([obs({}), obs({ shape: "benchmark" }), { ...obs({}), identified: "yes" } as unknown as Observation]),
    ).toThrow(/invalid observation/);
  });
});
