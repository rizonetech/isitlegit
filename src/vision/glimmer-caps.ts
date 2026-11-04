// The limits on Loupe's dedicated deployment (D03 T04 §14; design spec section 11). Fireworks has no daily runtime cap,
// so these are enforced by the callers through the `glimmer_runtime` ledger (./glimmer-minutes.ts): the Worker and the
// local scripts reserve minutes there before they send a request.

// The operator-authorized 60 cumulative runtime minutes a day, warm-up included (design spec section 11).
export const DAILY_MINUTES = 60;

// The deployment scales to zero 300 s after its last request, but §13 measured 319 s and 335 s from the last answer to
// 0 replicas (docs/glimmer/training.md, warm-ups 2026-10-31), so every burst is charged 6 minutes after its last activity.
export const SCALE_TO_ZERO_SECONDS = 300;
export const TAIL_MINUTES = 6;

// The longest warm-up §13 measured (195.0 s and 137.8 s, 2026-10-31; updated as §13 records more), and the margin the
// wake waits past it before Spark takes the page (§15).
export const MAX_WARMUP_SECONDS = 195;
export const WARMUP_MARGIN_SECONDS = 60;

// Fireworks' on-demand price per GPU-hour, billed per GPU second (fireworks.ai/pricing, read 2026-10-31). A GPU missing
// here refuses, so a reshaped deployment cannot run on a price nobody checked.
export const PRICE_PER_HOUR_USD: Readonly<Record<string, number>> = { NVIDIA_H200_141GB: 8, NVIDIA_H100_80GB: 8 };

// The version Loupe serves, in one place (D03 T04 §32): `glimmer-active.json`, written only by `deploy.ts promote` and
// `deploy.ts rollback` after the gate, a deployment ready and a probe answered. The Worker, the wake, the screener and the
// recovery command all derive from it, so replacing the version is the command and a Worker deploy to carry the file.
import active from "./glimmer-active.json" with { type: "json" };

export type Active = { version: string; deployment: string; previous: { version: string; deployment: string } | null };
export type Target = { version: string; deployment: string; model: string };
export const ACTIVE: Active = active;

export const FIREWORKS_ACCOUNT = "rizonetech";
// A version's deployment: Loupe 1.0 keeps the name §12 created it under; each later version has its own, so a new version
// is built and proved beside the one serving, which stays up until the active file changes.
export const deploymentFor = (version: string) =>
  version === "1.0" ? "isitlegit-loupe" : `isitlegit-loupe-${version.replace(".", "-")}`;
export const modelNameOf = (version: string) =>
  `accounts/${FIREWORKS_ACCOUNT}/models/isitlegit-loupe-${version.replace(".", "-")}`;
// What inference names: the version's LoRA on its dedicated deployment (D03 T04 §12).
export const targetOf = (version: string, deployment: string = deploymentFor(version)): Target => ({
  version,
  deployment,
  model: `${modelNameOf(version)}#accounts/${FIREWORKS_ACCOUNT}/deployments/${deployment}`,
});

export const DEPLOYMENT = ACTIVE.deployment;
export const DEPLOYED_VERSION = ACTIVE.version;
export const DEPLOYED: Target = targetOf(ACTIVE.version, ACTIVE.deployment);
export const DEPLOYED_GPU = "NVIDIA_H200_141GB";
export const DEPLOYED_GPU_COUNT = 1;

// The money caps on the deployment (design spec section 11): US$50 a day and US$250 in total (coordinator, 4 November 2026).
export const FIREWORKS_DAY_CAP_USD = 50;
export const FIREWORKS_TOTAL_CAP_USD = 250;

export function hourlyRateUsd(gpu: string = DEPLOYED_GPU, count: number = DEPLOYED_GPU_COUNT): number {
  const rate = PRICE_PER_HOUR_USD[gpu];
  if (rate === undefined) throw new Error(`glimmer: no checked price for ${gpu}; add it to PRICE_PER_HOUR_USD first`);
  return rate * count;
}

// The minutes a day may hold: the operator's 30, or fewer when the day's money cap would be reached first.
export const dayLimitMinutes = (rate = hourlyRateUsd()) => Math.min(DAILY_MINUTES, (FIREWORKS_DAY_CAP_USD / rate) * 60);
// The minutes the whole ledger may hold before the total cap.
export const totalLimitMinutes = (rate = hourlyRateUsd()) => (FIREWORKS_TOTAL_CAP_USD / rate) * 60;

export const DEPLOYED_MODEL = DEPLOYED.model;

// The command that recreates the deployment when Fireworks has deleted it (it deletes deployments idle for 7 days).
export const recoveryCommand = (version: string = DEPLOYED_VERSION) =>
  `node scripts/glimmer/deploy.ts ensure ${version}`;

// Runtime minutes accrue as an average, not a hard day (operator, 2026-10-31 22:16 SAST, D03 T04 §34): from the deployment's
// first day (§12 created it on 2026-10-31), the minutes used through any day may reach the day limit times the days so
// far plus one day borrowed ahead. A busy day borrows from the next, which then runs lighter; unused minutes roll over.
// The day's money cap averages with it: at US$8.00 an hour the minutes bind first (60 minutes is US$8 of the US$50).
export const AVERAGE_FROM_DAY = "2026-10-31";
export const BORROW_DAYS = 1;
export type Allowance = { from: string; borrow: number };
export const ALLOWANCE: Allowance = { from: AVERAGE_FROM_DAY, borrow: BORROW_DAYS };

// The SAST days from `from` through `day`, both counted (0 for a day before `from`).
export const daysThrough = (from: string, day: string) =>
  Math.max(0, Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);

// The minutes the ledger may hold through the end of `day`.
export const allowanceMinutes = (day: string, allowance: Allowance = ALLOWANCE, rate = hourlyRateUsd()) =>
  dayLimitMinutes(rate) * (daysThrough(allowance.from, day) + allowance.borrow);
