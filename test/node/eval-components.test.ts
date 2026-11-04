// Component measurements (D08 T02 section 8): exact figures over persisted records, not measured never zero.
import { describe, expect, it } from "vitest";
import {
  cacheFigures,
  checkComponentRows,
  comparatorFigures,
  floorFigures,
  intakeFigures,
  providerFigures,
  renderComponentRows,
  retryFigures,
  walkthroughCost,
} from "../../eval/components.ts";

describe("component measurements", () => {
  it("computes cache, provider, walkthrough, floor, comparator, intake and retry figures exactly", () => {
    const c = cacheFigures([
      { hit: true, ms: 10, avoidedUsd: 0.05 },
      { hit: true, ms: 30, avoidedUsd: null },
      { hit: false, ms: 100, avoidedUsd: null },
    ]);
    expect(c.hitRate).toBeCloseTo(2 / 3);
    expect(c.hits).toBe(2);
    expect(c.misses).toBe(1);
    expect(c.hitMedianMs).toBe(20);
    expect(c.missMedianMs).toBe(100);
    expect(c.avoidedUsd).toBe(0.05);
    expect(c.avoidedRows).toBe(1);
    expect(cacheFigures([]).hitRate).toBeNull();
    expect(cacheFigures([{ hit: true, ms: 1, avoidedUsd: null }]).avoidedUsd).toBeNull();

    const p = providerFigures([
      { provider: "a", checked: true, listed: true, genuine: true },
      { provider: "a", checked: true, listed: false, genuine: true },
      { provider: "a", checked: false, listed: false, genuine: true },
    ]);
    expect(p).toEqual([{ provider: "a", checked: 2, unchecked: 1, genuineChecked: 2, falsePositiveRate: 0.5 }]);

    expect(
      walkthroughCost([
        { completed: true, costUsd: 0.2 },
        { completed: false, costUsd: 9 },
      ]),
    ).toEqual({
      completed: 1,
      attempted: 1,
      medianCostUsd: 0.2,
    });
    expect(
      floorFigures([
        { before: "safe", after: "suspicious", attack: true },
        { before: "safe", after: "suspicious", attack: false },
        { before: "suspicious", after: "malicious", attack: true },
      ]),
    ).toEqual({ rows: 3, raised: 3, addedDetections: 1, causedFalsePositives: 1 });
    expect(floorFigures([])).toEqual({ rows: 0, raised: 0, addedDetections: 0, causedFalsePositives: 0 });

    const comps = comparatorFigures([
      {
        name: "Microsoft Defender for Office 365",
        evaluated: 2,
        attacks: 1,
        detected: 1,
        genuine: 1,
        falsePositives: 0,
        medianMs: 1000,
      },
    ]);
    expect(comps).toEqual([
      {
        name: "Microsoft Defender for Office 365",
        evaluated: 2,
        attacks: 1,
        detected: 1,
        detectionRate: 1,
        genuine: 1,
        falsePositives: 0,
        falsePositiveRate: 0,
        medianMs: 1000,
      },
    ]);

    const intake = intakeFigures([
      { band: "small", bytes: 4096, ms: 10, status: "ok" },
      { band: "small", bytes: 4096, ms: 20, status: "ok" },
      { band: "near-25mib", bytes: 24 * 1024 * 1024, ms: 90, status: "ok" },
      { band: "near-25mib", bytes: 24 * 1024 * 1024, ms: null, status: "failed" },
    ]);
    expect(intake.small).toEqual({ total: 2, completed: 2, failed: 0, medianMs: 15, p95Ms: 20 });
    expect(intake.near25Mib).toEqual({ total: 2, completed: 1, failed: 1, medianMs: 90, p95Ms: 90 });

    const retryMet = retryFigures([
      { kind: "retry", ms: 12000, completed: true },
      { kind: "retry", ms: 24000, completed: true },
      { kind: "interrupted-settle", ms: 300001, completed: true },
    ]);
    expect(retryMet.targetState).toBe("met");
    expect(retryMet.retryMedianMs).toBe(18000);
    expect(retryMet.settleMedianMs).toBe(300001);

    const retryIncomplete = retryFigures([
      { kind: "retry", ms: 12000, completed: true },
      { kind: "retry", ms: null, completed: false },
    ]);
    expect(retryIncomplete.targetState).toBe("incomplete");

    const retryMissed = retryFigures([{ kind: "retry", ms: 70000, completed: true }]);
    expect(retryMissed.targetState).toBe("missed");
  });

  it("refuses a RESULTS.md figure that differs from its records", () => {
    const records = {
      cache: [{ hit: true, ms: 10, avoidedUsd: 0.05 }],
      floor: [{ before: "safe" as const, after: "suspicious" as const, attack: true }],
      comparators: [
        {
          name: "Microsoft Defender for Office 365",
          evaluated: 0,
          attacks: 0,
          detected: 0,
          genuine: 0,
          falsePositives: 0,
          medianMs: null,
        },
      ],
      intake: [{ band: "small" as const, bytes: 4096, ms: 10, status: "ok" as const }],
      retry: [{ kind: "interrupted-settle" as const, ms: 300000.5, completed: true }],
    };
    const rendered = renderComponentRows(records);
    expect(rendered).toContain("| Deterministic floor | raised 1 of 1, added detections 1, caused false positives 0 |");
    expect(rendered).toContain("| Comparator Microsoft Defender for Office 365 | absent (not measured; no figures invented) |");
    expect(checkComponentRows(rendered, records)).toEqual([]);
    const problems = checkComponentRows("| Result cache | 0% hits |", records);
    expect(problems.some((p) => p.includes("Result cache"))).toBe(true);
  });
});
