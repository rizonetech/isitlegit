-- D07 T02 §8. An organisation's plan (spec 2b), stored only once it leaves the trial: `plan` is free, protect or msp,
-- empty while on the trial; `trial_ends_at` is an extension's end, empty for the default (14 days after the
-- organisation's createdAt, src/auth/plans.ts). An organisation with no row is on its trial; `daily_cases` is untouched.
ALTER TABLE org_limits ADD COLUMN plan TEXT CHECK (plan IS NULL OR plan IN ('free', 'protect', 'msp'));
ALTER TABLE org_limits ADD COLUMN trial_ends_at TEXT;
