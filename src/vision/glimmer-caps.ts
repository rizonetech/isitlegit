// The limits on Loupe's dedicated deployment (D03 T04 §14; design spec section 11). Fireworks has no daily runtime cap,
// so these are enforced by the callers through the `glimmer_runtime` ledger (./glimmer-minutes.ts): the Worker and the
// local scripts reserve minutes there before they send a request.

// The operator's 30 minutes a day, warm-up included (design spec section 11).
export const DAILY_MINUTES = 30;

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

// The deployment as D03 T04 §12 created it (docs/glimmer/training.md, Deployment): 1 x H200, Loupe 1.0.
export const DEPLOYMENT = "isitlegit-loupe";
export const DEPLOYED_VERSION = "1.0";
export const DEPLOYED_GPU = "NVIDIA_H200_141GB";
export const DEPLOYED_GPU_COUNT = 1;

// The money caps on the deployment (design spec section 11): US$5 a day and US$90 in total.
export const FIREWORKS_DAY_CAP_USD = 5;
export const FIREWORKS_TOTAL_CAP_USD = 90;

export function hourlyRateUsd(gpu: string = DEPLOYED_GPU, count: number = DEPLOYED_GPU_COUNT): number {
  const rate = PRICE_PER_HOUR_USD[gpu];
  if (rate === undefined) throw new Error(`glimmer: no checked price for ${gpu}; add it to PRICE_PER_HOUR_USD first`);
  return rate * count;
}

// The minutes a day may hold: the operator's 30, or fewer when the day's money cap would be reached first.
export const dayLimitMinutes = (rate = hourlyRateUsd()) => Math.min(DAILY_MINUTES, (FIREWORKS_DAY_CAP_USD / rate) * 60);
// The minutes the whole ledger may hold before the total cap.
export const totalLimitMinutes = (rate = hourlyRateUsd()) => (FIREWORKS_TOTAL_CAP_USD / rate) * 60;

// The model inference names: the deployed version's LoRA on the dedicated deployment (D03 T04 §12).
export const FIREWORKS_ACCOUNT = "rizonetech";
export const DEPLOYED_MODEL = `accounts/${FIREWORKS_ACCOUNT}/models/isitlegit-loupe-${DEPLOYED_VERSION.replace(".", "-")}#accounts/${FIREWORKS_ACCOUNT}/deployments/${DEPLOYMENT}`;

// The command that recreates the deployment when Fireworks has deleted it (it deletes deployments idle for 7 days).
export const recoveryCommand = (version: string = DEPLOYED_VERSION) =>
  `node scripts/glimmer/deploy.ts ensure ${version}`;
