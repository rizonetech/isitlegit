-- An organisation's daily case cap follows its plan (D07 T08 §8; design/SPEC.md S5: Free check, up to 5 checks a day):
-- `dailyCapSql` in src/auth/plan-sql.ts reads this override first, else the effective plan's cap. `daily_cases` was
-- NOT NULL DEFAULT 50, so a row written for a plan carried 50 that nobody chose; only a value an operator set (any but
-- 50) is carried across as an override. `daily_cases` stays for the readers not yet moved, and is no longer the cap.
ALTER TABLE org_limits ADD COLUMN daily_cases_override INTEGER CHECK (daily_cases_override IS NULL OR daily_cases_override >= 0);
UPDATE org_limits SET daily_cases_override = daily_cases WHERE daily_cases <> 50;
-- The protected demo organisation, Fynbos Freight (operator, 2026-10-31): held at its trial's cap for the whole event,
-- so a judge's demo never drops to Free's 5 a day; only where it exists, its plan and trial untouched.
INSERT INTO org_limits (org_id, daily_cases_override) SELECT id, 50 FROM "organization" WHERE id = 'ZF5SufztotybeXIWVncExFAVu9GYZ8Fu'
  ON CONFLICT (org_id) DO UPDATE SET daily_cases_override = 50;
