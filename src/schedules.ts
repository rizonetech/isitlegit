// The Worker's schedules, as wrangler.jsonc's `triggers.crons` lists them (D01 T01 §17), which `scheduled()` in
// src/index.ts dispatches on. Kept apart from the entry module, whose named exports workerd takes as handlers.
export const MAIN_CRON = "*/15 * * * *";
export const RETRY_CRON = "* * * * *";
// The forwarding scan between the quarter-hours (D01 T02 §12), so a refusal is alerted within five minutes of its grace
// ending; never on a quarter-hour, where MAIN_CRON scans it, so two scans never run at once.
export const FORWARD_CRON = "5,10,20,25,35,40,50,55 * * * *";
// The impersonation monitor's daily run at 06:15 SAST (D05 T04 §2); crons run in UTC.
export const MONITOR_CRON = "15 4 * * *";
