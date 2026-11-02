// Component measurements (D08 T02 section 8): exact figures over persisted records, not measured never zero.
import { describe, expect, it } from "vitest";
import {
  cacheFigures,
  checkComponentRows,
  floorFigures,
  providerFigures,
  renderComponentRows,
  walkthroughCost,
} from "../../eval/components.ts";

describe("component measurements", () => {
  it("computes cache, provider, walkthrough and floor figures exactly", () => {
    const c = cacheFigures([
      { hit: true, ms: 10, avoidedUsd: 0.05 },
      { hit: true, ms: 30, avoidedUsd: null },
      { hit: false, ms: 100, avoidedUsd: null },
    ]);
    expect(c.hitRate).toBeCloseTo(2 / 3);
    expect(c.hitMedianMs).toBe(20);
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
  });

  it("refuses a RESULTS.md figure that differs from its records", () => {
    const records = { cache: [{ hit: true, ms: 10, avoidedUsd: 0.05 }] };
    expect(checkComponentRows(renderComponentRows(records), records)).toEqual([]);
    const problems = checkComponentRows("| Result cache | 0% hits |", records);
    expect(problems.some((p) => p.includes("Result cache"))).toBe(true);
  });
});
