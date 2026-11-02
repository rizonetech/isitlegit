// The per-set stated caps for `pnpm eval:baseline` (D08 T02 §11): the measured rules-only baseline's figures,
// restated before every run and never raised. Each stays below the shared day headroom; the runner's preflight
// refuses anything above it.
export const BASELINE_SETS = ["synthetic-sa", "nazario-2025", "synthetic-challenge"] as const;

export type BaselineSet = (typeof BASELINE_SETS)[number];

export const BASELINE_CAPS: Record<BaselineSet, number> = {
  "synthetic-sa": 13.0,
  "nazario-2025": 5.0,
  "synthetic-challenge": 5.0,
};
