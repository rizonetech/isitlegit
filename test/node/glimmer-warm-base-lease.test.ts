import { expect, it } from "vitest";
import type { Deployment } from "../../scripts/glimmer/deploy.ts";
import { BASE_MODEL, BASE_TARGET, validateBase } from "../../scripts/glimmer/warm-base-lease.ts";
import type { Lease } from "../../scripts/glimmer/warm-lease.ts";

const t = Date.parse("2026-11-04T22:00:00Z");
const d: Deployment & { enableAddons: boolean; precision: string } = {
  enableAddons: false,
  precision: "BF16",
  name: `accounts/rizonetech/deployments/${BASE_TARGET}`,
  baseModel: BASE_MODEL,
  minReplicaCount: 1,
  maxReplicaCount: 1,
  replicaCount: 1,
  state: "READY",
  acceleratorType: "NVIDIA_H200_141GB",
  acceleratorCount: 1,
};
const l = {
  decision: "OPERATOR-LOUPE11-BASE-CONTROL-20261104",
  deployment: BASE_TARGET,
  model: `${BASE_MODEL}#${d.name}`,
  startedAt: new Date(t).toISOString(),
  sendCutoff: new Date(t + 49 * 60000).toISOString(),
  hardDeadline: new Date(t + 60 * 60000).toISOString(),
} as Lease;
it("accepts exact untuned owned control in original hour", () => expect(() => validateBase(d, l, t + 1)).not.toThrow());
it.each([
  { name: "accounts/rizonetech/deployments/isitlegit-loupe-1-1" },
  { baseModel: "accounts/rizonetech/models/isitlegit-loupe-1-1" },
  { replicaCount: 0 },
  { maxReplicaCount: 2 },
  { acceleratorCount: 2 },
  { enableAddons: true },
  { precision: "FP4" },
])("refuses cross-target or unready control %j", (change) =>
  expect(() => validateBase({ ...d, ...change }, l, t + 1)).toThrow(),
);
it("refuses expired or extended original window", () => {
  expect(() => validateBase(d, l, t + 49 * 60000)).toThrow();
  expect(() => validateBase(d, { ...l, hardDeadline: new Date(t + 61 * 60000).toISOString() }, t + 1)).toThrow();
});
