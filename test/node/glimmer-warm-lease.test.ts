import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkReadBack, type Deployment } from "../../scripts/glimmer/deploy.ts";
import { type Lease, save, validateWarm } from "../../scripts/glimmer/warm-lease.ts";

const start = Date.parse("2026-11-04T22:00:00Z");
const lease = {
  decision: "OPERATOR-LOUPE11-WARM-HOUR-20261104",
  deployment: "isitlegit-loupe-1-1",
  model: "accounts/rizonetech/models/isitlegit-loupe-1-1#accounts/rizonetech/deployments/isitlegit-loupe-1-1",
  startedAt: new Date(start).toISOString(),
  sendCutoff: new Date(start + 49 * 60000).toISOString(),
  restoreAt: new Date(start + 49 * 60000).toISOString(),
  hardDeadline: new Date(start + 60 * 60000).toISOString(),
} as Lease;
const ready: Deployment = {
  name: "accounts/rizonetech/deployments/isitlegit-loupe-1-1",
  baseModel: "accounts/rizonetech/models/isitlegit-loupe-1-1",
  state: "READY",
  replicaCount: 1,
  minReplicaCount: 1,
  maxReplicaCount: 1,
  acceleratorType: "NVIDIA_H200_141GB",
  acceleratorCount: 1,
  autoscalingPolicy: { scaleToZeroWindow: "300s" },
};
describe("explicit warm host lease", () => {
  it("accepts exact paid ready host only inside bounded window", () =>
    expect(() => validateWarm(ready, lease, start + 1)).not.toThrow());
  it("preserves ordinary minimum-zero enforcement", () => expect(() => checkReadBack(ready, 1)).toThrow());
  it.each([
    { minReplicaCount: 0 },
    { maxReplicaCount: 2 },
    { replicaCount: 0 },
    { state: "UPDATING" },
    { baseModel: "other" },
    { acceleratorCount: 2 },
    { autoscalingPolicy: { scaleToZeroWindow: "3600s" } },
  ])("refuses altered host %j", (change) =>
    expect(() => validateWarm({ ...ready, ...change }, lease, start + 1)).toThrow(),
  );
  it("refuses expiry and extended authorization", () => {
    expect(() => validateWarm(ready, lease, start + 49 * 60000)).toThrow();
    expect(() =>
      validateWarm(ready, { ...lease, sendCutoff: new Date(start + 120 * 60000).toISOString() }, start + 1),
    ).toThrow();
  });
});

it("does not overwrite another writer staging file", () => {
  const dir = mkdtempSync(join(tmpdir(), "warm-lease-test-"));
  try {
    const file = join(dir, "lease.json");
    writeFileSync(`${file}.tmp`, "other writer");
    save(file, { phase: "restored" });
    expect(readFileSync(`${file}.tmp`, "utf8")).toBe("other writer");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ phase: "restored" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
