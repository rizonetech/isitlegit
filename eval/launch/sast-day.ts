// The SAST day's start, as `src/db/cases.ts` (`sastDayStart`) counts the daily case cap from. Restated in a module
// with no imports because `src/db/cases.ts`'s extensionless imports do not load under plain Node, where
// `eval/launch/check-limits.ts` runs; `test/launch/sast-day.test.ts` (the Worker project) checks the two agree.
const SAST_OFFSET_MS = 2 * 60 * 60_000;
export const sastDayStart = (now: Date) => {
  const local = now.getTime() + SAST_OFFSET_MS;
  return new Date(local - (local % 86_400_000) - SAST_OFFSET_MS).toISOString();
};
