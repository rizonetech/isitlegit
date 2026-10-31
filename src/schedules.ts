// The Worker's schedules, as wrangler.jsonc's `triggers.crons` lists them (D01 T01 §17), which `scheduled()` in
// src/index.ts dispatches on. Kept apart from the entry module, whose named exports workerd takes as handlers.
export const MAIN_CRON = "*/15 * * * *";
export const RETRY_CRON = "* * * * *";
